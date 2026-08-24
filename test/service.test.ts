import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CalDavClient, basicAuth } from '../src/dav/client.js'
import { CalendarService, buildService, parseDateArg } from '../src/service.js'
import { CredentialResolver } from '../src/credentials.js'
import { makeUtc, toUtcMs, type VEvent } from '../src/core/ics.js'
import { startMockServer, type MockServer } from './helpers/mockCaldav.js'

const TZ = 'Asia/Shanghai'

function mkEvent(uid: string, summary: string, start: VEvent['dtStart']!, end: VEvent['dtEnd'], extra: Partial<VEvent> = {}): VEvent {
  return {
    uid,
    summary,
    dtStart: start,
    dtEnd: end,
    status: 'CONFIRMED',
    categories: ['work'],
    exdates: [],
    rdates: [],
    alarms: [],
    extra: [],
    ...extra,
  }
}

describe('CalendarService (operations layer)', () => {
  let mock: MockServer
  let svc: CalendarService

  beforeAll(async () => {
    process.env.CALDAV_USERNAME = 'u'
    process.env.CALDAV_PASSWORD = 'p'
    mock = await startMockServer()
    mock.calendar.seed([
      mkEvent('standup', 'Daily Standup', makeUtc(Date.UTC(2026, 0, 6, 1, 0)), makeUtc(Date.UTC(2026, 0, 6, 1, 30)), { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10', categories: ['work'] }),
      mkEvent('lunch', 'Team Lunch', makeUtc(Date.UTC(2026, 0, 8, 4, 30)), makeUtc(Date.UTC(2026, 0, 8, 5, 30)), { categories: ['social'] }),
    ])
    const creds = new CredentialResolver({})
    const built = await buildService({
      serverUrl: mock.baseUrl,
      defaultTz: TZ,
      authMode: 'basic',
      credentials: creds,
    })
    svc = new CalendarService(built.store, built.defaultTz, creds)
  })

  afterAll(async () => {
    await mock.close()
  })

  it('lists events in a window with wall times', async () => {
    const r = await svc.list({ start: '2026-01-05', end: '2026-01-20', tz: TZ })
    expect(r.events.length).toBeGreaterThanOrEqual(1)
    const standup = r.events.find((e) => e.uid === 'standup')
    expect(standup).toBeTruthy()
    // UTC 01:00 == 09:00 in Asia/Shanghai
    expect(standup!.start?.wall).toContain('09:00')
    expect(standup!.start?.utc).toBe('2026-01-06T01:00:00.000Z')
  })

  it('creates an event and reports conflicts', async () => {
    const result = await svc.create({
      summary: 'Overlap Attempt',
      start: '2026-01-08 12:30',
      end: '2026-01-08 13:00',
      tz: TZ,
    })
    expect(result.event.uid).toBeTruthy()
    // overlaps Team Lunch (04:30Z-05:30Z = 12:30-13:30 +08)
    expect(result.conflicts.length).toBe(1)
    expect(result.conflicts[0].summary).toBe('Team Lunch')
    // cleanup so later tests are not surprised
    await svc.remove(result.event.uid)
  })

  it('creates a non-conflicting event cleanly', async () => {
    const result = await svc.create({
      summary: 'Safe Slot',
      start: '2026-01-09 02:00',
      end: '2026-01-09 03:00',
      tz: TZ,
    })
    expect(result.conflicts.length).toBe(0)
    await svc.remove(result.event.uid)
  })

  it('searches text fields', async () => {
    const r = await svc.search('lunch', { start: '2026-01-01', end: '2026-01-31', tz: TZ })
    expect(r.events.some((e) => e.uid === 'lunch')).toBe(true)
    const none = await svc.search('zzz-nothing', { start: '2026-01-01', end: '2026-01-31', tz: TZ })
    expect(none.events).toHaveLength(0)
  })

  it('reports holidays and heutige 干支', async () => {
    const r = await svc.chinese({ after: '2026-02-10', days: 20 })
    expect(r.holidays.some((h) => h.key === 'spring-festival')).toBe(true)
    // 2026-02-17 is 春节 2026
    const sf = r.holidays.find((h) => h.key === 'spring-festival')
    expect(sf?.date).toBe('2026-02-17')
  })

  it('builds a reminder plan compatible with schedule_create', async () => {
    const plan = await svc.reminderPlan('standup', { before: '1h', tz: TZ, until: '2026-01-20', now: '2026-01-01' })
    expect(plan.occurrences.length).toBeGreaterThan(0)
    const first = plan.occurrences[0]
    expect(first.at.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(first.at.time_zone).toBe(TZ)
    expect(plan.reminderBeforeMinutes).toBe(60)
  })

  it('single-instance update via CalendarService', async () => {
    const updated = await svc.update('standup', {
      recurrenceId: '2026-01-09 09:00', // 3rd occurrence in Shanghai
      summary: 'Standup (rescheduled)',
      start: '2026-01-09 10:00',
      end: '2026-01-09 10:30',
      tz: TZ,
    })
    expect(updated.event?.summary).toBe('Standup (rescheduled)')
    const got = await svc.get('standup', { start: '2026-01-05', end: '2026-01-20', tz: TZ })
    expect(got!.series.filter((i) => i.uid === 'standup' && i.summary.includes('rescheduled'))).toHaveLength(1)
    // master title unchanged
    expect(got!.master?.summary).toBe('Daily Standup')
  })
})

describe('parseDateArg', () => {
  it('parses wall, UTC and all-day inputs', () => {
    const tz = 'Asia/Shanghai'
    expect(parseDateArg('2026-03-02', tz, false).type).toBe('date')
    expect(parseDateArg('2026-03-02 10:30', tz, false)).toMatchObject({ type: 'date-time', tzid: tz, hour: 10, minute: 30 })
    expect(parseDateArg('2026-03-02T10:30:00Z', tz, false)).toMatchObject({ type: 'date-time', utc: true, hour: 10 })
    expect(parseDateArg('2026-03-02', tz, true).type).toBe('date')
    // UTC timezone produces UTC-stored date-times
    expect(parseDateArg('2026-03-02 10:30', 'UTC', false)).toMatchObject({ type: 'date-time', utc: true })
  })

  it('standard parseDateArg is consistent with toUtcMs', () => {
    const v = parseDateArg('2026-03-02 10:30', TZ, false)
    expect(toUtcMs(v, TZ)).toBe(Date.UTC(2026, 2, 2, 2, 30))
  })
})

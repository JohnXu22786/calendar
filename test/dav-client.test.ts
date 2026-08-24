import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CalDavClient, basicAuth } from '../src/dav/client.js'
import { CalDavStore } from '../src/dav/store.js'
import { makeUtc, sameLocalValue, type VEvent } from '../src/core/ics.js'
import { startMockServer, type MockServer } from './helpers/mockCaldav.js'

const TZ = 'Asia/Shanghai'

function mkEvent(uid: string, summary: string, start: VEvent['dtStart']!, end: VEvent['dtEnd'], extra: Partial<VEvent> = {}): VEvent {
  return {
    uid,
    summary,
    dtStart: start,
    dtEnd: end,
    status: 'CONFIRMED',
    categories: [],
    exdates: [],
    rdates: [],
    alarms: [],
    extra: [],
    ...extra,
  }
}

describe('CalDAV client + store against an in-process mock server', () => {
  let mock: MockServer
  let client: CalDavClient

  beforeAll(async () => {
    mock = await startMockServer()
    client = new CalDavClient({ baseUrl: mock.baseUrl, auth: basicAuth('u', 'p') })
    mock.calendar.seed([
      mkEvent('alpha', 'Alpha', makeUtc(Date.UTC(2024, 2, 10, 2, 0)), makeUtc(Date.UTC(2024, 2, 10, 3, 0)), { rrule: 'FREQ=DAILY;COUNT=5' }),
      mkEvent('beta', 'Beta', makeUtc(Date.UTC(2024, 2, 12, 9, 30)), makeUtc(Date.UTC(2024, 2, 12, 10, 30)), {}),
    ])
  })

  afterAll(async () => {
    await mock.close()
  })

  it('discovers the calendar collection', async () => {
    const cals = await client.resolveCalendars()
    expect(cals.length).toBeGreaterThan(0)
    expect(cals[0].supportsVEVENT).toBe(true)
    expect(cals[0].url).toContain('/calendars/me/events/')
  })

  it('uses an explicit calendar URL without discovery', async () => {
    const store = new CalDavStore({ client, defaultTz: TZ, calendarUrl: '/calendars/me/events/' })
    expect(await store.calendarUrl()).toBe(`${mock.baseUrl}calendars/me/events/`)
  })

  it('lists events within a range', async () => {
    const store = new CalDavStore({ client, defaultTz: TZ })
    const rows = await store.list(Date.UTC(2024, 2, 1), Date.UTC(2024, 2, 20))
    expect(rows.length).toBe(2)
    const alpha = rows.find((r) => r.series.items[0].ev.uid === 'alpha')
    expect(alpha?.instances.length).toBe(5)
  })

  it('creates, fetches and updates an event', async () => {
    const store = new CalDavStore({ client, defaultTz: TZ })
    const ev = mkEvent('gamma', 'Gamma', makeUtc(Date.UTC(2024, 2, 20, 8, 0)), makeUtc(Date.UTC(2024, 2, 20, 9, 0)), {})
    const created = await store.create(ev)
    expect(created.href).toBeTruthy()
    expect(created.etag).toBeTruthy()

    const fetched = await store.get('gamma')
    expect(fetched).toBeTruthy()
    expect(fetched!.items[0].ev.summary).toBe('Gamma')
    expect(created.href).toBe(fetched!.items[0].href)

    fetched!.items[0].ev.summary = 'Gamma-2'
    await store.update(fetched!)
    const refetched = await store.get('gamma')
    expect(refetched!.items[0].ev.summary).toBe('Gamma-2')
  })

  it('deletes a single occurrence via a CANCELLED override', async () => {
    const store = new CalDavStore({ client, defaultTz: TZ })
    const alpha = await store.get('alpha')
    expect(alpha).toBeTruthy()
    const target = makeUtc(Date.UTC(2024, 2, 12, 2, 0)) // 3rd occurrence
    const ok = await store.remove('alpha', { recurrenceId: target, series: alpha! })
    expect(ok).toBe(true)
    const after = await store.get('alpha')
    const overrides = after!.items.filter((i) => i.ev.recurrenceId)
    expect(overrides.length).toBe(1)
    expect(overrides[0].ev.status).toBe('CANCELLED')
    expect(sameLocalValue(overrides[0].ev.recurrenceId!, target)).toBe(true)
  })

  it('removes a whole series', async () => {
    const store = new CalDavStore({ client, defaultTz: TZ })
    await store.remove('beta')
    const fetched = await store.get('beta')
    expect(fetched).toBeNull()
  })
})

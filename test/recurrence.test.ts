import { describe, expect, it } from 'vitest'
import {
  expandSeries,
  findOverride,
  removeOverride,
  seriesToVEvents,
  updateSingleInstance,
  deleteSingleInstance,
  type Series,
  type Instance,
} from '../src/core/recurrence.js'
import {
  makeDateTime,
  makeDate,
  type IcsDate,
  type VEvent,
} from '../src/core/ics.js'

const TZ = 'Asia/Shanghai'

function ics(
  uid: string,
  summary: string,
  start: IcsDate,
  end?: IcsDate,
  extra: Partial<VEvent> = {},
): VEvent {
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

function series(master: VEvent, overrides: VEvent[] = []): Series {
  return { master, overrides }
}

function expand(series: Series, rangeStartMs: number, rangeEndMs: number, opts: { includeCancelled?: boolean } = {}): Instance[] {
  return expandSeries(series, { rangeStartMs, rangeEndMs, defaultTz: TZ, includeCancelled: opts.includeCancelled })
}

describe('basic series expansion', () => {
  it('non-recurring event yields exactly one instance', () => {
    const s = series(ics('u1', 'Standup', makeDateTime(2024, 2, 10, 9, 0, 0, { tzid: TZ }), makeDateTime(2024, 2, 10, 9, 30, 0, { tzid: TZ })))
    const inst = expand(s, Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 15))
    expect(inst).toHaveLength(1)
    expect(inst[0].startMs).toBe(Date.UTC(2024, 1, 10, 1, 0))
    expect(inst[0].endMs).toBe(Date.UTC(2024, 1, 10, 1, 30))
    expect(inst[0].overridden).toBe(false)
  })

  it('daily series expands within the window', () => {
    const s = series(ics('u2', 'Daily', makeDateTime(2024, 3, 1, 10, 0, 0, { utc: true }), makeDateTime(2024, 3, 1, 11, 0, 0, { utc: true }), { rrule: 'FREQ=DAILY;COUNT=5' }))
    const inst = expand(s, Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1))
    expect(inst).toHaveLength(5)
    expect(inst.map((i) => i.startMs)).toEqual([0, 1, 2, 3, 4].map((d) => Date.UTC(2024, 2, 1 + d, 10, 0)))
    expect(inst[4].endMs).toBe(Date.UTC(2024, 2, 5, 11, 0))
  })

  it('all-day events use the day boundary', () => {
    const s = series(ics('u3', 'Vacation', makeDate(2024, 5, 1), makeDate(2024, 5, 3)))
    const inst = expand(s, Date.UTC(2024, 4, 1), Date.UTC(2024, 5, 1))
    expect(inst).toHaveLength(1)
    expect(inst[0].allDay).toBe(true)
    // 2024-05-01 00:00 +08 = 2024-04-30 16:00Z
    expect(inst[0].startMs).toBe(Date.UTC(2024, 3, 30, 16, 0))
    expect(inst[0].endMs).toBe(Date.UTC(2024, 4, 2, 16, 0))
  })
})

describe('EXDATE and RDATE', () => {
  it('EXDATE removes specific occurrences', () => {
    const ex = makeDateTime(2024, 3, 3, 10, 0, 0, { utc: true })
    const s = series(ics('u4', 'DailyX', makeDateTime(2024, 3, 1, 10, 0, 0, { utc: true }), makeDateTime(2024, 3, 1, 10, 30, 0, { utc: true }), { rrule: 'FREQ=DAILY;COUNT=4', exdates: [ex] }))
    const inst = expand(s, Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1))
    expect(inst).toHaveLength(3)
    expect(inst.map((i) => i.startMs)).not.toContain(Date.UTC(2024, 2, 3, 10, 0))
  })

  it('EXDATE matches by local value, independent of the representing timezone', () => {
    // DTSTART is 10:00 in Asia/Shanghai; the EXDATE carries the same *local*
    // value again in Asia/Shanghai — this is how servers express exceptions.
    const ex = makeDateTime(2024, 3, 3, 10, 0, 0, { tzid: TZ })
    const s = series(ics('u5', 'LocalX', makeDateTime(2024, 3, 1, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 1, 11, 0, 0, { tzid: TZ }), { rrule: 'FREQ=DAILY;COUNT=3', exdates: [ex] }))
    const inst = expand(s, Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1))
    expect(inst.map((i) => i.startMs)).toEqual([Date.UTC(2024, 2, 1, 2, 0), Date.UTC(2024, 2, 2, 2, 0)])
  })

  it('RDATE adds extra occurrences', () => {
    const rd = makeDateTime(2024, 3, 8, 10, 0, 0, { utc: true })
    const s = series(ics('u6', 'WithR', makeDateTime(2024, 3, 1, 10, 0, 0, { utc: true }), makeDateTime(2024, 3, 1, 10, 30, 0, { utc: true }), { rrule: 'FREQ=DAILY;COUNT=2', rdates: [rd] }))
    const inst = expand(s, Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 31))
    expect(inst).toHaveLength(3)
    expect(inst.map((i) => i.startMs)).toContain(Date.UTC(2024, 2, 8, 10, 0))
  })
})

describe('RECURRENCE-ID overrides (single-instance editing)', () => {
  it('an override replaces the matching instance only', () => {
    const ov = ics('u7', 'Daily (moved)', makeDateTime(2024, 3, 3, 14, 0, 0, { utc: true }), makeDateTime(2024, 3, 3, 15, 0, 0, { utc: true }))
    ov.recurrenceId = makeDateTime(2024, 3, 3, 10, 0, 0, { utc: true })
    const master = ics('u7', 'Daily', makeDateTime(2024, 3, 1, 10, 0, 0, { utc: true }), makeDateTime(2024, 3, 1, 11, 0, 0, { utc: true }), { rrule: 'FREQ=DAILY;COUNT=3' })
    const inst = expand(series(master, [ov]), Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1))
    expect(inst).toHaveLength(3)
    const moved = inst.find((i) => i.startMs === Date.UTC(2024, 2, 3, 14, 0))
    expect(moved).toBeTruthy()
    expect(moved!.summary).toBe('Daily (moved)')
    expect(moved!.overridden).toBe(true)
    expect(moved!.recurrenceId).toBeTruthy()
    const unchanged = inst.find((i) => i.startMs === Date.UTC(2024, 2, 2, 10, 0))
    expect(unchanged!.summary).toBe('Daily')
    expect(unchanged!.overridden).toBe(false)
  })

  it('a CANCELLED override removes the instance unless included', () => {
    const ov = ics('u7', 'Daily', makeDateTime(2024, 3, 3, 10, 0, 0, { utc: true }), makeDateTime(2024, 3, 3, 11, 0, 0, { utc: true }))
    ov.recurrenceId = makeDateTime(2024, 3, 3, 10, 0, 0, { utc: true })
    ov.status = 'CANCELLED'
    const master = ics('u7', 'Daily', makeDateTime(2024, 3, 1, 10, 0, 0, { utc: true }), makeDateTime(2024, 3, 1, 11, 0, 0, { utc: true }), { rrule: 'FREQ=DAILY;COUNT=3' })
    const without = expand(series(master, [ov]), Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1))
    expect(without.some((i) => i.startMs === Date.UTC(2024, 2, 3, 10, 0))).toBe(false)
    const withCancelled = expand(series(master, [ov]), Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1), { includeCancelled: true })
    const cancelled = withCancelled.find((i) => i.startMs === Date.UTC(2024, 2, 3, 10, 0))
    expect(cancelled?.status).toBe('CANCELLED')
  })

  it('updateSingleInstance produces a valid override VEVENT', () => {
    const master = ics('u8', 'Weekly', makeDateTime(2024, 4, 1, 9, 0, 0, { tzid: TZ }), makeDateTime(2024, 4, 1, 10, 0, 0, { tzid: TZ }), { rrule: 'FREQ=WEEKLY;COUNT=4' })
    const target = makeDateTime(2024, 4, 22, 9, 0, 0, { tzid: TZ })
    const ov = updateSingleInstance({ master, overrides: [] }, target, {
      summary: 'Weekly (special)',
      start: makeDateTime(2024, 4, 22, 13, 0, 0, { tzid: TZ }),
      end: makeDateTime(2024, 4, 22, 14, 0, 0, { tzid: TZ }),
    })
    expect(ov.uid).toBe('u8')
    expect(ov.summary).toBe('Weekly (special)')
    expect(ov.recurrenceId).toBeTruthy()
    // recurrence-id matches the *original* local start
    expect(ov.recurrenceId!.year).toBe(2024)
    expect(ov.recurrenceId!.month).toBe(4)
    expect(ov.recurrenceId!.day).toBe(22)
    expect(ov.recurrenceId!.hour).toBe(9)
    const s = { master, overrides: [ov] }
    const inst = expand(s, Date.UTC(2024, 3, 1), Date.UTC(2024, 5, 1))
    expect(inst.filter((i) => i.overridden)).toHaveLength(1)
    expect(inst.find((i) => i.overridden)!.startMs).toBe(Date.UTC(2024, 3, 22, 5, 0))
  })

  it('deleteSingleInstance cancels exactly one occurrence', () => {
    const master = ics('u9', 'Daily2', makeDateTime(2024, 6, 1, 8, 0, 0, { tzid: TZ }), makeDateTime(2024, 6, 1, 8, 30, 0, { tzid: TZ }), { rrule: 'FREQ=DAILY;COUNT=4' })
    const target = makeDateTime(2024, 6, 3, 8, 0, 0, { tzid: TZ })
    const ov = deleteSingleInstance({ master, overrides: [] }, target)
    expect(ov.status).toBe('CANCELLED')
    const inst = expand({ master, overrides: [ov] }, Date.UTC(2024, 5, 1), Date.UTC(2024, 7, 1))
    expect(inst).toHaveLength(3)
  })

  it('findOverride/removeOverride round-trip', () => {
    const target = makeDateTime(2024, 6, 3, 8, 0, 0, { tzid: TZ })
    const master = ics('u10', 'D', makeDateTime(2024, 6, 1, 8, 0, 0, { tzid: TZ }), makeDateTime(2024, 6, 1, 9, 0, 0, { tzid: TZ }), { rrule: 'FREQ=DAILY;COUNT=3' })
    const ov = deleteSingleInstance({ master, overrides: [] }, target)
    let s: Series = { master, overrides: [ov] }
    expect(findOverride(s, target)?.status).toBe('CANCELLED')
    s = removeOverride(s, target)
    expect(findOverride(s, target)).toBeUndefined()
    // master unconcerned
    expect(s.master.uid).toBe('u10')
  })

  it('seriesToVEvents includes the override beside the master', () => {
    const master = ics('u11', 'S', makeDateTime(2024, 7, 1, 9, 0, 0, { tzid: TZ }), makeDateTime(2024, 7, 1, 10, 0, 0, { tzid: TZ }), { rrule: 'FREQ=DAILY;COUNT=2' })
    const ov = updateSingleInstance({ master, overrides: [] }, makeDateTime(2024, 7, 2, 9, 0, 0, { tzid: TZ }), { summary: 'S2' })
    const all = seriesToVEvents({ master, overrides: [ov] })
    expect(all).toHaveLength(2)
    expect(all.some((e) => e.recurrenceId)).toBe(true)
  })
})

describe('DST safety', () => {
  it('a weekly series across spring-forward yields one instance per week', () => {
    const master = ics('u12', 'WeeklyLA', makeDateTime(2024, 3, 6, 9, 0, 0, { tzid: 'America/Los_Angeles' }), makeDateTime(2024, 3, 6, 10, 0, 0, { tzid: 'America/Los_Angeles' }), { rrule: 'FREQ=WEEKLY;COUNT=4' })
    const inst = expand(series(master), Date.UTC(2024, 2, 1), Date.UTC(2024, 4, 1))
    expect(inst).toHaveLength(4)
    const utcStarts = inst.map((i) => i.startMs).sort()
    // before DST: 17:00Z; after: 16:00Z — 4 distinct instants
    expect(new Set(utcStarts).size).toBe(4)
    // index 0 = 2024-03-06, index 1 = 2024-03-13 (first instance after spring-forward)
    expect(utcStarts[0]).toBe(Date.UTC(2024, 2, 6, 17, 0))
    expect(utcStarts[1]).toBe(Date.UTC(2024, 2, 13, 16, 0))
  })
})

describe('window slicing', () => {
  it('startInRange mode returns only instances starting inside the range', () => {
    const s = series(ics('u13', 'Month', makeDate(2024, 1, 1), makeDate(2024, 1, 2), { rrule: 'FREQ=MONTHLY;COUNT=12' }))
    const inst = expandSeries(s, { rangeStartMs: Date.UTC(2024, 4, 31, 16, 0), rangeEndMs: Date.UTC(2024, 5, 30, 16, 0), defaultTz: TZ, startInRange: true })
    // June 1 all-day in Asia/Shanghai starts 2024-05-31 16:00Z
    expect(inst.map((i) => i.startMs)).toEqual([Date.UTC(2024, 4, 31, 16, 0)])
  })

  it('overlap mode includes events that start before the range but span into it', () => {
    const s = series(ics('u15', 'Span', makeDate(2024, 5, 2), makeDate(2024, 6, 3))) // 2 May .. 3 June
    const inst = expandSeries(s, { rangeStartMs: Date.UTC(2024, 5, 1), rangeEndMs: Date.UTC(2024, 5, 15), defaultTz: TZ })
    expect(inst).toHaveLength(1)
  })
})

describe('master-less and degenerate cases', () => {
  it('an event without DTSTART produces no instances (guarded)', () => {
    const ev = ics('u14', 'NoStart', makeDateTime(2024, 1, 1, 0, 0, 0, {}))
    ev.dtStart = undefined as unknown as IcsDate
    expect(expand(series(ev), Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1))).toEqual([])
  })
})

describe('RDATE-only recurrence sets (regression)', () => {
  it('non-recurring event with RDATE expands all occurrences', () => {
    const rd1 = makeDateTime(2024, 5, 8, 10, 0, 0, { utc: true })
    const rd2 = makeDateTime(2024, 5, 20, 10, 0, 0, { utc: true })
    const s = series(ics('u20', 'OncePlus', makeDateTime(2024, 5, 1, 10, 0, 0, { utc: true }), makeDateTime(2024, 5, 1, 11, 0, 0, { utc: true }), { rdates: [rd1, rd2] }))
    const inst = expand(s, Date.UTC(2024, 4, 1), Date.UTC(2024, 5, 31))
    expect(inst).toHaveLength(3)
    expect(inst.map((i) => i.startMs)).toEqual([
      Date.UTC(2024, 4, 1, 10, 0),
      Date.UTC(2024, 4, 8, 10, 0),
      Date.UTC(2024, 4, 20, 10, 0),
    ])
    // RDATE occurrences inherit the master's duration (not the master's absolute end)
    const rdInst = inst.find((i) => i.startMs === Date.UTC(2024, 4, 8, 10, 0))!
    expect(rdInst.endMs).toBe(Date.UTC(2024, 4, 8, 11, 0))
  })

  it('EXDATE removes the master occurrence itself when listed', () => {
    const s = series(ics('u21', 'Gone', makeDateTime(2024, 6, 1, 9, 0, 0, { utc: true }), makeDateTime(2024, 6, 1, 9, 30, 0, { utc: true }), { exdates: [makeDateTime(2024, 6, 1, 9, 0, 0, { utc: true })] }))
    expect(expand(s, Date.UTC(2024, 5, 1), Date.UTC(2024, 7, 1))).toHaveLength(0)
  })
})

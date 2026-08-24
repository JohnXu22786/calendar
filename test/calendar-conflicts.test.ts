import { describe, expect, it } from 'vitest'
import { findConflicts } from '../src/core/calendar.js'
import { makeDateTime, makeDate, type IcsDate, type VEvent } from '../src/core/ics.js'

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

const R = { rangeStartMs: Date.UTC(2024, 2, 1), rangeEndMs: Date.UTC(2024, 5, 1), defaultTz: TZ }

function conflicts(others: VEvent[], candidate: VEvent, excludeUids?: string[]) {
  return findConflicts(
    others.map((master) => ({ master, overrides: [] })),
    { master: candidate, overrides: [] },
    { ...R, excludeUids },
  )
}

describe('conflict detection', () => {
  it('flags an overlapping timed event', () => {
    const other = ics('o1', 'Busy', makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 12, 0, 0, { tzid: TZ }))
    const cand = ics('c1', 'Mine', makeDateTime(2024, 3, 15, 11, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 13, 0, 0, { tzid: TZ }))
    const hits = conflicts([other], cand)
    expect(hits).toHaveLength(1)
    expect(hits[0].otherUid).toBe('o1')
    expect(hits[0].overlapMs).toBe(3600000)
  })

  it('adjacent events (end == start) do not conflict', () => {
    const other = ics('o2', 'A', makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 11, 0, 0, { tzid: TZ }))
    const cand = ics('c2', 'B', makeDateTime(2024, 3, 15, 11, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 12, 0, 0, { tzid: TZ }))
    expect(conflicts([other], cand)).toHaveLength(0)
  })

  it('non-overlapping events do not conflict', () => {
    const other = ics('o3', 'A', makeDateTime(2024, 3, 15, 8, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 9, 0, 0, { tzid: TZ }))
    const cand = ics('c3', 'B', makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 11, 0, 0, { tzid: TZ }))
    expect(conflicts([other], cand)).toHaveLength(0)
  })

  it('all-day events conflict on the same day', () => {
    const other = ics('o4', 'AllDay', makeDate(2024, 4, 10), makeDate(2024, 4, 11))
    const cand = ics('c4', 'HalfDay', makeDateTime(2024, 4, 10, 14, 0, 0, { tzid: TZ }), makeDateTime(2024, 4, 10, 16, 0, 0, { tzid: TZ }))
    expect(conflicts([other], cand)).toHaveLength(1)
  })

  it('recurring candidate conflicts on every matching instance', () => {
    const other = ics('o5', 'Weekly meeting', makeDateTime(2024, 3, 4, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 4, 11, 0, 0, { tzid: TZ }), { rrule: 'FREQ=WEEKLY;COUNT=8' })
    const cand = ics('c5', 'Daily task', makeDateTime(2024, 3, 5, 10, 30, 0, { tzid: TZ }), makeDateTime(2024, 3, 5, 10, 45, 0, { tzid: TZ }), { rrule: 'FREQ=DAILY;COUNT=30' })
    const hits = conflicts([other], cand)
    // Mondays at 10:30-10:45 overlap the 10:00-11:00 weekly meeting: Mar 4, 11, 18, 25
    expect(hits.length).toBeGreaterThanOrEqual(4)
    expect(hits.every((h) => h.otherUid === 'o5')).toBe(true)
  })

  it('excludes the event being updated', () => {
    const other = ics('c6', 'Self', makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 12, 0, 0, { tzid: TZ }))
    const cand = ics('c6', 'Self', makeDateTime(2024, 3, 15, 11, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 13, 0, 0, { tzid: TZ }))
    const hits = findConflicts(
      [{ master: other, overrides: [] }],
      { master: cand, overrides: [] },
      { ...R, excludeUids: ['c6'] },
    )
    expect(hits).toHaveLength(0)
  })

  it('ignores cancelled events', () => {
    const other = ics('o7', 'Cancelled', makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 12, 0, 0, { tzid: TZ }), { status: 'CANCELLED' })
    const cand = ics('c7', 'Mine', makeDateTime(2024, 3, 15, 11, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 12, 0, 0, { tzid: TZ }))
    expect(conflicts([other], cand)).toHaveLength(0)
  })

  it('virtual length: candidate without END is treated as point (no conflict with itself)', () => {
    const other = ics('o8', 'A', makeDateTime(2024, 3, 15, 9, 0, 0, { tzid: TZ }), makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }))
    // candidate has only DTSTART and no DTEND -> point event; strict overlap with
    // adjacent intervals is expected to be zero-length.
    const cand = ics('c8', 'Point', makeDateTime(2024, 3, 15, 10, 0, 0, { tzid: TZ }))
    expect(conflicts([other], cand)).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { expandRrule, parseRrule } from '../src/core/rrule.js'
import { makeWall, utcToWall } from '../src/core/tz.js'
import { parseIsoDuration } from '../src/core/duration.js'

/**
 * Expand a rule in UTC space and return ISO-8601 UTC strings for easy
 * comparison against RFC 5545 example vectors. `tzid` defaults to UTC so the
 * wall values equal the UTC values.
 */
function expandToIso(rrule: string, dtstart: number[], opts: { tzid?: string; until?: boolean } = {}): string[] {
  const start = makeWall(dtstart[0], dtstart[1], dtstart[2], dtstart[3] ?? 9, dtstart[4] ?? 0, dtstart[5] ?? 0)
  const parsed = parseRrule(rrule)
  const out = expandRrule(parsed, start, { tzid: opts.tzid ?? 'UTC', maxResults: 5000 })
  return out.map((i) => new Date(i.utcMs).toISOString())
}

function iso(y: number, mo: number, d: number, h = 9, mi = 0, s = 0): string {
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`
}

describe('RRULE parsing', () => {
  it('parses a standard rule', () => {
    const r = parseRrule('FREQ=WEEKLY;INTERVAL=2;COUNT=10;BYDAY=TU,SU;WKST=MO')
    expect(r.freq).toBe('WEEKLY')
    expect(r.interval).toBe(2)
    expect(r.count).toBe(10)
    expect(r.byDay.map((b) => b.weekday)).toEqual([2, 0]) // TU=2, SU=0 (JS weeks)
    expect(r.wkst).toBe(1)
  })

  it('parses ordinals and negatives in BYDAY/BYMONTHDAY', () => {
    const r = parseRrule('FREQ=MONTHLY;BYDAY=-1FR;BYMONTHDAY=-3,1,31')
    expect(r.byDay).toEqual([{ weekday: 5, ord: -1 }])
    expect(r.byMonthDay).toEqual([-3, 1, 31])
  })

  it('rejects a rule without FREQ', () => {
    expect(() => parseRrule('INTERVAL=2')).toThrow()
  })

  it('parses UNTIL with and without Z', () => {
    const utc = parseRrule('FREQ=DAILY;UNTIL=19971224T000000Z')
    expect(utc.until).toMatchObject({ utcMs: Date.UTC(1997, 11, 24, 0, 0, 0) })
    const local = parseRrule('FREQ=DAILY;UNTIL=19971224T000000')
    expect(local.until).toMatchObject({ wall: { year: 1997, month: 12, day: 24, hour: 0, minute: 0, second: 0 } })
  })
})

describe('RFC 5545 example vectors (UTC space)', () => {
  it('#1 FREQ=DAILY;COUNT=10', () => {
    const got = expandToIso('FREQ=DAILY;COUNT=10', [1997, 9, 2])
    expect(got).toEqual(Array.from({ length: 10 }, (_, k) => iso(1997, 9, 2 + k)))
  })

  it('#4 FREQ=DAILY;INTERVAL=10;COUNT=5', () => {
    expect(expandToIso('FREQ=DAILY;INTERVAL=10;COUNT=5', [1997, 9, 2]))
      .toEqual([iso(1997, 9, 2), iso(1997, 9, 12), iso(1997, 9, 22), iso(1997, 10, 2), iso(1997, 10, 12)])
  })

  it('#6 FREQ=WEEKLY;COUNT=10 (weekday of DTSTART)', () => {
    expect(expandToIso('FREQ=WEEKLY;COUNT=10', [1997, 9, 2]))
      .toEqual([iso(1997, 9, 2), iso(1997, 9, 9), iso(1997, 9, 16), iso(1997, 9, 23), iso(1997, 9, 30),
        iso(1997, 10, 7), iso(1997, 10, 14), iso(1997, 10, 21), iso(1997, 10, 28), iso(1997, 11, 4)])
  })

  it('#8 FREQ=WEEKLY;INTERVAL=2;WKST=SU', () => {
    expect(expandToIso('FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU', [1997, 8, 5]))
      .toEqual([iso(1997, 8, 5), iso(1997, 8, 19), iso(1997, 9, 2), iso(1997, 9, 16), iso(1997, 9, 30),
        iso(1997, 10, 14), iso(1997, 10, 28), iso(1997, 11, 11), iso(1997, 11, 25), iso(1997, 12, 9), iso(1997, 12, 23)])
  })

  it('#10 FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', () => {
    expect(expandToIso('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', [1997, 8, 5]))
      .toEqual([iso(1997, 8, 5), iso(1997, 8, 10), iso(1997, 8, 19), iso(1997, 8, 24)])
  })

  it('#11 FREQ=MONTHLY;COUNT=10;BYDAY=1FR', () => {
    expect(expandToIso('FREQ=MONTHLY;COUNT=10;BYDAY=1FR', [1997, 9, 5]))
      .toEqual([iso(1997, 9, 5), iso(1997, 10, 3), iso(1997, 11, 7), iso(1997, 12, 5), iso(1998, 1, 2),
        iso(1998, 2, 6), iso(1998, 3, 6), iso(1998, 4, 3), iso(1998, 5, 1), iso(1998, 6, 5)])
  })

  it('#13 FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU', () => {
    expect(expandToIso('FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU', [1997, 9, 7]))
      .toEqual([iso(1997, 9, 7), iso(1997, 9, 28), iso(1997, 11, 2), iso(1997, 11, 30), iso(1998, 1, 4),
        iso(1998, 1, 25), iso(1998, 3, 1), iso(1998, 3, 29), iso(1998, 5, 3), iso(1998, 5, 31)])
  })

  it('#14 FREQ=MONTHLY;COUNT=6;BYDAY=-2MO', () => {
    expect(expandToIso('FREQ=MONTHLY;COUNT=6;BYDAY=-2MO', [1997, 9, 22]))
      .toEqual([iso(1997, 9, 22), iso(1997, 10, 20), iso(1997, 11, 17), iso(1997, 12, 22), iso(1998, 1, 19), iso(1998, 2, 16)])
  })

  it('#15 FREQ=MONTHLY;BYMONTHDAY=-3', () => {
    const parsed = parseRrule('FREQ=MONTHLY;BYMONTHDAY=-3')
    const out = expandRrule(parsed, makeWall(1997, 9, 28, 9, 0), { tzid: 'UTC', windowEndMs: Date.UTC(1998, 1, 1, 0, 0, 0) })
    const got = out.map((i) => new Date(i.utcMs).toISOString()).slice(0, 5)
    expect(got).toEqual([iso(1997, 9, 28), iso(1997, 10, 29), iso(1997, 11, 28), iso(1997, 12, 29), iso(1998, 1, 29)])
  })

  it('#16 FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15', () => {
    const got = expandToIso('FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15', [1997, 9, 2])
    expect(got).toEqual([iso(1997, 9, 2), iso(1997, 9, 15), iso(1997, 10, 2), iso(1997, 10, 15), iso(1997, 11, 2),
      iso(1997, 11, 15), iso(1997, 12, 2), iso(1997, 12, 15), iso(1998, 1, 2), iso(1998, 1, 15)])
  })

  it('#18 FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15', () => {
    expect(expandToIso('FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15', [1997, 9, 10]))
      .toEqual([iso(1997, 9, 10), iso(1997, 9, 11), iso(1997, 9, 12), iso(1997, 9, 13), iso(1997, 9, 14), iso(1997, 9, 15),
        iso(1999, 3, 10), iso(1999, 3, 11), iso(1999, 3, 12), iso(1999, 3, 13)])
  })

  it('#20 FREQ=YEARLY;COUNT=10;BYMONTH=6,7', () => {
    expect(expandToIso('FREQ=YEARLY;COUNT=10;BYMONTH=6,7', [1997, 6, 10]))
      .toEqual([iso(1997, 6, 10), iso(1997, 7, 10), iso(1998, 6, 10), iso(1998, 7, 10), iso(1999, 6, 10),
        iso(1999, 7, 10), iso(2000, 6, 10), iso(2000, 7, 10), iso(2001, 6, 10), iso(2001, 7, 10)])
  })

  it('#21 FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3', () => {
    const got = expandToIso('FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3', [1997, 1, 1])
    expect(got).toEqual([iso(1997, 1, 1), iso(1997, 2, 1), iso(1997, 3, 1), iso(1999, 1, 1), iso(1999, 2, 1),
      iso(1999, 3, 1), iso(2001, 1, 1), iso(2001, 2, 1), iso(2001, 3, 1), iso(2003, 1, 1)])
  })

  it('#22 FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200', () => {
    const got = expandToIso('FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200', [1997, 1, 1])
    // day 100 of 1997 (365-day year) = Apr 10; day 200 = Jul 19
    expect(got.slice(0, 3)).toEqual([iso(1997, 1, 1), iso(1997, 4, 10), iso(1997, 7, 19)])
    expect(got).toHaveLength(10)
  })

  it('#24 FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO', () => {
    // Monday of ISO week 20 in 1997 = 1997-05-12 (RFC vector)
    const parsed = parseRrule('FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO')
    const out = expandRrule(parsed, makeWall(1997, 1, 1), { tzid: 'UTC', windowEndMs: Date.UTC(1998, 0, 1) })
    expect(out[0].wall).toMatchObject({ year: 1997, month: 5, day: 12 })
  })

  it('#25 FREQ=YEARLY;BYMONTH=3;BYDAY=TH (instances before DTSTART excluded)', () => {
    const got = expandToIso('FREQ=YEARLY;BYMONTH=3;BYDAY=TH', [1997, 3, 13])
    // Thursdays in March 1997 from DTSTART onward: 13, 20, 27
    expect(got.slice(0, 3)).toEqual([iso(1997, 3, 13), iso(1997, 3, 20), iso(1997, 3, 27)])
  })

  it('#26 FREQ=YEARLY;BYMONTH=3;BYDAY=-1TH: last Thursday of March', () => {
    const parsed = parseRrule('FREQ=YEARLY;BYMONTH=3;BYDAY=-1TH')
    const out = expandRrule(parsed, makeWall(1997, 3, 27, 9, 0), { tzid: 'UTC', windowEndMs: Date.UTC(2002, 0, 1) })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    expect(got).toEqual([iso(1997, 3, 27), iso(1998, 3, 26), iso(1999, 3, 25), iso(2000, 3, 30), iso(2001, 3, 29)])
  })

  it('#27 FREQ=DAILY;BYHOUR=12..14;BYMINUTE=0,20,40 (grid)', () => {
    const parsed = parseRrule('FREQ=DAILY;BYHOUR=12,13,14;BYMINUTE=0,20,40')
    const out = expandRrule(parsed, makeWall(1997, 9, 2, 9, 0), { tzid: 'UTC', windowEndMs: Date.UTC(1997, 8, 3, 0, 0, 0) })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    expect(got).toEqual([
      iso(1997, 9, 2, 12, 0), iso(1997, 9, 2, 12, 20), iso(1997, 9, 2, 12, 40),
      iso(1997, 9, 2, 13, 0), iso(1997, 9, 2, 13, 20), iso(1997, 9, 2, 13, 40),
      iso(1997, 9, 2, 14, 0), iso(1997, 9, 2, 14, 20), iso(1997, 9, 2, 14, 40),
    ])
    expect(got).toHaveLength(9)
  })

  it('#30 FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2', () => {
    const parsed = parseRrule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2')
    const out = expandRrule(parsed, makeWall(1997, 9, 29, 9, 0), { tzid: 'UTC', windowEndMs: Date.UTC(1997, 10, 5, 0, 0, 0) })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    // second-to-last weekday of September 1997 = Sep 29 (Mon); of Oct = Oct 30
    expect(got).toEqual([iso(1997, 9, 29), iso(1997, 10, 30)])
  })
})

describe('UNTIL limits', () => {
  it('stops at UNTIL (UTC)', () => {
    const got = expandToIso('FREQ=DAILY;UNTIL=19971215T120000Z', [1997, 12, 1])
    expect(got).toHaveLength(15) // Dec 1 .. Dec 15 inclusive
    expect(got[got.length - 1]).toBe(iso(1997, 12, 15))
  })

  it('stops at UNTIL (local, resolved in DTSTART timezone)', () => {
    const got = expandToIso('FREQ=DAILY;UNTIL=19971215T080000', [1997, 12, 1], { tzid: 'Asia/Shanghai' })
    // DTSTART 09:00 +08 = 01:00Z; until local Dec15 08:00 = Dec15 00:00Z.
    // Last instance Dec 15 with utc <= Dec 15 00:00 <= .. -> Dec 14 01:00Z qualifies, Dec 15 01:00Z doesn't.
    expect(got[got.length - 1]).toBe('1997-12-14T01:00:00.000Z')
  })
})

describe('DST handling', () => {
  it('weekly meeting across the 2024 US spring-forward keeps wall time, shifts UTC', () => {
    // Wednesdays 09:00 America/Los_Angeles starting 2024-02-28 (before DST)
    const start = makeWall(2024, 2, 28, 9, 0, 0)
    const parsed = parseRrule('FREQ=WEEKLY;COUNT=5')
    const out = expandRrule(parsed, start, { tzid: 'America/Los_Angeles' })
    expect(out).toHaveLength(5)
    // Feb 28 & Mar 6 are in PST (UTC-8) -> 17:00Z; Mar 13, 20, 27 in PDT -> 16:00Z
    expect(out[0].wall).toMatchObject({ month: 2, day: 28, hour: 9 })
    expect(out[0].utcMs).toBe(Date.UTC(2024, 1, 28, 17, 0))
    expect(out[2].wall).toMatchObject({ month: 3, day: 13, hour: 9 })
    expect(out[2].utcMs).toBe(Date.UTC(2024, 2, 13, 16, 0))
  })

  it('daily series spans both offsets with correct instants', () => {
    const start = makeWall(2024, 3, 9, 12, 0, 0)
    const parsed = parseRrule('FREQ=DAILY;COUNT=3')
    const out = expandRrule(parsed, start, { tzid: 'America/Los_Angeles' })
    expect(out[0].utcMs).toBe(Date.UTC(2024, 2, 9, 20, 0)) // PST
    expect(out[1].utcMs).toBe(Date.UTC(2024, 2, 10, 19, 0)) // PDT (wall 12:00)
    expect(out[2].utcMs).toBe(Date.UTC(2024, 2, 11, 19, 0))
  })
})

describe('edge cases', () => {
  it('COUNT of 1 yields only DTSTART', () => {
    expect(expandToIso('FREQ=DAILY;COUNT=1', [1997, 9, 2])).toEqual([iso(1997, 9, 2)])
  })

  it('Feb-29 yearly rule skips non-leap years', () => {
    const got = expandToIso('FREQ=YEARLY;COUNT=3', [2024, 2, 29])
    expect(got).toEqual([iso(2024, 2, 29), iso(2028, 2, 29), iso(2032, 2, 29)])
  })

  it('monthly day-31 skips months without a 31st', () => {
    const got = expandToIso('FREQ=MONTHLY;COUNT=5', [2024, 1, 31])
    expect(got).toEqual([iso(2024, 1, 31), iso(2024, 3, 31), iso(2024, 5, 31), iso(2024, 7, 31), iso(2024, 8, 31)])
  })

  it('windowStart/windowEnd filters results', () => {
    const parsed = parseRrule('FREQ=DAILY;COUNT=400')
    const out = expandRrule(parsed, makeWall(2024, 1, 1), {
      tzid: 'UTC',
      windowStartMs: Date.UTC(2024, 1, 15, 0, 0, 0),
      windowEndMs: Date.UTC(2024, 1, 20, 0, 0, 0),
    })
    const days = out.map((i) => new Date(i.utcMs).getUTCDate())
    expect(days).toEqual([15, 16, 17, 18, 19])
  })
})

describe('sub-daily frequencies (regression)', () => {
  it('HOURLY;INTERVAL=3 advances the hour', () => {
    const parsed = parseRrule('FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000Z')
    const out = expandRrule(parsed, makeWall(1997, 9, 2, 9, 0), { tzid: 'UTC' })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    expect(got).toContain(iso(1997, 9, 2, 9, 0))
    expect(got).toContain(iso(1997, 9, 2, 12, 0))
    expect(got).toContain(iso(1997, 9, 2, 15, 0))
    expect(got).toHaveLength(3)
  })

  it('MINUTELY;INTERVAL=15;COUNT=6 advances the minute', () => {
    const parsed = parseRrule('FREQ=MINUTELY;INTERVAL=15;COUNT=6')
    const out = expandRrule(parsed, makeWall(1997, 9, 2, 9, 0), { tzid: 'UTC' })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    expect(got).toEqual([
      iso(1997, 9, 2, 9, 0), iso(1997, 9, 2, 9, 15), iso(1997, 9, 2, 9, 30),
      iso(1997, 9, 2, 9, 45), iso(1997, 9, 2, 10, 0), iso(1997, 9, 2, 10, 15),
    ])
  })

  it('MINUTELY;INTERVAL=90;COUNT=4', () => {
    const parsed = parseRrule('FREQ=MINUTELY;INTERVAL=90;COUNT=4')
    const out = expandRrule(parsed, makeWall(1997, 9, 2, 9, 0), { tzid: 'UTC' })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    expect(got).toEqual([iso(1997, 9, 2, 9, 0), iso(1997, 9, 2, 10, 30), iso(1997, 9, 2, 12, 0), iso(1997, 9, 2, 13, 30)])
  })

  it('SECONDLY;COUNT=6;BYSECOND=5,15 limits seconds', () => {
    const parsed = parseRrule('FREQ=SECONDLY;COUNT=6;BYSECOND=5,15')
    const out = expandRrule(parsed, makeWall(1997, 9, 2, 9, 0, 0), { tzid: 'UTC' })
    const got = out.map((i) => new Date(i.utcMs).toISOString())
    expect(got.length).toBe(6)
    expect(got.every((s) => s.slice(17, 19) === '05' || s.slice(17, 19) === '15')).toBe(true)
    expect(got[0]).toBe(iso(1997, 9, 2, 9, 0, 5))
  })
})

describe('DAILY + BYDAY limit (regression)', () => {
  it('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR skips weekends', () => {
    const parsed = parseRrule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=8')
    const out = expandRrule(parsed, makeWall(2024, 10, 7, 9, 0), { tzid: 'UTC' }) // Monday
    const got = out.map((i) => new Date(i.utcMs).toISOString().slice(0, 10))
    expect(got).toEqual(['2024-10-07', '2024-10-08', '2024-10-09', '2024-10-10', '2024-10-11',
      '2024-10-14', '2024-10-15', '2024-10-16'])
  })
})

describe('UNTIL in DATE form (regression)', () => {
  it('DATE-valued UNTIL parses and limits inclusively', () => {
    const parsed = parseRrule('FREQ=DAILY;UNTIL=20240305')
    const out = expandRrule(parsed, makeWall(2024, 3, 1, 9, 0), { tzid: 'UTC' })
    const got = out.map((i) => new Date(i.utcMs).toISOString().slice(0, 10))
    // Dec-25: last instance is on the UNTIL day itself (09:00 <= end of day)
    expect(got).toEqual(['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04', '2024-03-05'])
  })
})

describe('COUNT semantics with a query window (regression)', () => {
  it('returns only the in-window subset of a COUNT-bound rule', () => {
    // Rule has 5 daily occurrences from Jan 1; a query starting Jan 3 must
    // return Jan 3..5, NOT Jan 3..7 (phantom occurrences past the rule end).
    const parsed = parseRrule('FREQ=DAILY;COUNT=5')
    const out = expandRrule(parsed, makeWall(2024, 1, 1, 9, 0), {
      tzid: 'UTC',
      windowStartMs: Date.UTC(2024, 0, 3, 0, 0, 0),
      windowEndMs: Date.UTC(2024, 0, 15, 0, 0, 0),
    })
    const got = out.map((i) => new Date(i.utcMs).toISOString().slice(0, 10))
    expect(got).toEqual(['2024-01-03', '2024-01-04', '2024-01-05'])
  })
})

describe('sub-daily limiting by coarser BY* parts (regression)', () => {
  it('MINUTELY;BYHOUR=13 limits the hour', () => {
    const parsed = parseRrule('FREQ=MINUTELY;BYHOUR=13;COUNT=3')
    const out = expandRrule(parsed, makeWall(2024, 1, 1, 0, 0), { tzid: 'UTC' })
    expect(out.map((i) => new Date(i.utcMs).toISOString().slice(11, 16))).toEqual(['13:00', '13:01', '13:02'])
  })

  it('SECONDLY;BYMINUTE=30;BYSECOND=0 limits minute and second', () => {
    const parsed = parseRrule('FREQ=SECONDLY;BYMINUTE=30;BYSECOND=0;COUNT=3')
    const out = expandRrule(parsed, makeWall(2024, 1, 1, 0, 0, 0), { tzid: 'UTC' })
    expect(out.map((i) => new Date(i.utcMs).toISOString().slice(11, 19))).toEqual(['00:30:00', '01:30:00', '02:30:00'])
  })
})

describe('sparse sub-daily rules terminate gracefully (regression)', () => {
  it('unbounded FREQ=MINUTELY;BYMINUTE=30 returns results without throwing', () => {
    const parsed = parseRrule('FREQ=MINUTELY;BYMINUTE=30')
    const out = expandRrule(parsed, makeWall(2024, 1, 1, 0, 0), { tzid: 'UTC' })
    expect(out.length).toBeGreaterThan(2)
    expect(out.length).toBeLessThanOrEqual(5000)
    // all minutes are 30
    for (const i of out.slice(0, 5)) expect(new Date(i.utcMs).getUTCMinutes()).toBe(30)
  })
})

describe('sub-daily rules across a DST spring-forward gap (regression)', () => {
  it('phantom 02:00-02:59 wall times are ignored, not double-counted', () => {
    // LA DST starts 2024-03-10 at 02:00; MINUTELY through the gap must yield
    // exactly as many distinct instants as COUNT (RFC 5545: nonexistent local
    // times must be ignored and NOT counted).
    const parsed = parseRrule('FREQ=MINUTELY;COUNT=130')
    const out = expandRrule(parsed, makeWall(2024, 3, 10, 1, 55), { tzid: 'America/Los_Angeles' })
    expect(out).toHaveLength(130)
    const distinct = new Set(out.map((i) => i.utcMs))
    expect(distinct.size).toBe(130)
    // no phantom wall (02:00 .. 02:59) is present
    expect(out.some((i) => i.wall.hour === 2)).toBe(false)
    // every returned wall round-trips to its own instant
    for (const i of out.slice(0, 5)) {
      expect(utcToWall(i.utcMs, 'America/Los_Angeles').wall).toMatchObject(i.wall)
    }
  })
})

describe('duration weeks-isolation (regression)', () => {
  it('rejects mixing weeks with other units', () => {
    expect(() => parseIsoDuration('P1WT1H')).toThrow()
    expect(() => parseIsoDuration('P1W')).not.toThrow()
    expect(() => parseIsoDuration('P1DT1H')).not.toThrow()
  })
})

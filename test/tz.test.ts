import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayOfWeek,
  formatWall,
  getZone,
  hasZone,
  isLeapYear,
  listZones,
  makeWall,
  nthWeekdayOfMonth,
  offsetAt,
  parseWall,
  serialToWall,
  toWall,
  wallEquals,
  wallToSerial,
  wallToUTC,
  wallToUTCms,
} from '../src/core/tz.js'

const JUL2000 = Date.UTC(2000, 6, 1, 0, 0, 0)

describe('civil date helpers', () => {
  it('detects leap years', () => {
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2025)).toBe(false)
  })

  it('round-trips wall <-> serial', () => {
    const w = makeWall(2024, 2, 29, 13, 45, 30)
    expect(serialToWall(wallToSerial(w))).toMatchObject(w)
  })

  it('addDays crosses boundaries', () => {
    const w = addDays(makeWall(2020, 2, 28), 2)
    expect(w).toMatchObject({ year: 2020, month: 3, day: 1 })
  })

  it('computes weekday and nth weekday', () => {
    // 2024-03-10 was a Sunday
    expect(dayOfWeek(makeWall(2024, 3, 10))).toBe(0)
    // 2nd Sunday of March 2024 = 10
    expect(nthWeekdayOfMonth(2024, 3, 0, 2)).toBe(10)
    // last Sunday of March 2024 = 31
    expect(nthWeekdayOfMonth(2024, 3, 0, -1)).toBe(31)
    // 5th Friday of Feb 2024 does not exist
    expect(nthWeekdayOfMonth(2024, 2, 5, 5)).toBe(0)
  })

  it('parses and formats walls', () => {
    expect(parseWall('2024-03-10')).toMatchObject(makeWall(2024, 3, 10))
    expect(parseWall('2024-03-10 02:30')).toMatchObject(makeWall(2024, 3, 10, 2, 30))
    expect(parseWall('2024-03-10T14:05:06')).toMatchObject(makeWall(2024, 3, 10, 14, 5, 6))
    expect(formatWall(makeWall(2024, 3, 10, 14, 5))).toBe('2024-03-10 14:05')
    expect(formatWall(makeWall(2024, 3, 10))).toBe('2024-03-10')
  })
})

describe('zones with no DST', () => {
  it('Asia/Shanghai is fixed at UTC+8', () => {
    expect(getZone('Asia/Shanghai').stdOffset).toBe(480)
    expect(wallToUTC(makeWall(2024, 3, 10, 12, 0), 'Asia/Shanghai').utcMs)
      .toBe(Date.UTC(2024, 2, 10, 4, 0))
  })

  it('resolves aliases', () => {
    expect(hasZone('PRC')).toBe(true)
    expect(hasZone('Asia/Beijing')).toBe(true)
    expect(wallToUTCms(makeWall(2024, 1, 1, 0, 0), 'PRC')).toBe(Date.UTC(2023, 11, 31, 16, 0))
  })

  it('Tokyo and Seoul are UTC+9', () => {
    expect(wallToUTCms(makeWall(2024, 6, 1, 12, 0), 'Asia/Tokyo')).toBe(Date.UTC(2024, 5, 1, 3, 0))
    expect(wallToUTCms(makeWall(2024, 6, 1, 12, 0), 'Asia/Seoul')).toBe(Date.UTC(2024, 5, 1, 3, 0))
  })

  it('exposes a zone listing', () => {
    expect(listZones()).toContain('Asia/Shanghai')
    expect(listZones()).toContain('America/Los_Angeles')
  })
})

describe('US DST transitions', () => {
  const LA = 'America/Los_Angeles'

  it('2024 spring forward: 2nd Sunday in March at 02:00 PST = 10:00Z', () => {
    expect(offsetAt(Date.UTC(2024, 2, 10, 9, 59, 59), getZone(LA))).toBe(-480)
    expect(offsetAt(Date.UTC(2024, 2, 10, 10, 0, 0), getZone(LA))).toBe(-420)
  })

  it('2024 fall back: 1st Sunday in November at 02:00 PDT = 09:00Z', () => {
    expect(offsetAt(Date.UTC(2024, 10, 3, 8, 59, 59), getZone(LA))).toBe(-420)
    expect(offsetAt(Date.UTC(2024, 10, 3, 9, 0, 0), getZone(LA))).toBe(-480)
  })

  it('converts normal wall times in both halves of the year', () => {
    // January: PST (-8)
    expect(wallToUTCms(makeWall(2024, 1, 15, 12, 0, 0), LA)).toBe(Date.UTC(2024, 0, 15, 20, 0))
    // July: PDT (-7)
    expect(wallToUTCms(makeWall(2024, 7, 15, 12, 0, 0), LA)).toBe(Date.UTC(2024, 6, 15, 19, 0))
  })

  it('gap: 2024-03-10 02:30 does not exist; pushed forward to 03:30 local', () => {
    const r = wallToUTC(makeWall(2024, 3, 10, 2, 30, 0), LA)
    expect(r.utcMs).toBe(Date.UTC(2024, 2, 10, 10, 30))
    expect(toWall(r.utcMs, LA).wall).toMatchObject({ year: 2024, month: 3, day: 10, hour: 3, minute: 30 })
  })

  it('fold: 2024-11-03 01:30 occurs twice; picks the first (PDT) occurrence', () => {
    const r = wallToUTC(makeWall(2024, 11, 3, 1, 30, 0), LA)
    expect(r.utcMs).toBe(Date.UTC(2024, 10, 3, 8, 30))
    expect(r.offsetMin).toBe(-420)
  })

  it('utcToWall applies the correct DST offset', () => {
    const w = toWall(Date.UTC(2024, 2, 10, 17, 0), LA)
    expect(w.wall).toMatchObject({ year: 2024, month: 3, day: 10, hour: 10, minute: 0 })
    expect(w.offsetMin).toBe(-420)
  })
})

describe('European DST', () => {
  it('London last Sunday March 01:00 GMT -> BST', () => {
    // 2024-03-31 01:00 GMT = 01:00Z; before that GMT, after BST
    expect(offsetAt(Date.UTC(2024, 2, 31, 0, 59, 59), getZone('Europe/London'))).toBe(0)
    expect(offsetAt(Date.UTC(2024, 2, 31, 1, 0, 0), getZone('Europe/London'))).toBe(60)
    expect(wallToUTCms(makeWall(2024, 7, 1, 12, 0), 'Europe/London')).toBe(Date.UTC(2024, 6, 1, 11, 0))
    expect(wallToUTCms(makeWall(2024, 1, 1, 12, 0), 'Europe/London')).toBe(Date.UTC(2024, 0, 1, 12, 0))
  })

  it('Paris is UTC+1, +2 in summer', () => {
    expect(wallToUTCms(makeWall(2024, 7, 1, 12, 0), 'Europe/Paris')).toBe(Date.UTC(2024, 6, 1, 10, 0))
    expect(wallToUTCms(makeWall(2024, 1, 1, 12, 0), 'Europe/Paris')).toBe(Date.UTC(2024, 0, 1, 11, 0))
  })
})

describe('Southern-hemisphere DST (Sydney)', () => {
  it('first Sunday in October 02:00 AEST -> AEDT (2023 season)', () => {
    // 02:00 AEST on Oct 1 2023 equals 16:00Z on Sep 30 2023.
    expect(offsetAt(Date.UTC(2023, 8, 30, 15, 59, 59), getZone('Australia/Sydney'))).toBe(600)
    expect(offsetAt(Date.UTC(2023, 8, 30, 16, 0, 0), getZone('Australia/Sydney'))).toBe(660)
  })

  it('January is summer (UTC+11), July winter (UTC+10)', () => {
    expect(wallToUTCms(makeWall(2024, 2, 1, 12, 0), 'Australia/Sydney')).toBe(Date.UTC(2024, 1, 1, 1, 0))
    expect(wallToUTCms(makeWall(2024, 7, 1, 12, 0), 'Australia/Sydney')).toBe(Date.UTC(2024, 6, 1, 2, 0))
  })

  it('handles New Year across the seasonal boundary', () => {
    // 2023-12-31 12:00 AEDT = 01:00Z Dec 31
    expect(wallToUTCms(makeWall(2023, 12, 31, 12, 0), 'Australia/Sydney')).toBe(Date.UTC(2023, 11, 31, 1, 0))
  })
})

describe('misc conversions', () => {
  it('UTC is independent of jitter', () => {
    expect(wallToUTCms(makeWall(2020, 3, 8, 1, 59, 59), 'UTC')).toBe(Date.UTC(2020, 2, 8, 1, 59, 59))
  })

  it('Auckland DST start: last Sunday in September', () => {
    // 2024-12-01 12:00 NZDT (+13) = 2024-11-30 23:00Z; June is NZST (+12)
    expect(wallToUTCms(makeWall(2024, 12, 1, 12, 0), 'Pacific/Auckland')).toBe(Date.UTC(2024, 10, 30, 23, 0))
    expect(wallToUTCms(makeWall(2024, 6, 1, 12, 0), 'Pacific/Auckland')).toBe(Date.UTC(2024, 5, 1, 0, 0))
  })

  it('throws on unknown zones', () => {
    expect(() => getZone('Mars/Olympus')).toThrow()
    expect(() => wallToUTCms(makeWall(2024, 1, 1), 'Nope/Nowhere')).toThrow()
  })

  it('wallEquals works', () => {
    expect(wallEquals(makeWall(2024, 1, 1), makeWall(2024, 1, 1))).toBe(true)
    expect(wallEquals(makeWall(2024, 1, 1), makeWall(2024, 1, 2))).toBe(false)
  })

  
  it('gap resolution reports the offset in effect at the returned instant', () => {
    const r = wallToUTC(makeWall(2024, 3, 10, 2, 30, 0), 'America/Los_Angeles')
    // resolved to 10:30Z, which is in PDT (-420)
    expect(r.utcMs).toBe(Date.UTC(2024, 2, 10, 10, 30))
    expect(r.offsetMin).toBe(-420)
    expect(toWall(r.utcMs, 'America/Los_Angeles').offsetMin).toBe(-420)
  })
  it('epoch sanity', () => {
    expect(wallToUTCms(makeWall(1999, 12, 31, 16, 0, 0), 'Asia/Shanghai')).toBe(Date.UTC(1999, 11, 31, 8, 0))
    expect(JUL2000).toBeGreaterThan(0)
  })
})


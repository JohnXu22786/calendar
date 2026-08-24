import { describe, expect, it } from 'vitest'
import {
  ganzhiZodiac,
  holidaysOnDate,
  isLeapLunarYear,
  lunarNewYear,
  lunarToSolar,
  solarToLunar,
  upcomingHolidays,
} from '../src/core/lunar.js'
type DateYmd = { year: number; month: number; day: number }
const ymd = (s: string): DateYmd => {
  const [year, month, day] = s.split('-').map(Number)
  return { year, month, day }
}

describe('lunar new year (春节) dates 2000-2100', () => {
  const known: Array<[number, string]> = [
    [2000, '2000-02-05'], [2001, '2001-01-24'], [2004, '2004-01-22'], [2007, '2007-02-18'],
    [2008, '2008-02-07'], [2010, '2010-02-14'], [2012, '2012-01-23'], [2014, '2014-01-31'],
    [2015, '2015-02-19'], [2016, '2016-02-08'], [2018, '2018-02-16'], [2020, '2020-01-25'],
    [2021, '2021-02-12'], [2022, '2022-02-01'], [2023, '2023-01-22'], [2024, '2024-02-10'],
    [2025, '2025-01-29'], [2026, '2026-02-17'], [2027, '2027-02-06'], [2028, '2028-01-26'],
    [2029, '2029-02-13'], [2030, '2030-02-03'], [2033, '2033-01-31'], [2034, '2034-02-19'],
    [2040, '2040-02-12'], [2050, '2050-01-23'], [2052, '2052-02-01'], [2053, '2053-02-19'],
    [2074, '2074-01-27'], [2080, '2080-01-22'], [2090, '2090-01-30'], [2091, '2091-02-18'],
    [2094, '2094-02-15'], [2100, '2100-02-09'],
  ]
  for (const [year, date] of known) {
    it(`春节 ${year} = ${date}`, () => {
      const d = lunarNewYear(year)
      expect(`${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`).toBe(date)
    })
  }
})

describe('leap months (闰月) 2000-2035', () => {
  const leapMonths: Array<[number, number]> = [
    [2001, 4], [2004, 2], [2006, 7], [2009, 5], [2012, 4], [2014, 9], [2017, 6],
    [2020, 4], [2023, 2], [2025, 6], [2028, 5], [2031, 3], [2033, 11],
  ]
  for (const [year, month] of leapMonths) {
    it(`year ${year} has leap month ${month}`, () => {
      expect(isLeapLunarYear(year)).toBe(true)
      const leap = findLeapInYear(year)
      expect(leap).toBe(month)
    })
  }
  it('2024 has no leap month', () => {
    expect(isLeapLunarYear(2024)).toBe(false)
  })
  it('2033 (4033 问题) is 闰十一月, so 中秋 is 2033-09-08', () => {
    // Official modern calendar: 2033 闰十一月 (not 闰七月)
    expect(solarToLunar(2033, 12, 22)).toMatchObject({ year: 2033, month: 11, day: 1, leap: true })
    expect(solarToLunar(2033, 9, 8)).toMatchObject({ year: 2033, month: 8, day: 15, leap: false })
    expect(holidaysOnDate(2033, 9, 8).map((h) => h.key)).toContain('mid-autumn')
  })
})

describe('solar <-> lunar round-trip sweep (2000-2100)', () => {
  it('every solarToLunar converts back exactly', () => {
    for (let y = 2000; y <= 2100; y++) {
      for (let mo = 1; mo <= 12; mo++) {
        const src = solarToLunar(y, mo, 15)
        if (!src) continue
        const back = lunarToSolar(src.year, src.month, src.day, src.leap)
        expect(back).not.toBeNull()
        expect(back!.year).toBe(y)
        expect(back!.month).toBe(mo)
        expect(back!.day).toBe(15)
      }
    }
  })
})

function findLeapInYear(year: number): number | null {
  // For lunar year `year`, the leap month M is the month for which
  // lunarToSolar(year, M, 10, leap=true) yields a valid date.
  for (let month = 1; month <= 12; month++) {
    const d = lunarToSolar(year, month, 10, true)
    if (d && d.year === year) return month
  }
  return null
}

describe('solar <-> lunar conversion', () => {
  const cases: Array<[string, number, number, number, boolean]> = [
    // [gregorian date, lunar year, lunar month, lunar day, isLeap]
    ['2024-02-10', 2024, 1, 1, false], // 春节
    ['2024-02-09', 2023, 12, 30, false], // 除夕 2024
    ['2024-06-10', 2024, 5, 5, false], // 端午
    ['2024-09-17', 2024, 8, 15, false], // 中秋
    ['2024-12-01', 2024, 11, 1, false],
    ['2023-03-22', 2023, 2, 1, true], // 2023 闰二月初一
    ['2025-07-25', 2025, 6, 1, true], // 2025 闰六月初一
    ['2000-02-05', 2000, 1, 1, false],
    ['2100-02-09', 2100, 1, 1, false],
  ]
  for (const [greg, y, mo, d, leap] of cases) {
    it(`solarToLunar ${greg}`, () => {
      const g = ymd(greg)
      const lunar = solarToLunar(g.year, g.month, g.day)
      expect(lunar).toBeTruthy()
      expect(lunar!.year).toBe(y)
      expect(lunar!.month).toBe(mo)
      expect(lunar!.day).toBe(d)
      expect(lunar!.leap).toBe(leap)
      // round-trip
      const back = lunarToSolar(y, mo, d, leap)
      expect(back && back.year === g.year && back.month === g.month && back.day === g.day).toBe(true)
    })
  }

  it('returns null for invalid lunar dates', () => {
    // a lunar month never has 31 days; month numbers are 1..12
    expect(lunarToSolar(2024, 2, 31)).toBeNull()
    expect(lunarToSolar(2024, 13, 1)).toBeNull()
    expect(lunarToSolar(2099, 2, 31)).toBeNull()
  })
})

describe('holidays', () => {
  it('detects Spring Festival, Qingming, Dragon Boat, Mid-Autumn', () => {
    expect(holidaysOnDate(2024, 2, 10).map((h) => h.key)).toContain('spring-festival')
    expect(holidaysOnDate(2024, 4, 4).map((h) => h.key)).toContain('qingming')
    expect(holidaysOnDate(2024, 6, 10).map((h) => h.key)).toContain('dragon-boat')
    expect(holidaysOnDate(2024, 9, 17).map((h) => h.key)).toContain('mid-autumn')
  })

  it('detects fixed holidays (元旦/劳动节/国庆节) and 除夕', () => {
    expect(holidaysOnDate(2024, 1, 1).map((h) => h.key)).toContain('new-year')
    expect(holidaysOnDate(2024, 5, 1).map((h) => h.key)).toContain('labor-day')
    expect(holidaysOnDate(2024, 10, 1).map((h) => h.key)).toContain('national-day')
    expect(holidaysOnDate(2024, 2, 9).map((h) => h.key)).toContain('spring-eve')
  })

  it('returns a stable descriptor set', () => {
    const hs = holidaysOnDate(2024, 2, 10)
    expect(hs[0]).toHaveProperty('name')
    expect(hs[0]).toHaveProperty('date')
    expect(hs[0].date).toEqual({ year: 2024, month: 2, day: 10 })
  })

  it('upcomingHolidays walks forward across years', () => {
    // 2026-02-01 → next holidays: 除夕 (2026-02-16), 春节 (2026-02-17)...
    const list = upcomingHolidays({ year: 2026, month: 2, day: 1 }, 20)
    expect(list.some((h) => h.key === 'spring-festival' && h.date.day === 17 && h.date.month === 2)).toBe(true)
  })

  it('qingming moves within Apr 4-6', () => {
    for (const y of [2021, 2022, 2023, 2024, 2025, 2026, 2030]) {
      const hs = upcomingHolidays({ year: y, month: 3, day: 1 }, 60).filter((h) => h.key === 'qingming')
      expect(hs).toHaveLength(1)
      expect(hs[0].date.month).toBe(4)
      expect([4, 5, 6]).toContain(hs[0].date.day)
    }
  })
})

describe('ganzhi / zodiac (干支/生肖)', () => {
  it('flips at 立春', () => {
    // 2024 立春 ~ Feb 4 -> before it: 癸卯兔 (2023), on/after: 甲辰龙 (2024)
    expect(ganzhiZodiac(2024, 2, 1)).toMatchObject({ gan: '癸', zhi: '卯', zodiac: '兔', ganzhi: '癸卯' })
    expect(ganzhiZodiac(2024, 2, 5)).toMatchObject({ gan: '甲', zhi: '辰', zodiac: '龙', ganzhi: '甲辰' })
    expect(ganzhiZodiac(2025, 2, 3)).toMatchObject({ zhi: '巳', zodiac: '蛇', ganzhi: '乙巳' })
  })
})

/**
 * Chinese lunar calendar (农历) conversion for the 2000-2100 era, implemented
 * from astronomical principles (Meeus, "Astronomical Algorithms": truncated
 * new-moon series + solar-longitude series) instead of a hard-coded table, so
 * the whole 2000-2100 range is covered by construction.
 *
 * Control date is Chinese Standard Time (UTC+8), the official legal time for
 * the Chinese calendar throughout this era.
 *
 * Also provides the traditional festivals relevant to Chinese scheduling
 * (Spring Festival, Qingming, Dragon Boat, Mid-Autumn, ...) plus the
 * 干支/生肖 (sexagenary cycle + zodiac) conversion anchored at 立春.
 */

import { daysInMonth, serialToWall } from './tz.js'

/* ------------------------------------------------------------------ */
/* Astronomy: Julian dates, new moons, solar longitude                  */
/* ------------------------------------------------------------------ */

/** Julian day (UT) from unix milliseconds. 2440587.5 = JD of 1970-01-01 00:00 UT. */
function jdFromMs(ms: number): number {
  return ms / 86400000 + 2440587.5
}

/** ΔT (TT - UT) in seconds; quadratic fit, adequate for day-level use 2000-2100. */
function deltaTSeconds(year: number): number {
  const t = year - 2000
  return 62.92 + 0.32217 * t + 0.005589 * t * t
}

/** Moment as a "TT" Julian day. */
function jdTT(ms: number): number {
  return jdFromMs(ms) + deltaTSeconds(new Date(ms).getUTCFullYear()) / 86400
}

/** Meeus ch.49 truncated new-moon series; returns JD (TT). */
function newMoonJd(k: number): number {
  const T = k / 1236.85
  const T2 = T * T
  const T3 = T2 * T
  const T4 = T3 * T
  const rad = Math.PI / 180
  const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4
  const E = 1 - 0.002516 * T - 0.0000074 * T2
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3) * rad
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4) * rad
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4) * rad
  const Om = (124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3) * rad
  const corr =
    -0.4072 * Math.sin(Mp) + 0.17241 * E * Math.sin(M) + 0.01608 * Math.sin(2 * Mp) +
    0.01039 * Math.sin(2 * F) + 0.00739 * E * Math.sin(Mp - M) - 0.00514 * E * Math.sin(Mp + M) +
    0.00208 * E * E * Math.sin(2 * M) - 0.00111 * Math.sin(Mp - 2 * F) - 0.00057 * Math.sin(Mp + 2 * F) +
    0.00056 * E * Math.sin(2 * Mp + M) - 0.00042 * Math.sin(3 * Mp) + 0.00042 * E * Math.sin(M + 2 * F) +
    0.00038 * E * Math.sin(M - 2 * F) - 0.00024 * E * Math.sin(2 * Mp - M) - 0.00017 * Math.sin(Om) -
    0.00007 * Math.sin(Mp + 2 * M) + 0.00004 * Math.sin(2 * Mp - 2 * F) + 0.00004 * Math.sin(3 * M) +
    0.00003 * Math.sin(Mp + M - 2 * F) + 0.00003 * Math.sin(2 * Mp + 2 * F) - 0.00003 * Math.sin(Mp + M + 2 * F) +
    0.00003 * Math.sin(Mp - M + 2 * F) - 0.00002 * Math.sin(Mp - M - 2 * F) - 0.00002 * Math.sin(3 * Mp + M) +
    0.00002 * Math.sin(4 * Mp)
  return jde + corr
}

/** Apparent solar longitude (degrees, 0..360) at a UTC instant. */
function solarLongitude(utcMs: number): number {
  const T = (jdTT(utcMs) - 2451545.0) / 36525
  const T2 = T * T
  const rad = Math.PI / 180
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T2
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T2
  const C = (1.914602 - 0.004817 * T - 0.000014 * T2) * Math.sin(M * rad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M * rad) +
    0.000289 * Math.sin(3 * M * rad)
  const trueLong = L0 + C
  const omega = 125.04 - 1934.136 * T
  const app = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad)
  return ((app % 360) + 360) % 360
}

/** Newton solve for the UTC instant where solar longitude crosses theta near a guess. */
function solveSolarLongitude(theta: number, guessMs: number): number {
  const delta = (ms: number) => ((solarLongitude(ms) - theta + 540) % 360) - 180
  let t = guessMs
  for (let i = 0; i < 14; i++) {
    const f = delta(t)
    if (Math.abs(f) < 1e-6) break
    const h = 3600000
    const deriv = (delta(t + h) - delta(t - h)) / (2 * h)
    if (Math.abs(deriv) < 1e-14) break
    t -= f / deriv
  }
  return t
}

/** Approximate day-of-year (1..366) of a solar term crossing within a Gregorian year. */
function approxDoy(theta: number): number {
  // 0° ≈ 春分 ≈ Mar 20 (doy ~79); longitudes ≥ 283° occur in Jan-Feb,
  // longitudes < 283° occur Mar-Dec.
  return theta >= 283
    ? 79.7 + ((theta - 360) * 365.25) / 360
    : 79.7 + (theta * 365.25) / 360
}

/* ------------------------------------------------------------------ */
/* Control-date day numbers (Chinese Standard Time, UTC+8)             */
/* ------------------------------------------------------------------ */

const DAY = 86400000
const TZ8 = 8 * 3600000

/** CST day number containing the given UTC instant; day n runs [n*DAY - 8h, (n+1)*DAY - 8h). */
function cstDayOfMs(utcMs: number): number {
  return Math.floor((utcMs + TZ8) / DAY)
}

/** The UTC instant at 00:00 +08 of CST day n. */
function msOfCstDay(n: number): number {
  return n * DAY - TZ8
}

/** CST day number of a Gregorian civil date. */
function cstDayOfYmd(year: number, month: number, day: number): number {
  return cstDayOfMs(Date.UTC(year, month - 1, day, 0, 0, 0))
}

/** Gregorian civil date (in CST) for a CST day number. */
function ymdOfCstDay(n: number): { year: number; month: number; day: number } {
  const d = serialToWall(n * DAY)
  return { year: d.year, month: d.month, day: d.day }
}

/* ------------------------------------------------------------------ */
/* Lunar months and years                                              */
/* ------------------------------------------------------------------ */

const SYNODIC = 29.530588853

/** k of the last new moon at or before a UTC instant. */
function newMoonKAtOrBefore(ms: number): number {
  const target = jdTT(ms)
  let k = Math.floor((target - 2451550.09766) / SYNODIC)
  while (newMoonJd(k) > target) k--
  while (newMoonJd(k + 1) <= target) k++
  return k
}

/** UTC instant (ms) of new moon k. */
function newMoonMs(k: number): number {
  const jdUt = newMoonJd(k) - deltaTSeconds(2000 + Math.floor(k / 12.37)) / 86400
  return (jdUt - 2440587.5) * DAY
}

/** CST day of the new moon at or before a UTC instant. */
function newMoonDayAtOrBefore(ms: number): number {
  return cstDayOfMs(newMoonMs(newMoonKAtOrBefore(ms)))
}

/**
 * CST civil day of the last new moon whose CIVIL DAY is at or before the
 * given civil day. Lunar months begin on the civil day of a new moon, so this
 * is the correct "new moon on or before day D" (the solstice day itself
 * counts even when the new moon happens after midnight of that day).
 */
function newMoonDayAtOrBeforeCivilDay(civilDay: number): number {
  let k = newMoonKAtOrBefore(msOfCstDay(civilDay + 1))
  while (cstDayOfMs(newMoonMs(k)) > civilDay) k--
  return cstDayOfMs(newMoonMs(k))
}

/** CST day of the first new moon strictly after CST day `startDay`. */
function nextNewMoonDayAfterStartDay(startDay: number): number {
  let k = newMoonKAtOrBefore(msOfCstDay(startDay + 1))
  while (cstDayOfMs(newMoonMs(k)) <= startDay) k++
  return cstDayOfMs(newMoonMs(k))
}

/** Solar term (theta) crossing instant (UTC ms) for Gregorian year y; cached. */
const termMsCache = new Map<string, number>()
function solarTermMs(year: number, theta: number): number {
  const cacheKey = `${year}:${theta}`
  let ms = termMsCache.get(cacheKey)
  if (ms === undefined) {
    const guessMs = Date.UTC(year, 0, 1) + approxDoy(theta) * DAY
    ms = solveSolarLongitude(theta, guessMs)
    termMsCache.set(cacheKey, ms)
  }
  return ms
}

/** Solar term (theta) crossing day for Gregorian year y; cached. */
const termCache = new Map<string, number>()
function solarTermDay(year: number, theta: number): number {
  const cacheKey = `${year}:${theta}`
  let d = termCache.get(cacheKey)
  if (d === undefined) {
    d = cstDayOfMs(solarTermMs(year, theta))
    termCache.set(cacheKey, d)
  }
  return d
}

/** Winter solstice (270°) CST civil day in Gregorian year `y`. */
function winterSolsticeDay(y: number): number {
  return solarTermDay(y, 270)
}

interface Segment {
  start: number // CST day of month-day 1
  length: number // days in the month (29 or 30)
  end: number // start + length (exclusive)
  month: number // 1..12
  leap: boolean
}

/**
 * The labelled month span [month 11 of lunar year (y-1), month 11 of lunar
 * year y): labelled 11,12,1,...,10, with the (single) 中气-less month flagged
 * as leap. The first segment necessarily contains the winter solstice.
 */
function month11Span(year: number): Segment[] {
  // Month 11 is the lunar month whose civil day span contains the winter
  // solstice day (Chinese months start on the civil day of the new moon).
  const m11Prev = newMoonDayAtOrBeforeCivilDay(winterSolsticeDay(year - 1))
  const m11This = newMoonDayAtOrBeforeCivilDay(winterSolsticeDay(year))
  const major = majorTermDays(year - 2, year + 1)
  const hasMajor = (s: Segment) => {
    for (let d = s.start; d < s.end; d++) if (major.has(d)) return true
    return false
  }
  const segments: Segment[] = []
  let cur = m11Prev
  let safety = 0
  while (cur < m11This && safety++ < 30) {
    const nxt = nextNewMoonDayAfterStartDay(cur)
    segments.push({ start: cur, length: nxt - cur, end: nxt, month: 0, leap: false })
    cur = nxt
  }
  const LABEL_SEQ = [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  // Label sequentially 11,12,1,...,10 from the solstice month. When the span
  // holds THIRTEEN lunations exactly one month has no principal term — that
  // month is the leap (it duplicates its predecessor's number). With 12
  // months no leap exists, even if a month happens to lack a term (cf. 2053
  // 正月, which lacks 雨水 yet is a normal 正月初一).
  if (segments.length === 13) {
    const leapIdx = segments.findIndex((s, i) => i > 0 && !hasMajor(s))
    let label = 0
    for (let i = 0; i < segments.length; i++) {
      if (i === leapIdx) {
        segments[i].month = segments[i - 1].month
        segments[i].leap = true
      } else {
        segments[i].month = LABEL_SEQ[label]
        label++
      }
    }
  } else {
    for (let i = 0; i < segments.length; i++) segments[i].month = LABEL_SEQ[i]
  }
  return segments
}

/** Major solar terms (0°,30°,...,330°) day numbers for Gregorian years [y0..y1]. */
function majorTermDays(y0: number, y1: number): Map<number, number> {
  const byDay = new Map<number, number>()
  for (let y = y0; y <= y1; y++) {
    for (let theta = 0; theta < 360; theta += 30) {
      byDay.set(solarTermDay(y, theta), theta)
    }
  }
  return byDay
}

/** CST day number of 春节 (lunar month 1 day 1) for lunar year `year`. Cached. */
const newYearCache = new Map<number, number>()
function newYearDay(year: number): number {
  let d = newYearCache.get(year)
  if (d === undefined) {
    const spring = month11Span(year).find((s) => s.month === 1 && !s.leap)
    if (!spring) {
      const any = month11Span(year).find((s) => s.month === 1)
      if (!any) throw new Error(`no 春节 for lunar year ${year}`)
      d = any.start
    } else {
      d = spring.start
    }
    newYearCache.set(year, d)
  }
  return d
}

/** The lunar months of lunar year `year`: from 春节(year) to 春节(year+1). */
const segmentsCache = new Map<number, Segment[]>()
function segmentsOfYear(year: number): Segment[] {
  let seg = segmentsCache.get(year)
  if (seg === undefined) {
    const start = newYearDay(year)
    const end = newYearDay(year + 1)
    const major = majorTermDays(year - 2, year + 1)
    const hasMajor = (s: Segment) => {
      for (let d = s.start; d < s.end; d++) if (major.has(d)) return true
      return false
    }
    const out: Segment[] = []
    let cur = start
    let safety = 0
    while (cur < end && safety++ < 30) {
      const nxt = nextNewMoonDayAfterStartDay(cur)
      out.push({ start: cur, length: nxt - cur, end: nxt, month: 0, leap: false })
      cur = nxt
    }
    // Leap rule (现行农历置闰, 闰前不闰后): a leap exists in an interval
    // between two adjacent winter solstices when that interval holds THIRTEEN
    // new-moon days; the leap is then the first 无中气 month after the first
    // solstice. A lunar year spans two such intervals, so consult both.
    if (out.length === 13) {
      const candidates = [solsticeIntervalLeapStart(year), solsticeIntervalLeapStart(year + 1)]
      const target = candidates.find((s) => s !== null && out.some((o) => o.start === s))
      if (target !== undefined && target !== null) {
        const idx = out.findIndex((o) => o.start === target)
        if (idx > 0) {
          out[idx].month = out[idx - 1].month
          out[idx].leap = true
        }
      }
    }
    // Label 1..12 sequentially; the leap duplicates its predecessor's number.
    let label = 1
    for (let i = 0; i < out.length; i++) {
      if (!out[i].leap) {
        out[i].month = label
        label++
      } else {
        out[i].month = out[i - 1].month
      }
    }
    seg = out
    segmentsCache.set(year, seg)
  }
  return seg
}

/**
 * The 朔日 (start day) of the leap month belonging to the winter-solstice
 * interval [冬至(y-1) day, 冬至(y) day), or null when that interval has no
 * leap (12 new-moon days, or none of them lacks a major term).
 */
function solsticeIntervalLeapStart(y: number): number | null {
  const a = winterSolsticeDay(y - 1)
  const b = winterSolsticeDay(y)
  const major = majorTermDays(y - 2, y + 1)
  const hasTerm = (from: number, to: number) => {
    for (let d = from; d < to; d++) if (major.has(d)) return true
    return false
  }
  let k = newMoonKAtOrBefore(msOfCstDay(a + 1))
  while (cstDayOfMs(newMoonMs(k)) <= a) k++
  const days: number[] = []
  let guard = 0
  while (cstDayOfMs(newMoonMs(k)) <= b && guard++ < 20) {
    days.push(cstDayOfMs(newMoonMs(k)))
    k++
  }
  if (days.length !== 13) return null
  for (let i = 0; i + 1 < days.length; i++) {
    if (!hasTerm(days[i], days[i + 1])) return days[i]
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Public conversion API                                               */
/* ------------------------------------------------------------------ */

export interface LunarDate {
  year: number
  month: number
  day: number
  leap: boolean
}

export interface GregorianDate {
  year: number
  month: number
  day: number
}

/** Convert a Gregorian calendar date to its lunar date, or null when invalid/out of range. */
export function solarToLunar(year: number, month: number, day: number): LunarDate | null {
  if (year < 1900 || year > 2150) return null
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  const target = cstDayOfYmd(year, month, day)
  let L = year
  while (newYearDay(L) > target) L--
  while (newYearDay(L + 1) <= target) L++
  const segs = segmentsOfYear(L)
  for (const s of segs) {
    if (target >= s.start && target < s.end) {
      return { year: L, month: s.month, day: target - s.start + 1, leap: s.leap }
    }
  }
  return null
}

/** Convert a lunar date to its Gregorian date, or null when invalid. */
export function lunarToSolar(lunarYear: number, month: number, day: number, leap = false): GregorianDate | null {
  if (lunarYear < 1900 || lunarYear > 2150) return null
  if (month < 1 || month > 12 || day < 1) return null
  const seg = segmentsOfYear(lunarYear).find((s) => s.month === month && s.leap === leap)
  if (!seg || day > seg.length) return null
  return ymdOfCstDay(seg.start + day - 1)
}

/** Gregorian date (CST) of 春节 for lunar year `year`. */
export function lunarNewYear(year: number): GregorianDate {
  if (year < 1900 || year > 2150) throw new RangeError(`lunar year ${year} out of range`)
  return ymdOfCstDay(newYearDay(year))
}

/** True when a lunar year contains a leap month. */
export function isLeapLunarYear(year: number): boolean {
  return segmentsOfYear(year).some((s) => s.leap)
}

/** The leap month number (1..12) of a lunar year, or 0 when there is none. */
export function leapMonthOfYear(year: number): number {
  const s = segmentsOfYear(year).find((seg) => seg.leap)
  return s ? s.month : 0
}

/* ------------------------------------------------------------------ */
/* Festivals / holidays                                                */
/* ------------------------------------------------------------------ */

export interface Holiday {
  key: string
  name: string
  nameEn: string
  kind: 'solar' | 'lunar' | 'term'
  date: GregorianDate
  /** lunar date when the festival is lunar-based */
  lunar?: LunarDate
}

type FestivalMatcher = (L: LunarDate | null, y: number, mo: number, d: number) => boolean

const FESTIVALS: Array<{ key: string; name: string; nameEn: string; kind: 'solar' | 'lunar' | 'term'; match: FestivalMatcher }> = [
  { key: 'new-year', name: '元旦', nameEn: "New Year's Day", kind: 'solar', match: (_L, _y, mo, d) => mo === 1 && d === 1 },
  { key: 'spring-festival', name: '春节', nameEn: 'Spring Festival', kind: 'lunar', match: (L) => L?.month === 1 && L?.day === 1 && !L.leap },
  { key: 'lantern', name: '元宵节', nameEn: 'Lantern Festival', kind: 'lunar', match: (L) => L?.month === 1 && L?.day === 15 && !L.leap },
  { key: 'qixi', name: '七夕节', nameEn: 'Qixi Festival', kind: 'lunar', match: (L) => L?.month === 7 && L?.day === 7 && !L.leap },
  { key: 'dragon-boat', name: '端午节', nameEn: 'Dragon Boat Festival', kind: 'lunar', match: (L) => L?.month === 5 && L?.day === 5 && !L.leap },
  { key: 'mid-autumn', name: '中秋节', nameEn: 'Mid-Autumn Festival', kind: 'lunar', match: (L) => L?.month === 8 && L?.day === 15 && !L.leap },
  { key: 'chongyang', name: '重阳节', nameEn: 'Double Ninth Festival', kind: 'lunar', match: (L) => L?.month === 9 && L?.day === 9 && !L.leap },
  { key: 'qingming', name: '清明节', nameEn: 'Qingming Festival', kind: 'term', match: (_L, y, mo, d) => solarTermDay(y, 15) === cstDayOfYmd(y, mo, d) },
  { key: 'labor-day', name: '劳动节', nameEn: "International Workers' Day", kind: 'solar', match: (_L, _y, mo, d) => mo === 5 && d === 1 },
  { key: 'national-day', name: '国庆节', nameEn: 'National Day', kind: 'solar', match: (_L, _y, mo, d) => mo === 10 && d === 1 },
]

/** The day before 春节(lunar year y) is 除夕 (Chinese New Year's Eve) of lunar year y-1. */
function isSpringEve(year: number, month: number, day: number): boolean {
  try {
    return cstDayOfYmd(year, month, day) === newYearDay(year) - 1
  } catch {
    return false
  }
}

/** All holidays (if any) falling on a Gregorian date. */
export function holidaysOnDate(year: number, month: number, day: number): Holiday[] {
  if (year < 1900 || year > 2150) return []
  const lunar = solarToLunar(year, month, day)
  const out: Holiday[] = []
  for (const f of FESTIVALS) {
    if (f.match(lunar, year, month, day)) {
      out.push({ key: f.key, name: f.name, nameEn: f.nameEn, kind: f.kind, date: { year, month, day }, lunar: lunar ?? undefined })
    }
  }
  if (isSpringEve(year, month, day)) {
    out.push({ key: 'spring-eve', name: '除夕', nameEn: "Chinese New Year's Eve", kind: 'lunar', date: { year, month, day }, lunar: lunar ?? undefined })
  }
  return out
}

/** Holidays within `days` days starting on `from` (inclusive). */
export function upcomingHolidays(from: GregorianDate, days = 60): Holiday[] {
  if (days <= 0) return []
  const out: Holiday[] = []
  let y = from.year
  let mo = from.month
  let d = from.day
  for (let i = 0; i < days; i++) {
    out.push(...holidaysOnDate(y, mo, d))
    d += 1
    if (d > daysInMonth(y, mo)) { d = 1; mo += 1; if (mo > 12) { mo = 1; y += 1 } }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 干支 / 生肖 (sexagenary cycle + zodiac), anchored at 立春             */
/* ------------------------------------------------------------------ */

const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']

export interface Ganzhi {
  gan: string
  zhi: string
  ganzhi: string
  zodiac: string
}

/** 干支/生肖 for a Gregorian date; the cycle advances at 立春 (315°). */
export function ganzhiZodiac(year: number, month: number, day: number): Ganzhi {
  const lichun = solarTermDay(year, 315)
  const target = cstDayOfYmd(year, month, day)
  const gy = target < lichun ? year - 1 : year
  // 1984 = 甲子
  const idx = (((gy - 1984) % 60) + 60) % 60
  const gan = GAN[idx % 10]
  const zhi = ZHI[idx % 12]
  return { gan, zhi, ganzhi: `${gan}${zhi}`, zodiac: ZODIAC[idx % 12] }
}

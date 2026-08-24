/**
 * Recurrence rule (RFC 5545 §3.3.10) parser and expander.
 *
 * Self-implemented, dependency-free. Supports FREQ (SECONDLY..YEARLY),
 * INTERVAL, COUNT, UNTIL (UTC and local), BYDAY (with ordinals), BYMONTH,
 * BYMONTHDAY, BYYEARDAY, BYWEEKNO, BYSETPOS, WKST, BYHOUR/BYMINUTE/BYSECOND.
 *
 * Expansion happens on the DTSTART's *local wall-clock* representation and
 * the resulting wall times are converted to absolute (UTC) instants by the
 * timezone engine, so DST transitions are handled naturally.
 *
 * Known limitation (documented in README): complex combinations of BYMONTH +
 * BYWEEKNO + BYYEARDAY are evaluated per-branch rather than with the full
 * RFC 5545 expansion ordering; every individual BY* expansion is honoured.
 */

import {
  addDays,
  addMinutes,
  daysInMonth,
  daysInYear,
  dayOfWeek,
  makeWall,
  serialToWall,
  utcToWall,
  wallEquals,
  wallToSerial,
  wallToUTCms,
  type Wall,
} from './tz.js'

export type Freq = 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface ByDay {
  /** 0=Sunday .. 6=Saturday */
  weekday: number
  /** ordinal within month/year; absent/0 means "every such weekday" */
  ord?: number
}

export interface RRule {
  freq: Freq
  interval: number
  count?: number
  until?: { wall?: Wall; utcMs?: number }
  /** week start weekday, 0=Sunday..6=Saturday (RFC default = Monday = 1) */
  wkst: number
  byDay: ByDay[]
  byMonth: number[]
  byMonthDay: number[]
  byYearDay: number[]
  byWeekNo: number[]
  bySetPos: number[]
  byHour: number[]
  byMinute: number[]
  bySecond: number[]
}

/* ------------------------------------------------------------------ */
/* Parsing                                                              */
/* ------------------------------------------------------------------ */

function rfcWeekdayToJs(code: string): number {
  // RFC uses MO=1..SU=7; JS uses 0=Sunday..6=Saturday.
  const map: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
  const v = map[code.toUpperCase()]
  if (v === undefined) throw new RangeError(`unknown weekday "${code}"`)
  return v
}

function parseNumberList(raw: string | undefined, check: (n: number) => boolean, what: string): number[] {
  if (raw === undefined || raw === '') return []
  return raw.split(',').map((t) => {
    const n = Number(t)
    if (!Number.isInteger(n)) throw new RangeError(`invalid ${what} list item "${t}"`)
    if (!check(n)) throw new RangeError(`invalid ${what} value "${t}"`)
    return n
  })
}

export function parseRrule(input: string): RRule {
  const map = new Map<string, string>()
  for (const part of input.split(';')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq === -1) throw new RangeError(`bad RRULE part "${part}"`)
    map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1))
  }
  const freqRaw = map.get('FREQ')
  if (!freqRaw) throw new Error('RRULE requires FREQ')
  const freq = freqRaw.toUpperCase() as Freq
  const freqs: Freq[] = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
  if (!freqs.includes(freq)) throw new RangeError(`unsupported FREQ "${freqRaw}"`)

  const countRaw = map.get('COUNT')
  const count = countRaw !== undefined ? Math.trunc(Number(countRaw)) : undefined
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw new RangeError(`invalid COUNT "${countRaw}"`)

  const intervalRaw = map.get('INTERVAL')
  const interval = intervalRaw !== undefined ? Math.trunc(Number(intervalRaw)) : 1
  if (interval < 1) throw new RangeError(`invalid INTERVAL "${intervalRaw}"`)

  const untilRaw = map.get('UNTIL')
  let until: { wall?: Wall; utcMs?: number } | undefined
  if (untilRaw !== undefined) {
    // RFC 5545 permits DATE-valued UNTIL (when DTSTART is VALUE=DATE); we
    // interpret it as end-of-that-day so the day itself stays inclusive.
    const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(untilRaw)
    const dOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(untilRaw)
    if (dt) {
      if (dt[7] === 'Z') {
        until = { utcMs: Date.UTC(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6])) }
      } else {
        until = { wall: makeWall(Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6])) }
      }
    } else if (dOnly) {
      until = { wall: makeWall(Number(dOnly[1]), Number(dOnly[2]), Number(dOnly[3]), 23, 59, 59) }
    } else {
      throw new RangeError(`invalid UNTIL "${untilRaw}"`)
    }
  }

  const byDay: ByDay[] = []
  for (const tok of (map.get('BYDAY') ?? '').split(',')) {
    if (!tok) continue
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(tok.trim())
    if (!m) throw new RangeError(`invalid BYDAY "${tok}"`)
    if (m[1] !== undefined && (Number(m[1]) === 0 || Math.abs(Number(m[1])) > 53)) {
      throw new RangeError(`invalid BYDAY ordinal in "${tok}"`)
    }
    byDay.push({ weekday: rfcWeekdayToJs(m[2]), ord: m[1] !== undefined ? Number(m[1]) : undefined })
  }

  const wsRaw = map.get('WKST')
  const wkst = wsRaw !== undefined ? rfcWeekdayToJs(wsRaw) : 1 // RFC default MO

  return {
    freq,
    interval,
    count,
    until,
    wkst,
    byDay,
    byMonth: parseNumberList(map.get('BYMONTH'), (n) => n >= 1 && n <= 12, 'BYMONTH'),
    byMonthDay: parseNumberList(map.get('BYMONTHDAY'), (n) => n !== 0 && n >= -31 && n <= 31, 'BYMONTHDAY'),
    byYearDay: parseNumberList(map.get('BYYEARDAY'), (n) => n !== 0 && n >= -366 && n <= 366, 'BYYEARDAY'),
    byWeekNo: parseNumberList(map.get('BYWEEKNO'), (n) => n !== 0 && n >= -53 && n <= 53, 'BYWEEKNO'),
    bySetPos: parseNumberList(map.get('BYSETPOS'), (n) => n !== 0 && n >= -366 && n <= 366, 'BYSETPOS'),
    byHour: parseNumberList(map.get('BYHOUR'), (n) => n >= 0 && n <= 24, 'BYHOUR'),
    byMinute: parseNumberList(map.get('BYMINUTE'), (n) => n >= 0 && n <= 59, 'BYMINUTE'),
    bySecond: parseNumberList(map.get('BYSECOND'), (n) => n >= 0 && n <= 60, 'BYSECOND'),
  }
}

/* ------------------------------------------------------------------ */
/* Civil math helpers (wall-clock space)                               */
/* ------------------------------------------------------------------ */

function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month))
}

function addMonthsRaw(year: number, month: number, months: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + months
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

function resolveMonthDay(year: number, month: number, mday: number): number {
  const dim = daysInMonth(year, month)
  return mday > 0 ? mday : dim + mday + 1
}

function nthWeekdayOfMonthDay(year: number, month: number, weekday: number, nth: number): number {
  const dim = daysInMonth(year, month)
  if (nth > 0) {
    let d = 1
    while (dayOfWeek(makeWall(year, month, d)) !== weekday) d++
    const day = d + (nth - 1) * 7
    return day <= dim ? day : 0
  }
  let d = dim
  while (dayOfWeek(makeWall(year, month, d)) !== weekday) d--
  const day = d + (nth + 1) * 7
  return day >= 1 ? day : 0
}

function allWeekdaysInMonth(year: number, month: number, weekday: number): number[] {
  const days: number[] = []
  const dim = daysInMonth(year, month)
  for (let d = 1; d <= dim; d++) {
    if (dayOfWeek(makeWall(year, month, d)) === weekday) days.push(d)
  }
  return days
}

/** All day-of-month values of a month matching a BYDAY list (ordinals honoured). */
function datesFromByDayInMonth(year: number, month: number, byDay: ByDay[]): number[] {
  const out: number[] = []
  for (const bd of byDay) {
    if (bd.ord === undefined) {
      out.push(...allWeekdaysInMonth(year, month, bd.weekday))
    } else {
      const d = nthWeekdayOfMonthDay(year, month, bd.weekday, bd.ord)
      if (d !== 0) out.push(d)
    }
  }
  return out
}

function ordinalDayToWall(year: number, ordinal: number): Wall | null {
  if (ordinal < 1 || ordinal > daysInYear(year)) return null
  return serialToWall(Date.UTC(year, 0, ordinal))
}

/** Week start (aligned to `wkst`) of the week containing `w`. */
function weekStartOf(w: Wall, wkst: number): Wall {
  const offset = (dayOfWeek(w) - wkst + 7) % 7
  return addDays(w, -offset)
}

/** ISO-style week-1 start of a year for the given wkst (week containing Jan 4). */
function week1Start(year: number, wkst: number): Wall {
  return weekStartOf(makeWall(year, 1, 4), wkst)
}

/** Number of ISO-style weeks in a year (52 or 53) for the given wkst. */
function weeksInYear(year: number, wkst: number): number {
  const a = wallToSerial(week1Start(year, wkst))
  const b = wallToSerial(week1Start(year + 1, wkst))
  return Math.round((b - a) / (7 * 86400000))
}

/** nth weekday of a year (positive from start, negative from end); returns Wall or null. */
function nthWeekdayOfYear(year: number, weekday: number, nth: number): Wall | null {
  if (nth > 0) {
    let d = 1
    while (dayOfWeek(makeWall(year, 1, d)) !== weekday) d++
    const ordinal = d + (nth - 1) * 7
    return ordinalDayToWall(year, ordinal)
  }
  let d = daysInYear(year)
  let wall: Wall | null = ordinalDayToWall(year, d)
  while (wall && dayOfWeek(wall) !== weekday) {
    d--
    wall = ordinalDayToWall(year, d)
  }
  if (!wall) return null
  const ordinal = d + (nth + 1) * 7
  return ordinalDayToWall(year, ordinal)
}

/* ------------------------------------------------------------------ */
/* Expander                                                             */
/* ------------------------------------------------------------------ */

export interface ExpandOptions {
  /** timezone for floating/UNTIL-local resolution; default UTC */
  tzid?: string
  /** safety cap on generated instances (infinite-loop guard) */
  maxResults?: number
  /** only return instances at or after this UTC instant */
  windowStartMs?: number
  /** only return instances strictly before this UTC instant */
  windowEndMs?: number
}

export interface ExpandedInstance {
  wall: Wall
  utcMs: number
}

export function expandRrule(r: RRule, start: Wall, opts: ExpandOptions = {}): ExpandedInstance[] {
  const tzid = opts.tzid ?? 'UTC'
  const maxResults = opts.maxResults ?? 5000

  let untilMs: number | undefined
  if (r.until) {
    untilMs = r.until.utcMs !== undefined ? r.until.utcMs : wallToUTCms(r.until.wall!, tzid)
  }

  const hourBase = r.byHour.length > 0 ? r.byHour : [start.hour]
  const minuteBase = r.byMinute.length > 0 ? r.byMinute : [start.minute]
  const secondBase = r.bySecond.length > 0 ? r.bySecond : [start.second]

  const timeCombinations = (wall: Wall): Wall[] => {
    const out: Wall[] = []
    for (const h of hourBase) for (const mi of minuteBase) for (const s of secondBase) {
      out.push(makeWall(wall.year, wall.month, wall.day, h, mi, s))
    }
    return out
  }

  const results: ExpandedInstance[] = []
  const seen = new Set<number>()
  // `count` tracks the number of RULE OCCURRENCES (RFC 5545 COUNT semantics),
  // independent of the requested window, so a windowed query never invents
  // occurrences beyond the rule's true end.
  let count = 0
  const startSerial = wallToSerial(start)

  const addCandidate = (utcMs: number, wall: Wall, phantom: boolean): boolean => {
    // RFC 5545 §3.3.10: local times that do not exist (DST spring-forward gap)
    // MUST be ignored and MUST NOT be counted as part of the recurrence set.
    if (phantom) return false
    // RFC: instances never precede DTSTART.
    if (wallToSerial(wall) < startSerial) return false
    if (r.count !== undefined && count >= r.count) return true // stop signal
    if (untilMs !== undefined && utcMs > untilMs) return true // stop signal
    if (opts.windowEndMs !== undefined && utcMs >= opts.windowEndMs) return true // stop signal
    const key = wallToSerial(wall)
    if (seen.has(key)) return false
    seen.add(key)
    count++
    if (opts.windowStartMs !== undefined && utcMs < opts.windowStartMs) return false // counted but outside range
    results.push({ wall, utcMs })
    return false
  }

  const generatePeriod = (period: Wall, freq: Freq): Wall[] => {
    const cands: Wall[] = []
    switch (freq) {
      case 'SECONDLY': {
        // BYHOUR / BYMINUTE act as limits (RFC 5545 §3.3.10); BYSECOND limits the seconds.
        if (r.byHour.length > 0 && !r.byHour.includes(period.hour)) return []
        if (r.byMinute.length > 0 && !r.byMinute.includes(period.minute)) return []
        return r.bySecond.length === 0 || r.bySecond.includes(period.second) ? [period] : []
      }
      case 'MINUTELY': {
        // period carries the advanced minute; BYHOUR/BYMINUTE limit, BYSECOND expands.
        if (r.byHour.length > 0 && !r.byHour.includes(period.hour)) return []
        if (r.byMinute.length > 0 && !r.byMinute.includes(period.minute)) return []
        const seconds = r.bySecond.length > 0 ? r.bySecond : [start.second]
        for (const s of seconds) cands.push(makeWall(period.year, period.month, period.day, period.hour, period.minute, s))
        return cands
      }
      case 'HOURLY': {
        // period carries the advanced hour; BYHOUR limits, BYMINUTE/BYSECOND expand.
        if (r.byHour.length > 0 && !r.byHour.includes(period.hour)) return []
        const minutes = r.byMinute.length > 0 ? r.byMinute : [start.minute]
        const seconds = r.bySecond.length > 0 ? r.bySecond : [start.second]
        for (const mi of minutes) for (const s of seconds) {
          cands.push(makeWall(period.year, period.month, period.day, period.hour, mi, s))
        }
        return cands
      }
      case 'DAILY': {
        const walls = timeCombinations(period)
        if (r.byDay.length === 0) return walls
        // BYDAY limits for DAILY (RFC 5545 §3.3.10); ordinals ignored.
        return walls.filter((w) => r.byDay.some((b) => b.weekday === dayOfWeek(w)))
      }
      case 'WEEKLY': {
        if (r.byDay.length === 0) return timeCombinations(period)
        const ws = weekStartOf(period, r.wkst)
        for (const bd of r.byDay) {
          const off = (bd.weekday - r.wkst + 7) % 7
          cands.push(...timeCombinations(addDays(ws, off)))
        }
        return cands
      }
      case 'MONTHLY': {
        const y = period.year
        const mo = period.month
        if (r.byMonth.length > 0 && !r.byMonth.includes(mo)) return []
        const byMonthDay = r.byMonthDay.length > 0 ? r.byMonthDay : undefined
        const byDay = r.byDay.length > 0 ? r.byDay : undefined
        let days: number[]
        if (byMonthDay && byDay) {
          const d1 = byMonthDay.map((m) => resolveMonthDay(y, mo, m)).filter((d) => d <= daysInMonth(y, mo))
          const d2set = new Set(datesFromByDayInMonth(y, mo, byDay))
          days = d1.filter((d) => d2set.has(d))
        } else if (byMonthDay) {
          days = byMonthDay.map((m) => resolveMonthDay(y, mo, m)).filter((d) => d <= daysInMonth(y, mo))
        } else if (byDay) {
          days = datesFromByDayInMonth(y, mo, byDay)
        } else {
          // plain monthly: DTSTART's own day-of-month; invalid dates (e.g. the
          // 31st) are NOT generated for shorter months (RFC 5545 §3.3.10).
          days = start.day <= daysInMonth(y, mo) ? [start.day] : []
        }
        for (const d of days) cands.push(...timeCombinations(makeWall(y, mo, d)))
        return cands
      }
      case 'YEARLY': {
        const y = period.year
        if (r.byWeekNo.length > 0) {
          const weekdays = new Set(r.byDay.length > 0 ? r.byDay.map((b) => b.weekday) : [dayOfWeek(start)])
          const weeks = weeksInYear(y, r.wkst)
          for (const wn of r.byWeekNo) {
            const wk = wn > 0 ? wn : weeks + wn + 1
            if (wk < 1 || wk > weeks) continue
            const ws = addDays(week1Start(y, r.wkst), (wk - 1) * 7)
            for (const wd of weekdays) {
              const off = (wd - r.wkst + 7) % 7
              const d = addDays(ws, off)
              if (d.year === y) cands.push(...timeCombinations(d))
            }
          }
          return cands
        }
        if (r.byYearDay.length > 0) {
          for (const yd of r.byYearDay) {
            const ord = yd > 0 ? yd : daysInYear(y) + yd + 1
            const wall = ordinalDayToWall(y, ord)
            if (wall) cands.push(...timeCombinations(wall))
          }
          return cands
        }
        if (r.byMonth.length > 0) {
          for (const mo of r.byMonth) {
            const byMonthDay = r.byMonthDay.length > 0 ? r.byMonthDay : undefined
            const byDay = r.byDay.length > 0 ? r.byDay : undefined
            let days: number[]
            if (byMonthDay && byDay) {
              const d1 = byMonthDay.map((m) => resolveMonthDay(y, mo, m)).filter((d) => d <= daysInMonth(y, mo))
              const d2set = new Set(datesFromByDayInMonth(y, mo, byDay))
              days = d1.filter((d) => d2set.has(d))
            } else if (byMonthDay) {
              days = byMonthDay.map((m) => resolveMonthDay(y, mo, m)).filter((d) => d <= daysInMonth(y, mo))
            } else if (byDay) {
              days = datesFromByDayInMonth(y, mo, byDay)
            } else {
              days = [clampDay(y, mo, start.day)]
            }
            for (const d of days) cands.push(...timeCombinations(makeWall(y, mo, d)))
          }
          return cands
        }
        if (r.byDay.length > 0) {
          const hasOrd = r.byDay.some((b) => b.ord !== undefined)
          if (hasOrd) {
            for (const bd of r.byDay) {
              if (bd.ord === undefined || bd.ord === 0) continue
              const wall = nthWeekdayOfYear(y, bd.weekday, bd.ord)
              if (wall) cands.push(...timeCombinations(wall))
            }
          } else {
            const dim = daysInYear(y)
            for (let ord = 1; ord <= dim; ord++) {
              const w = ordinalDayToWall(y, ord)!
              if (r.byDay.some((b) => b.weekday === dayOfWeek(w))) cands.push(...timeCombinations(w))
            }
          }
          return cands
        }
        if (r.byMonthDay.length > 0) {
          for (let mo = 1; mo <= 12; mo++) {
            for (const m of r.byMonthDay) {
              const d = resolveMonthDay(y, mo, m)
              if (d <= daysInMonth(y, mo)) cands.push(...timeCombinations(makeWall(y, mo, d)))
            }
          }
          return cands
        }
        // plain annual anniversary: DTSTART's own date; invalid dates (e.g.
        // Feb 29 in a non-leap year) are skipped.
        if (start.day <= daysInMonth(y, start.month)) {
          return timeCombinations(makeWall(y, start.month, start.day, start.hour, start.minute, start.second))
        }
        return []
      }
    }
  }

  const advance = (n: number): Wall => {
    switch (r.freq) {
      case 'SECONDLY': return serialToWall(wallToSerial(start) + n * 1000)
      case 'MINUTELY': return addMinutes(start, n)
      case 'HOURLY': return serialToWall(wallToSerial(start) + n * 3600000)
      case 'DAILY': return addDays(start, n)
      case 'WEEKLY': return addDays(start, n * 7)
      case 'MONTHLY': {
        const ym = addMonthsRaw(start.year, start.month, n)
        return makeWall(ym.year, ym.month, clampDay(ym.year, ym.month, start.day), start.hour, start.minute, start.second)
      }
      case 'YEARLY': {
        const y = start.year + n
        return makeWall(y, start.month, clampDay(y, start.month, start.day), start.hour, start.minute, start.second)
      }
    }
  }

  const applySetPos = (cands: Wall[]): Wall[] => {
    if (r.bySetPos.length === 0) return cands
    const out: Wall[] = []
    for (const pos of r.bySetPos) {
      const idx = pos > 0 ? pos - 1 : cands.length + pos
      if (idx >= 0 && idx < cands.length) out.push(cands[idx])
    }
    return out
  }

  let n = 0
  let guard = 0
  // The safety cap bounds total periods examined. It is generous because
  // sparse sub-daily rules (e.g. FREQ=SECONDLY;BYMINUTE=30) legitimately need
  // many periods per match; reaching it just yields the partial result set
  // (bounded by maxResults) instead of throwing.
  const hardLoopCap = 1000000
  while (guard++ < hardLoopCap) {
    const period = advance(n)
    let candidates = generatePeriod(period, r.freq)
    candidates = [...new Map(candidates.map((c) => [wallToSerial(c), c])).values()]
    candidates.sort((a, b) => wallToSerial(a) - wallToSerial(b))
    // BYSETPOS operates on the sorted candidate set of the current period.
    candidates = applySetPos(candidates)
    const withUtc: Array<{ wall: Wall; utcMs: number; phantom: boolean }> = candidates.map((wall) => {
      const utcMs = wallToUTCms(wall, tzid)
      const phantom = tzid !== 'UTC' && !wallEquals(wall, utcToWall(utcMs, tzid).wall)
      return { wall, utcMs, phantom }
    })
    if (withUtc.length > 0) {
      // Precise early-exit: when even the earliest candidate of this (later)
      // period is past UNTIL / the window end, no further period can contain
      // results (candidates within a period may precede the period anchor,
      // hence we compare against the candidate minimum, not the anchor).
      const minUtc = withUtc.reduce((a, b) => Math.min(a, b.utcMs), Infinity)
      if (untilMs !== undefined && minUtc > untilMs) break
      if (opts.windowEndMs !== undefined && minUtc >= opts.windowEndMs) break
    }
    let stop = false
    for (const cand of withUtc) {
      if (addCandidate(cand.utcMs, cand.wall, cand.phantom)) { stop = true; break }
    }
    if (stop) break
    if (r.count !== undefined && count >= r.count) break
    if (results.length >= maxResults) break
    n += r.interval
  }

  results.sort((a, b) => a.utcMs - b.utcMs || wallToSerial(a.wall) - wallToSerial(b.wall))
  if (results.length > maxResults) return results.slice(0, maxResults)
  return results
}

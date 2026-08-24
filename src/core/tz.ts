/**
 * Minimal, self-implemented timezone engine.
 *
 * The engine covers a curated set of present-day IANA zones for the
 * 2000-2100 era. Each zone is described by its standard offset plus a
 * transparent daylight-saving rule, and conversions are done by explicit
 * civil-date arithmetic rather than the platform timezone database, so
 * behaviour is deterministic, dependency-free and fully under test.
 *
 * Resolving ambiguous / non-existent wall times (RFC 5545 mandates a policy
 * but does not choose one) follows this documented, deterministic policy:
 *
 *   - a wall clock that occurs TWICE (autumn "fall back" fold): we pick the
 *     FIRST occurrence in absolute time, i.e. the one with the larger
 *     (more eastward) offset;
 *   - a wall clock that does NOT occur at all (spring "spring forward" gap):
 *     we shift the time forward across the gap, i.e. interpret it with the
 *     offset that is in effect AFTER the transition.
 */

export interface Wall {
  year: number
  /** 1..12 */
  month: number
  /** 1..31 */
  day: number
  /** 0..23 */
  hour: number
  /** 0..59 */
  minute: number
  /** 0..59 */
  second: number
}

export interface TransitionDef {
  /** 1..12 month in which the transition happens */
  month: number
  /** fixed day of month (1..31); ignore if `weekday`+`nth` are present */
  day?: number
  /** 0=Sunday .. 6=Saturday; paired with `nth` */
  weekday?: number
  /** ordinal: 2 = second, -1 = last, aware of negative counting */
  nth?: number
  /** wall-clock minutes since midnight (interpreted in the STANDARD offset) at which the transition takes effect */
  atMin: number
}

export interface ZoneDef {
  id: string
  /** standard offset, minutes east of UTC */
  stdOffset: number
  /** offset while daylight saving is in effect, minutes east of UTC */
  dstOffset: number
  /** transition toward dstOffset */
  dstStart?: TransitionDef
  /** transition back to stdOffset */
  dstEnd?: TransitionDef
}

/** Weekday constants in JS convention (0=Sunday..6=Saturday). */
export const SUNDAY = 0
export const MONDAY = 1
export const TUESDAY = 2
export const WEDNESDAY = 3
export const THURSDAY = 4
export const FRIDAY = 5
export const SATURDAY = 6

/* ------------------------------------------------------------------ */
/* Civil-date helpers (all timezone independent)                        */
/* ------------------------------------------------------------------ */

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31
    case 4: case 6: case 9: case 11:
      return 30
    case 2:
      return isLeapYear(year) ? 29 : 28
    default:
      throw new RangeError(`invalid month ${month}`)
  }
}

export function makeWall(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Wall {
  return { year, month, day, hour, minute, second }
}

export function wallEquals(a: Wall, b: Wall): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second
}

export function compareWall(a: Wall, b: Wall): number {
  return wallToSerial(a) - wallToSerial(b)
}

/**
 * Serialize a Wall as milliseconds since epoch *as if it were UTC*.
 * This is pure civil arithmetic used as the numeric spine for all
 * timezone-neutral date logic (RRULE iteration, day boundaries, ...).
 */
export function wallToSerial(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
}

/** Inverse of {@link wallToSerial}. */
export function serialToWall(ms: number): Wall {
  const d = new Date(ms)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  }
}

export function addDays(w: Wall, days: number): Wall {
  return serialToWall(wallToSerial(w) + days * 86400000)
}

export function addMinutes(w: Wall, minutes: number): Wall {
  return serialToWall(wallToSerial(w) + minutes * 60000)
}

/** Day of week in JS convention (0=Sunday .. 6=Saturday). */
export function dayOfWeek(w: Wall): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()
}

/** Ordinal day of year, 1..366. */
export function ordinalDay(w: Wall): number {
  const base = Date.UTC(w.year, 0, 0)
  const here = Date.UTC(w.year, w.month - 1, w.day)
  return Math.round((here - base) / 86400000)
}

/** Days in a Gregorian year. */
export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365
}

/** Number of ISO-8601 weeks in a year (not used internally, kept for callers). */
export function weeksInYear(year: number): number {
  const jan1 = dayOfWeek(makeWall(year, 1, 1))
  return (jan1 === THURSDAY || (isLeapYear(year) && jan1 === WEDNESDAY)) ? 53 : 52
}

/* ------------------------------------------------------------------ */
/* Zone registry                                                       */
/* ------------------------------------------------------------------ */

// Present-day rules, stable across 2000-2100. Documented in README.
const ZONES: ZoneDef[] = [
  { id: 'UTC', stdOffset: 0, dstOffset: 0 },
  { id: 'Etc/UTC', stdOffset: 0, dstOffset: 0 },
  { id: 'Asia/Shanghai', stdOffset: 480, dstOffset: 480 },
  { id: 'Asia/Beijing', stdOffset: 480, dstOffset: 480 },
  { id: 'PRC', stdOffset: 480, dstOffset: 480 },
  { id: 'Asia/Hong_Kong', stdOffset: 480, dstOffset: 480 },
  { id: 'Asia/Singapore', stdOffset: 480, dstOffset: 480 },
  { id: 'Asia/Tokyo', stdOffset: 540, dstOffset: 540 },
  { id: 'Asia/Seoul', stdOffset: 540, dstOffset: 540 },
  { id: 'Asia/Kolkata', stdOffset: 330, dstOffset: 330 },
  { id: 'Asia/Jakarta', stdOffset: 420, dstOffset: 420 },
  { id: 'Asia/Dubai', stdOffset: 240, dstOffset: 240 },
  { id: 'Asia/Moscow', stdOffset: 180, dstOffset: 180 },
  { id: 'Europe/London', stdOffset: 0, dstOffset: 60,
    dstStart: { month: 3, weekday: SUNDAY, nth: -1, atMin: 60 },
    dstEnd: { month: 10, weekday: SUNDAY, nth: -1, atMin: 60 } },
  { id: 'Europe/Paris', stdOffset: 60, dstOffset: 120,
    dstStart: { month: 3, weekday: SUNDAY, nth: -1, atMin: 120 },
    dstEnd: { month: 10, weekday: SUNDAY, nth: -1, atMin: 180 } },
  { id: 'Europe/Berlin', stdOffset: 60, dstOffset: 120,
    dstStart: { month: 3, weekday: SUNDAY, nth: -1, atMin: 120 },
    dstEnd: { month: 10, weekday: SUNDAY, nth: -1, atMin: 180 } },
  { id: 'Europe/Madrid', stdOffset: 60, dstOffset: 120,
    dstStart: { month: 3, weekday: SUNDAY, nth: -1, atMin: 120 },
    dstEnd: { month: 10, weekday: SUNDAY, nth: -1, atMin: 180 } },
  { id: 'Europe/Rome', stdOffset: 60, dstOffset: 120,
    dstStart: { month: 3, weekday: SUNDAY, nth: -1, atMin: 120 },
    dstEnd: { month: 10, weekday: SUNDAY, nth: -1, atMin: 180 } },
  { id: 'Europe/Zurich', stdOffset: 60, dstOffset: 120,
    dstStart: { month: 3, weekday: SUNDAY, nth: -1, atMin: 120 },
    dstEnd: { month: 10, weekday: SUNDAY, nth: -1, atMin: 180 } },
  { id: 'America/New_York', stdOffset: -300, dstOffset: -240,
    dstStart: { month: 3, weekday: SUNDAY, nth: 2, atMin: 120 },
    dstEnd: { month: 11, weekday: SUNDAY, nth: 1, atMin: 120 } },
  { id: 'America/Toronto', stdOffset: -300, dstOffset: -240,
    dstStart: { month: 3, weekday: SUNDAY, nth: 2, atMin: 120 },
    dstEnd: { month: 11, weekday: SUNDAY, nth: 1, atMin: 120 } },
  { id: 'America/Chicago', stdOffset: -360, dstOffset: -300,
    dstStart: { month: 3, weekday: SUNDAY, nth: 2, atMin: 120 },
    dstEnd: { month: 11, weekday: SUNDAY, nth: 1, atMin: 120 } },
  { id: 'America/Denver', stdOffset: -420, dstOffset: -360,
    dstStart: { month: 3, weekday: SUNDAY, nth: 2, atMin: 120 },
    dstEnd: { month: 11, weekday: SUNDAY, nth: 1, atMin: 120 } },
  { id: 'America/Los_Angeles', stdOffset: -480, dstOffset: -420,
    dstStart: { month: 3, weekday: SUNDAY, nth: 2, atMin: 120 },
    dstEnd: { month: 11, weekday: SUNDAY, nth: 1, atMin: 120 } },
  { id: 'America/Sao_Paulo', stdOffset: -180, dstOffset: -180 },
  { id: 'Australia/Sydney', stdOffset: 600, dstOffset: 660,
    dstStart: { month: 10, weekday: SUNDAY, nth: 1, atMin: 120 },
    dstEnd: { month: 4, weekday: SUNDAY, nth: 1, atMin: 180 } },
  { id: 'Australia/Melbourne', stdOffset: 600, dstOffset: 660,
    dstStart: { month: 10, weekday: SUNDAY, nth: 1, atMin: 120 },
    dstEnd: { month: 4, weekday: SUNDAY, nth: 1, atMin: 180 } },
  { id: 'Australia/Perth', stdOffset: 480, dstOffset: 480 },
  { id: 'Pacific/Auckland', stdOffset: 720, dstOffset: 780,
    dstStart: { month: 9, weekday: SUNDAY, nth: -1, atMin: 120 },
    dstEnd: { month: 4, weekday: SUNDAY, nth: 1, atMin: 180 } },
]

const ALIASES: Record<string, string> = {
  'PRC': 'Asia/Shanghai',
  'Asia/Beijing': 'Asia/Shanghai',
  'GMT': 'UTC',
  'Etc/GMT': 'UTC',
  'Asia/Calcutta': 'Asia/Kolkata',
  'America/New_York': 'America/New_York',
  'CST': 'Asia/Shanghai',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
}

const ZONE_MAP: Map<string, ZoneDef> = new Map(ZONES.map((z) => [z.id, z]))

export function resolveZoneId(id: string): string {
  return ALIASES[id] ?? id
}

export function hasZone(id: string): boolean {
  return ZONE_MAP.has(resolveZoneId(id))
}

export function getZone(id: string): ZoneDef {
  const z = ZONE_MAP.get(resolveZoneId(id))
  if (!z) {
    throw new RangeError(`unknown timezone "${id}"`)
  }
  return z
}

export function listZones(): string[] {
  return ZONES.map((z) => z.id).sort()
}

/* ------------------------------------------------------------------ */
/* Transitions                                                          */
/* ------------------------------------------------------------------ */

/**
 * Compute a transition's wall clock for the given year, or null when the
 * definition cannot be evaluated (e.g. 5th Friday never existing).
 */
export function transitionWall(zone: ZoneDef, def: TransitionDef, year: number): Wall | null {
  let day: number
  if (def.weekday !== undefined && def.nth !== undefined && def.day === undefined) {
    day = nthWeekdayOfMonth(year, def.month, def.weekday, def.nth)
    if (day === 0) return null
  } else if (def.day !== undefined) {
    day = def.day
  } else {
    throw new Error('transition definition needs day or weekday+nth')
  }
  const min = def.atMin
  return makeWall(year, def.month, day, Math.floor(min / 60), min % 60, 0)
}

/** nth weekday of a month; negative counts from the end; returns 0 when absent. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const dim = daysInMonth(year, month)
  if (nth > 0) {
    let first = 1
    while (new Date(Date.UTC(year, month - 1, first)).getUTCDay() !== weekday) first++
    const day = first + (nth - 1) * 7
    return day <= dim ? day : 0
  }
  let last = dim
  while (new Date(Date.UTC(year, month - 1, last)).getUTCDay() !== weekday) last--
  const day = last + (nth + 1) * 7
  return day >= 1 ? day : 0
}

/**
 * The UTC instants at which this zone's offset changes during a calendar
 * year, as [{ utcMs, offsetAfter }] sorted ascending. Offsets in minutes.
 */
export function zoneTransitions(zone: ZoneDef, year: number): Array<{ utcMs: number; offsetAfter: number }> {
  const out: Array<{ utcMs: number; offsetAfter: number }> = []
  if (!zone.dstStart || !zone.dstEnd) return out
  const push = (def: TransitionDef, offsetAfter: number, offsetBefore: number) => {
    const w = transitionWall(zone, def, year)
    if (w) {
      // A transition's wall time is read in the offset in effect BEFORE the
      // change ("clocks move at 2:00 LOCAL"), so the UTC instant is derived
      // with offsetBefore.
      out.push({ utcMs: wallToSerial(w) - offsetBefore * 60000, offsetAfter })
    }
  }
  push(zone.dstStart, zone.dstOffset, zone.stdOffset)
  push(zone.dstEnd, zone.stdOffset, zone.dstOffset)
  out.sort((a, b) => a.utcMs - b.utcMs)
  return out
}

/** Offset (minutes east of UTC) in effect at the given UTC instant. */
export function offsetAt(utcMs: number, zone: ZoneDef): number {
  if (!zone.dstStart || !zone.dstEnd) return zone.stdOffset
  const y = new Date(utcMs).getUTCFullYear()
  const transitions: Array<{ utcMs: number; offsetAfter: number }> = []
  for (const yy of [y - 1, y, y + 1]) {
    transitions.push(...zoneTransitions(zone, yy))
  }
  transitions.sort((a, b) => a.utcMs - b.utcMs)
  let offset = zone.stdOffset
  for (const t of transitions) {
    if (t.utcMs <= utcMs) offset = t.offsetAfter
    else break
  }
  return offset
}

/* ------------------------------------------------------------------ */
/* Conversions                                                          */
/* ------------------------------------------------------------------ */

export interface ZonedResult {
  wall: Wall
  /** offset in minutes that was in effect */
  offsetMin: number
  /** the resolved UTC instant in ms */
  utcMs: number
}

/**
 * Convert a wall clock in the zone to UTC milliseconds, resolving
 * ambiguous or non-existent times per the documented policy.
 */
export function wallToUTC(wall: Wall, zoneId: string): ZonedResult {
  const zone = getZone(zoneId)
  const offsets = [zone.stdOffset]
  if (zone.dstStart && zone.dstEnd && zone.dstOffset !== zone.stdOffset) offsets.push(zone.dstOffset)
  const candidates: Array<{ offset: number; utcMs: number; roundtrip: Wall }> = []
  for (const off of offsets) {
    const utcMs = wallToSerial(wall) - off * 60000
    candidates.push({ offset: off, utcMs, roundtrip: toWall(utcMs, zone).wall })
  }
  const valid = candidates.filter((c) => wallEquals(c.roundtrip, wall))
  // Fold (both offsets round-trip): pick the FIRST occurrence in absolute
  // time, i.e. the larger (more eastward) offset.
  // Gap (none round-trip): pick the SMALLER (pre-transition) offset, which
  // converts the wall clock by pushing it forward across the gap.
  const chosen = valid.length > 0
    ? valid.reduce((a, b) => (a.offset >= b.offset ? a : b))
    : candidates.reduce((a, b) => (a.offset <= b.offset ? a : b))
  // report the offset actually in effect at the resolved instant (so offsetMin
  // is always consistent with utcMs, even across gap/fold resolution)
  return { wall, offsetMin: offsetAt(chosen.utcMs, zone), utcMs: chosen.utcMs }
}

export function wallToUTCms(wall: Wall, zoneId: string): number {
  return wallToUTC(wall, zoneId).utcMs
}

/** Split a UTC instant into wall + offset for the zone. */
export function toWall(utcMs: number, zone: ZoneDef): ZonedResult
export function toWall(utcMs: number, zoneId: string): ZonedResult
export function toWall(utcMs: number, zone: ZoneDef | string): ZonedResult {
  const def = typeof zone === 'string' ? getZone(zone) : zone
  const offsetMin = offsetAt(utcMs, def)
  const wall = serialToWall(utcMs + offsetMin * 60000)
  return { wall, offsetMin, utcMs }
}

export function utcToWall(utcMs: number, zoneId: string): ZonedResult {
  return toWall(utcMs, zoneId)
}

/** Format a wall as ISO-ish "YYYY-MM-DD HH:mm[:ss]" (trailing zero seconds elided). */
export function formatWall(w: Wall): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  let s = `${w.year}-${pad(w.month)}-${pad(w.day)}`
  if (w.hour !== 0 || w.minute !== 0 || w.second !== 0) {
    s += ` ${pad(w.hour)}:${pad(w.minute)}`
    if (w.second !== 0) s += `:${pad(w.second)}`
  }
  return s
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]" into a Wall. */
export function parseWall(input: string): Wall {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(input.trim())
  if (!m) throw new RangeError(`cannot parse date-time "${input}"`)
  return makeWall(
    Number(m[1]), Number(m[2]), Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
    m[6] ? Number(m[6]) : 0,
  )
}

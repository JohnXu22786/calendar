/**
 * ISO-8601 duration parsing/formatting (RFC 5545 / RFC 3339 subset).
 * Supports the forms: P[n]W and P[n]D[T[n]H[n]M[n]S] (fractions allowed only
 * on the smallest present unit, kept as integer seconds for calendar use).
 */

export interface Duration {
  weeks?: number
  days?: number
  hours?: number
  minutes?: number
  seconds?: number
}

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR
const MS_PER_WEEK = 7 * MS_PER_DAY

export function parseIsoDuration(input: string): Duration {
  const s = String(input).trim()
  const m = /^([+-]?)P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s)
  if (!m) throw new RangeError(`invalid ISO-8601 duration "${input}"`)
  const sign = m[1] === '-' ? -1 : 1
  const out: Duration = {}
  if (m[2] !== undefined) out.weeks = sign * Number(m[2])
  if (m[3] !== undefined) out.days = sign * Number(m[3])
  if (m[4] !== undefined) out.hours = sign * Number(m[4])
  if (m[5] !== undefined) out.minutes = sign * Number(m[5])
  if (m[6] !== undefined) out.seconds = sign * Number(m[6])
  // RFC 5545 forbids combining weeks with any other unit; reject it rather
  // than silently dropping the weeks on round-trip.
  if (out.weeks !== undefined &&
      (out.days !== undefined || out.hours !== undefined || out.minutes !== undefined || out.seconds !== undefined)) {
    throw new RangeError(`ISO-8601 duration "${input}" mixes weeks with other units`)
  }
  return out
}

export function durationToMs(d: Duration): number {
  return Math.round(
    ((d.weeks ?? 0) * MS_PER_WEEK) +
    ((d.days ?? 0) * MS_PER_DAY) +
    ((d.hours ?? 0) * MS_PER_HOUR) +
    ((d.minutes ?? 0) * MS_PER_MINUTE) +
    ((d.seconds ?? 0) * MS_PER_SECOND),
  )
}

/** Whole minutes of a duration (seconds truncated). */
export function durationToMinutes(d: Duration): number {
  const ms = durationToMs(d)
  return Math.floor(ms / MS_PER_MINUTE)
}

export function formatIsoDuration(d: Duration): string {
  const weeks = d.weeks ?? 0
  const days = d.days ?? 0
  const hours = d.hours ?? 0
  const minutes = d.minutes ?? 0
  const seconds = d.seconds ?? 0
  if (weeks !== 0 && days === 0 && hours === 0 && minutes === 0 && seconds === 0) {
    return `P${weeks}W`
  }
  if (days === 0 && hours === 0 && minutes === 0 && seconds === 0) {
    return 'PT0S'
  }
  let out = 'P'
  if (days !== 0) out += `${days}D`
  if (hours !== 0 || minutes !== 0 || seconds !== 0) {
    out += 'T'
    if (hours !== 0) out += `${hours}H`
    if (minutes !== 0) out += `${minutes}M`
    if (seconds !== 0) out += `${seconds}S`
  }
  return out
}

export function durationAddMs(d: Duration, base: number): number {
  return base + durationToMs(d)
}

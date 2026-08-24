/**
 * Series expansion and single-instance editing for recurring events.
 *
 * A CalDAV "series" is a master VEVENT (with optional RRULE) plus zero or
 * more override VEVENTs that share the same UID and carry a RECURRENCE-ID.
 * Editing a single occurrence is done by adding / replacing such an override
 * (deleting one means writing an override with STATUS:CANCELLED) — this is the
 * standard RFC 4791 behaviour and never touches the master rule.
 *
 * Expansion happens in two steps: the RRULE is expanded on the master's
 * wall-clock representation (see rrule.ts), each occurrence is matched against
 * EXDATE (skip) and overrides (replacement), and RDATEs are appended.
 */

import {
  cloneIcsDate,
  isAllDay,
  sameLocalValue,
  toUtcMs,
  type IcsDate,
  type VEvent,
} from './ics.js'
import { durationToMs } from './duration.js'
import { expandRrule, parseRrule } from './rrule.js'
import { makeWall, toWall } from './tz.js'

export interface Series {
  master: VEvent
  overrides: VEvent[]
}

export interface Instance {
  uid: string
  /** the occurrence's local start value (used to match RECURRENCE-ID/EXDATE) */
  localStart: IcsDate
  startMs: number
  endMs: number
  /** offset (minutes east of UTC) in effect at startMs, when applicable */
  offsetMin?: number
  allDay: boolean
  summary: string
  location?: string
  description?: string
  status: string
  /** set when this instance is a single-instance override */
  recurrenceId?: IcsDate
  overridden: boolean
}

export interface ExpandOptions {
  rangeStartMs: number
  rangeEndMs: number
  defaultTz: string
  /** safety cap on total expanded instances */
  maxInstances?: number
  /** also return CANCELLED instances instead of dropping them */
  includeCancelled?: boolean
  /**
   * When true, only instances whose START falls in [rangeStartMs, rangeEndMs)
   * are returned (list-style); when false (default), any instance overlapping
   * the range is returned (conflict-style).
   */
  startInRange?: boolean
}

/** Duration of one master occurrence in ms (master DTEND - DTSTART); 0 when absent (RFC: zero-length event). */
function masterLength(master: VEvent, defaultTz: string): number {
  const start = givenStartMs(master, defaultTz)
  if (start === undefined) return 0
  if (master.dtEnd) {
    return toUtcMs(master.dtEnd, defaultTz) - start
  }
  if (master.duration) {
    return durationToMs(master.duration)
  }
  return 0
}

function givenStartMs(master: VEvent, defaultTz: string): number | undefined {
  return master.dtStart ? toUtcMs(master.dtStart, defaultTz) : undefined
}

/** Effective expansion timezone for a DTSTART value. */
function effectiveTz(dtStart: IcsDate, defaultTz: string): string {
  return dtStart.tzid ?? (dtStart.utc ? 'UTC' : defaultTz)
}

/**
 * Expand a series into concrete instances within a time range.
 * Instances overlapping [rangeStartMs, rangeEndMs) are returned, sorted by start.
 */
export function expandSeries(series: Series, opts: ExpandOptions): Instance[] {
  const { master, overrides } = series
  const defaultTz = opts.defaultTz
  const maxInstances = opts.maxInstances ?? 5000

  const masterStart = givenStartMs(master, defaultTz)
  if (masterStart === undefined || !master.dtStart) return []
  const dtStart = master.dtStart
  const len = masterLength(master, defaultTz)
  const tz = effectiveTz(dtStart, defaultTz)
  const allDay = isAllDay(dtStart)
  const wall = makeWall(dtStart.year, dtStart.month, dtStart.day, dtStart.hour, dtStart.minute, dtStart.second)

  const results: Instance[] = []
  const seenLocal = new Set<string>()
  const localKey = (v: IcsDate) => `${v.type}|${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}`

  /**
   * Add an instance. For recurring occurrences the end is start+masterLength
   * (the master's DTEND is an absolute value that must not be reused); an
   * override with its own DTEND uses its own span.
   */
  const addInstance = (ev: VEvent, localStart: IcsDate, overridden: boolean, isRecurring: boolean) => {
    const key = localKey(localStart)
    if (seenLocal.has(key)) return
    const startMs = toUtcMs(localStart, defaultTz)
    let endMs: number
    const useOwnEnd = (!isRecurring || overridden) && !!ev.dtEnd
    if (useOwnEnd) {
      endMs = toUtcMs(ev.dtEnd!, defaultTz)
    } else if (ev.duration) {
      endMs = startMs + durationToMs(ev.duration)
    } else if (len > 0) {
      endMs = startMs + len
    } else {
      endMs = startMs
    }
    const inst: Instance = {
      uid: ev.uid,
      localStart,
      startMs,
      endMs,
      offsetMin: localStart.tzid && !localStart.utc ? toWall(startMs, localStart.tzid).offsetMin : undefined,
      allDay: isAllDay(localStart),
      summary: ev.summary,
      location: ev.location,
      description: ev.description,
      status: ev.status ?? 'CONFIRMED',
      recurrenceId: overridden ? localStart : undefined,
      overridden,
    }
    // range semantics
    if (opts.startInRange) {
      if (!(startMs >= opts.rangeStartMs && startMs < opts.rangeEndMs)) return
    } else if (!(inst.startMs < opts.rangeEndMs && inst.endMs > opts.rangeStartMs)) {
      return
    }
    if (inst.status === 'CANCELLED' && !opts.includeCancelled) return
    seenLocal.add(key)
    results.push(inst)
  }

  if (!master.rrule) {
    if (!master.exdates.some((ex) => sameLocalValue(ex, dtStart))) {
      const ov = findOverrideByLocal(overrides, dtStart)
      if (ov) addInstance(ov, ov.dtStart ?? dtStart, true, false)
      else addInstance(master, dtStart, false, false)
    }
    // RDATE-only recurrence sets (RFC 5545): extra occurrences with no RRULE.
    for (const rd of master.rdates) {
      if (master.exdates.some((ex) => sameLocalValue(ex, rd))) continue
      const ov = findOverrideByLocal(overrides, rd)
      // treat as recurring so the end is start+master length (never the
      // master's absolute DTEND)
      if (ov) addInstance(ov, ov.dtStart ?? rd, true, true)
      else addInstance(master, rd, false, true)
      if (results.length > maxInstances) break
    }
  } else {
    const rr = parseRrule(master.rrule)
    const windowStart = opts.rangeStartMs - len
    const expanded = expandRrule(rr, wall, {
      tzid: tz,
      windowStartMs: windowStart,
      windowEndMs: opts.rangeEndMs,
      maxResults: maxInstances,
    })
    for (const e of expanded) {
      const localStart: IcsDate = allDay
        ? { type: 'date', year: e.wall.year, month: e.wall.month, day: e.wall.day, hour: 0, minute: 0, second: 0, tzid: master.dtStart.tzid }
        : {
            type: 'date-time',
            year: e.wall.year, month: e.wall.month, day: e.wall.day,
            hour: e.wall.hour, minute: e.wall.minute, second: e.wall.second,
            tzid: master.dtStart.tzid,
            utc: master.dtStart.utc,
          }
      if (master.exdates.some((ex) => sameLocalValue(ex, localStart))) continue
      const ov = findOverrideByLocal(overrides, localStart)
      if (ov) addInstance(ov, ov.dtStart ?? localStart, true, true)
      else addInstance(master, localStart, false, true)
    }
    // RDATE extra occurrences
    for (const rd of master.rdates) {
      if (master.exdates.some((ex) => sameLocalValue(ex, rd))) continue
      const ov = findOverrideByLocal(overrides, rd)
      if (ov) addInstance(ov, ov.dtStart ?? rd, true, true)
      else addInstance(master, rd, false, true)
      if (results.length > maxInstances) break
    }
  }

  results.sort((a, b) => a.startMs - b.startMs || localKey(a.localStart).localeCompare(localKey(b.localStart)))
  if (results.length > maxInstances) return results.slice(0, maxInstances)
  return results
}

/** Find the override whose RECURRENCE-ID equals the local value, if any. */
export function findOverride(series: Series, localValue: IcsDate): VEvent | undefined {
  return series.overrides.find((ov) => ov.recurrenceId && sameLocalValue(ov.recurrenceId, localValue))
}

function findOverrideByLocal(overrides: VEvent[], localValue: IcsDate): VEvent | undefined {
  return overrides.find((ov) => ov.recurrenceId && sameLocalValue(ov.recurrenceId, localValue))
}

export interface InstancePatch {
  summary?: string
  description?: string
  location?: string
  start?: IcsDate
  end?: IcsDate
  duration?: VEvent['duration']
}

/**
 * Create or replace the override VEVENT for a single occurrence, preserving
 * the master series untouched. `instanceLocal` is the original occurrence's
 * local start (becomes RECURRENCE-ID).
 */
export function updateSingleInstance(series: Series, instanceLocal: IcsDate, patch: InstancePatch): VEvent {
  const existing = findOverride(series, instanceLocal)
  const base: VEvent = {
    uid: series.master.uid,
    summary: existing?.summary ?? series.master.summary,
    description: existing?.description ?? series.master.description,
    location: existing?.location ?? series.master.location,
    status: existing?.status ?? series.master.status ?? 'CONFIRMED',
    categories: existing?.categories ?? [...series.master.categories],
    exdates: [],
    rdates: [],
    alarms: existing?.alarms ?? [],
    extra: existing?.extra ?? [],
  }
  const out: VEvent = {
    ...base,
    uid: series.master.uid || 'unknown',
    summary: patch.summary ?? base.summary,
    description: patch.description !== undefined ? patch.description : base.description,
    location: patch.location !== undefined ? patch.location : base.location,
    // keep an existing override's own times when the patch does not move it
    dtStart: patch.start ? cloneIcsDate(patch.start) : (existing?.dtStart ? cloneIcsDate(existing.dtStart) : cloneIcsDate(instanceLocal)),
    dtEnd: patch.end ? cloneIcsDate(patch.end) : existing?.dtEnd ? cloneIcsDate(existing.dtEnd) : undefined,
    duration: patch.duration !== undefined ? patch.duration : existing?.duration,
    recurrenceId: cloneIcsDate(instanceLocal),
  }
  return out
}

/**
 * Delete a single occurrence by writing a CANCELLED override for that
 * instance (standard CalDAV pattern).
 */
export function deleteSingleInstance(series: Series, instanceLocal: IcsDate): VEvent {
  const existing = findOverride(series, instanceLocal)
  const uid = series.master.uid || 'unknown'
  const out: VEvent = {
    uid,
    summary: existing?.summary ?? series.master.summary,
    description: existing?.description ?? series.master.description,
    location: existing?.location ?? series.master.location,
    status: 'CANCELLED',
    categories: existing?.categories ?? [...series.master.categories],
    dtStart: existing?.dtStart ?? cloneIcsDate(instanceLocal),
    dtEnd: existing?.dtEnd,
    recurrenceId: cloneIcsDate(instanceLocal),
    exdates: existing?.exdates ?? [],
    rdates: existing?.rdates ?? [],
    alarms: existing?.alarms ?? [],
    extra: existing?.extra ?? [],
  }
  return out
}

/** Remove the override for a given occurrence (used to un-cancel / revert). */
export function removeOverride(series: Series, instanceLocal: IcsDate): Series {
  return {
    ...series,
    overrides: series.overrides.filter((ov) => !(ov.recurrenceId && sameLocalValue(ov.recurrenceId, instanceLocal))),
  }
}

/** Flatten a series back to the list of VEVENTs to store (master + overrides). */
export function seriesToVEvents(series: Series): VEvent[] {
  return [series.master, ...series.overrides]
}

/** Convenience: master VEvent with a helper to find instances (used by tests). */
export function instanceMinuteCount(inst: Instance): number {
  return Math.round((inst.endMs - inst.startMs) / 60000)
}


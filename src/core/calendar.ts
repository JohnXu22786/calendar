/**
 * High-level calendar model: series-level conflict detection.
 *
 * A "series" is a master VEVENT plus its single-instance overrides (see
 * recurrence.ts). Conflicts are computed by expanding both sides over a time
 * range and testing pairwise overlap of concrete instances.
 */

import { expandSeries, type Instance, type Series } from './recurrence.js'
import { utcToWall, makeWall, formatWall } from './tz.js'

export interface Conflict {
  /** uid of the series that collides */
  otherUid: string
  otherSummary: string
  otherStatus: string
  /** the colliding concrete instance's span (UTC ms) */
  instanceStartMs: number
  instanceEndMs: number
  /** the candidate instance's span (UTC ms) */
  candidateStartMs: number
  candidateEndMs: number
  /** overlap duration in ms */
  overlapMs: number
  /** human-readable hint (in the configured default timezone) */
  hint: string
}

export interface ConflictOptions {
  rangeStartMs: number
  rangeEndMs: number
  defaultTz: string
  /** uids to skip (e.g. the event being updated) */
  excludeUids?: Set<string> | string[]
  /** cap on returned conflicts */
  maxResults?: number
}

function toSet(uids: Set<string> | string[] | undefined): Set<string> | undefined {
  if (uids === undefined) return undefined
  return Array.isArray(uids) ? new Set(uids) : uids
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
}

function hintOf(tzid: string, ms: number): string {
  const w = utcToWall(ms, tzid).wall
  return formatWall(w)
}

/**
 * Find all concrete-instance overlaps between an existing series collection
 * and a candidate series within the time window. CANCELLED instances (and
 * override-cancelled occurrences) never conflict.
 */
export function findConflicts(others: Series[], candidate: Series, opts: ConflictOptions): Conflict[] {
  const exclude = toSet(opts.excludeUids)
  const maxResults = opts.maxResults ?? 200
  const out: Conflict[] = []

  const candInstances: Instance[] = expandSeries(candidate, {
    rangeStartMs: opts.rangeStartMs,
    rangeEndMs: opts.rangeEndMs,
    defaultTz: opts.defaultTz,
    maxInstances: 2000,
  })

  for (const other of others) {
    if (exclude?.has(other.master.uid)) continue
    if (other.master.uid === candidate.master.uid) continue
    const otherInstances: Instance[] = expandSeries(other, {
      rangeStartMs: opts.rangeStartMs,
      rangeEndMs: opts.rangeEndMs,
      defaultTz: opts.defaultTz,
      maxInstances: 2000,
    })
    for (const oi of otherInstances) {
      if (oi.status === 'CANCELLED') continue
      for (const ci of candInstances) {
        if (ci.status === 'CANCELLED') continue
        const ov = overlapMs(ci.startMs, ci.endMs, oi.startMs, oi.endMs)
        if (ov > 0) {
          out.push({
            otherUid: oi.uid,
            otherSummary: oi.summary,
            otherStatus: oi.status,
            instanceStartMs: oi.startMs,
            instanceEndMs: oi.endMs,
            candidateStartMs: ci.startMs,
            candidateEndMs: ci.endMs,
            overlapMs: ov,
            hint: `overlaps "${oi.summary}" on ${hintOf(opts.defaultTz, oi.startMs)}`,
          })
          if (out.length >= maxResults) return out
        }
      }
    }
  }

  out.sort((a, b) => a.candidateStartMs - b.candidateStartMs || a.instanceStartMs - b.instanceStartMs)
  return out
}

/** Re-exported convenience for the tools' human-readable output. */
export function describeInstance(inst: Instance, tzid: string): string {
  const start = utcToWall(inst.startMs, tzid).wall
  const end = inst.endMs > inst.startMs ? utcToWall(inst.endMs, tzid).wall : null
  let s = formatWall(start)
  if (end) s += ` → ${formatWall(end)}`
  return s
}

void makeWall

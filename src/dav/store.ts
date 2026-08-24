/**
 * High-level calendar store on top of the CalDAV client.
 *
 * A remote series is one or more ICS resources (a master VEVENT plus any
 * RECURRENCE-ID override VEVENTs, either in separate resources or bundled in
 * one VCALENDAR). The store keeps href/etag bookkeeping so updates go through
 * the CalDAV optimistic-concurrency path (If-Match).
 */

import type { CalendarObject, CalendarInfo } from './client.js'
import { CalDavClient } from './client.js'
import { buildCalendar, parseCalendar, sameLocalValue, type IcsDate, type VEvent } from '../core/ics.js'
import { deleteSingleInstance, expandSeries, type Instance, type Series } from '../core/recurrence.js'
import { renderXml } from './xml.js'

export interface StoredItem {
  ev: VEvent
  href?: string
  etag?: string
}

export interface StoredSeries {
  items: StoredItem[]
}

export interface CalDavStoreOptions {
  client: CalDavClient
  /** preferred calendar collection URL; empty means auto-discovery */
  calendarUrl?: string
  defaultTz: string
  prodid?: string
}

export class CalDavStore {
  readonly client: CalDavClient
  readonly defaultTz: string
  private readonly preferredUrl?: string
  private readonly prodid: string
  private calendars?: CalendarInfo[]
  private chosen?: CalendarInfo

  constructor(opts: CalDavStoreOptions) {
    this.client = opts.client
    this.defaultTz = opts.defaultTz
    this.preferredUrl = opts.calendarUrl
    this.prodid = opts.prodid ?? '-//dsh-calendar//EN'
  }

  /** Resolve and cache the calendar collection URL (auto-discovery). */
  async calendarUrl(): Promise<string> {
    if (this.chosen) return this.chosen.url
    const cals = await this.listCalendars()
    const primary = cals[0]
    this.chosen = primary
    return primary.url
  }

  /** List calendars, the configured/first one first. */
  async listCalendars(): Promise<CalendarInfo[]> {
    if (!this.calendars) this.calendars = await this.client.resolveCalendars(this.preferredUrl)
    return this.calendars
  }

  private itemFromObject(obj: CalendarObject): StoredItem[] {
    let events: VEvent[]
    try {
      events = parseCalendar(obj.text).events
    } catch {
      return []
    }
    return events.map((ev) => ({ ev, href: obj.href, etag: obj.etag }))
  }

  private group(items: StoredItem[]): StoredSeries[] {
    const buckets = new Map<string, { master?: StoredItem; overrides: StoredItem[] }>()
    for (const it of items) {
      const b = buckets.get(it.ev.uid) ?? { overrides: [] }
      if (it.ev.recurrenceId) b.overrides.push(it)
      else if (!b.master) b.master = it
      else b.overrides.push(it)
      buckets.set(it.ev.uid, b)
    }
    const out: StoredSeries[] = []
    for (const [, b] of buckets) {
      if (!b.master) {
        // Only override resources were returned: promote the first as its own record.
        b.master = b.overrides.shift()
      }
      if (!b.master) continue
      out.push({ items: [b.master!, ...b.overrides] })
    }
    return out
  }

  /** List series with concrete instances overlapping the range. */
  async list(startMs: number, endMs: number, opts: { startInRange?: boolean; maxInstances?: number } = {}): Promise<Array<{ series: StoredSeries; instances: Instance[] }>> {
    const calendarUrl = await this.calendarUrl()
    const objects = await this.client.query(calendarUrl, startMs, endMs)
    const items: StoredItem[] = []
    for (const obj of objects) items.push(...this.itemFromObject(obj))
    const out: Array<{ series: StoredSeries; instances: Instance[] }> = []
    for (const s of this.group(items)) {
      const instances = expandSeries(toSeries(s), {
        rangeStartMs: startMs,
        rangeEndMs: endMs,
        defaultTz: this.defaultTz,
        startInRange: opts.startInRange,
        maxInstances: opts.maxInstances ?? 400,
      })
      if (instances.length === 0) continue
      out.push({ series: s, instances })
    }
    out.sort((a, b) => a.instances[0].startMs - b.instances[0].startMs)
    return out
  }

  /** Fetch a full series by UID. */
  async get(uid: string): Promise<StoredSeries | null> {
    const calendarUrl = await this.calendarUrl()
    const objects = await this.client.report(calendarUrl, reportBodyForUid(uid))
    const items: StoredItem[] = []
    for (const obj of objects) items.push(...this.itemFromObject(obj))
    const found = this.group(items)
    return found.find((s) => s.items.some((i) => i.ev.uid === uid)) ?? null
  }

  /** Create a new event (single VEVENT). */
  async create(ev: VEvent): Promise<StoredItem> {
    const calendarUrl = await this.calendarUrl()
    const text = buildCalendar([ev], { prodid: this.prodid })
    const result = await this.client.put(calendarUrl, text, { uid: ev.uid })
    return { ev, href: result.href, etag: result.etag }
  }

  /** Write a whole series back (master + overrides), preserving hrefs. */
  async update(stored: StoredSeries): Promise<void> {
    const calendarUrl = await this.calendarUrl()
    for (const item of stored.items) {
      const text = buildCalendar([item.ev], { prodid: this.prodid })
      if (item.href) {
        const result = await this.client.put(calendarUrl, text, { href: item.href, etag: item.etag })
        item.etag = result.etag ?? item.etag
      } else {
        // New override resources need a distinct file name so they do not
        // collide with the master's resource (the VEVENT UID stays identical).
        const resourceUid = item.ev.recurrenceId
          ? `${item.ev.uid}-r${stamp(item.ev.recurrenceId)}`
          : item.ev.uid
        const result = await this.client.put(calendarUrl, text, { uid: resourceUid })
        item.href = result.href
        item.etag = result.etag
      }
    }
  }

  /**
   * Delete a whole series, or a single occurrence when `recurrenceId` is
   * given (written as a CANCELLED override, standard CalDAV pattern).
   */
  async remove(uid: string, opts: { recurrenceId?: IcsDate; series?: StoredSeries } = {}): Promise<boolean> {
    const calendarUrl = await this.calendarUrl()
    const stored = opts.series ?? (await this.get(uid))
    if (!stored || stored.items.length === 0) return false

    if (opts.recurrenceId) {
      const master = stored.items.find((i) => !i.ev.recurrenceId)?.ev
      if (!master) return false
      const overrides = stored.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev)
      const cancelled = deleteSingleInstance({ master, overrides }, opts.recurrenceId)
      const existing = stored.items.find((i) => i.ev.recurrenceId && sameLocalValue(i.ev.recurrenceId, opts.recurrenceId!))
      const text = buildCalendar([cancelled], { prodid: this.prodid })
      if (existing?.href) {
        await this.client.put(calendarUrl, text, { href: existing.href, etag: existing.etag })
      } else {
        await this.client.put(calendarUrl, text, { uid: `${uid}-r${stamp(opts.recurrenceId)}` })
      }
      return true
    }

    const hrefs = [...new Set(stored.items.map((i) => i.href).filter((h): h is string => !!h))]
    if (hrefs.length === 0) return false
    for (const h of hrefs) await this.client.del(calendarUrl, h)
    return true
  }
}

/** Convert stored items to the pure Series used by recurrence logic. */
export function toSeries(stored: StoredSeries): Series {
  const master = stored.items.find((i) => !i.ev.recurrenceId)?.ev ?? stored.items[0].ev
  return {
    master,
    overrides: stored.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev),
  }
}

function reportBodyForUid(uid: string): string {
  return renderXml({
    prefix: 'C', local: 'calendar-query',
    children: [
      { prefix: 'D', local: 'prop', children: [{ prefix: 'D', local: 'getetag' }, { prefix: 'C', local: 'calendar-data' }] },
      {
        prefix: 'C', local: 'filter',
        children: [{
          prefix: 'C', local: 'comp-filter', attrs: { name: 'VCALENDAR' },
          children: [{
            prefix: 'C', local: 'comp-filter', attrs: { name: 'VEVENT' },
            children: [{
              prefix: 'C', local: 'prop-filter', attrs: { name: 'UID' },
              children: [{ prefix: 'C', local: 'text-match', attrs: { collation: 'i;octet', 'match-type': 'equals' }, children: [uid] }],
            }],
          }],
        }],
      },
    ],
  })
}

function stamp(v: IcsDate): string {
  return `${v.year}${String(v.month).padStart(2, '0')}${String(v.day).padStart(2, '0')}T${String(v.hour).padStart(2, '0')}${String(v.minute).padStart(2, '0')}${String(v.second).padStart(2, '0')}`
}

/**
 * High-level calendar operations shared by the dsh tools and the CLI.
 *
 * This layer translates between raw series/instances and JSON-friendly
 * "views", implements event creation/update/delete/search/conflicts/holidays
 * on top of the CalDAV store, and wires up authentication (Basic or Google
 * OAuth) from a CredentialResolver.
 */

import { CalDavStore, type StoredSeries } from './dav/store.js'
import { CalDavClient, basicAuth, bearerAuth, type AuthProvider, type CalendarInfo } from './dav/client.js'
import { GoogleOAuth, GOOGLE_CALDAV_ROOT } from './dav/oauth.js'
import { CredentialResolver, type CredentialServiceLike } from './credentials.js'
import { toUtcMs, type IcsDate, type VEvent } from './core/ics.js'
import { expandSeries, updateSingleInstance, type InstancePatch } from './core/recurrence.js'
import { findConflicts } from './core/calendar.js'
import {
  ganzhiZodiac,
  upcomingHolidays,
  type Ganzhi,
} from './core/lunar.js'
import { daysInMonth, formatWall, parseWall, utcToWall } from './core/tz.js'

export const SCOPES = 'https://www.googleapis.com/auth/calendar'

/* ------------------------------------------------------------------ */
/* Configuration & wiring                                               */
/* ------------------------------------------------------------------ */

export type AuthMode = 'basic' | 'google'

export interface ServiceConfig {
  authMode?: AuthMode
  /** discovery base URL for CalDAV (e.g. Nextcloud /remote.php/dav/) or an explicit calendar collection */
  serverUrl?: string
  /** explicit calendar collection URL (takes precedence over discovery) */
  calendarUrl?: string
  defaultTz?: string
  prodid?: string
  credentials?: CredentialResolver
  /** dsh credential service, when available */
  credentialService?: CredentialServiceLike
}

function env(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>
}

const REF_NAMES = {
  url: 'CALDAV_URL',
  username: 'CALDAV_USERNAME',
  password: 'CALDAV_PASSWORD',
  googleClientId: 'GOOGLE_CLIENT_ID',
  googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  googleRefreshToken: 'GOOGLE_CALDAV_REFRESH_TOKEN',
} as const

export interface BuiltService {
  client: CalDavClient
  store: CalDavStore
  credentials: CredentialResolver
  defaultTz: string
  authMode: AuthMode
  calendars(): Promise<CalendarInfo[]>
}

/** Strip URL userinfo (user:pass@) from a configured base URL at build time,
 *  so secret material never flows into hrefs, calendar listings or logs. */
export function stripUserinfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/i, '$1')
}

/** Build a wired service from config + credentials. Never logs secrets. */
export async function buildService(config: ServiceConfig): Promise<BuiltService> {
  const creds = config.credentials ?? new CredentialResolver({ service: config.credentialService })
  const defaultTz = config.defaultTz ?? env().DSH_CALENDAR_DEFAULT_TZ ?? 'Asia/Shanghai'
  const authMode: AuthMode = config.authMode ?? (env().GOOGLE_CLIENT_ID ? 'google' : 'basic')

  let client: CalDavClient
  let auth: AuthProvider

  if (authMode === 'google') {
    const clientId = (await creds.get(REF_NAMES.googleClientId)) ?? env().GOOGLE_CLIENT_ID
    const clientSecret = (await creds.get(REF_NAMES.googleClientSecret)) ?? env().GOOGLE_CLIENT_SECRET
    const refreshToken = (await creds.get(REF_NAMES.googleRefreshToken)) ?? env().GOOGLE_CALDAV_REFRESH_TOKEN
    if (!clientId) throw new Error('Google OAuth requires GOOGLE_CLIENT_ID (env or credential service)')
    // Persisting token store: refresh tokens rotated by Google are written back
    // through the same credential channel so a restarted process reuses them.
    const store = new PersistingTokenStore(creds, refreshToken)
    const oauth = new GoogleOAuth(clientId, store, clientSecret)
    auth = bearerAuth(() => oauth.accessToken())
    client = new CalDavClient({ baseUrl: stripUserinfo(config.serverUrl ?? GOOGLE_CALDAV_ROOT), auth })
  } else if (authMode === 'basic') {
    const serverUrl = config.serverUrl ?? config.calendarUrl
    if (!serverUrl) {
      const fromEnv = (await creds.get(REF_NAMES.url)) ?? env().CALDAV_URL
      if (!fromEnv) throw new Error('no CalDAV endpoint configured (set calendarUrl/serverUrl or CALDAV_URL)')
      auth = await basicAuthFrom(creds)
      client = new CalDavClient({ baseUrl: stripUserinfo(fromEnv), auth })
    } else {
      auth = await basicAuthFrom(creds)
      client = new CalDavClient({ baseUrl: stripUserinfo(serverUrl), auth })
    }
  } else {
    throw new Error(`unsupported auth mode "${authMode}"`)
  }

  const store = new CalDavStore({
    client,
    calendarUrl: config.calendarUrl ? stripUserinfo(config.calendarUrl) : undefined,
    defaultTz,
    prodid: config.prodid ?? '-//dsh-calendar//EN',
  })

  return {
    client,
    store,
    credentials: creds,
    defaultTz,
    authMode,
    calendars: () => store.listCalendars(),
  }
}

async function basicAuthFrom(creds: CredentialResolver): Promise<AuthProvider> {
  const username = (await creds.get(REF_NAMES.username)) ?? env().CALDAV_USERNAME
  const password = (await creds.get(REF_NAMES.password)) ?? env().CALDAV_PASSWORD
  if (!username || !password) throw new Error('Basic auth requires CALDAV_USERNAME and CALDAV_PASSWORD')
  return basicAuth(username, password)
}

/**
 * Token store that persists the refresh token through the credential resolver
 * (dsh credential service or the local secure file), so a process restart can
 * re-use a possibly-rotated refresh token without an extra exchange.
 */
class PersistingTokenStore {
  private cache?: import('./dav/oauth.js').TokenSet
  constructor(
    private readonly creds: CredentialResolver,
    private readonly initialRefreshToken?: string,
  ) {}

  async load(): Promise<import('./dav/oauth.js').TokenSet | undefined> {
    if (this.cache) return this.cache
    const rt = (await this.creds.get(REF_NAMES.googleRefreshToken)) ?? this.initialRefreshToken ?? env().GOOGLE_CALDAV_REFRESH_TOKEN
    if (rt) return { accessToken: '', refreshToken: rt, expiresAtMs: 0 }
    return undefined
  }

  async save(tokens: import('./dav/oauth.js').TokenSet): Promise<void> {
    this.cache = tokens
    if (tokens.refreshToken) {
      try {
        await this.creds.set(REF_NAMES.googleRefreshToken, tokens.refreshToken)
      } catch {
        // no writable backend; the in-memory value is enough for this process
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                                */
/* ------------------------------------------------------------------ */

export interface TimeView {
  utc: string
  wall: string
  tzid: string
  allDay: boolean
}

export interface EventView {
  uid: string
  summary: string
  description?: string
  location?: string
  status?: string
  categories: string[]
  allDay: boolean
  start: TimeView | null
  end: TimeView | null
  rrule?: string
  recurrenceId?: string
  seriesUid?: string
  href?: string
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString()
}

function wallOf(ms: number, tz: string): string {
  return formatWall(utcToWall(ms, tz).wall)
}

function timeView(v: IcsDate, ms: number, tz: string): TimeView | null {
  if (!v) return null
  return {
    utc: isoOf(ms),
    wall: wallOf(ms, tz),
    tzid: v.tzid ?? (v.utc ? 'UTC' : tz),
    allDay: v.type === 'date',
  }
}

export function instanceToView(inst: import('./core/recurrence.js').Instance, tz: string, href?: string): EventView {
  return {
    uid: inst.uid,
    summary: inst.summary,
    description: inst.description,
    location: inst.location,
    status: inst.status,
    categories: [],
    allDay: inst.allDay,
    start: timeView(inst.localStart, inst.startMs, tz),
    end: inst.endMs > inst.startMs ? { utc: isoOf(inst.endMs), wall: wallOf(inst.endMs, tz), tzid: inst.localStart.tzid ?? (inst.localStart.utc ? 'UTC' : tz), allDay: inst.allDay } : null,
    rrule: undefined,
    recurrenceId: inst.recurrenceId ? localIso(inst.recurrenceId) : undefined,
    seriesUid: inst.uid,
    href,
  }
}

function localIso(v: IcsDate): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${v.year}-${pad(v.month)}-${pad(v.day)}T${pad(v.hour)}:${pad(v.minute)}:${pad(v.second)}`
}

/* ------------------------------------------------------------------ */
/* Operations                                                           */
/* ------------------------------------------------------------------ */

export interface ListArgs {
  start?: string
  end?: string
  tz?: string
  count?: number
}

export interface OperationResult {
  events: EventView[]
  warnings?: string[]
}

/** Resolve a "YYYY-MM-DD[ HH:MM[:SS]]" or ISO-8601 start into an IcsDate. */
export function parseDateArg(value: string, tz: string, allDay: boolean): IcsDate {
  const trimmed = (value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?Z?)?$/.test(trimmed)) {
    throw new RangeError(`invalid date-time "${value}" (use "YYYY-MM-DD[ HH:MM[:SS]]")`)
  }
  const hasTime = /\d{2}:\d{2}/.test(trimmed)
  const isUtc = /Z$/i.test(trimmed) && hasTime
  const wall = parseWall(trimmed.replace(/Z$/i, ''))
  // range validation (GI: Date.UTC silently normalizes out-of-range values)
  if (wall.month < 1 || wall.month > 12) throw new RangeError(`invalid month in "${value}"`)
  const dim = daysInMonth(wall.year, wall.month)
  if (wall.day < 1 || wall.day > dim) throw new RangeError(`invalid day ${wall.day} for ${wall.year}-${wall.month} in "${value}"`)
  if (wall.hour < 0 || wall.hour > 23 || wall.minute < 0 || wall.minute > 59 || wall.second < 0 || wall.second > 60) {
    throw new RangeError(`invalid time in "${value}"`)
  }
  if (allDay || !hasTime) {
    // all-day: interpreted in the requested timezone
    if (tz && tz !== 'UTC') {
      return { type: 'date', year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0, tzid: tz }
    }
    return { type: 'date', year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 }
  }
  if (isUtc) {
    return { type: 'date-time', year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second, utc: true }
  }
  if (tz && tz !== 'UTC') {
    return { type: 'date-time', year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second, tzid: tz }
  }
  return { type: 'date-time', year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second, utc: true }
}

export class CalendarService {
  constructor(
    readonly store: CalDavStore,
    readonly tz: string,
    readonly creds: CredentialResolver,
  ) {}

  /** List accessible calendar collections. */
  async calendars(): Promise<CalendarInfo[]> {
    return this.store.listCalendars()
  }

  /** List events (optionally within a [start,end] window). */
  async list(args: ListArgs): Promise<OperationResult> {
    const tz = args.tz ?? this.tz
    const endMs = args.end
      ? toUtcMs(parseDateArg(args.end, tz, true), tz) + DAYMS
      : Date.now() + 8 * DAYMS
    const startMs = args.start ? toUtcMs(parseDateArg(args.start, tz, true), tz) : Date.now() - DAYMS
    const rows = await this.store.list(startMs, endMs, { maxInstances: args.count ?? 100 })
    const events = rows.flatMap(({ series, instances }) => instances.map((i) => instanceToView(i, tz, series.items[0]?.href)))
    events.sort((a, b) => (a.start?.utc ?? '').localeCompare(b.start?.utc ?? ''))
    if (args.count) return { events: events.slice(0, args.count) }
    return { events }
  }

  /** Fetch a single series (master + its concrete occurrences in a window). */
  async get(uid: string, args: { start?: string; end?: string; tz?: string } = {}): Promise<{ series: EventView[]; master: EventView | null } | null> {
    const stored = await this.store.get(uid)
    if (!stored) return null
    const tz = args.tz ?? this.tz
    const startMs = args.start ? toUtcMs(parseDateArg(args.start, tz, true), tz) : Date.now() - 30 * DAYMS
    const endMs = args.end ? toUtcMs(parseDateArg(args.end, tz, true), tz) : Date.now() + 365 * DAYMS
    const masterEv = stored.items.find((i) => !i.ev.recurrenceId)?.ev
    const instances = expandSeries({
      master: masterEv ?? stored.items[0].ev,
      overrides: stored.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev),
    }, { rangeStartMs: startMs, rangeEndMs: endMs, defaultTz: tz })
    return {
      master: masterEv ? eventToView(masterEv, tz, stored.items[0]?.href) : null,
      series: instances.map((i) => instanceToView(i, tz, stored.items[0]?.href)),
    }
  }

  /** Create an event, optionally checking conflicts first. */
  async create(args: CreateArgs): Promise<{ event: EventView; conflicts: ConflictView[] }> {
    const tz = args.tz ?? this.tz
    const allDay = !!args.allDay
    const start = parseDateArg(args.start, tz, allDay)
    let end: IcsDate | undefined
    if (args.end) end = parseDateArg(args.end, tz, allDay)
    const ev: VEvent = makeVEvent({
      uid: args.uid ?? randomUid(),
      summary: args.summary,
      description: args.description,
      location: args.location,
      categories: args.categories ?? [],
      status: args.status ?? 'CONFIRMED',
      start,
      end,
      rrule: args.rrule,
      exdates: (args.exdates ?? []).map((s) => parseDateArg(s, tz, allDay)),
      rdates: (args.rdates ?? []).map((s) => parseDateArg(s, tz, allDay)),
    })
    const stored = await this.store.create(ev)
    const view = eventToView(ev, tz, stored.href)
    const conflicts = args.checkConflicts !== false ? await this.checkConflictsFor(ev, tz) : []
    return { event: view, conflicts }
  }

  /** Update a whole series or a single occurrence (via RECURRENCE-ID). */
  async update(uid: string, patch: UpdatePatch): Promise<{ event: EventView | null; conflicts: ConflictView[] }> {
    const stored = await this.store.get(uid)
    if (!stored) throw new Error(`event "${uid}" not found`)
    const tz = patch.tz ?? this.tz
    const points = stored.items.map((i) => i.ev)

    if (patch.recurrenceId) {
      const rid = await this.resolveOccurrence(stored, patch.recurrenceId, tz)
      const master = points.find((e) => !e.recurrenceId) ?? stored.items[0].ev
      const instancePatch0: InstancePatch = {
        summary: patch.summary,
        description: patch.description,
        location: patch.location,
      }
      const newStart = patch.start ? parseDateArg(patch.start, tz, !!patch.allDay) : undefined
      const newEnd = patch.end ? parseDateArg(patch.end, tz, !!patch.allDay) : undefined
      if (newStart) instancePatch0.start = newStart
      if (newEnd) instancePatch0.end = newEnd
      const updated = updateSingleInstance({ master, overrides: points.filter((e) => e.recurrenceId) }, rid, instancePatch0)
      const nextItems = stored.items.map((i) => (!i.ev.recurrenceId ? i : sameLocalV(i.ev.recurrenceId!, rid) ? { ...i, ev: updated } : i))
      const hasExisting = stored.items.some((i) => i.ev.recurrenceId && sameLocalV(i.ev.recurrenceId!, rid))
      const items = hasExisting ? nextItems : [...stored.items, { ev: updated }]
      const stored2: StoredSeries = { items }
      await this.store.update(stored2)
      const instances = expandSeries({
        master,
        overrides: items.filter((i) => i.ev.recurrenceId).map((i) => i.ev),
      }, { rangeStartMs: toUtcMs(newStart ?? rid, tz) - DAYMS, rangeEndMs: toUtcMs(newEnd ?? rid, tz) + 2 * DAYMS, defaultTz: tz })
      const view = instances.find((i) => i.recurrenceId) ? instanceToView(instances.find((i) => i.recurrenceId)!, tz) : null
      return { event: view, conflicts: [] }
    }

    // whole-series update
    const ev = stored.items[0].ev
    if (patch.summary !== undefined) ev.summary = patch.summary
    if (patch.description !== undefined) ev.description = patch.description
    if (patch.location !== undefined) ev.location = patch.location
    if (patch.status !== undefined) ev.status = patch.status
    if (patch.categories !== undefined) ev.categories = patch.categories
    if (patch.start) ev.dtStart = parseDateArg(patch.start, tz, !!patch.allDay)
    if (patch.end !== undefined) {
      ev.dtEnd = patch.end ? parseDateArg(patch.end, tz, !!patch.allDay) : undefined
    }
    if (patch.rrule !== undefined) ev.rrule = patch.rrule || undefined
    if (patch.exdates !== undefined) ev.exdates = patch.exdates.map((s) => parseDateArg(s, tz, !!patch.allDay))
    if (patch.rdates !== undefined) ev.rdates = patch.rdates.map((s) => parseDateArg(s, tz, !!patch.allDay))
    await this.store.update(stored)
    const conflicts = patch.checkConflicts !== false ? await this.checkConflictsFor(ev, tz, [uid]) : []
    return { event: eventToView(ev, tz, stored.items[0]?.href), conflicts }
  }

  /** Delete a whole series or a single occurrence. */
  async remove(uid: string, recurrenceId?: string): Promise<{ removed: boolean; note?: string }> {
    if (recurrenceId) {
      const tz = this.tz
      const stored = await this.store.get(uid)
      if (!stored) return { removed: false, note: 'series not found' }
      const rid = await this.resolveOccurrence(stored, recurrenceId, tz)
      const ok = await this.store.remove(uid, { recurrenceId: rid, series: stored })
      return { removed: ok, note: ok ? undefined : 'series not found' }
    }
    const ok = await this.store.remove(uid)
    return { removed: ok, note: ok ? undefined : 'series not found' }
  }

  /** Text search across events in a window. */
  async search(query: string, args: { start?: string; end?: string; tz?: string } = {}): Promise<OperationResult> {
    const tz = args.tz ?? this.tz
    const q = query.toLowerCase()
    const endMs = args.end ? toUtcMs(parseDateArg(args.end, tz, true), tz) : Date.now() + 7 * DAYMS
    const startMs = args.start ? toUtcMs(parseDateArg(args.start, tz, true), tz) : Date.now() - 30 * DAYMS
    const rows = await this.store.list(startMs, endMs, { maxInstances: 500 })
    const events = rows
      .flatMap(({ series, instances }) => instances.map((i) => instanceToView(i, tz, series.items[0]?.href)))
      .filter((e) =>
        e.summary.toLowerCase().includes(q) ||
        (e.description?.toLowerCase().includes(q) ?? false) ||
        (e.location?.toLowerCase().includes(q) ?? false),
      )
    return { events }
  }

  /** Conflict check for a proposed (or existing) event. */
  async conflicts(uid: string | undefined, spec: ConflictSpec): Promise<ConflictView[]> {
    const tz = spec.tz ?? this.tz
    const startMs = toUtcMs(parseDateArg(spec.start, tz, !!spec.allDay), tz)
    const endMs = spec.end ? toUtcMs(parseDateArg(spec.end, tz, !!spec.allDay), tz) : startMs
    const rangeStart = startMs - DAYMS
    const rangeEnd = endMs + 30 * DAYMS
    const others = await this.store.list(rangeStart, rangeEnd, { maxInstances: 2000 })
    const othersSeries = others.map((r) => ({ master: r.series.items.find((i) => !i.ev.recurrenceId)?.ev ?? r.series.items[0].ev, overrides: r.series.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev) }))

    let candidateMaster: VEvent
    let overrideItems: VEvent[] = []
    if (uid && spec.start === undefined) {
      const stored = await this.store.get(uid)
      if (!stored) throw new Error(`event "${uid}" not found`)
      candidateMaster = stored.items.find((i) => !i.ev.recurrenceId)?.ev ?? stored.items[0].ev
      overrideItems = stored.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev)
    } else {
      const allDay = !!spec.allDay
      const start = parseDateArg(spec.start, tz, allDay)
      const end = spec.end ? parseDateArg(spec.end, tz, allDay) : undefined
      candidateMaster = makeVEvent({
        uid: uid ?? randomUid(),
        summary: spec.summary ?? uid ?? '(new event)',
        categories: [],
        status: 'CONFIRMED',
        start,
        end,
        rrule: spec.rrule,
        rdates: [],
        exdates: [],
      })
    }
    const conflicts = findConflicts(othersSeries, { master: candidateMaster, overrides: overrideItems }, {
      rangeStartMs: rangeStart,
      rangeEndMs: rangeEnd,
      defaultTz: tz,
      excludeUids: uid ? [uid] : undefined,
    })
    return conflicts.map((c) => ({
      uid: c.otherUid,
      summary: c.otherSummary,
      startMs: c.instanceStartMs,
      endMs: c.instanceEndMs,
      overlapMs: c.overlapMs,
      hint: c.hint,
      candidateStart: isoOf(c.candidateStartMs),
      candidateEnd: isoOf(c.candidateEndMs),
    }))
  }

  /** Chinese-bias helpers: holidays, ganzhi/zodiac, lunar date. */
  async chinese(args: { after?: string; days?: number }): Promise<{ holidays: HolidayView[]; today?: { date: string; ganzhi: Ganzhi; lunar?: string } }> {
    const after = args.after ? parseWall(args.after) : utcToWall(Date.now(), this.tz).wall
    const days = args.days ?? 30
    const hs = upcomingHolidays({ year: after.year, month: after.month, day: after.day }, days)
    const today = args.after === undefined
      ? (() => {
          const w = utcToWall(Date.now(), this.tz).wall
          const g = ganzhiZodiac(w.year, w.month, w.day)
          return { date: formatWall(w), ganzhi: g }
        })()
      : undefined
    return {
      holidays: hs.map((h) => ({
        key: h.key,
        name: h.name,
        nameEn: h.nameEn,
        date: `${h.date.year}-${String(h.date.month).padStart(2, '0')}-${String(h.date.day).padStart(2, '0')}`,
        lunar: h.lunar ? `${h.lunar.year}年${h.lunar.leap ? '闰' : ''}${h.lunar.month}月${h.lunar.day}日` : undefined,
      })),
      today,
    }
  }

  /** Reminder plan for an event's upcoming occurrences (schedule_create-compatible). */
  async reminderPlan(uid: string, args: { before?: string; tz?: string; until?: string; prompt?: string; now?: string } = {}) {
    const stored = await this.store.get(uid)
    if (!stored) throw new Error(`event "${uid}" not found`)
    const tz = args.tz ?? this.tz
    const master = stored.items.find((i) => !i.ev.recurrenceId)?.ev ?? stored.items[0].ev
    const now = (args.now
      ? toUtcMs(parseDateArg(args.now, tz, false), tz)
      : Date.now()) || Date.now()
    const untilMs = args.until ? toUtcMs(parseDateArg(args.until, tz, true), tz) : now + 30 * DAYMS
    const instances = expandSeries({
      master,
      overrides: stored.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev),
    }, { rangeStartMs: now, rangeEndMs: untilMs, defaultTz: tz })
    const beforeMin = parseBefore(args.before)
    return {
      event: uid,
      occurrences: instances.map((i) => {
        const w = utcToWall(i.startMs, tz).wall
        const pad = (n: number) => String(n).padStart(2, '0')
        return {
          at: {
            date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
            time: `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`,
            time_zone: tz,
          },
          wall: wallOf(i.startMs, tz),
          utc: isoOf(i.startMs),
          prompt: args.prompt ?? `reminder: "${i.summary}" at ${wallOf(i.startMs, tz)}`,
        }
      }),
      reminderBeforeMinutes: beforeMin,
      note: 'Pass an occurrence’s `at`/`prompt` to the dsh `schedule_create` tool to register a session reminder.',
    }
  }

  /**
   * Resolve a user-supplied recurrence target ("YYYY-MM-DD HH:MM" in `tz`)
   * to the occurrence's canonical stored local value. Occurrences seen in the
   * calendar timezone map to the master's representation (which may be UTC).
   */
  private async resolveOccurrence(stored: StoredSeries, requestValue: string, tz: string): Promise<IcsDate> {
    const parsed = parseDateArg(requestValue, tz, false)
    const targetMs = toUtcMs(parsed, tz)
    const master = stored.items.find((i) => !i.ev.recurrenceId)?.ev ?? stored.items[0].ev
    const overrides = stored.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev)
    const instances = expandSeries({ master, overrides }, {
      rangeStartMs: targetMs - 2 * DAYMS,
      rangeEndMs: targetMs + 2 * DAYMS,
      defaultTz: tz,
      includeCancelled: true,
    })
    const exact = instances.find((i) => i.startMs === targetMs)
    if (exact) return exact.localStart
    const close = instances.find((i) => Math.abs(i.startMs - targetMs) < 2000)
    if (close) return close.localStart
    throw new Error(`no occurrence of "${master.uid}" found at "${requestValue}" (${tz})`)
  }

  private async checkConflictsFor(ev: VEvent, tz: string, excludeUids?: string[]): Promise<ConflictView[]> {
    const startMs = ev.dtStart ? toUtcMs(ev.dtStart, tz) : Date.now()
    const endMs = ev.dtEnd ? toUtcMs(ev.dtEnd, tz) : startMs
    const rangeStart = startMs - DAYMS
    const rangeEnd = endMs + 30 * DAYMS
    const others = await this.store.list(rangeStart, rangeEnd, { maxInstances: 1000 })
    const othersSeries = others.map((r) => ({ master: r.series.items.find((i) => !i.ev.recurrenceId)?.ev ?? r.series.items[0].ev, overrides: r.series.items.filter((i) => i.ev.recurrenceId).map((i) => i.ev) }))
    const conflicts = findConflicts(othersSeries, { master: ev, overrides: [] }, {
      rangeStartMs: rangeStart,
      rangeEndMs: rangeEnd,
      defaultTz: tz,
      excludeUids,
    })
    return conflicts.map((c) => ({
      uid: c.otherUid,
      summary: c.otherSummary,
      startMs: c.instanceStartMs,
      endMs: c.instanceEndMs,
      overlapMs: c.overlapMs,
      hint: c.hint,
      candidateStart: isoOf(c.candidateStartMs),
      candidateEnd: isoOf(c.candidateEndMs),
    }))
  }
}

const DAYMS = 86400000

export interface CreateArgs {
  uid?: string
  summary: string
  description?: string
  location?: string
  categories?: string[]
  status?: string
  start: string
  end?: string
  allDay?: boolean
  tz?: string
  rrule?: string
  exdates?: string[]
  rdates?: string[]
  checkConflicts?: boolean
}

export interface UpdatePatch {
  summary?: string
  description?: string
  location?: string
  status?: string
  categories?: string[]
  start?: string
  end?: string
  allDay?: boolean
  tz?: string
  rrule?: string
  exdates?: string[]
  rdates?: string[]
  recurrenceId?: string
  checkConflicts?: boolean
}

export interface ConflictSpec {
  uid?: string
  summary?: string
  start: string
  end?: string
  allDay?: boolean
  tz?: string
  rrule?: string
}

export interface ConflictView {
  uid: string
  summary: string
  startMs: number
  endMs: number
  overlapMs: number
  hint: string
  candidateStart: string
  candidateEnd: string
}

export interface HolidayView {
  key: string
  name: string
  nameEn: string
  date: string
  lunar?: string
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function randomUid(): string {
  return `dsh-cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@dsh`
}

export function makeVEvent(input: {
  uid: string
  summary: string
  description?: string
  location?: string
  categories: string[]
  status?: string
  start: IcsDate
  end?: IcsDate
  rrule?: string
  exdates: IcsDate[]
  rdates: IcsDate[]
}): VEvent {
  return {
    uid: input.uid,
    summary: input.summary,
    description: input.description,
    location: input.location,
    status: input.status ?? 'CONFIRMED',
    categories: input.categories,
    dtStart: input.start,
    dtEnd: input.end,
    rrule: input.rrule,
    exdates: input.exdates,
    rdates: input.rdates,
    alarms: [],
    extra: [],
    dtstamp: Date.now(),
  }
}

export function eventToView(ev: VEvent, tz: string, href?: string): EventView {
  const startMs = ev.dtStart ? toUtcMs(ev.dtStart, tz) : 0
  const endMs = ev.dtEnd ? toUtcMs(ev.dtEnd, tz) : startMs
  return {
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    status: ev.status,
    categories: ev.categories,
    allDay: ev.dtStart?.type === 'date',
    start: ev.dtStart ? timeView(ev.dtStart, startMs, tz) : null,
    end: ev.dtEnd ? { utc: isoOf(endMs), wall: wallOf(endMs, tz), tzid: ev.dtEnd.tzid ?? (ev.dtEnd.utc ? 'UTC' : tz), allDay: ev.dtEnd.type === 'date' } : null,
    rrule: ev.rrule,
    href,
  }
}

function sameLocalV(a: IcsDate, b: IcsDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second && a.type === b.type
}

function parseBefore(value: string | undefined): number {
  if (!value) return 10
  const m = /^(\d+)\s*(m|min|h|hr|d)?$/.exec(value.trim())
  if (!m) return 10
  const n = Number(m[1])
  switch (m[2]) {
    case 'h': case 'hr': return n * 60
    case 'd': return n * 24 * 60
    default: return n
  }
}

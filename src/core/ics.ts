/**
 * Self-implemented iCalendar (RFC 5545) parser and serializer covering the
 * subset needed by a CalDAV calendar: VCALENDAR / VEVENT / VTIMEZONE /
 * VALARM, property parameters, line folding, value escaping, all-day dates,
 * timezone-tagged and UTC date-times, RRULE / EXDATE / RDATE /
 * RECURRENCE-ID. Unknown properties and sub-components are preserved so an
 * event fetched from a server can be edited and written back losslessly.
 */

import { formatIsoDuration, parseIsoDuration, type Duration } from './duration.js'
import { makeWall, wallToUTCms, type Wall } from './tz.js'

/* ------------------------------------------------------------------ */
/* Date-time value model                                                */
/* ------------------------------------------------------------------ */

export interface IcsDate {
  /** all-day = 'date', timed = 'date-time' */
  type: 'date' | 'date-time'
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** wall-clock timezone id (RFC TZID) when the value is neither UTC nor floating */
  tzid?: string
  /** trailing "Z" suffix means UTC; only valid for date-time values */
  utc?: boolean
}

export function makeDate(year: number, month: number, day: number): IcsDate {
  return { type: 'date', year, month, day, hour: 0, minute: 0, second: 0 }
}

export function makeDateTime(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  opts: { tzid?: string; utc?: boolean } = {},
): IcsDate {
  return { type: 'date-time', year, month, day, hour, minute, second, tzid: opts.tzid, utc: opts.utc }
}

export function makeUtc(ms: number): IcsDate {
  const d = new Date(ms)
  return {
    type: 'date-time', utc: true,
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  }
}

export function cloneIcsDate(v: IcsDate): IcsDate {
  return { ...v }
}

export function isAllDay(v: IcsDate | undefined): v is IcsDate {
  return !!v && v.type === 'date'
}

/** RFC 5545 local-value equality: same type and same wall-clock fields. */
export function sameLocalValue(a: IcsDate, b: IcsDate): boolean {
  return a.type === b.type && a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second
}

export function toWall(v: IcsDate): Wall {
  return makeWall(v.year, v.month, v.day, v.hour, v.minute, v.second)
}

/**
 * Absolute (UTC ms) instant of a date value.
 * - UTC date-times convert directly.
 * - TZID / floating date-times convert using their zone (floating uses the
 *   default/session zone). All-day values start at midnight in that zone.
 */
export function toUtcMs(v: IcsDate, defaultTz: string): number {
  const wall = toWall(v)
  if (v.type === 'date') return wallToUTCms(wall, v.tzid ?? defaultTz)
  if (v.utc) return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second)
  return wallToUTCms(wall, v.tzid ?? defaultTz)
}

export function formatIcsDate(v: IcsDate): string {
  return `${String(v.year).padStart(4, '0')}${String(v.month).padStart(2, '0')}${String(v.day).padStart(2, '0')}`
}

export function formatIcsDateTime(v: IcsDate): string {
  const core = `${formatIcsDate(v)}T${String(v.hour).padStart(2, '0')}${String(v.minute).padStart(2, '0')}${String(v.second).padStart(2, '0')}`
  return v.utc ? `${core}Z` : core
}

/* ------------------------------------------------------------------ */
/* Content line model (name, params, value)                            */
/* ------------------------------------------------------------------ */

export interface IcsParam {
  key: string
  value: string
}

export interface IcsLine {
  name: string
  params: IcsParam[]
  value: string
}

/* ------------------------------------------------------------------ */
/* Component model                                                      */
/* ------------------------------------------------------------------ */

export class IcsComponent {
  name: string
  props: IcsLine[]
  children: IcsComponent[]

  constructor(name: string, props: IcsLine[] = [], children: IcsComponent[] = []) {
    this.name = name
    this.props = props
    this.children = children
  }

  prop(name: string): IcsLine | undefined {
    const upper = name.toUpperCase()
    return this.props.find((p) => p.name === upper)
  }

  propValues(name: string): string {
    return this.prop(name)?.value ?? ''
  }

  /** All lines with the given name (e.g. multiple EXDATE). */
  propAll(name: string): IcsLine[] {
    const upper = name.toUpperCase()
    return this.props.filter((p) => p.name === upper)
  }

  child(name: string): IcsComponent | undefined {
    const upper = name.toUpperCase()
    return this.children.find((c) => c.name === upper)
  }

  childrenOf(name: string): IcsComponent[] {
    const upper = name.toUpperCase()
    return this.children.filter((c) => c.name === upper)
  }
}

/* ------------------------------------------------------------------ */
/* Text encoding / escaping                                             */
/* ------------------------------------------------------------------ */

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

export function unescapeText(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\' && i + 1 < value.length) {
      const n = value[i + 1]
      if (n === 'n' || n === 'N') { out += '\n'; i++ }
      else if (n === '\\' || n === ';' || n === ',' || n === '"') { out += n; i++ }
      else { out += c } // keep unknown escapes verbatim
    } else {
      out += c
    }
  }
  return out
}

/**
 * Fold a content line at 75 octets per RFC 5545 §3.1, on UTF-8 byte count.
 */
export function foldLine(line: string): string {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
  if (bytes(line) <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of line) {
    const w = bytes(ch)
    const max = out.length === 0 ? 75 : 74
    if (curBytes > 0 && curBytes + w > max) {
      out.push(cur)
      cur = ' ' + ch
      curBytes = 1 + w
    } else {
      cur += ch
      curBytes += w
    }
  }
  if (cur.length) out.push(cur)
  return out.join('\r\n')
}

/* ------------------------------------------------------------------ */
/* Parser                                                               */
/* ------------------------------------------------------------------ */

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const raw of lines) {
    if (raw.length === 0) continue
    if ((raw[0] === ' ' || raw[0] === '\t') && out.length > 0) {
      out[out.length - 1] += raw.slice(1)
    } else {
      out.push(raw)
    }
  }
  return out
}

function splitFirst(value: string, sep: string): [string, string] {
  const idx = value.indexOf(sep)
  if (idx === -1) return [value, '']
  return [value.slice(0, idx), value.slice(idx + 1)]
}

function parseParams(paramsPart: string): IcsParam[] {
  const params: IcsParam[] = []
  if (!paramsPart) return params
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < paramsPart.length; i++) {
    const c = paramsPart[i]
    if (c === '"') quoted = !quoted
    if (c === ';' && !quoted) { tokens.push(current); current = ''; continue }
    current += c
  }
  tokens.push(current)
  for (const token of tokens) {
    if (!token) continue
    const [key, value] = splitFirst(token, '=')
    const clean = value.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    if (key) params.push({ key: key.toUpperCase(), value: clean })
  }
  return params
}

function parseLine(raw: string): IcsLine {
  const [head, value] = splitFirst(raw, ':')
  const semi = head.indexOf(';')
  const name = (semi === -1 ? head : head.slice(0, semi)).trim().toUpperCase()
  const paramsPart = semi === -1 ? '' : head.slice(semi + 1)
  return { name, params: parseParams(paramsPart), value }
}

function parseComponent(lines: string[], index: { i: number }): IcsComponent {
  const start = lines[index.i]
  const nameMatch = /^BEGIN:([A-Za-z0-9-]+)/.exec(start)
  if (!nameMatch) throw new Error(`expected BEGIN, got "${start}"`)
  const name = nameMatch[1].toUpperCase()
  const props: IcsLine[] = []
  const children: IcsComponent[] = []
  index.i++
  for (; index.i < lines.length; index.i++) {
    const line = lines[index.i]
    if (/^BEGIN:/.test(line)) {
      children.push(parseComponent(lines, index))
    } else if (/^END:/.test(line)) {
      return new IcsComponent(name, props, children)
    } else if (line.length > 0) {
      props.push(parseLine(line))
    }
  }
  throw new Error(`unterminated component ${name}`)
}

/* ------------------------------------------------------------------ */
/* Event-level typed model                                              */
/* ------------------------------------------------------------------ */

export interface VEvent {
  uid: string
  summary: string
  description?: string
  location?: string
  url?: string
  status?: string
  categories: string[]
  dtstamp?: number
  created?: number
  lastModified?: number
  sequence?: number
  dtStart?: IcsDate
  dtEnd?: IcsDate
  /** duration applies only when DTEND is absent */
  duration?: Duration
  recurrenceId?: IcsDate
  rrule?: string
  exdates: IcsDate[]
  rdates: IcsDate[]
  alarms: string[]
  /** preserved properties that are not part of the typed model */
  extra: { name: string; params: IcsParam[]; value: string }[]
}

export interface ParsedCalendar {
  version?: string
  prodid?: string
  calscale?: string
  method?: string
  timezones: IcsComponent[]
  events: VEvent[]
}

function splitValues(raw: string): string[] {
  // Split on unescaped commas.
  const out: string[] = []
  let current = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && i + 1 < raw.length) { current += c + raw[i + 1]; i++; continue }
    if (c === ',') { out.push(current); current = ''; continue }
    current += c
  }
  out.push(current)
  return out
}

function parseIntOrUndef(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function ucsDateToIcs(line: IcsLine): IcsDate {
  const value = line.value.trim()
  const paramOf = (key: string) => line.params.find((p) => p.key === key)
  const valueType = (paramOf('VALUE')?.value ?? '').toUpperCase()
  const tzid = paramOf('TZID')?.value
  const isDateLike = valueType === 'DATE' || (valueType !== 'DATE-TIME' && /^\d{8}$/.test(value))
  if (isDateLike) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
    if (!m) throw new Error(`invalid DATE "${value}"`)
    return makeDate(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (!m) throw new Error(`invalid DATE-TIME "${value}"`)
  const utc = m[7] === 'Z'
  return makeDateTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), { tzid, utc })
}

function lineToIcsDate(comp: IcsComponent, name: string): IcsDate | undefined {
  const line = comp.prop(name)
  return line ? ucsDateToIcs(line) : undefined
}

function lineToUts(comp: IcsComponent, name: string): number | undefined {
  const v = comp.propAll(name)[0]?.value
  if (v === undefined) return undefined
  const re = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v.trim())
  if (!re) return undefined
  return Date.UTC(Number(re[1]), Number(re[2]) - 1, Number(re[3]), Number(re[4]), Number(re[5]), Number(re[6]))
}

const TYPED_PROPS = new Set(['UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'SUMMARY',
  'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'CATEGORIES', 'DTSTART', 'DTEND', 'DURATION',
  'RECURRENCE-ID', 'RRULE', 'EXDATE', 'RDATE'])

export function parseEvent(comp: IcsComponent): VEvent {
  const uid = comp.propValues('UID')
  if (!uid) throw new Error('VEVENT without UID')
  const extra: { name: string; params: IcsParam[]; value: string }[] = []
  for (const p of comp.props) {
    // PRESERVED_PROPS (TRANSP/ATTENDEE/...) and any untyped/X- property are
    // kept verbatim so a fetched event survives an update round-trip.
    if (TYPED_PROPS.has(p.name)) continue
    extra.push({ name: p.name, params: p.params, value: p.value })
  }
  const categories = splitValues(comp.propValues('CATEGORIES')).filter(Boolean).map(unescapeText)
  const exdates: IcsDate[] = []
  for (const line of comp.propAll('EXDATE')) {
    for (const v of splitValues(line.value)) {
      exdates.push(ucsDateToIcs({ name: 'EXDATE', params: line.params, value: v }))
    }
  }
  const rdates: IcsDate[] = []
  for (const line of comp.propAll('RDATE')) {
    for (const v of splitValues(line.value)) {
      const vt = line.params.find((p) => p.key === 'VALUE')?.value.toUpperCase()
      if (vt === 'PERIOD') continue // PERIOD not modelled
      rdates.push(ucsDateToIcs({ name: 'RDATE', params: line.params, value: v }))
    }
  }
  const alarms = comp.childrenOf('VALARM').map(serializeComponent)
  const durationRaw = comp.propValues('DURATION')
  return {
    uid,
    summary: unescapeText(comp.propValues('SUMMARY')),
    description: comp.prop('DESCRIPTION') ? unescapeText(comp.propValues('DESCRIPTION')) : undefined,
    location: comp.prop('LOCATION') ? unescapeText(comp.propValues('LOCATION')) : undefined,
    url: comp.prop('URL') ? unescapeText(comp.propValues('URL')) : undefined,
    status: comp.propValues('STATUS') || undefined,
    categories,
    dtstamp: lineToUts(comp, 'DTSTAMP'),
    created: lineToUts(comp, 'CREATED'),
    lastModified: lineToUts(comp, 'LAST-MODIFIED'),
    sequence: parseIntOrUndef(comp.propAll('SEQUENCE')[0]?.value),
    dtStart: lineToIcsDate(comp, 'DTSTART'),
    dtEnd: lineToIcsDate(comp, 'DTEND'),
    duration: durationRaw ? parseIsoDuration(durationRaw) : undefined,
    recurrenceId: lineToIcsDate(comp, 'RECURRENCE-ID'),
    rrule: comp.propValues('RRULE') || undefined,
    exdates,
    rdates,
    alarms,
    extra,
  }
}

export function parseCalendar(text: string): ParsedCalendar {
  const lines = unfold(text)
  const root = parseComponent(lines, { i: 0 })
  if (root.name !== 'VCALENDAR') throw new Error(`expected VCALENDAR, got ${root.name}`)
  return {
    version: root.propValues('VERSION') || undefined,
    prodid: root.propValues('PRODID') || undefined,
    calscale: root.propValues('CALSCALE') || undefined,
    method: root.propValues('METHOD') || undefined,
    timezones: root.childrenOf('VTIMEZONE'),
    events: root.childrenOf('VEVENT').map(parseEvent),
  }
}

/* ------------------------------------------------------------------ */
/* Serializer                                                           */
/* ------------------------------------------------------------------ */

function buildParamsString(params: IcsParam[]): string {
  if (params.length === 0) return ''
  return params.map((p) => {
    const clean = p.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const needsQuote = /[;:,]/.test(clean)
    return `;${p.key}${needsQuote ? `="${clean}"` : `=${clean}`}`
  }).join('')
}

export function serializeLine(name: string, params: IcsParam[], value: string): string {
  return foldLine(`${name}${buildParamsString(params)}:${value}`)
}

export function serializeIcsDateProperty(name: string, v: IcsDate): string {
  if (v.type === 'date') {
    return serializeLine(name, [{ key: 'VALUE', value: 'DATE' }], formatIcsDate(v))
  }
  const params: IcsParam[] = []
  if (v.tzid) params.push({ key: 'TZID', value: v.tzid })
  return serializeLine(name, params, formatIcsDateTime(v))
}

export function serializeUts(name: string, ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return serializeLine(name, [], `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`)
}

/**
 * Serialize a VEVENT as a complete iCalendar component (including
 * BEGIN:VEVENT / END:VEVENT and sub-components such as VALARM).
 */
export function serializeEvent(ev: VEvent): string {
  const lines: string[] = []
  const known = new Set(['UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE',
    'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'CATEGORIES',
    'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID', 'RRULE', 'EXDATE', 'RDATE'])
  lines.push(serializeLine('UID', [], ev.uid))
  if (ev.sequence !== undefined) lines.push(serializeLine('SEQUENCE', [], String(ev.sequence)))
  if (ev.lastModified !== undefined) lines.push(serializeUts('LAST-MODIFIED', ev.lastModified))
  if (ev.created !== undefined) lines.push(serializeUts('CREATED', ev.created))
  if (ev.dtstamp !== undefined) lines.push(serializeUts('DTSTAMP', ev.dtstamp))
  lines.push(serializeLine('SUMMARY', [], escapeText(ev.summary)))
  if (ev.description !== undefined) lines.push(serializeLine('DESCRIPTION', [], escapeText(ev.description)))
  if (ev.location !== undefined) lines.push(serializeLine('LOCATION', [], escapeText(ev.location)))
  if (ev.url !== undefined) lines.push(serializeLine('URL', [], escapeText(ev.url)))
  if (ev.status !== undefined) lines.push(serializeLine('STATUS', [], ev.status))
  if (ev.categories.length > 0) {
    lines.push(serializeLine('CATEGORIES', [], ev.categories.map(escapeText).join(',')))
  }
  if (ev.dtStart) lines.push(serializeIcsDateProperty('DTSTART', ev.dtStart))
  if (ev.dtEnd) lines.push(serializeIcsDateProperty('DTEND', ev.dtEnd))
  if (!ev.dtEnd && ev.duration) {
    lines.push(serializeLine('DURATION', [], formatIsoDuration(ev.duration)))
  }
  if (ev.recurrenceId) lines.push(serializeIcsDateProperty('RECURRENCE-ID', ev.recurrenceId))
  if (ev.rrule) lines.push(serializeLine('RRULE', [], ev.rrule))
  for (const ex of ev.exdates) lines.push(serializeIcsDateProperty('EXDATE', ex))
  for (const rd of ev.rdates) lines.push(serializeIcsDateProperty('RDATE', rd))
  for (const ex of ev.extra) {
    if (!known.has(ex.name)) lines.push(serializeLine(ex.name, ex.params, ex.value))
  }

  const body = lines.map((l) => l.replace(/\r\n?/g, '\n')).join('\r\n')
  const children = ev.alarms.join('\r\n')
  return `BEGIN:VEVENT\r\n${body}${children ? `\r\n${children}` : ''}\r\nEND:VEVENT`
}

export function serializeComponent(comp: IcsComponent): string {
  const out: string[] = []
  out.push(`BEGIN:${comp.name}`)
  for (const p of comp.props) out.push(serializeLine(p.name, p.params, p.value))
  for (const c of comp.children) out.push(serializeComponent(c))
  out.push(`END:${comp.name}`)
  return out.join('\r\n')
}

export interface CalendarMeta {
  prodid?: string
  version?: string
  calscale?: string
  method?: string
}

export function buildCalendar(events: VEvent[], meta: CalendarMeta = {}, timezones: IcsComponent[] = []): string {
  const parts: string[] = []
  parts.push(serializeLine('BEGIN', [], 'VCALENDAR'))
  parts.push(serializeLine('VERSION', [], meta.version ?? '2.0'))
  parts.push(serializeLine('PRODID', [], meta.prodid ?? '-//dsh-calendar//EN'))
  if (meta.calscale) parts.push(serializeLine('CALSCALE', [], meta.calscale))
  if (meta.method) parts.push(serializeLine('METHOD', [], meta.method))
  for (const tz of timezones) parts.push(serializeComponent(tz))
  for (const ev of events) parts.push(serializeEvent(ev))
  parts.push(serializeLine('END', [], 'VCALENDAR'))
  return parts.join('\r\n') + '\r\n'
}

/** Parse the first VEVENT out of calendar text. */
export function parseFirstEvent(text: string): VEvent {
  const cal = parseCalendar(text)
  const ev = cal.events[0]
  if (!ev) throw new Error('calendar contains no VEVENT')
  return ev
}

/**
 * CalDAV (RFC 4791) client implemented on Node's global fetch: standard
 * discovery (base -> current-user-principal -> calendar-home-set ->
 * calendars), PROPFIND / REPORT / GET / PUT / DELETE / MKCALENDAR, and
 * Basic / Bearer authentication.
 */

import {
  cellChildrenText,
  childLocalAll,
  findLocal,
  localName,
  parseXml,
  renderXml,
  textOf,
  type XmlNode,
  type Elem,
} from './xml.js'

export interface AuthProvider {
  /** Add authentication headers (e.g. Authorization). May throw when absent. */
  apply(headers: Record<string, string>): Promise<void> | void
  describe(): string
}

export function basicAuth(username: string, password: string): AuthProvider {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return {
    apply: (h) => { h.Authorization = `Basic ${token}` },
    describe: () => `basic (user ${username})`,
  }
}

export function bearerAuth(token: () => Promise<string>): AuthProvider {
  return {
    apply: async (h) => { h.Authorization = `Bearer ${await token()}` },
    describe: () => 'oauth2 bearer',
  }
}

export class HttpError extends Error {
  status: number
  statusText: string
  body: string
  constructor(status: number, statusText: string, body: string, url: string) {
    super(`HTTP ${status} ${statusText} for ${url}${body ? `: ${body.slice(0, 300)}` : ''}`)
    this.name = 'HttpError'
    this.status = status
    this.statusText = statusText
    this.body = body
  }
}

export interface RawResponse {
  status: number
  statusText: string
  headers: Headers
  text: string
}

export interface CalDavOptions {
  baseUrl: string
  auth: AuthProvider
  userAgent?: string
  fetchImpl?: typeof fetch
}

export interface CalendarInfo {
  href: string
  url: string
  displayName: string
  supportsVEVENT: boolean
}

export interface CalendarObject {
  href: string
  url: string
  etag?: string
  text: string
}

export class CalDavClient {
  readonly baseUrl: string
  private readonly auth: AuthProvider
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: CalDavOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.auth = opts.auth
    this.userAgent = opts.userAgent ?? 'dsh-calendar/0.1 (CalDAV)'
    this.fetchImpl = opts.fetchImpl ?? (fetch as typeof fetch)
  }

  private async request(
    method: string,
    url: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { 'User-Agent': this.userAgent, ...extraHeaders }
    try {
      await this.auth.apply(headers)
    } catch (e) {
      throw new Error(`authentication not available: ${(e as Error).message}`)
    }
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? body : undefined,
      redirect: 'follow',
    })
    const text = await res.text()
    const raw: RawResponse = { status: res.status, statusText: res.statusText, headers: res.headers, text }
    if (res.status >= 400) throw new HttpError(res.status, res.statusText, text, url)
    return raw
  }

  private resolveHref(url: string, href: string): string {
    if (/^https?:\/\//i.test(href)) return href
    if (href.startsWith('/')) {
      const u = new URL(url)
      return `${u.protocol}//${u.host}${href}`
    }
    return new URL(href, url.endsWith('/') ? url : url + '/').toString()
  }

  private static readProps(stat: XmlNode): Map<string, string> {
    const props = new Map<string, string>()
    const prop = findLocal(stat, 'prop')
    if (!prop) return props
    for (const p of prop.children) {
      const local = localName(p.name)
      if (local === 'resourcetype') {
        props.set(local, p.children.map((c) => localName(c.name)).join(' '))
      } else if (local === 'supported-calendar-component-set') {
        props.set(local, p.children.map((c) => c.attrs['name'] ?? localName(c.name)).join(' '))
      } else {
        props.set(local, p.text)
      }
    }
    return props
  }

  /** All <D:response> entries of a multistatus body (status=200 only). */
  private static* responses(root: XmlNode): Generator<{ href: string; props: Map<string, string> }> {
    for (const response of childLocalAll(root, 'response')) {
      const href = textOf(findLocal(response, 'href'))
      if (!href) continue
      const props = new Map<string, string>()
      for (const stat of childLocalAll(response, 'propstat')) {
        const ok = / 200 /.test(findLocal(stat, 'status')?.text ?? '')
        if (!ok) continue
        for (const [k, v] of CalDavClient.readProps(stat)) props.set(k, v)
      }
      yield { href, props }
    }
  }

  private async propfind(url: string, depth: '0' | '1', props: Elem[]): Promise<XmlNode> {
    const body = renderXml({ prefix: 'D', local: 'propfind', children: [{ prefix: 'D', local: 'prop', children: props }] })
    const raw = await this.request('PROPFIND', url, xml(body), { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' })
    try {
      return parseXml(raw.text)
    } catch {
      return { name: 'multistatus', attrs: {}, children: [], text: '' }
    }
  }

  /** Resolve the calendar collection to operate on. */
  async resolveCalendars(preferredUrl?: string): Promise<CalendarInfo[]> {
    if (preferredUrl) {
      const url = this.resolveHref(this.baseUrl, preferredUrl)
      return [{ href: preferredUrl, url, displayName: preferredUrl, supportsVEVENT: true }]
    }

    const baseRoot = await this.propfind(this.baseUrl, '0', [{ prefix: 'D', local: 'current-user-principal' }])
    const principalNode = findLocal(baseRoot, 'current-user-principal')
    const principalHref = principalNode ? textOf(findLocal(principalNode, 'href')) : undefined
    const principalUrl = principalHref ? this.resolveHref(this.baseUrl, principalHref) : this.baseUrl

    const principalRoot = await this.propfind(principalUrl, '0', [{ prefix: 'C', local: 'calendar-home-set' }])
    const homeNode = findLocal(principalRoot, 'calendar-home-set')
    const homeHref = homeNode ? textOf(findLocal(homeNode, 'href')) : undefined
    if (!homeHref) throw new Error('no calendar-home-set discovered (is this a CalDAV endpoint?)')
    const homeUrl = this.resolveHref(principalUrl, homeHref)

    const listRoot = await this.propfind(homeUrl, '1', [
      { prefix: 'D', local: 'displayname' },
      { prefix: 'D', local: 'resourcetype' },
      { prefix: 'C', local: 'supported-calendar-component-set' },
    ])
    const out: CalendarInfo[] = []
    for (const { href, props } of CalDavClient.responses(listRoot)) {
      const rt = props.get('resourcetype') ?? ''
      if (!/\bcalendar\b/.test(rt)) continue
      out.push({
        href,
        url: this.resolveHref(homeUrl, href),
        displayName: props.get('displayname') || href,
        supportsVEVENT: /VEVENT/.test(props.get('supported-calendar-component-set') ?? ''),
      })
    }
    if (out.length === 0) throw new Error('no calendar collections found under the calendar home')
    const primary = out.find((c) => /primary|default/i.test(c.displayName)) ?? out[0]
    return [primary, ...out.filter((c) => c !== primary)]
  }

  /** Query calendar objects overlapping [startMs, endMs). */
  async query(calendarUrl: string, startMs: number, endMs: number): Promise<CalendarObject[]> {
    const body = renderXml({
      prefix: 'C', local: 'calendar-query',
      children: [
        { prefix: 'D', local: 'prop', children: [{ prefix: 'D', local: 'getetag' }, { prefix: 'C', local: 'calendar-data' }] },
        {
          prefix: 'C', local: 'filter',
          children: [{
            prefix: 'C', local: 'comp-filter', attrs: { name: 'VCALENDAR' },
            children: [{
              prefix: 'C', local: 'comp-filter', attrs: { name: 'VEVENT' },
              children: [{ prefix: 'C', local: 'time-range', attrs: { start: utcStamp(startMs), end: utcStamp(endMs) } }],
            }],
          }],
        },
      ],
    })
    return this.report(calendarUrl, body)
  }

  /**
   * Run an arbitrary CalDAV REPORT body against a collection and parse every
   * returned calendar object.
   */
  async report(calendarUrl: string, body: string): Promise<CalendarObject[]> {
    const raw = await this.request('REPORT', calendarUrl, xml(body), {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    })
    const root = parseXml(raw.text)
    const out: CalendarObject[] = []
    for (const response of childLocalAll(root, 'response')) {
      const rawHref = textOf(findLocal(response, 'href'))
      if (!rawHref) continue
      const dataNode = findLocal(response, 'calendar-data')
      const etagNode = findLocal(response, 'getetag')
      const url = this.resolveHref(calendarUrl, rawHref)
      out.push({
        href: url,
        url,
        etag: etagNode ? unwrap(etagNode.text) : undefined,
        text: dataNode ? cellText(dataNode) : '',
      })
    }
    return out
  }

  /** Fetch one calendar object by href. */
  async get(calendarUrl: string, href: string): Promise<CalendarObject> {
    const url = this.resolveHref(calendarUrl, href)
    const raw = await this.request('GET', url, undefined, { Accept: 'text/calendar; charset=utf-8' })
    const etag = raw.headers.get('etag')
    return { href: url, url, etag: etag ? unwrap(etag) : undefined, text: raw.text }
  }

  /**
   * Create or replace a calendar object.
   * - `uid` provided -> create at `${calendarUrl}/${uid}.ics` (If-None-Match:*)
   * - `href` provided  -> overwrite the existing resource (If-Match when a
   *   strong `etag` is given, otherwise If-Match:* for a fresh write)
   */
  async put(calendarUrl: string, ics: string, opts: { uid?: string; href?: string; etag?: string }): Promise<{ href: string; etag?: string }> {
    let url: string
    let headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' }
    if (opts.href) {
      url = this.resolveHref(calendarUrl, opts.href)
      // weak etags cannot be used in If-Match (RFC 7232 strong comparison)
      if (opts.etag && !opts.etag.startsWith('W/')) headers['If-Match'] = `"${opts.etag}"`
      else headers['If-Match'] = '*'
    } else {
      url = this.resolveHref(calendarUrl, `${sanitizeUid(opts.uid ?? `event-${Date.now()}`)}.ics`)
      headers['If-None-Match'] = '*'
    }
    const raw = await this.request('PUT', url, ics, headers)
    const etag = raw.headers.get('etag')
    return { href: url, etag: etag ? unwrap(etag) : undefined }
  }

  /** Delete a calendar object resource; returns false when it is already gone (404). */
  async del(calendarUrl: string, href: string): Promise<boolean> {
    const url = this.resolveHref(calendarUrl, href)
    try {
      const raw = await this.request('DELETE', url)
      void raw
      return true
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false
      throw e
    }
  }

  /** Create a calendar collection under a parent. */
  async makeCalendar(parentUrl: string, displayName: string): Promise<string> {
    const url = this.resolveHref(parentUrl, encodeURIComponent(sanitizeUid(displayName)))
    const body = renderXml({
      prefix: 'C', local: 'mkcalendar',
      children: [{
        prefix: 'D', local: 'set',
        children: [{ prefix: 'D', local: 'prop', children: [{ prefix: 'D', local: 'displayname', children: [displayName] }] }],
      }],
    })
    await this.request('MKCALENDAR', url, xml(body), { 'Content-Type': 'application/xml; charset=utf-8' })
    return url
  }
}

function xml(body: string): string {
  // Bind the WebDAV / CalDAV namespace prefixes on the document ROOT element
  // (required by conforming servers; the mock is namespace-blind so tests pass
  // regardless).
  const withNs = body.replace(
    /^<([A-Za-z0-9_:-]+)(?=\s|>)/,
    (_m, name: string) => `<${name} xmlns:D="${NS_DAV}" xmlns:C="${NS_CALDAV}" xmlns:CS="${NS_CS}"`,
  )
  return `<?xml version="1.0" encoding="utf-8" ?>\n${withNs}`
}

const NS_DAV = 'DAV:'
const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav'
const NS_CS = 'http://calendarserver.org/ns/'

/** Recurse into C:calendar-data to collect the raw iCalendar text. */
function cellText(node: XmlNode): string {
  if (node.children.length === 0) return node.text
  return cellChildrenText(node)
}

function unwrap(v: string): string {
  // strip surrounding quotes only; keep a leading W/ weak marker intact
  return v.trim().replace(/^"|"$/g, '')
}

function utcStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

function sanitizeUid(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._@-]/g, '_')
  return cleaned || `event-${Date.now()}`
}

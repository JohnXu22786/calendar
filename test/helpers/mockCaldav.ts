/**
 * Shared in-process mock CalDAV server used by the integration tests.
 * Stores calendar objects in memory and answers discovery / REPORT / GET /
 * PUT / DELETE like a minimal server.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { findLocal, parseXml } from '../../src/dav/xml.js'
import { buildCalendar, parseCalendar, toUtcMs, type VEvent } from '../../src/core/ics.js'

const TZ = 'Asia/Shanghai'

export interface MockCalendar {
  object(path: string): { text: string; etag: string } | undefined
  seed(events: VEvent[]): void
  clear(): void
}

export interface MockServer {
  baseUrl: string
  calendar: MockCalendar
  close(): Promise<void>
}

function multistatus(nodes: Array<{ href: string; props: string }>): string {
  const inner = nodes.map((n) => `
      <D:response>
        <D:href>${n.href}</D:href>
        <D:propstat>
          <D:prop>${n.props}</D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>`).join('')
  return `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</D:multistatus>`
}

function overlaps(ev: VEvent, startMs: number, endMs: number): boolean {
  if (!ev.dtStart) return false
  const s = toUtcMs(ev.dtStart, TZ)
  const e = ev.dtEnd ? toUtcMs(ev.dtEnd, TZ) : s + 3600000
  return s < endMs && e > startMs
}

function parseUtc(v: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(v)
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

function escapeXmlIcs(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
  })
}

export async function startMockServer(): Promise<MockServer> {
  const objects = new Map<string, { text: string; etag: string }>()
  let etagCounter = 1

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    const method = (req.method ?? 'GET').toUpperCase()
    const bodyString = await readBody(req)

    const send = (status: number, text: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', ...headers })
      res.end(text)
    }

    if (method === 'PROPFIND') {
      if (path === '/' || path === '/remote.php/dav') {
        send(207, multistatus([{ href: path === '/' ? '/' : '/remote.php/dav', props: '<D:current-user-principal><D:href>/principals/me/</D:href></D:current-user-principal>' }]))
        return
      }
      if (path === '/principals/me/') {
        send(207, multistatus([{ href: path, props: '<C:calendar-home-set><D:href>/calendars/me/</D:href></C:calendar-home-set>' }]))
        return
      }
      if (path === '/calendars/me/') {
        send(207, multistatus([{ href: '/calendars/me/events/', props: '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Events</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' }]))
        return
      }
      if (path.endsWith('/events/')) {
        send(207, multistatus([{ href: '/calendars/me/events/', props: '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Events</D:displayname>' }]))
        return
      }
      send(404, 'not found')
      return
    }

    if (method === 'REPORT') {
      if (!path.endsWith('/events/')) { send(404, 'no'); return }
      const root = parseXml(bodyString)
      const timeRange = findLocal(root, 'time-range')
      const matchNode = findLocal(root, 'text-match')
      const uidFilter = matchNode ? matchNode.text.trim() : undefined
      const startMs = timeRange?.attrs['start'] ? parseUtc(timeRange.attrs.start) : -Infinity
      const endMs = timeRange?.attrs['end'] ? parseUtc(timeRange.attrs.end) : Infinity
      const items: string[] = []
      for (const [p, obj] of objects) {
        let events: VEvent[]
        try { events = parseCalendar(obj.text).events } catch { continue }
        if (uidFilter !== undefined) {
          if (events.some((e) => e.uid === uidFilter)) items.push(p)
          continue
        }
        if (events.some((e) => overlaps(e, startMs, endMs))) items.push(p)
      }
      const nodes = items.map((p) => {
        const obj = objects.get(p)!
        return { href: p, props: `<D:getetag>"${obj.etag}"</D:getetag><C:calendar-data>${escapeXmlIcs(obj.text)}</C:calendar-data>` }
      })
      send(207, multistatus(nodes))
      return
    }

    if (method === 'GET') {
      const obj = objects.get(path)
      if (!obj) { send(404, 'no'); return }
      send(200, obj.text, { 'Content-Type': 'text/calendar; charset=utf-8', ETag: `"${obj.etag}"` })
      return
    }

    if (method === 'PUT') {
      const wantCreate = req.headers['if-none-match'] === '*'
      const existing = objects.get(path)
      if (wantCreate && existing) { send(412, 'precondition failed'); return }
      const etag = `etag-${etagCounter++}`
      objects.set(path, { text: bodyString, etag })
      send(201, '', { 'Content-Type': 'text/calendar; charset=utf-8', ETag: `"${etag}"` })
      return
    }

    if (method === 'DELETE') {
      if (!objects.has(path)) { send(404, 'no'); return }
      objects.delete(path)
      send(204, '')
      return
    }

    send(405, 'method not allowed')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

  return {
    baseUrl,
    calendar: {
      object: (p) => objects.get(p),
      seed(events: VEvent[]) {
        for (const ev of events) {
          const uid = ev.uid
          objects.set(`/calendars/me/events/${uid}.ics`, { text: buildCalendar([ev]), etag: `etag-${etagCounter++}` })
        }
      },
      clear() { objects.clear() },
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

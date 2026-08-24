#!/usr/bin/env node
/**
 * dsh-calendar command line interface.
 *
 * Shares the exact CalendarService operations used by the dsh tools, wired to
 * environment variables / a local chmod-0600 credential store.
 *
 * Examples:
 *   dsh-calendar list --start 2026-01-01 --end 2026-01-31
 *   dsh-calendar create --summary "Team sync" --start "2026-03-02 10:00" --end "2026-03-02 11:00" --rrule "FREQ=WEEKLY;COUNT=4"
 *   dsh-calendar delete 7f8a3c --recurrence-id "2026-03-09 10:00"
 *   dsh-calendar holidays --days 60
 *   dsh-calendar auth google --device
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { CalendarService, buildService } from './service.js'
import { CredentialResolver, defaultStorePath } from './credentials.js'
import { runDeviceFlow } from './dav/oauth.js'
import type { EventView, ConflictView, HolidayView } from './service.js'

interface CliResult {
  ok: boolean
  text: string
}

function loadDotEnv(): void {
  const p = path.join(process.cwd(), '.env')
  if (!fs.existsSync(p)) return
  const raw = fs.readFileSync(p, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) {
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  }
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

function fmtEvent(e: EventView): string {
  const when = e.allDay
    ? `${e.start?.wall ?? ''} (all day)`
    : `${e.start?.wall ?? ''} → ${e.end?.wall ?? ''}`
  return `  [${e.uid}] ${e.summary}${e.status === 'CANCELLED' ? ' [CANCELLED]' : ''}\n      ${when}${e.rrule ? `\n      rrule: ${e.rrule}` : ''}${e.location ? `\n      location: ${e.location}` : ''}${e.description ? `\n      ${e.description}` : ''}`
}

function fmtConflicts(c: ConflictView[]): string {
  if (c.length === 0) return '  no conflicts'
  return c.map((x) => `  CONFLICT: ${x.summary} (${x.hint})`).join('\n')
}

async function main(): Promise<CliResult> {
  loadDotEnv()
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const cmd = positionals.shift() ?? 'help'

  const creds = new CredentialResolver({ storePath: defaultStorePath(process.cwd()) })

  const guard = async (fn: () => Promise<CliResult>): Promise<CliResult> => {
    try {
      return await fn()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, text: creds.redact(message) }
    }
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { ok: true, text: HELP }
  }

  if (cmd === 'auth') {
    return guard(async () => {
      const sub = positionals.shift() ?? 'status'
      if (sub === 'google') {
        const clientId = flags['client-id'] ? String(flags['client-id']) : undefined
        const resolved = clientId ?? (await creds.get('GOOGLE_CLIENT_ID')) ?? process.env.GOOGLE_CLIENT_ID
        if (!resolved) {
          return { ok: false, text: 'google device flow needs --client-id or GOOGLE_CLIENT_ID' }
        }
        if (flags['device'] !== undefined) {
          const tokens = await runDeviceFlow(resolved, {
            print: (msg) => process.stdout.write(msg + '\n'),
          })
          if (tokens.refreshToken) {
            await creds.set('GOOGLE_CALDAV_REFRESH_TOKEN', tokens.refreshToken)
            return { ok: true, text: 'authorized; refresh token saved to local secure store' }
          }
          return { ok: false, text: 'no refresh token returned' }
        }
        return { ok: false, text: 'usage: dsh-calendar auth google --device [--client-id X]' }
      }
      if (sub === 'status') {
        const missing: string[] = []
        for (const n of ['CALDAV_URL', 'CALDAV_USERNAME', 'CALDAV_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CALDAV_REFRESH_TOKEN']) {
          if (!(await creds.has(n))) missing.push(n)
        }
        return { ok: true, text: `credential status: ${missing.length ? `missing: ${missing.join(', ')}` : 'all configured'}` }
      }
      return { ok: false, text: `unknown auth subcommand "${sub}"` }
    })
  }

  // Wire a service for all calendar commands (errors are redacted by `guard`).
  return guard(async () => {
    const built = await buildService({
      calendarUrl: flags['calendar'] && flags['calendar'] !== true ? String(flags['calendar']) : undefined,
      credentials: creds,
    })
    const svc = new CalendarService(built.store, flags['tz'] && flags['tz'] !== true ? String(flags['tz']) : built.defaultTz, creds)
    const tz = svc.tz

    switch (cmd) {
    case 'list': {
      const countRaw = flagStr(flags, 'count')
      const count = countRaw !== undefined && /^\d+$/.test(countRaw) ? Number(countRaw) : undefined
      const rows = await svc.list({
        start: flagStr(flags, 'start'),
        end: flagStr(flags, 'end'),
        tz,
        count,
      })
      if (rows.events.length === 0) return { ok: true, text: 'no events' }
      return { ok: true, text: `${rows.events.length} event(s) in ${tz}:\n` + rows.events.map(fmtEvent).join('\n') }
    }
    case 'get': {
      const uid = positionals[0]
      if (!uid) return { ok: false, text: 'usage: dsh-calendar get <uid>' }
      const got = await svc.get(uid, { start: flagStr(flags, 'start'), end: flagStr(flags, 'end'), tz })
      if (!got) return { ok: false, text: `event "${uid}" not found` }
      return { ok: true, text: (got.master ? fmtEvent(got.master) : '') + '\n\noccurrences:\n' + got.series.map(fmtEvent).join('\n') }
    }
    case 'create': {
      const summary = flagStr(flags, 'summary') ?? positionals[0]
      const start = flagStr(flags, 'start')
      if (!summary || !start) return { ok: false, text: 'usage: dsh-calendar create --summary "X" --start "2026-03-02 10:00" [--end ...] [--rrule ...]' }
      const result = await svc.create({
        summary,
        description: flagStr(flags, 'description'),
        location: flagStr(flags, 'location'),
        categories: flagStr(flags, 'categories')?.split(',').map((s) => s.trim()).filter(Boolean),
        start,
        end: flagStr(flags, 'end'),
        allDay: flags['all-day'] !== undefined,
        tz: flagStr(flags, 'tz') ?? tz,
        rrule: flagStr(flags, 'rrule'),
        exdates: flagStr(flags, 'exdates')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
        rdates: flagStr(flags, 'rdates')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
        checkConflicts: flags['no-conflicts'] === undefined,
      })
      const text = `created:\n${fmtEvent(result.event)}` + (result.conflicts.length ? `\n\n${fmtConflicts(result.conflicts)}` : '')
      return { ok: true, text }
    }
    case 'update': {
      const uid = positionals[0]
      if (!uid) return { ok: false, text: 'usage: dsh-calendar update <uid> [--summary X] [--start ...] [--recurrence-id "2026-03-09 10:00"]' }
      const result = await svc.update(uid, {
        summary: flagStr(flags, 'summary'),
        description: flagStr(flags, 'description'),
        location: flagStr(flags, 'location'),
        status: flagStr(flags, 'status'),
        categories: flagStr(flags, 'categories')?.split(',').map((s) => s.trim()).filter(Boolean),
        start: flagStr(flags, 'start'),
        end: flagStr(flags, 'end'),
        allDay: flags['all-day'] !== undefined,
        tz: flagStr(flags, 'tz') ?? tz,
        rrule: flagStr(flags, 'rrule'),
        recurrenceId: flagStr(flags, 'recurrence-id'),
        checkConflicts: flags['no-conflicts'] === undefined,
      })
      const text = result.event ? `updated:\n${fmtEvent(result.event)}` : 'updated' + (result.conflicts.length ? `\n\n${fmtConflicts(result.conflicts)}` : '')
      return { ok: true, text }
    }
    case 'delete': {
      const uid = positionals[0]
      if (!uid) return { ok: false, text: 'usage: dsh-calendar delete <uid> [--recurrence-id "2026-03-09 10:00"]' }
      const r = await svc.remove(uid, flagStr(flags, 'recurrence-id'))
      return { ok: true, text: r.removed ? 'deleted' : `not deleted: ${r.note ?? 'unknown'}` }
    }
    case 'search': {
      const q = positionals[0] ?? flagStr(flags, 'query')
      if (!q) return { ok: false, text: 'usage: dsh-calendar search <query>' }
      const r = await svc.search(q, { start: flagStr(flags, 'start'), end: flagStr(flags, 'end'), tz })
      if (r.events.length === 0) return { ok: true, text: 'no matches' }
      return { ok: true, text: `${r.events.length} match(es):\n` + r.events.map(fmtEvent).join('\n') }
    }
    case 'conflicts': {
      const start = flagStr(flags, 'start')
      if (!start) return { ok: false, text: 'usage: dsh-calendar conflicts --start "2026-03-02 10:00" [--end ...] [--rrule ...]' }
      const c = await svc.conflicts(flagStr(flags, 'uid'), {
        summary: flagStr(flags, 'summary'),
        start,
        end: flagStr(flags, 'end'),
        allDay: flags['all-day'] !== undefined,
        tz: flagStr(flags, 'tz') ?? tz,
        rrule: flagStr(flags, 'rrule'),
      })
      return { ok: true, text: c.length ? `conflicts found: ${c.length}\n${fmtConflicts(c)}` : 'no conflicts' }
    }
    case 'holidays': {
      const daysRaw = flagStr(flags, 'days')
      const days = daysRaw !== undefined && /^\d+$/.test(daysRaw) ? Number(daysRaw) : 30
      const r = await svc.chinese({ after: flagStr(flags, 'after'), days })
      const hs: HolidayView[] = r.holidays
      const today = r.today ? `today (${r.today.date}): ${r.today.ganzhi.ganzhi} ${r.today.ganzhi.zodiac}年` : ''
      const lines = hs.map((h) => `  ${h.date}  ${h.name}${h.lunar ? ` (${h.lunar})` : ''}`)
      return { ok: true, text: (today ? today + '\n\n' : '') + `upcoming holidays (${hs.length}):\n` + (lines.join('\n') || '  (none in range)') }
    }
    case 'calendars': {
      const cal = await svc.calendars()
      return { ok: true, text: cal.length ? cal.map((c) => `  ${c.displayName}  ${c.url}${c.supportsVEVENT ? '' : ' (no VEVENT)'}`).join('\n') : 'no calendars' }
    }
    case 'remind': {
      const uid = positionals[0]
      if (!uid) return { ok: false, text: 'usage: dsh-calendar remind <uid> [--before 10m] [--until ...]' }
      const plan = await svc.reminderPlan(uid, { before: flagStr(flags, 'before'), until: flagStr(flags, 'until'), tz })
      return { ok: true, text: JSON.stringify(plan, null, 2) }
    }
    default:
      return { ok: false, text: `unknown command "${cmd}"\n\n${HELP}` }
    }
  })
}

function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key]
  return v === true || v === undefined ? undefined : v
}

const HELP = `dsh-calendar - CalDAV + iCalendar + RRULE command line

Usage: dsh-calendar <command> [args]

Commands:
  list                          list events within a window
      --start "YYYY-MM-DD[ HH:MM]"   --end "..."   --tz <IANA>   --count N
  get <uid>                     show one event series and its occurrences
  create                        create an event
      --summary X --start "..." [--end "..." --all-day --tz ... --rrule "..." --description ... --location ... --categories a,b --no-conflicts]
  update <uid>                  edit a series or one occurrence
      [--summary X --start "..." --end "..." --status CONFIRMED --rrule "..." --recurrence-id "2026-03-09 10:00"]
  delete <uid>                  delete a series; add --recurrence-id to delete one occurrence
  search <query>                text search over events
  conflicts                     check overlaps
      --start "..." [--end "..." --tz ... --rrule "..." --uid <uid> --no-conflicts]
  holidays                      Chinese holidays + 干支/生肖
      [--after "YYYY-MM-DD" --days N --tz ...]
  calendars                     list accessible calendars
  remind <uid>                  reminder plan for upcoming occurrences (schedule_create-ready)
  auth google --device          obtain OAuth2 via the device flow (saves the refresh token locally)
  auth status                   show which credentials are configured

Environment / .env: CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD,
GOOGLE_CLIENT_ID, GOOGLE_CALDAV_REFRESH_TOKEN, DSH_CALENDAR_DEFAULT_TZ.
Secrets are never printed.
`

main()
  .then((r) => {
    process.stdout.write((r.ok ? '' : 'error: ') + r.text + '\n')
    process.exit(r.ok ? 0 : 1)
  })
  .catch((e: Error) => {
    process.stderr.write(`error: ${e.message}\n`)
    process.exit(1)
  })

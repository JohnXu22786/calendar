/**
 * Tool definitions for dsh's `ctx.tools` (cal_* namespace).
 *
 * Each tool follows the dsh ToolDefinition shape (name, description,
 * parameters, output {schema, render}, execute). Operations live in
 * service.ts so the CLI reuses exactly the same behaviour.
 *
 * The service is obtained lazily through a factory: tools may be registered
 * before credentials are resolvable, and the first call connects.
 */

import type { CalendarService, ConflictView } from './service.js'

export interface ToolExecContext {
  signal?: AbortSignal
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, {
    type?: string
    required?: boolean
    description?: string
    default?: unknown
    enum?: unknown[]
    items?: unknown
  }>
  execute(args: Record<string, string>, ctx: ToolExecContext): Promise<unknown>
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return v === undefined || v === null ? undefined : String(v)
}

function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (v === undefined || v === '') return undefined
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function renderJson(value: unknown): string {
  return JSON.stringify(value, (k, v) => (typeof v === 'number' && Number.isNaN(v) ? null : v), 2)
}

function withConflicts(payload: { event?: unknown; conflicts?: ConflictView[] }): unknown {
  const conflicts = payload.conflicts ?? []
  return {
    ...payload,
    conflicts,
    conflictCount: conflicts.length,
    warning: conflicts.length > 0
      ? `conflict detected: ${conflicts.length} overlapping event(s)`
      : undefined,
  }
}

type ServiceFactory = () => Promise<CalendarService>

export function buildTools(getService: ServiceFactory): ToolDef[] {
  const use = (args: Record<string, unknown>, fn: (s: CalendarService, tz: string) => Promise<unknown>) =>
    async (args: Record<string, unknown>) => {
      const service = await getService()
      return fn(service, str(args, 'timezone') ?? service.tz)
    }

  return [
    {
      name: 'cal_list',
      description: 'List calendar events, optionally within a [start, end) window. Times use the calendar timezone by default.',
      parameters: {
        start: { type: 'string', description: 'window start, "YYYY-MM-DD[ HH:MM[:SS]]" or ISO with Z (optional; default 1 day ago)' },
        end: { type: 'string', description: 'window end, exclusive (optional; default 1 week ahead)' },
        timezone: { type: 'string', description: 'display timezone (IANA id, default Asia/Shanghai)' },
        count: { type: 'string', description: 'maximum number of events to return' },
      },
      async execute(args) {
        const countRaw = str(args, 'count')
        const count = countRaw !== undefined && /^\d+$/.test(countRaw) ? Number(countRaw) : undefined
        return use(args, (s, tz) => s.list({ start: str(args, 'start'), end: str(args, 'end'), tz, count }).then((r) => ({ timezone: tz, events: r.events, count: r.events.length })))
      },
    },
    {
      name: 'cal_get',
      description: 'Fetch one event series by UID with its concrete occurrences over a window.',
      parameters: {
        uid: { type: 'string', required: true, description: 'the event UID' },
        start: { type: 'string', description: 'window start (optional)' },
        end: { type: 'string', description: 'window end (optional)' },
        timezone: { type: 'string', description: 'display timezone (default Asia/Shanghai)' },
      },
      async execute(args) { return use(args, async (s, tz) => {
        const uid = String(str(args, 'uid'))
        const got = await s.get(uid, { start: str(args, 'start'), end: str(args, 'end'), tz })
        if (!got) return { uid, found: false }
        return { uid, found: true, master: got.master, occurrences: got.series }
      }) },
    },
    {
      name: 'cal_create',
      description: 'Create a calendar event (optionally recurring via RFC 5545 RRULE), with automatic conflict check.',
      parameters: {
        summary: { type: 'string', required: true, description: 'event title' },
        start: { type: 'string', required: true, description: '"YYYY-MM-DD[ HH:MM[:SS]]" or ISO with Z' },
        end: { type: 'string', description: '"YYYY-MM-DD[ HH:MM[:SS]]" or ISO with Z (optional)' },
        allDay: { type: 'string', description: '"true" for an all-day event' },
        timezone: { type: 'string', description: 'event timezone (default Asia/Shanghai)' },
        description: { type: 'string', description: 'details' },
        location: { type: 'string', description: 'location' },
        categories: { type: 'string', description: 'comma-separated category tags' },
        rrule: { type: 'string', description: 'recurrence rule, e.g. "FREQ=WEEKLY;COUNT=10;BYDAY=MO"' },
        exdates: { type: 'string', description: 'comma-separated exception dates (same format as start)' },
        rdates: { type: 'string', description: 'comma-separated additional occurrence dates' },
        checkConflicts: { type: 'string', description: '"false" to skip the conflict check' },
      },
      async execute(args) { return use(args, (s, tz) => s.create({
        summary: String(str(args, 'summary')),
        description: str(args, 'description'),
        location: str(args, 'location'),
        categories: strArray(args, 'categories'),
        start: String(str(args, 'start')),
        end: str(args, 'end'),
        allDay: str(args, 'allDay') === 'true',
        tz,
        rrule: str(args, 'rrule'),
        exdates: strArray(args, 'exdates') ?? [],
        rdates: strArray(args, 'rdates') ?? [],
        checkConflicts: str(args, 'checkConflicts') !== 'false',
      }).then((p) => withConflicts(p))) },
    },
    {
      name: 'cal_update',
      description: 'Update an event. Use `recurrenceId` to edit a single occurrence (the series stays intact).',
      parameters: {
        uid: { type: 'string', required: true, description: 'the event UID' },
        recurrenceId: { type: 'string', description: 'the occurrence local start (e.g. "2024-05-06 09:00") to edit only that instance' },
        summary: { type: 'string', description: 'new title' },
        description: { type: 'string', description: 'new details' },
        location: { type: 'string', description: 'new location' },
        status: { type: 'string', enum: ['CONFIRMED', 'TENTATIVE', 'CANCELLED'], description: 'new status' },
        start: { type: 'string', description: 'new start (whole series, or the single instance when recurrenceId is set)' },
        end: { type: 'string', description: 'new end' },
        allDay: { type: 'string', description: '"true" for all-day' },
        timezone: { type: 'string', description: 'timezone (default Asia/Shanghai)' },
        rrule: { type: 'string', description: 'new recurrence rule (whole series)' },
        categories: { type: 'string', description: 'comma-separated categories' },
        checkConflicts: { type: 'string', description: '"false" to skip the conflict check' },
      },
      async execute(args) { return use(args, (s, tz) => s.update(String(str(args, 'uid')), {
        summary: str(args, 'summary'),
        description: str(args, 'description'),
        location: str(args, 'location'),
        status: str(args, 'status'),
        categories: strArray(args, 'categories'),
        start: str(args, 'start'),
        end: str(args, 'end'),
        allDay: str(args, 'allDay') === 'true',
        tz,
        rrule: str(args, 'rrule'),
        recurrenceId: str(args, 'recurrenceId'),
        checkConflicts: str(args, 'checkConflicts') !== 'false',
      }).then((p) => withConflicts(p as unknown as { event?: unknown; conflicts?: ConflictView[] }))) },
    },
    {
      name: 'cal_delete',
      description: 'Delete a whole event series, or a single occurrence when `recurrenceId` is given (series stays intact).',
      parameters: {
        uid: { type: 'string', required: true, description: 'the event UID' },
        recurrenceId: { type: 'string', description: 'delete only this occurrence (e.g. "2024-05-06 09:00")' },
      },
      async execute(args) { return use(args, async (s) => {
        const uid = String(str(args, 'uid'))
        const rid = str(args, 'recurrenceId')
        const result = await s.remove(uid, rid)
        return { ...result, note: rid ? `occurrence ${rid} of "${uid}" cancelled; series kept` : `series "${uid}" ${result.removed ? 'removed' : 'not found'}` }
      }) },
    },
    {
      name: 'cal_search',
      description: 'Text search over event titles, descriptions and locations within a window.',
      parameters: {
        query: { type: 'string', required: true, description: 'search terms' },
        start: { type: 'string', description: 'window start (optional)' },
        end: { type: 'string', description: 'window end (optional)' },
        timezone: { type: 'string', description: 'display timezone (default Asia/Shanghai)' },
      },
      async execute(args) { return use(args, async (s, tz) => {
        const q = String(str(args, 'query'))
        const r = await s.search(q, { start: str(args, 'start'), end: str(args, 'end'), tz })
        return { query: q, matches: r.events, count: r.events.length }
      }) },
    },
    {
      name: 'cal_conflicts',
      description: 'Check whether a proposed time (optionally recurring) overlaps existing events.',
      parameters: {
        start: { type: 'string', required: true, description: '"YYYY-MM-DD[ HH:MM[:SS]]" or ISO with Z' },
        end: { type: 'string', description: 'end (optional)' },
        allDay: { type: 'string', description: '"true" for all-day' },
        timezone: { type: 'string', description: 'timezone (default Asia/Shanghai)' },
        rrule: { type: 'string', description: 'recurrence rule to check across instances' },
        summary: { type: 'string', description: 'label for the candidate (display only)' },
        uid: { type: 'string', description: 'existing event UID to check (rereads the series)' },
      },
      async execute(args) { return use(args, (s, tz) => s.conflicts(str(args, 'uid'), {
        summary: str(args, 'summary'),
        start: String(str(args, 'start')),
        end: str(args, 'end'),
        allDay: str(args, 'allDay') === 'true',
        tz,
        rrule: str(args, 'rrule'),
      }).then((conflicts) => ({ conflictCount: conflicts.length, conflicts }))) },
    },
    {
      name: 'cal_holidays',
      description: 'List upcoming Chinese holidays (Spring Festival, Qingming, Dragon Boat, Mid-Autumn, ...) and today’s 干支/生肖.',
      parameters: {
        after: { type: 'string', description: 'start date "YYYY-MM-DD" (default today)' },
        days: { type: 'string', description: 'how many days to look ahead (default 30)' },
        timezone: { type: 'string', description: 'timezone for "today" (default Asia/Shanghai)' },
      },
      async execute(args) { return use(args, (s) => {
        const daysRaw = str(args, 'days')
        const days = daysRaw !== undefined && /^\d+$/.test(daysRaw) ? Number(daysRaw) : 30
        return s.chinese({
          after: str(args, 'after'),
          days,
        }).then((r) => ({ timezone: str(args, 'timezone') ?? 'Asia/Shanghai', holidays: r.holidays, today: r.today }))
      }) },
    },
    {
      name: 'cal_calendars',
      description: 'List the calendar collections the current credentials can access.',
      parameters: {},
      async execute() {
        const s = await getService()
        const calendars = await s.calendars()
        return { calendars: calendars.map((c) => ({ displayName: c.displayName, url: c.url, supportsVEVENT: c.supportsVEVENT })) }
      },
    },
    {
      name: 'cal_remind',
      description: 'Build a reminder plan for an event’s upcoming occurrences, formatted to hand to the dsh `schedule_create` tool.',
      parameters: {
        uid: { type: 'string', required: true, description: 'the event UID' },
        before: { type: 'string', description: 'lead time before the event, e.g. "10m", "1h", "1d" (default 10m)' },
        until: { type: 'string', description: 'plan occurrences until this date (default 30 days ahead)' },
        timezone: { type: 'string', description: 'timezone (default Asia/Shanghai)' },
        prompt: { type: 'string', description: 'custom reminder text' },
      },
      async execute(args) { return use(args, (s, tz) => s.reminderPlan(String(str(args, 'uid')), {
        before: str(args, 'before'),
        until: str(args, 'until'),
        tz,
        prompt: str(args, 'prompt'),
      })) },
    },
  ]
}

/** Default text renderer output block (used by the dsh entry). */
export function renderBlocks(value: unknown): Array<{ type: string; text: string }> {
  return [{ type: 'text', text: renderJson(value) }]
}

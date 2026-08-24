#!/usr/bin/env node
/**
 * Standalone usage demo of the dsh-calendar core libraries (no dsh needed).
 *
 * Run after `npm run build`:
 *   node examples/usage.mjs
 *
 * It exercises: iCalendar parsing/serialization, RRULE expansion (with
 * EXDATE), single-instance overrides, conflict detection, and the Chinese
 * lunar/holiday helpers.
 */
import { parseCalendar, buildCalendar, makeDateTime } from '../lib/core/ics.js'
import { parseRrule, expandRrule } from '../lib/core/rrule.js'
import { expandSeries, updateSingleInstance } from '../lib/core/recurrence.js'
import { findConflicts } from '../lib/core/calendar.js'
import { solarToLunar, holidaysOnDate, ganzhiZodiac, upcomingHolidays } from '../lib/core/lunar.js'
import { utcToWall, formatWall } from '../lib/core/tz.js'

const TZ = 'Asia/Shanghai'

// --- 1. Parse an existing ICS (e.g. fetched from a CalDAV server) -----------
const ics = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//demo//EN',
  'BEGIN:VEVENT',
  'UID:standup-2026',
  'SUMMARY:Daily Standup',
  'DTSTART;TZID=Asia/Shanghai:20260106T090000',
  'DTEND;TZID=Asia/Shanghai:20260106T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10',
  'EXDATE;TZID=Asia/Shanghai:20260109T090000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const event = parseCalendar(ics).events[0]
console.log('parsed event :', event.summary, '/ rrule =', event.rrule, '/ exdates =', event.exdates.length)

// --- 2. RRULE expansion ------------------------------------------------------
const startWall = { year: 2026, month: 1, day: 6, hour: 9, minute: 0, second: 0 }
const parsed = parseRrule(event.rrule)
const instances = expandRrule(parsed, startWall, { tzid: TZ })
console.log('\nRRULE instances (first 5):')
for (const i of instances.slice(0, 5)) console.log('   ', formatWall(utcToWall(i.utcMs, TZ).wall), '->', new Date(i.utcMs).toISOString())

// --- 3. Series expansion + single-instance edit ------------------------------
const master = event
master.dtStart = makeDateTime(2026, 1, 6, 9, 0, 0, { tzid: TZ })
master.dtEnd = makeDateTime(2026, 1, 6, 9, 30, 0, { tzid: TZ })
master.exdates = [makeDateTime(2026, 1, 9, 9, 0, 0, { tzid: TZ })]

const series = { master, overrides: [] }
const expanded = expandSeries(series, {
  rangeStartMs: Date.UTC(2026, 0, 1),
  rangeEndMs: Date.UTC(2026, 1, 1),
  defaultTz: TZ,
})
console.log(`\nseries occurrences in January: ${expanded.length} (Jan 9 excluded by EXDATE)`)

// move the 2026-01-13 instance to 15:00
const target = makeDateTime(2026, 1, 13, 9, 0, 0, { tzid: TZ })
const movedOverride = updateSingleInstance(series, target, {
  summary: 'Standup (moved)',
  start: makeDateTime(2026, 1, 13, 15, 0, 0, { tzid: TZ }),
  end: makeDateTime(2026, 1, 13, 15, 30, 0, { tzid: TZ }),
})
const after = expandSeries({ master, overrides: [movedOverride] }, {
  rangeStartMs: Date.UTC(2026, 0, 1),
  rangeEndMs: Date.UTC(2026, 1, 1),
  defaultTz: TZ,
})
const moved = after.find((x) => x.overridden)
console.log('moved instance:', moved?.summary, 'at', formatWall(utcToWall(moved.startMs, TZ).wall))

// --- 4. Conflict detection ----------------------------------------------------
const lunch = makePlain('lunch-1', 'Team Lunch', makeDateTime(2026, 1, 13, 12, 0, 0, { tzid: TZ }), makeDateTime(2026, 1, 13, 13, 0, 0, { tzid: TZ }))
let conflicts = findConflicts([{ master: lunch, overrides: [] }], { master, overrides: [movedOverride] }, {
  rangeStartMs: Date.UTC(2026, 0, 1),
  rangeEndMs: Date.UTC(2026, 1, 1),
  defaultTz: TZ,
})
// (the moved standup at 15:00 does not overlap the 12:00 lunch)
console.log('conflicts with 12:00 lunch when standup is at 15:00:', conflicts.length)

// But a 12:30–13:00 slot WOULD collide:
const earlyOverride = updateSingleInstance(series, target, {
  start: makeDateTime(2026, 1, 13, 12, 30, 0, { tzid: TZ }),
  end: makeDateTime(2026, 1, 13, 12, 45, 0, { tzid: TZ }),
})
conflicts = findConflicts([{ master: lunch, overrides: [] }], { master, overrides: [earlyOverride] }, {
  rangeStartMs: Date.UTC(2026, 0, 1),
  rangeEndMs: Date.UTC(2026, 1, 1),
  defaultTz: TZ,
})
console.log('conflicts with 12:00 lunch when standup moves to 12:30:', conflicts.length)

function makePlain(uid, summary, start, end) {
  return { uid, summary, dtStart: start, dtEnd: end, status: 'CONFIRMED', categories: [], exdates: [], rdates: [], alarms: [], extra: [] }
}

// --- 5. Lunar / holidays / ganzhi --------------------------------------------
const lunar = solarToLunar(2026, 2, 17)
console.log('\nlunar 2026-02-17 :', lunar?.year, '年', lunar?.leap ? '闰' : '', lunar?.month, '月', lunar?.day, '日')
for (const h of holidaysOnDate(2026, 2, 17)) console.log('  holiday        :', h.name, '(' + h.nameEn + ')')
console.log('  ganzhi/zodiac  :', ganzhiZodiac(2026, 2, 17).ganzhi, ganzhiZodiac(2026, 2, 17).zodiac)
const upcoming = upcomingHolidays({ year: 2026, month: 9, day: 1 }, 45)
console.log('  next holiday   :', upcoming[0]?.name, upcoming[0]?.date.year + '-' + String(upcoming[0]?.date.month).padStart(2, '0') + '-' + String(upcoming[0]?.date.day).padStart(2, '0'))

// --- 6. Round-trip serialization ----------------------------------------------
const text = buildCalendar([master, movedOverride])
console.log('\nserialized bytes:', Buffer.byteLength(text, 'utf8'), '| reparsed events:', parseCalendar(text).events.length)

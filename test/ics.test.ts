import { describe, expect, it } from 'vitest'
import {
  buildCalendar,
  escapeText,
  foldLine,
  formatIcsDateTime,
  makeDate,
  makeDateTime,
  makeUtc,
  parseCalendar,
  parseFirstEvent,
  sameLocalValue,
  serializeEvent,
  toUtcMs,
  unescapeText,
  unescapeText as unescape,
} from '../src/core/ics.js'

const DEFAULT_TZ = 'Asia/Shanghai'

describe('escaping', () => {
  it('escapes and unescapes text', () => {
    expect(escapeText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d')
    expect(unescape(escapeText('a,b;c\\d'))).toBe('a,b;c\\d')
    expect(unescape('line1\\nline2')).toBe('line1\nline2')
    expect(unescape('plain')).toBe('plain')
  })
})

describe('folding', () => {
  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:Hello')).toBe('SUMMARY:Hello')
  })
  it('folds long lines and unfolds on parse', () => {
    const long = 'X-LONG:' + 'a'.repeat(200)
    const folded = foldLine(long)
    expect(folded.includes('\r\n')).toBe(true)
    for (const seg of folded.split('\r\n')) expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(75)
    // round-trip through parse (must not throw on the folded long line)
    const cal = parseCalendar(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${folded}\r\nEND:VCALENDAR`)
    expect(cal.events).toEqual([])
  })
})

describe('date-time values', () => {
  it('formats UTC date-times with Z', () => {
    expect(formatIcsDateTime({ type: 'date-time', utc: true, year: 2024, month: 2, day: 10, hour: 2, minute: 0, second: 0 }))
      .toBe('20240210T020000Z')
  })
  it('converts to UTC via the default timezone', () => {
    const v = makeDateTime(2024, 2, 10, 10, 0, 0, { tzid: 'Asia/Shanghai' })
    expect(toUtcMs(v, DEFAULT_TZ)).toBe(Date.UTC(2024, 1, 10, 2, 0))
  })
  it('converts all-day dates to midnight in default tz', () => {
    expect(toUtcMs(makeDate(2024, 2, 10), DEFAULT_TZ)).toBe(Date.UTC(2024, 1, 9, 16, 0))
  })
  it('local value equality ignores zone', () => {
    expect(sameLocalValue(
      makeDateTime(2024, 2, 10, 9, 0, 0, { tzid: 'Asia/Shanghai' }),
      makeDateTime(2024, 2, 10, 9, 0, 0, { utc: true }),
    )).toBe(true)
  })
})

describe('parse + serialize round-trips', () => {
  const simple = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:abc-123',
    'DTSTAMP:20240101T000000Z',
    'SUMMARY:Team Standup',
    'DESCRIPTION:Daily sync',
    'LOCATION:Room 1',
    'DTSTART;TZID=Asia/Shanghai:20240210T090000',
    'DTEND;TZID=Asia/Shanghai:20240210T100000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('parses a basic event', () => {
    const cal = parseCalendar(simple)
    expect(cal.events).toHaveLength(1)
    const ev = cal.events[0]
    expect(ev.uid).toBe('abc-123')
    expect(ev.summary).toBe('Team Standup')
    expect(ev.location).toBe('Room 1')
    expect(ev.dtStart?.tzid).toBe('Asia/Shanghai')
    expect(toUtcMs(ev.dtStart!, DEFAULT_TZ)).toBe(Date.UTC(2024, 1, 10, 1, 0))
    expect(ev.seq === undefined || Number.isFinite(ev.seq)).toBeTruthy()
  })

  it('serializes and re-parses losslessly', () => {
    const ev = parseFirstEvent(simple)
    const out = buildCalendar([ev])
    const back = parseFirstEvent(out)
    expect(back.uid).toBe(ev.uid)
    expect(back.summary).toBe(ev.summary)
    expect(back.location).toBe(ev.location)
    expect(back.dtStart?.tzid).toBe('Asia/Shanghai')
    expect(sameLocalValue(back.dtStart!, ev.dtStart!)).toBe(true)
  })

  it('handles recurring events with RRULE/EXDATE/RDATE/RECURRENCE-ID', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:rec-1',
      'DTSTART:20240201T090000Z',
      'DTEND:20240201T093000Z',
      'RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE',
      'EXDATE:20240205T090000Z',
      'EXDATE;TZID=Asia/Shanghai:20240205T170000',
      'RDATE:20240301T090000Z',
      'RECURRENCE-ID:20240228T090000Z',
      'SUMMARY:Weekly',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const ev = parseFirstEvent(text)
    expect(ev.rrule).toBe('FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE')
    expect(ev.exdates).toHaveLength(2)
    expect(ev.rdates).toHaveLength(1)
    expect(ev.recurrenceId).toBeTruthy()
    const round = parseFirstEvent(buildCalendar([ev]))
    expect(round.rrule).toBe(ev.rrule)
    expect(round.exdates).toHaveLength(2)
  })

  it('handles all-day events', () => {
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:all-day-1',
      'DTSTART;VALUE=DATE:20240210',
      'DTEND;VALUE=DATE:20240211',
      'SUMMARY:Vacation',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    const ev = parseFirstEvent(text)
    expect(ev.dtStart?.type).toBe('date')
    const round = parseFirstEvent(buildCalendar([ev]))
    expect(round.dtStart?.type).toBe('date')
    expect((round.dtStart as any).value?.kind).toBeUndefined()
  })

  it('preserves unknown properties and alarms', () => {
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:u-1',
      'SUMMARY:With Extra',
      'X-CUSTOM-FIELD:hello',
      'TRANSP:OPAQUE',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    const ev = parseFirstEvent(text)
    expect(ev.extra.some((e) => e.name === 'X-CUSTOM-FIELD')).toBe(true)
    expect(ev.extra.some((e) => e.name === 'TRANSP')).toBe(true)
    expect(ev.alarms).toHaveLength(1)
    expect(ev.alarms[0]).toContain('BEGIN:VALARM')
    const round = parseFirstEvent(buildCalendar([ev]))
    expect(round.extra.some((e) => e.name === 'X-CUSTOM-FIELD')).toBe(true)
    expect(round.alarms).toHaveLength(1)
    expect(round.alarms[0]).toContain('TRIGGER:-PT15M')
  })

  it('unfolds continuation lines', () => {
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:fold-1',
      `SUMMARY:${'long '.repeat(20)}end`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    const cal = parseCalendar(foldLineWrapped(text))
    expect(cal.events[0].summary).toBe(`${'long '.repeat(20)}end`)
  })

  it('creates UTC events and round-trips', () => {
    const ev = {
      uid: 'x',
      summary: 'Meeting',
      dtStart: makeDateTime(2024, 3, 1, 10, 0, 0, { utc: true }),
      dtEnd: makeDateTime(2024, 3, 1, 11, 0, 0, { utc: true }),
      categories: ['work'],
      status: 'CONFIRMED',
      exdates: [],
      rdates: [],
      alarms: [],
      extra: [],
    }
    const text = buildCalendar([ev])
    const back = parseFirstEvent(text)
    expect(back.dtStart?.utc).toBe(true)
    expect(toUtcMs(back.dtStart!, 'UTC')).toBe(Date.UTC(2024, 2, 1, 10, 0))
    expect(back.categories).toEqual(['work'])
    expect(back.status).toBe('CONFIRMED')
    expect(makeUtc(Date.UTC(2024, 2, 1, 10, 0)).utc).toBe(true)
  })

  it('multivalue EXDATE with shared params', () => {
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:mv-1',
      'SUMMARY:Multi',
      'EXDATE;TZID=Asia/Shanghai:20240205T090000,20240206T090000',
      'DTSTART;TZID=Asia/Shanghai:20240201T090000',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    const ev = parseFirstEvent(text)
    expect(ev.exdates).toHaveLength(2)
    expect(ev.exdates.every((e) => e.tzid === 'Asia/Shanghai')).toBe(true)
  })
})

// helper that forces one of the lines to wrap, to exercise folding on parse
function foldLineWrapped(text: string): string {
  const lines = text.split('\r\n')
  return lines.map((l) => (l.startsWith('SUMMARY:') ? foldLine(l) : l)).join('\r\n')
}

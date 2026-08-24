# dsh-calendar

A calendar / scheduling integration **bundle** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh),
built as a self-contained npm package that follows the dsh bundle convention
(`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`).

It connects to any **CalDAV** server (Google Calendar, iCloud, Nextcloud,
custom), stores and computes iCalendar/RRULE data itself, understands Chinese
calendar context (lunar calendar, holidays, `Asia/Shanghai` by default), and
detects time conflicts — all without a single runtime dependency.

---

## Features

1. **CalDAV integration** — `list` / `create` / `update` / `delete` / `search`
   events over standard **REPORT/PROPFIND/GET/PUT/DELETE**, with automatic
   discovery (well-known → current-user-principal → calendar-home-set →
   calendars). Two authentication channels:
   - **Basic** auth (Nextcloud, iCloud, generic servers)
   - **Google OAuth2** via the **device flow** (headless-friendly), with a
     refresh-token flow and secure token storage
   - Credentials come from environment variables **or** the dsh credential
     service (`ctx.credentials`) **or** a local chmod-0600 store. Secrets are
     **never written to logs** — a `redact()` helper masks them in output.

2. **RRULE expansion + single-instance editing** — a from-scratch RFC 5545
   recurrence engine covering `FREQ` (SECONDLY…YEARLY), `INTERVAL`, `COUNT`,
   `UNTIL` (UTC & local), `BYDAY` (with ordinals), `BYMONTH`, `BYMONTHDAY`,
   `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS`, `WKST`, `BYHOUR/BYMINUTE/BYSECOND`,
   plus `EXDATE` and `RDATE`. Editing or deleting **one occurrence** writes a
   `RECURRENCE-ID` override (`STATUS:CANCELLED` for deletion) and never
   touches the series master.

3. **Chinese bias** — lunar calendar conversion (astronomically computed,
   full 2000–2100 coverage), Chinese holidays (春节 / 清明 / 端午 / 中秋 /
   元宵 / 七夕 / 重阳 / 除夕 / 元旦 / 劳动节 / 国庆节), 干支/生肖 anchored
   at 立春, `Asia/Shanghai` default timezone, and a `cal_remind` tool whose
   output plugs straight into dsh's session-local `schedule_create`.

4. **Conflict detection** — overlapping events (timed, all-day, and across
   recurring instances) are flagged with the overlapping span; updates can
   exclude the event itself.

5. **Timezone handling** — an embedded, dependency-free timezone engine
   (present-day rules, 2000–2100) with correct DST transitions; wall-time ↔
   UTC conversion with documented ambiguity/gap resolution; TZID-preserving
   ICS round-trips.

6. **Toolchain** — dsh tools under `ctx.tools` (`cal_list`, `cal_get`,
   `cal_create`, `cal_update`, `cal_delete`, `cal_search`, `cal_conflicts`,
   `cal_holidays`, plus `cal_calendars`, `cal_remind`) and a standalone CLI
   (`dsh-calendar`).

---

## Bundle layout

| file | purpose |
|---|---|
| `package.json` | npm manifest with `dsh.bundle.patch` + peer deps |
| `cordis.patch.yml` | config layer mounting the bundle entry |
| `src/index.ts` | dsh plugin entry: `name` / `inject` / `Config` / `apply` |
| `src/service.ts` | high-level operations shared by tools & CLI |
| `src/tools.ts` | `cal_*` tool definitions |
| `src/credentials.ts` | secret resolution + redaction |
| `src/dav/*` | CalDAV client, OAuth2 (Google device flow), XML, store |
| `src/core/*` | timezone, iCalendar, RRULE, recurrence, conflicts, lunar |

No runtime dependencies — `peerDependencies` (`@deepseek-ai/cordis`,
`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) are only used by the
entry module and are provided by the dsh runtime.

---

## Install & connect to dsh

Prerequisite: a working dsh profile. Then:

```bash
# 1. build the bundle (produces lib/)
npm install
npm run build

# 2. install it into your dsh profile
dsh plugin --profile <name> add ./calendar
```

This pnpm-links the checkout, appends the bundle to the profile, and dsh then
mounts the entry module via `cordis.patch.yml` (`id: calendar, name:
dsh-calendar`), registering the `cal_*` tools.

To iterate without installing, layer the patch directly:

```bash
dsh --profile <name> --patch ./cordis.patch.yml
```

(When installed by git/pack instead of a local checkout, run `npm run build`
first — the manifest ships built `lib/`, not sources.)

### Configuration

Configuration goes through the bundle's `Config` schema (set in the patch /
profile overlay):

```yaml
- insert:
    - id: calendar
      name: dsh-calendar
      config:
        defaultTimezone: Asia/Shanghai
        serverUrl: https://nextcloud.example.com/remote.php/dav/
        # or calendarUrl: https://nextcloud.example.com/remote.php/dav/calendars/me/personal/
        authMode: basic   # basic | google
```

or via environment variables / the dsh credential service (see below).

#### Credentials (never logged)

| secret | meaning |
|---|---|
| `CALDAV_URL` | full calendar collection URL (Basic) |
| `CALDAV_USERNAME` / `CALDAV_PASSWORD` | Basic credentials |
| `GOOGLE_CLIENT_ID` | Google OAuth client id |
| `GOOGLE_CALDAV_REFRESH_TOKEN` | long-lived refresh token (see below) |

Set them in the environment, or store them in the **dsh credential service**
(`credentialRef` names match the table above, e.g.
`credentialRef('CALDAV_PASSWORD')`), or, for the CLI, in the local
`.calendar-credentials.json` (mode 0600). The resolver checks environment →
dsh credential service → local store.

#### Google OAuth (device flow)

```bash
dsh-calendar auth google --device --client-id <CLIENT_ID>
```

opens a URL to authorize; the refresh token is saved to the secure store. The
server-side client refreshes the access token automatically when near expiry.

---

## Tools (`ctx.tools`)

| tool | description |
|---|---|
| `cal_list` | events in a window (with wall/UTC times) |
| `cal_get` | one series + its concrete occurrences |
| `cal_create` | create (RRULE/EXDATE/RDATE/all-day) + conflict check |
| `cal_update` | update whole series, or one occurrence via `recurrenceId` |
| `cal_delete` | delete series, or one occurrence (→ CANCELLED override) |
| `cal_search` | text search over titles/descriptions/locations |
| `cal_conflicts` | check a proposed time (incl. recurring) for overlaps |
| `cal_holidays` | upcoming Chinese holidays + today's 干支/生肖 |
| `cal_calendars` | list accessible calendars |
| `cal_remind` | reminder plan, formatted for dsh `schedule_create` |

**Reminder linkage:** dsh's schedule surface is deliberately model-facing
(`schedule_create` / `schedule_list` / `schedule_delete`). `cal_remind`
expands the event and returns `{ at: { date, time, time_zone }, prompt }`
per occurrence — pass those directly to `schedule_create` to register
session-local reminders in the calendar's timezone.

---

## CLI

```
dsh-calendar list  [--start "2026-01-01" --end "2026-01-31" --tz Asia/Shanghai]
dsh-calendar get      <uid>
dsh-calendar create   --summary "Team sync" --start "2026-03-02 10:00" --end "2026-03-02 11:00" \
                      --rrule "FREQ=WEEKLY;COUNT=4"
dsh-calendar update   <uid> --summary "Renamed" --recurrence-id "2026-03-09 10:00" --start "2026-03-09 15:00"
dsh-calendar delete   <uid> [--recurrence-id "2026-03-09 10:00"]
dsh-calendar search   "meeting"
dsh-calendar conflicts --start "2026-06-01 14:00" --end "2026-06-01 15:00"
dsh-calendar holidays --days 60
dsh-calendar calendars
dsh-calendar remind   <uid> --before 30m
dsh-calendar auth google --device
dsh-calendar auth status
```

A `.env` file in the working directory is loaded (if present) before
credentials are resolved.

---

## Timezone model

The engine embeds present-day IANA-style rules for common zones (Shanghai,
Tokyo, Seoul, London, Paris, Berlin, New York, Chicago, Los Angeles, Sydney,
Auckland, …). Conversions are:

- `wall (TZID) ↔ UTC` with deterministic DST handling:
  - a **fold** (autumn, wall time occurs twice) picks the **first** occurrence
    (the larger offset);
  - a **gap** (spring, wall time does not exist) is shifted **forward** across
    the gap.
- All-day dates are stored as dates and interpreted at midnight in the event
  / default timezone.
- RRULE instances are expanded on the DTSTART's wall-clock representation, so
  a weekly 09:00 meeting stays at 09:00 on both sides of a DST transition.

## Lunar calendar

Computed from astronomical principles (Meeus truncated new-moon &
solar-longitude series) rather than a hard-coded table, so the whole
**2000–2100** range is covered by construction, including leap months (闰月)
and the famously unusual 2033 闰十一月. The test suite pins 春节 dates across
2000–2100, known leap months (2001–2033), and holiday dates (端午/中秋/清明).

---

## Development

```bash
npm install
npm test             # vitest: 185 tests (rrule vectors, DST, lunar, conflicts, CalDAV mock)
npm run typecheck
npm run build        # compile to lib/
```

Tests run against an in-process mock CalDAV server (`test/helpers/mockCaldav.ts`)
and RFC 5545 example vectors — no network access needed.

---

## License

MIT — see [LICENSE](./LICENSE).

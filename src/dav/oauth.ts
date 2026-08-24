/**
 * Google OAuth2 device-flow support for Google Calendar CalDAV.
 *
 * The device flow lets a headless agent obtain long-lived credentials without
 * a browser server component: the user opens a verification URL and enters a
 * code. Resulting tokens (access + refresh) are persisted through a pluggable
 * TokenStore (dsh credential service or a chmod-0600 local file) and the
 * access token is transparently refreshed when near expiry.
 */

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAtMs: number
  tokenType?: string
  scope?: string
}

export interface TokenStore {
  load(): Promise<TokenSet | undefined>
  save(tokens: TokenSet): Promise<void>
}

export const GOOGLE_DEVICE_URL = 'https://oauth2.googleapis.com/device/code'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_CALDAV_SCOPE = 'https://www.googleapis.com/auth/calendar'
export const GOOGLE_CALDAV_ROOT = 'https://apidata.googleusercontent.com/caldav/v2/'

export interface DeviceCodePayload {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(form).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'follow',
  })
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`OAuth endpoint returned non-JSON (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const err = json['error'] ?? `HTTP ${res.status}`
    throw new Error(`OAuth error: ${String(err)}`)
  }
  return json
}

function parseDevice(json: Record<string, unknown>): DeviceCodePayload {
  return {
    deviceCode: String(json['device_code']),
    userCode: String(json['user_code']),
    verificationUrl: String(json['verification_url']),
    expiresIn: Number(json['expires_in']),
    interval: Number(json['interval'] ?? 5),
  }
}

/** Step 1: start a device flow; the user must visit verificationUrl and enter userCode. */
export async function startDeviceFlow(clientId: string, scope = GOOGLE_CALDAV_SCOPE): Promise<DeviceCodePayload> {
  const json = await postForm(GOOGLE_DEVICE_URL, { client_id: clientId, scope })
  return parseDevice(json)
}

export type PollResult =
  | { status: 'ok'; tokens: TokenSet }
  | { status: 'pending' }
  | { status: 'slow_down'; retryAfterMs: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

/** Step 2: poll until the user authorizes (or the flow expires/denies). */
export async function pollDeviceFlow(clientId: string, deviceCode: string): Promise<PollResult> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString(),
    redirect: 'follow',
  })
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    return { status: 'error', message: `non-JSON response (HTTP ${res.status})` }
  }
  if (json['error']) {
    switch (json['error']) {
      case 'authorization_pending': return { status: 'pending' }
      case 'slow_down': return { status: 'slow_down', retryAfterMs: Number(json['interval'] ?? 10) * 1000 }
      case 'access_denied': return { status: 'denied' }
      case 'expired_token': return { status: 'expired' }
      default: return { status: 'error', message: String(json['error']) }
    }
  }
  if (json['access_token']) {
    return { status: 'ok', tokens: parseTokens(json) }
  }
  return { status: 'error', message: 'unexpected poll response' }
}

function parseTokens(json: Record<string, unknown>): TokenSet {
  const expiresIn = Number(json['expires_in'] ?? 3600)
  return {
    accessToken: String(json['access_token']),
    refreshToken: json['refresh_token'] !== undefined ? String(json['refresh_token']) : undefined,
    expiresAtMs: Date.now() + expiresIn * 1000,
    tokenType: json['token_type'] !== undefined ? String(json['token_type']) : undefined,
    scope: json['scope'] !== undefined ? String(json['scope']) : undefined,
  }
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<TokenSet> {
  const form: Record<string, string> = {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }
  if (clientSecret) form['client_secret'] = clientSecret
  const json = await postForm(GOOGLE_TOKEN_URL, form)
  return parseTokens(json)
}

/** Run the whole device flow to completion (good for an interactive CLI). */
export async function runDeviceFlow(
  clientId: string,
  opts: { scope?: string; print?: (msg: string) => void; sleep?: (ms: number) => Promise<void>; deadlineMs?: number },
): Promise<TokenSet> {
  const print = opts.print ?? (() => undefined)
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const scope = opts.scope ?? GOOGLE_CALDAV_SCOPE
  const started = await startDeviceFlow(clientId, scope)
  print(`\nOpen the following URL in your browser:\n\n  ${started.verificationUrl}\n\nand enter the code:\n\n  ${started.userCode}\n\nWaiting for authorization (device code expires in ${started.expiresIn}s)...`)
  const deadline = Date.now() + (opts.deadlineMs ?? started.expiresIn * 1000)
  let intervalMs = Math.max(started.interval, 5) * 1000
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const result = await pollDeviceFlow(clientId, started.deviceCode)
    if (result.status === 'ok') return result.tokens
    if (result.status === 'slow_down') intervalMs = result.retryAfterMs
    if (result.status === 'denied') throw new Error('authorization denied by user')
    if (result.status === 'expired') throw new Error('device code expired; please retry')
    if (result.status === 'error') throw new Error(`device flow error: ${result.message}`)
  }
  throw new Error('device flow timed out')
}

/** OAuth client that keeps an access token fresh via its TokenStore. */
export class GoogleOAuth {
  constructor(
    private readonly clientId: string,
    private readonly store: TokenStore,
    private readonly clientSecret?: string,
  ) {}

  /** A valid access token, refreshing and persisting when near expiry. */
  async accessToken(now = Date.now()): Promise<string> {
    const current = await this.store.load()
    if (current && current.expiresAtMs - now > 60000) return current.accessToken
    if (current?.refreshToken) {
      const fresh = await refreshAccessToken(this.clientId, current.refreshToken, this.clientSecret)
      const merged: TokenSet = {
        ...fresh,
        refreshToken: fresh.refreshToken ?? current.refreshToken,
      }
      await this.store.save(merged)
      return merged.accessToken
    }
    throw new Error('no OAuth tokens available (run the device flow first)')
  }
}

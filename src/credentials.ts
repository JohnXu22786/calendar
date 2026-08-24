/**
 * Secret resolution and redaction for dsh-calendar.
 *
 * Secrets are read from (in order, first non-empty wins):
 *   1. process environment variables (never logged)
 *   2. the dsh credential service (ctx.credentials), when provided
 *   3. an optional local chmod-0600 JSON store (used by the standalone CLI)
 *
 * Nothing here ever writes secrets to logs: `redact()` masks every resolved
 * secret value in any string passed through it.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** Minimal shape of the dsh credential service surface we use. */
export interface CredentialServiceLike {
  resolve(name: string): Promise<{ value: string } | undefined> | { value: string } | undefined
  set?(name: string, value: string): Promise<void> | void
  unset?(name: string): Promise<void> | void
}

export interface ResolverOptions {
  /** dsh ctx.credentials (optional) */
  service?: CredentialServiceLike
  /** function returning env vars (defaults to process.env) */
  env?: () => Record<string, string | undefined>
  /** path to the local secure store; undefined disables it */
  storePath?: string
}

export class CredentialResolver {
  private readonly service?: CredentialServiceLike
  private readonly env: () => Record<string, string | undefined>
  private readonly storePath?: string
  private readonly resolved: Map<string, string> = new Map()

  constructor(opts: ResolverOptions = {}) {
    this.service = opts.service
    this.env = opts.env ?? (() => process.env as Record<string, string | undefined>)
    this.storePath = opts.storePath
  }

  /** Resolve a secret by configured name; caches the value for redaction. */
  async get(name: string): Promise<string | undefined> {
    const found = await this.lookup(name)
    if (found !== undefined) this.resolved.set(name, found)
    return found
  }

  private async lookup(name: string): Promise<string | undefined> {
    const envVal = this.env()[name]
    if (envVal !== undefined && envVal !== '') return envVal
    if (this.service) {
      const hit = await this.service.resolve(name)
      if (hit && hit.value !== undefined && hit.value !== '') return hit.value
    }
    if (this.storePath) {
      const rec = await this.readStore()
      return rec[name]
    }
    return undefined
  }

  /** True when a secret is configured somewhere. */
  async has(name: string): Promise<boolean> {
    return (await this.lookup(name)) !== undefined
  }

  /** Persist a value (dsh credential service when available, else the local store). */
  async set(name: string, value: string): Promise<void> {
    this.resolved.set(name, value)
    if (this.service?.set) {
      await this.service.set(name, value)
      return
    }
    if (this.storePath) {
      await this.writeStore((rec) => ({ ...rec, [name]: value }))
    } else {
      throw new Error(`no writable secret backend configured for "${name}"`)
    }
  }

  private async readStore(): Promise<Record<string, string>> {
    if (!this.storePath) return {}
    try {
      const raw = await fs.readFile(this.storePath, 'utf8')
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async writeStore(mutate: (rec: Record<string, string>) => Record<string, string>): Promise<void> {
    if (!this.storePath) return
    const rec = await this.readStore()
    const next = mutate(rec)
    await fs.mkdir(path.dirname(this.storePath), { recursive: true })
    const tmp = `${this.storePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.storePath)
    // best-effort: enforce 0600 on POSIX-like platforms
    try {
      await fs.chmod(this.storePath, 0o600)
    } catch {
      /* not supported on this platform */
    }
  }

  /**
   * Mask all resolved secrets inside a string (for safe logging/output), and
   * always mask URL userinfo ("scheme://user:pass@host") even before a secret
   * was ever resolved.
   */
  redact(text: string): string {
    let out = text
    for (const v of this.resolved.values()) {
      if (v.length >= 4) out = out.split(v).join('***')
    }
    // scheme://userinfo@host — mask everything between the scheme and the last
    // '@' that precedes a '/' or whitespace (handles passwords containing @).
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/]*@)/gi, '$1***@')
    return out
  }
}

/** Default local credential store location for the CLI. */
export function defaultStorePath(cwd?: string): string {
  const dir = cwd ?? process.cwd()
  const p = path.join(dir, '.calendar-credentials.json')
  return p
}

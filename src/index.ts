/**
 * dsh-calendar bundle entry.
 *
 * Exports the Cordis plugin surface: `name`, `inject` (optional tools +
 * credentials services), `Config` (Schemastery schema) and `apply(ctx, config)`.
 *
 * Mounted by the bundle's cordis.patch.yml (`id: calendar, name: dsh-calendar`).
 */

import type { Context } from '@deepseek-ai/cordis'
import { Schema } from '@deepseek-ai/schemastery'
import { CalendarService } from './service.js'
import { CredentialResolver, type CredentialServiceLike } from './credentials.js'
import { buildTools, renderBlocks } from './tools.js'

export const name = 'calendar'

/** Both services are optional so the bundle degrades gracefully: without a
 *  tools service nothing is registered, without a credentials service the
 *  environment / local store fallback is used. */
export const inject = {
  tools: 'optional' as const,
  credentials: 'optional' as const,
}

export interface Config {
  defaultTimezone: string
  serverUrl: string
  calendarUrl: string
  authMode: 'basic' | 'google' | ''
  prodid: string
}

// Schemastery schema used by dsh for validation + defaults.
export const Config = Schema.object({
  defaultTimezone: Schema.string().default('Asia/Shanghai'),
  serverUrl: Schema.string().default(''),
  calendarUrl: Schema.string().default(''),
  authMode: Schema.union(['basic', 'google', '']).default(''),
  prodid: Schema.string().default('-//dsh-calendar//EN'),
})

export function apply(ctx: Context, config: Config): void {
  const logger = (ctx.logger ?? console) as {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }

  const defaultTz = (config.defaultTimezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai'
  let servicePromise: Promise<CalendarService> | undefined

  const credentialsService = ctx.credentials ? (ctx.credentials as unknown as CredentialServiceLike) : undefined

  const getService = async (): Promise<CalendarService> => {
    if (!servicePromise) {
      const p = (async (): Promise<CalendarService> => {
        // ONE resolver shared by buildService and redaction, so the secrets it
        // resolves during build are the same ones redact() masks afterwards.
        const creds = new CredentialResolver({ service: credentialsService })
        const { buildService } = await import('./service.js')
        const built = await buildService({
          authMode: config.authMode === '' ? undefined : config.authMode,
          serverUrl: config.serverUrl || undefined,
          calendarUrl: config.calendarUrl || undefined,
          defaultTz,
          prodid: config.prodid,
          credentials: creds,
        })
        return new CalendarService(built.store, built.defaultTz, creds)
      })()
      servicePromise = p
      // a transient failure must not poison the service forever: clear the
      // memo so the next tool call retries initialization.
      p.catch((e: Error) => {
        logger.warn(`[dsh-calendar] initialization failed (will retry): ${e.message}`)
        if (servicePromise === p) servicePromise = undefined
      })
    }
    return servicePromise
  }

  // Register the cal_* tools if the tools service is present.
  if (ctx.tools?.register) {
    const serviceFromError = async (): Promise<CalendarService | null> => {
      try {
        return await getService()
      } catch {
        return null
      }
    }
    const toolDefs = buildTools(getService)
    for (const tool of toolDefs) {
      const def = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: { type: 'object', description: 'structured calendar result' },
          render: (_args: unknown, value: unknown) => renderBlocks(value),
        },
        async execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }) {
          try {
            return await tool.execute(args as Record<string, string>, { signal: exec?.signal })
          } catch (e) {
            // never leak secrets in tool errors
            const service = await serviceFromError()
            const message = e instanceof Error ? e.message : String(e)
            const redacted = service ? service.creds.redact(message) : message
            throw new Error(redacted)
          }
        },
      }
      ctx.tools.register(def)
    }
    logger.info(`[dsh-calendar] registered ${toolDefs.length} cal_* tools (timezone ${defaultTz})`)
  } else {
    logger.warn('[dsh-calendar] tools service unavailable; skipping tool registration')
  }
}

export default { name, inject, Config, apply }

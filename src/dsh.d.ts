/**
 * Ambient type declarations for the dsh / Cordis surface used by the bundle
 * entry. These packages are peerDependencies provided by the dsh runtime;
 * the declarations let the bundle type-check and build without them installed.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools?: {
      register(def: unknown): () => void
      get(name: string, scope?: unknown): unknown
    }
    credentials?: {
      resolve(name: string): Promise<{ value: string; source?: string } | undefined> | { value: string; source?: string } | undefined
      set(name: string, value: string): Promise<void> | void
      describe(name: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>
    }
    logger?: {
      info(msg: string, ...args: unknown[]): void
      warn(msg: string, ...args: unknown[]): void
      error(msg: string, ...args: unknown[]): void
    }
    effect?<T>(fn: (ctx: Context) => T): void
  }
}

declare module '@deepseek-ai/schemastery' {
  // The real package exports a chained builder + validator; we only need the
  // builder here. Typed `any` on purpose.
  export const Schema: Record<string, any>
  export namespace Schema {
    export {}
  }
  export const z: unknown
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ParameterSchemaSpec {
    type?: string
    required?: boolean
    description?: string
    default?: unknown
    enum?: unknown[]
    items?: unknown
  }
  export interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, ParameterSchemaSpec>
    output: {
      schema: unknown
      render?(args: Record<string, unknown>, value: unknown): Array<{ type: string; text?: string }>
    }
    async execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
  }
  export function defineTool(def: ToolDefinition): ToolDefinition
}

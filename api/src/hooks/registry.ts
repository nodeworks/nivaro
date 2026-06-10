import type { FastifyRequest } from 'fastify'
import type { Database } from '../db/index.js'
import type { User } from '../types.js'

export type HookAction = 'create' | 'update' | 'delete' | 'read'
export type HookTiming = 'before' | 'after'

export interface HookContext {
  collection: string
  action: HookAction
  keys?: Array<string | number>
  payload?: Record<string, unknown>
  result?: unknown
  previousData?: Record<string, unknown>
  user?: User
  database: Database
  req?: FastifyRequest
}

type HookFn = (ctx: HookContext) => void | Promise<void>

interface HookEntry {
  collection: string | '*'
  action: HookAction | '*'
  fn: HookFn
  extensionId?: string
  disabled?: boolean
}

class HookRegistry {
  private beforeHooks: HookEntry[] = []
  private afterHooks: HookEntry[] = []

  before(
    collection: string | '*',
    action: HookAction | '*',
    fn: HookFn,
    opts?: { extensionId?: string }
  ) {
    this.beforeHooks.push({ collection, action, fn, extensionId: opts?.extensionId })
  }

  after(
    collection: string | '*',
    action: HookAction | '*',
    fn: HookFn,
    opts?: { extensionId?: string }
  ) {
    this.afterHooks.push({ collection, action, fn, extensionId: opts?.extensionId })
  }

  setExtensionEnabled(extensionId: string, enabled: boolean) {
    for (const entry of [...this.beforeHooks, ...this.afterHooks]) {
      if (entry.extensionId === extensionId) {
        entry.disabled = !enabled
      }
    }
  }

  removeExtensionHooks(extensionId: string) {
    this.beforeHooks = this.beforeHooks.filter((e) => e.extensionId !== extensionId)
    this.afterHooks = this.afterHooks.filter((e) => e.extensionId !== extensionId)
  }

  async trigger(timing: HookTiming, ctx: HookContext) {
    const list = timing === 'before' ? this.beforeHooks : this.afterHooks
    for (const entry of list) {
      if (entry.disabled) continue
      const collectionMatch = entry.collection === '*' || entry.collection === ctx.collection
      const actionMatch = entry.action === '*' || entry.action === ctx.action
      if (!collectionMatch || !actionMatch) continue
      try {
        await entry.fn(ctx)
      } catch (err) {
        // Before-hooks may intentionally block the operation by throwing an
        // error that carries an HTTP statusCode (e.g. AI validation 422).
        // Such errors propagate to the caller; everything else stays non-fatal.
        if (
          timing === 'before' &&
          typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ) {
          throw err
        }
        console.error({ err, timing, collection: ctx.collection, action: ctx.action }, 'Hook error')
      }
    }
  }
}

export const hooks = new HookRegistry()

import type { FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import type { ExtensionUser } from './user.js'

export type HookAction = 'create' | 'update' | 'delete' | 'read'
export type HookTiming = 'before' | 'after'

/** What a before/after hook receives. `previousData` is set on update and
 *  delete (captured before the write); `result` on after-hooks; `keys` holds
 *  the record id(s) the write concerned. */
export interface ExtensionHookContext {
  collection: string
  action: HookAction
  keys?: Array<string | number>
  payload?: Record<string, unknown>
  result?: unknown
  previousData?: Record<string, unknown>
  /** Caller-supplied justification for this write (change-reason config). */
  changeReason?: string
  /** True while a write is being rehearsed (`dry_run`): a hook may read and
   *  shape the payload, and must not write, send or notify. */
  dryRun?: boolean
  user?: ExtensionUser
  database: Knex
  req?: FastifyRequest
}

export type ExtensionHookHandler = (ctx: ExtensionHookContext) => void | Promise<void>

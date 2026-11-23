/**
 * @nivaro/extension-kit — the contract a Nivaro extension is written against.
 *
 * Types: the extension context and every registration the core accepts.
 * Helpers: the small pure functions extensions used to hand-copy from the API
 * because `api/src` cannot be imported from an extension.
 */

export { databaseKey, hasColumn, resetColumnProbes } from './column-probe.js'
export type * from './context.js'
export {
  deprecationMessage,
  KIT_DEPRECATIONS,
  type KitDeprecation,
  watchDeprecatedMembers
} from './deprecations.js'
export type * from './environments.js'
export type * from './flows.js'
export type * from './help-videos.js'
export type * from './hooks.js'
export type * from './imports.js'
export type * from './notifications.js'
export type * from './obligations.js'
export type * from './quality.js'
export type * from './readable-ops.js'
export type * from './registrations.js'
export {
  REQUESTER_COLUMNS,
  type RequesterTable,
  requesterInsertFields,
  requesterSelectColumns
} from './requester-columns.js'
export type * from './signals.js'
export type * from './tools.js'
export type * from './user.js'

/**
 * Set by a core that hands extensions `ctx.apps` (the app a request or job serves), before it
 * imports any extension: `globalThis[Symbol.for(CTX_APPS_MARKER)] === true`. An extension that
 * keeps per-app state through `ctx.apps` declares `shared: true` only when it is set, so an older
 * core on a shared deployment refuses the extension instead of serving every app from one slot.
 */
export const CTX_APPS_MARKER = 'nivaro.extension.ctx.apps'

/** Whether the running core provides `ctx.apps` (see CTX_APPS_MARKER). */
export function coreProvidesApps(): boolean {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(CTX_APPS_MARKER)] === true
}

/** Type-checks an extension's default export without changing it. */
export function defineExtension<T extends import('./context.js').ExtensionDefinition>(ext: T): T {
  return ext
}
export {
  createTestContext,
  createTestDb,
  type TestContext,
  type TestContextOptions,
  type TestDbState,
  type TestRoute
} from './testing.js'

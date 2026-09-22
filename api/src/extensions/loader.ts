import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Inngest } from 'inngest'
import type { Knex } from 'knex'
import type { Database } from '../db/index.js'
import {
  emitTrigger,
  type OpFieldSchema,
  type OpHandler,
  type RegisteredOp,
  type RegisteredTrigger,
  registerOp,
  registerTrigger
} from '../flows/registry.js'
import { type HookAction, hooks } from '../hooks/registry.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { registerPortalLinks } from '../services/app-links.js'
import { registerBriefLine } from '../services/approval-brief-lines.js'
import { registerDigestSection } from '../services/daily-digest.js'
import {
  type ExtensionEventHandler,
  publishExtensionEvent,
  registerExtensionEventHandler
} from '../services/extension-events.js'
import { type CallOptions, type CallResult, callExternalApi } from '../services/external-apis.js'
import { registerIntegrityCheck } from '../services/integrity-checks.js'
import { registerMailTemplateRoot, renderMailTemplate } from '../services/mail.js'
import { registerMailType, renderViaFlow } from '../services/mail-types.js'
import { type NotifyUserOptions, notifyUser } from '../services/notification-channels.js'
import { registerReadinessCheck } from '../services/readiness.js'
import { type BulkActionDef, bulkActionRegistry } from './bulk-actions.js'
import { type CollectionViewDef, collectionViewRegistry } from './collection-views.js'
import { type DashboardWidgetDef, dashboardWidgetRegistry } from './dashboard-widgets.js'
import { type FieldTypeDef, fieldTypeRegistry } from './field-types.js'
import { type ImportParserDef, importParserRegistry } from './import-parsers.js'
import { type ItemActionDef, itemActionRegistry } from './item-actions.js'
import {
  type NotificationChannelDef,
  notificationChannelRegistry
} from './notification-channels.js'
import {
  type NotificationSourceProvider,
  notificationSourceRegistry
} from './notification-sources.js'
import {
  type MachineMarkerSet,
  type RelatedNoteProvider,
  relatedNoteRegistry
} from './related-notes.js'
import { type StorageAdapter, storageAdapterRegistry } from './storage-adapters.js'
import { type ValidatorDef, validatorRegistry } from './validators.js'
import '../plugin-types.js'
import { runLongSql } from '../services/run-long.js'

export type FlowOpRegistration = Omit<RegisteredOp, never>
export type FlowTriggerRegistration = RegisteredTrigger
export type {
  BulkActionDef,
  CollectionViewDef,
  DashboardWidgetDef,
  FieldTypeDef,
  ImportParserDef,
  ItemActionDef,
  NotificationChannelDef,
  OpFieldSchema,
  OpHandler,
  StorageAdapter,
  ValidatorDef
}

export interface ExtensionContext {
  app: FastifyInstance
  database: Database
  inngest: Inngest
  logger: FastifyInstance['log']
  /** Admin-editable extension settings (#112/#505) — declared on the export.
   *  Values are parsed by the declared type (number/boolean), 30s cache. */
  settings?: {
    get(key: string): Promise<string | number | boolean | null>
    getAll(): Promise<Record<string, string | number | boolean | null>>
  }
  /** Durable event outbox (#504) — publish inserts a pending row delivered by
   *  the sweep cron; `on` registers a delivery handler for this extension's
   *  events ('*' = every type). Delivery retries with exponential backoff. */
  events: {
    publish(eventType: string, payload?: unknown): Promise<number | null>
    on(eventType: string | '*', fn: ExtensionEventHandler): void
  }
  /** Call a configured external API by name or numeric ID. Auth resolved automatically. */
  callExternalApi(nameOrId: string | number, options?: CallOptions): Promise<CallResult>
  /**
   * Write an audit entry to nivaro_activity. Extension-driven mutations that
   * bypass the items service (raw knex writes in crons, hooks, or routes) are
   * invisible to the audit log otherwise — log them here. The action string is
   * automatically namespaced with the extension id (`<extId>:<action>`) so
   * extension activity is distinguishable from core activity. Never throws.
   */
  /**
   * Long-running SQL outside knex.raw's 15s request timeout — an EXEC of a
   * legacy procedure, a scan over a 16M-row activity table. One statement,
   * its own timeout (default one hour), rows back. Bind nothing: the batch is
   * sent as text, so only interpolate values you built yourself.
   */
  sql: {
    runLong<T = Record<string, unknown>>(sql: string, opts?: { timeoutMs?: number }): Promise<T[]>
  }
  logActivity(entry: {
    action: string
    user?: string | null
    collection?: string
    item?: string | number
    comment?: string
    /** person | machine | import | integration — default: machine with no user (#518). */
    origin?: 'person' | 'machine' | 'import' | 'integration'
  }): Promise<number | null>
  /**
   * Deliver a notification through the full channel stack — inbox row, live
   * socket event, browser push, optional email — honouring the recipient's
   * notification rules (per-category in-app / push / email, quiet hours).
   * Extensions must use this instead of inserting nivaro_notifications rows
   * directly: a raw insert bypasses every preference. Never throws.
   */
  notifyUser(userId: string, opts: NotifyUserOptions): Promise<void>
  /** Hook helpers scoped to this extension — hooks are tagged and can be disabled/removed. */
  hooks: {
    before(
      collection: string | '*',
      action: HookAction | '*',
      fn: Parameters<typeof hooks.before>[2]
    ): void
    after(
      collection: string | '*',
      action: HookAction | '*',
      fn: Parameters<typeof hooks.after>[2]
    ): void
  }
  /** Cron helpers scoped to this extension — jobs are paused/resumed with the extension. */
  cron: {
    /** Register a recurring job. `id` is scoped to this extension automatically. */
    schedule(
      id: string,
      expression: string,
      fn: () => void | Promise<void>,
      opts?: {
        /** Plain-language purpose — what the job does and what it touches (Background Jobs page). */
        description?: string
        heavy?: boolean
        idempotent?: 'safe' | 'unsafe' | 'unknown'
      }
    ): void
    /** Cancel a previously scheduled job. */
    unschedule(id: string): void
    /** Attach a description / heavy / idempotent flag to one of this extension's jobs after scheduling. */
    annotate(
      id: string,
      meta: {
        description?: string
        heavy?: boolean
        idempotent?: 'safe' | 'unsafe' | 'unknown'
        /** The deployment flag this job no-ops behind, and whether it currently lets the job run. */
        gate?: { flag: string; enabled: boolean }
      }
    ): void
  }
  /** Register custom bulk actions that appear in the collection browser action bar. */
  bulkActions: {
    register(def: BulkActionDef): void
  }
  /** Register contextual action buttons shown in the item editor toolbar. */
  itemActions: {
    register(def: ItemActionDef): void
  }
  /** Register custom notification delivery channels (e.g. SMS, Slack, Teams). */
  notificationChannels: {
    register(def: NotificationChannelDef): void
  }
  /** Contribute extension-owned alert subscriptions to the profile's
   *  notification-sources aggregation. */
  notificationSources: {
    register(provider: NotificationSourceProvider): void
  }
  /** Add read-only entries to a record's Notes thread (GET /comments/related)
   *  — integration events, external history — beside transitions and
   *  change reasons. */
  notes: {
    registerSource(provider: RelatedNoteProvider): void
    /** #10 — declare the comment strings this extension's machinery writes
     *  (sync provenance tags, proc markers) so the Notes thread drops them
     *  and row history renders them as provenance, not as someone's note. */
    registerMachineMarkers(set: MachineMarkerSet): void
  }
  /** Register custom dashboard widget types shown in the dashboard builder. */
  dashboardWidgets: {
    register(def: DashboardWidgetDef): void
  }
  /** Register a named file storage adapter (e.g. S3, Azure Blob). */
  storage: {
    register(name: string, adapter: StorageAdapter): void
    /** Activate a registered adapter for all new uploads. */
    setActive(name: string): void
  }
  /** Register custom field types with optional serialize/deserialize transforms. */
  fieldTypes: {
    register(def: FieldTypeDef): void
  }
  /** Register custom collection view modes (Kanban, calendar, Gantt, map, etc.). */
  collectionViews: {
    register(def: CollectionViewDef): void
  }
  /** Register file import parsers for additional formats (Excel, XML, JSON, etc.). */
  importParsers: {
    register(def: ImportParserDef): void
  }
  /** Register custom field validators (new operators for validation_rules). */
  validators: {
    register(def: ValidatorDef): void
  }
  /** Register custom flow operation types and triggers. */
  approvalBrief: {
    /** One short line on the transition confirm's approval brief for records of `collection`. */
    registerLine(
      collection: string,
      fn: import('../services/approval-brief-lines.js').BriefLineProvider
    ): void
  }
  digest: {
    /** Add a per-user section to the daily action digest email. */
    registerSection(fn: import('../services/daily-digest.js').DigestSectionProvider): void
  }
  readiness: {
    /** Register a scored check on the go-live readiness scorecard. */
    registerCheck(check: import('../services/readiness.js').ReadinessCheck): void
  }
  integrity: {
    /** Register a Data Integrity check the conformance sweep, the record
     *  banner and the Fix button run alongside the built-in rules. */
    registerCheck(check: import('../services/integrity-checks.js').IntegrityCheck): void
  }
  links: {
    /** Register the headless frontend's base URL + route map so email links
     *  land there for non-admin recipients (Settings → Frontend app wins). */
    register(reg: import('../services/app-links.js').LinkRegistration): void
  }
  mail: {
    /** Register an email type so it appears in the admin mail harness
     *  (preview / send with real data). */
    registerType(def: import('../services/mail-types.js').MailTypeDef): void
    /** Dry-run an active flow with a payload and return what its mail op would send. */
    renderViaFlow(
      flowName: string,
      payload: Record<string, unknown>
    ): Promise<{ to: string; subject: string; html: string } | null>
    /** Render a named Liquid mail template (core or extension root). */
    renderTemplate(name: string, data: Record<string, unknown>): Promise<string>
  }
  flows: {
    /**
     * Register a custom operation type. The handler receives parsed options,
     * current flow data, and execution context.
     */
    registerOperation(op: FlowOpRegistration): void
    /**
     * Register a custom trigger type. It appears in the flow trigger dropdown.
     * Call `flows.emit(type, payload)` from hooks, cron jobs, or route handlers
     * to fire all active flows using this trigger.
     */
    registerTrigger(trigger: FlowTriggerRegistration): void
    /**
     * Fire all active flows registered to this trigger type.
     * Safe to call from any async context — fire-and-forget.
     */
    emit(triggerType: string, payload: Record<string, unknown>): void
  }
  /** Chat bot (#247): register tools the AI chat bot may call. Handlers run
   *  with the ASKING user — the extension owns its permission posture. */
  chatBot: {
    registerTool(def: import('../services/chat-bot.js').BotToolDef): void
  }
  /** Auth middleware helpers — use as Fastify `onRequest` handlers. */
  auth: {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  /**
   * Cloud-only context — populated when CLOUD_META_DB_URL is set.
   * Undefined in self-hosted mode. Cloud extensions check `if (ctx.cloud)` before use.
   */
  cloud?: {
    /** Immutable tenant UUID for the current request (used as R2 key prefix). Undefined outside request context (e.g., cron jobs). */
    getTenantId(): string | undefined
    /** Tenant slug for the current request. Undefined outside request context. */
    getTenantSlug(): string | undefined
    /** Knex client connected to the Nivaro Cloud meta database (cloud_tenants, cloud_billing, etc.). */
    metaDb: Knex
  }
}

export interface Extension {
  id: string
  register(ctx: ExtensionContext): void | Promise<void>
  /** Permission scopes (#215): what this extension touches — a declared
   *  manifest shown before enabling, not an enforcement boundary. */
  scopes?: string[]
  /** Dependencies (#426): extension ids that must load FIRST. Missing or
   *  failed deps make this extension error instead of half-working. */
  requires?: string[]
  /** Command-palette entries (#260) served to the admin palette. */
  palette?: Array<{ label: string; path: string }>
  /** Admin-editable settings (#112/#505), stored in nivaro_extension_settings.
   *  type 'secret' (or the legacy `secret: true` flag) masks the value on read
   *  and preserves the stored value when the mask is re-submitted. */
  settings?: Array<{
    key: string
    label: string
    type?: 'string' | 'number' | 'boolean' | 'secret'
    description?: string
    default?: string
    secret?: boolean
    /** #17 — what production is expected to hold; the readiness scorecard
     *  warns when the live value differs. */
    production_expect?: string
    /** #13 — refuse a value with a message (null = fine). */
    validate?: (value: string | number | boolean | null) => string | null | Promise<string | null>
    /** #13 — applied the moment a value is saved (no restart, no cache wait). */
    on_change?: (value: string | number | boolean | null) => void | Promise<void>
  }>
  /** Capability manifest (#660): freeform declared capabilities (e.g.
   *  'routes','cron','hooks','flows','item-actions'). The loader ALSO records
   *  which ctx members register() actually touched — the Extensions page shows
   *  observed-but-undeclared capabilities amber. */
  capabilities?: string[]
  /** Health probe (#262): quick self-check surfaced on the Extensions page. */
  healthCheck?(): Promise<{ ok: boolean; note?: string }>
}

export interface PluginManifest {
  uiBundle?: string // filename of the UI bundle, e.g. "ui.js"
  slots?: string[] // informational list of slot names used
  name?: string
  version?: string
}

export interface ExtensionEntry {
  id: string
  status: 'loaded' | 'error' | 'missing'
  enabled: boolean
  path: string
  error?: string
  manifest?: PluginManifest
  cloud?: boolean
  scopes?: string[]
  requires?: string[]
  palette?: Array<{ label: string; path: string }>
  has_settings?: boolean
  has_health_check?: boolean
  /** Capability manifest (#660) — declared list from the export; observed
   *  actuals live in the module map, composed by GET /extensions. */
  declared_capabilities?: string[]
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export const EXTENSIONS_DIR = new URL('../../extensions', import.meta.url).pathname
const CONFIG_PATH = join(EXTENSIONS_DIR, '.config.json')

// Cloud-internal extensions — loaded only when CLOUD_META_DB_URL is set.
// This directory is not present in the OSS repo; it is injected by the cloud
// deployment pipeline from the private nivaro-cloud repo.
const CLOUD_EXTENSIONS_DIR = new URL('../../cloud-extensions', import.meta.url).pathname

// ─── Config persistence ───────────────────────────────────────────────────────

function readConfig(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, boolean>
  } catch {
    return {}
  }
}

function writeConfig(config: Record<string, boolean>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const extensionRegistry = new Map<string, ExtensionEntry>()

// ── Extension settings (#112/#505) ───────────────────────────────────────────

export interface ExtensionSettingDecl {
  key: string
  label: string
  /** Normalized: 'secret' folds in the legacy `secret: true` flag. */
  type: 'string' | 'number' | 'boolean' | 'secret'
  description?: string
  default?: string
  production_expect?: string
  /** The decl carries a validate and/or on_change handler (#13). */
  has_validate?: boolean
  has_on_change?: boolean
}

export const extensionSettingsDecls = new Map<string, NonNullable<Extension['settings']>>()

/** The declared settings schema for an extension, types normalized (#505). */
export function getExtensionSettingsSchema(extId: string): ExtensionSettingDecl[] {
  return (extensionSettingsDecls.get(extId) ?? []).map((d) => ({
    key: d.key,
    label: d.label,
    type: d.type === 'secret' || d.secret ? 'secret' : (d.type ?? 'string'),
    ...(d.description ? { description: d.description } : {}),
    ...(d.default !== undefined ? { default: d.default } : {}),
    ...(d.production_expect !== undefined ? { production_expect: d.production_expect } : {}),
    has_validate: typeof d.validate === 'function',
    has_on_change: typeof d.on_change === 'function'
  }))
}

/** #13 — the live handlers a setting declared (never serialized). */
export function getSettingHandlers(
  extId: string,
  key: string
): {
  validate?: (value: string | number | boolean | null) => string | null | Promise<string | null>
  on_change?: (value: string | number | boolean | null) => void | Promise<void>
} {
  const d = (extensionSettingsDecls.get(extId) ?? []).find((x) => x.key === key)
  return { validate: d?.validate, on_change: d?.on_change }
}

type SettingValue = string | number | boolean | null

const settingsCache = new Map<string, { values: Record<string, SettingValue>; at: number }>()
export function bustExtensionSettingsCache(extId?: string): void {
  if (extId) settingsCache.delete(extId)
  else settingsCache.clear()
}

function parseSettingValue(raw: string | null, type: ExtensionSettingDecl['type']): SettingValue {
  if (raw == null) return null
  if (type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  if (type === 'boolean') return raw === 'true' || raw === '1'
  return raw
}

export async function readExtensionSettings(extId: string): Promise<Record<string, SettingValue>> {
  const hit = settingsCache.get(extId)
  if (hit && Date.now() - hit.at < 30_000) return hit.values
  const { db } = await import('../db/index.js')
  const decls = getExtensionSettingsSchema(extId)
  const raw: Record<string, string | null> = {}
  for (const d of decls) raw[d.key] = d.default ?? null
  try {
    const rows = (await db('nivaro_extension_settings')
      .where({ extension_id: extId })
      .select('key', 'value')) as Array<{ key: string; value: string | null }>
    for (const r of rows) raw[r.key] = r.value
  } catch {
    /* table missing pre-migration — declared defaults stand */
  }
  const typeByKey = new Map(decls.map((d) => [d.key, d.type]))
  const values: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(raw)) {
    values[key] = parseSettingValue(value, typeByKey.get(key) ?? 'string')
  }
  settingsCache.set(extId, { values, at: Date.now() })
  return values
}

// ── Capability manifest (#660) ───────────────────────────────────────────────
// Observed actuals — which ctx members register() (and later runtime code)
// actually touched, recorded by thin wrappers in loadExtension.
const observedCapabilities = new Map<string, Set<string>>()
export function getObservedCapabilities(extId: string): string[] {
  return Array.from(observedCapabilities.get(extId) ?? []).sort()
}
/** #40 — what each extension registered, by kind, for the registry page.
 *  Kept beside the observed-capability ledger: capabilities say WHICH ctx
 *  members were touched, this says WHAT they were given. */
const extensionRegistrations = new Map<string, Map<string, string[]>>()
function recordRegistration(extId: string, kind: string, label: string): void {
  let kinds = extensionRegistrations.get(extId)
  if (!kinds) {
    kinds = new Map()
    extensionRegistrations.set(extId, kinds)
  }
  const list = kinds.get(kind) ?? []
  if (!list.includes(label)) list.push(label)
  kinds.set(kind, list)
}
export function getExtensionRegistrations(extId: string): Record<string, string[]> {
  return Object.fromEntries(extensionRegistrations.get(extId) ?? [])
}

/** `<id>.next` / `<id>.prev` hold staged and previous builds (#76) — never
 *  extensions of their own. */
function isParkedBuildDir(name: string): boolean {
  return name.endsWith('.next') || name.endsWith('.prev')
}

function noteCapability(extId: string, cap: string): void {
  const set = observedCapabilities.get(extId) ?? new Set<string>()
  set.add(cap)
  observedCapabilities.set(extId, set)
}

// ── Health probes (#262) ─────────────────────────────────────────────────────
export const extensionHealthChecks = new Map<
  string,
  () => Promise<{ ok: boolean; note?: string }>
>()

// ── Log channels (#427) ──────────────────────────────────────────────────────
// Per-extension ring buffer of recent log lines — served by
// GET /extensions/:id/logs so an extension's chatter is inspectable without
// grepping the server log.
const extensionLogs = new Map<string, Array<{ at: string; level: string; msg: string }>>()
export function getExtensionLogs(extId: string): Array<{ at: string; level: string; msg: string }> {
  return extensionLogs.get(extId) ?? []
}
function pushExtLog(extId: string, level: string, args: unknown[]): void {
  const list = extensionLogs.get(extId) ?? []
  const msg = args
    .map((a) =>
      typeof a === 'string'
        ? a
        : (() => {
            try {
              return JSON.stringify(a)
            } catch {
              return String(a)
            }
          })()
    )
    .join(' ')
    .slice(0, 500)
  list.push({ at: new Date().toISOString(), level, msg })
  if (list.length > 200) list.splice(0, list.length - 200)
  extensionLogs.set(extId, list)
}
function channelLogger(base: FastifyInstance['log'], extId: string): FastifyInstance['log'] {
  // pino child tags every server log line with {extension}; the wrapper also
  // mirrors info/warn/error/debug into the per-extension ring buffer.
  const child = base.child({ extension: extId })
  const wrapped = Object.create(child) as FastifyInstance['log']
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    ;(wrapped as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
      pushExtLog(extId, level, args)
      ;(child[level] as (...a: unknown[]) => void)(...args)
    }
  }
  return wrapped
}

// ─── Load a single extension folder ──────────────────────────────────────────

async function resolveIndexPath(dir: string): Promise<string | null> {
  for (const name of ['index.ts', 'index.js']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

async function loadExtension(
  entry: string,
  ctx: Omit<
    ExtensionContext,
    | 'hooks'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'auth'
    | 'flows'
    | 'events'
    | 'chatBot'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'integrity'
    | 'mail'
    | 'links'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'notificationSources'
    | 'notes'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
  >,
  config: Record<string, boolean>
): Promise<void> {
  const dirPath = join(EXTENSIONS_DIR, entry)

  try {
    const s = await stat(dirPath)
    if (!s.isDirectory()) return
  } catch {
    return
  }

  const indexPath = await resolveIndexPath(dirPath)
  if (!indexPath) {
    ctx.logger.warn({ entry }, 'Extension has no index.ts or index.js, skipping')
    return
  }

  const enabled = config[entry] !== false // enabled by default

  // Convention: <extension>/templates/mail holds Liquid mail templates that
  // override/extend the core set (including 'base' — how a deployment
  // rebrands every outgoing email). Registered before register() runs so an
  // extension's own startup sends already resolve its templates.
  if (enabled) {
    const mailDir = join(dirPath, 'templates', 'mail')
    try {
      const s = await stat(mailDir)
      if (s.isDirectory()) {
        registerMailTemplateRoot(mailDir)
        ctx.logger.info({ entry }, 'Registered extension mail templates')
      }
    } catch {
      // no templates dir — fine
    }
  }

  try {
    // Cache-bust with timestamp so hot-scan reloads fresh modules
    const mod = (await import(`${indexPath}?t=${Date.now()}`)) as { default: Extension }
    const ext = mod.default

    if (!ext?.id || typeof ext.register !== 'function') {
      ctx.logger.warn({ entry }, 'Extension missing id or register(), skipping')
      return
    }

    const extId = ext.id

    // Capability manifest (#660): the ctx members register() touches are noted
    // as observed capabilities, compared against the declared list in the UI.
    const note = (cap: string) => noteCapability(extId, cap)
    const own = (kind: string, label: string) => recordRegistration(extId, kind, label)
    // app.register → 'routes': a minimal Proxy intercepting ONLY `register`;
    // every other property passes through to the real instance untouched.
    const observedApp = new Proxy(ctx.app, {
      get(target, prop) {
        if (prop === 'register') {
          return (...args: unknown[]) => {
            note('routes')
            return (target.register as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return Reflect.get(target, prop)
      }
    }) as FastifyInstance

    // Scoped hooks + cron context — all entries are tagged with this extension's id
    const scopedCtx: ExtensionContext = {
      ...ctx,
      app: observedApp,
      // Log channels (#427): every line tagged {extension} + ring-buffered.
      logger: channelLogger(ctx.logger, extId),
      settings: {
        get: async (key: string) => (await readExtensionSettings(extId))[key] ?? null,
        getAll: () => readExtensionSettings(extId)
      },
      events: {
        publish: (eventType, payload) => {
          note('events')
          return publishExtensionEvent(extId, eventType, payload)
        },
        on: (eventType, fn) => {
          note('events')
          own('event_handlers', eventType)
          registerExtensionEventHandler(extId, eventType, fn)
        }
      },
      callExternalApi: (nameOrId, options) => {
        note('external-apis')
        return callExternalApi(nameOrId, options)
      },
      notifyUser: (userId, opts) => {
        note('notifications')
        return notifyUser(ctx.app, userId, opts).then(
          () => undefined,
          () => undefined
        )
      },
      sql: {
        runLong: (sql, opts) => runLongSql(sql, opts)
      },
      logActivity: (entry) => {
        note('activity')
        return logActivity({
          action: `${extId}:${entry.action}`,
          user: entry.user ?? null,
          collection: entry.collection,
          item: entry.item != null ? String(entry.item) : undefined,
          comment: entry.comment,
          // An extension row with no acting user is the extension itself (#518).
          origin: entry.origin ?? (entry.user ? 'person' : 'machine')
        })
      },
      auth: { authenticate, requireAuth, requireAdmin },
      hooks: {
        before: (collection, action, fn) => {
          note('hooks')
          hooks.before(collection, action, fn, { extensionId: extId })
        },
        after: (collection, action, fn) => {
          note('hooks')
          hooks.after(collection, action, fn, { extensionId: extId })
        }
      },
      cron: {
        schedule: (id, expression, fn, opts) => {
          note('cron')
          ctx.app.cron.schedule(`ext:${extId}:${id}`, expression, fn, {
            extensionId: extId,
            ...(opts ?? {})
          })
        },
        unschedule: (id) => ctx.app.cron.unschedule(`ext:${extId}:${id}`),
        annotate: (id, meta) => ctx.app.cron.annotate(`ext:${extId}:${id}`, meta)
      },
      bulkActions: {
        register: (def) => {
          note('bulk-actions')
          own('bulk_actions', `${def.id} · ${def.label}`)
          bulkActionRegistry.register(def)
        }
      },
      itemActions: {
        register: (def) => {
          note('item-actions')
          own('item_actions', `${def.id} · ${def.label}`)
          itemActionRegistry.register(def)
        }
      },
      notificationChannels: {
        register: (def) => {
          note('notification-channels')
          own(
            'notification_channels',
            String(
              (def as { id?: string; key?: string }).id ??
                (def as { key?: string }).key ??
                'channel'
            )
          )
          notificationChannelRegistry.register(def)
        }
      },
      notificationSources: {
        register: (provider) => {
          note('notification-sources')
          own(
            'notification_sources',
            String(
              (provider as { id?: string; key?: string }).id ??
                (provider as { key?: string }).key ??
                'source'
            )
          )
          notificationSourceRegistry.register(provider)
        }
      },
      notes: {
        registerSource: (provider) => {
          note('notes')
          own('note_sources', `${provider.id} · ${provider.collection}`)
          relatedNoteRegistry.register(provider)
        },
        registerMachineMarkers: (set) => {
          note('notes')
          own(
            'note_markers',
            [...(set.exact ?? []), ...(set.prefixes ?? []).map((p) => `${p}…`)].join(', ')
          )
          relatedNoteRegistry.registerMachineMarkers(extId, set)
        }
      },
      dashboardWidgets: {
        register: (def) => {
          note('dashboard-widgets')
          own(
            'dashboard_widgets',
            String(
              (def as { type?: string; id?: string }).type ??
                (def as { id?: string }).id ??
                'widget'
            )
          )
          dashboardWidgetRegistry.register(def)
        }
      },
      storage: {
        register: (name, adapter) => {
          note('storage')
          own('storage_adapters', name)
          storageAdapterRegistry.register(name, adapter)
        },
        setActive: (name) => storageAdapterRegistry.setActive(name)
      },
      fieldTypes: {
        register: (def) => {
          note('field-types')
          own(
            'field_types',
            String(
              (def as { type?: string; id?: string }).type ??
                (def as { id?: string }).id ??
                'field type'
            )
          )
          fieldTypeRegistry.register(def)
        }
      },
      collectionViews: {
        register: (def) => {
          note('collection-views')
          own(
            'collection_views',
            String(
              (def as { id?: string; type?: string }).id ??
                (def as { type?: string }).type ??
                'view'
            )
          )
          collectionViewRegistry.register(def)
        }
      },
      importParsers: {
        register: (def) => {
          note('import-parsers')
          own(
            'import_parsers',
            String(
              (def as { id?: string; name?: string }).id ??
                (def as { name?: string }).name ??
                'parser'
            )
          )
          importParserRegistry.register(def)
        }
      },
      validators: {
        register: (def) => {
          note('validators')
          own(
            'validators',
            String(
              (def as { id?: string; type?: string }).id ??
                (def as { type?: string }).type ??
                'validator'
            )
          )
          validatorRegistry.register(def)
        }
      },
      approvalBrief: {
        registerLine: (collection, fn) => {
          note('approvalBrief')
          own('approval_brief_lines', collection)
          registerBriefLine(extId, collection, fn)
        }
      },
      digest: {
        registerSection: (fn) => {
          note('digest')
          own(
            'digest_sections',
            fn.name ||
              `section ${(extensionRegistrations.get(extId)?.get('digest_sections')?.length ?? 0) + 1}`
          )
          registerDigestSection(fn)
        }
      },
      readiness: {
        registerCheck: (check) => {
          note('readiness')
          own('readiness_checks', `${check.id} · ${check.label}`)
          registerReadinessCheck(check)
        }
      },
      integrity: {
        registerCheck: (check) => {
          note('integrity')
          own('integrity_checks', `${check.id} · ${check.label}`)
          registerIntegrityCheck(check)
        }
      },
      links: {
        register: (reg) => {
          note('links')
          own('portal_links', (reg as { base?: string }).base ?? 'routes')
          registerPortalLinks(reg)
        }
      },
      mail: {
        registerType: (def) => {
          note('mail')
          own('mail_types', `${def.key} · ${def.label}`)
          registerMailType(def)
        },
        renderViaFlow: (flowName, payload) => renderViaFlow(flowName, payload),
        renderTemplate: (name, data) => renderMailTemplate(name, data)
      },
      flows: {
        registerOperation: (op) => {
          note('flows')
          own('flow_operations', `${op.type}${op.label ? ` · ${op.label}` : ''}`)
          registerOp(op)
        },
        registerTrigger: (trigger) => {
          note('flows')
          own('flow_triggers', `${trigger.type}${trigger.label ? ` · ${trigger.label}` : ''}`)
          registerTrigger(trigger)
        },
        emit: (triggerType, payload) => {
          note('flows')
          emitTrigger(triggerType, payload, ctx.logger)
        }
      },
      chatBot: {
        registerTool: (def) => {
          note('chat-bot')
          own('chat_bot_tools', String((def as { name?: string }).name ?? 'tool'))
          void import('../services/chat-bot.js')
            .then(({ registerBotTool }) => registerBotTool(def))
            .catch(() => {})
        }
      }
    }

    await ext.register(scopedCtx)

    // Respect initial enabled state from config
    if (!enabled) {
      hooks.setExtensionEnabled(extId, false)
      ctx.app.cron.setExtensionEnabled(extId, false)
    }

    if (Array.isArray(ext.settings) && ext.settings.length > 0)
      extensionSettingsDecls.set(extId, ext.settings)
    if (typeof ext.healthCheck === 'function')
      extensionHealthChecks.set(extId, ext.healthCheck.bind(ext))

    extensionRegistry.set(ext.id, {
      id: ext.id,
      status: 'loaded',
      enabled,
      path: dirPath,
      scopes: Array.isArray(ext.scopes) ? ext.scopes.map(String).slice(0, 30) : undefined,
      requires: Array.isArray(ext.requires) ? ext.requires.map(String) : undefined,
      palette: Array.isArray(ext.palette)
        ? ext.palette
            .filter((pp) => pp && typeof pp.label === 'string' && typeof pp.path === 'string')
            .slice(0, 20)
        : undefined,
      has_settings: Array.isArray(ext.settings) && ext.settings.length > 0,
      has_health_check: typeof ext.healthCheck === 'function',
      declared_capabilities: Array.isArray(ext.capabilities)
        ? ext.capabilities.map(String).slice(0, 30)
        : undefined
    })

    // Load optional manifest.json for UI plugin support
    const manifestPath = join(dirPath, 'manifest.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
        const registryEntry = extensionRegistry.get(ext.id)
        if (registryEntry) {
          registryEntry.manifest = manifest
          // Register a route to serve the UI bundle if declared.
          // Validate ext.id is safe before embedding it in a route path.
          const SAFE_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/
          if (!SAFE_ID.test(extId)) {
            ctx.logger.warn(
              { extId },
              'Extension id contains unsafe characters — skipping UI bundle route'
            )
          } else if (manifest.uiBundle) {
            // Validate the bundle filename contains no path separators or traversal sequences.
            const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/
            if (!SAFE_FILENAME.test(manifest.uiBundle)) {
              ctx.logger.warn(
                { uiBundle: manifest.uiBundle },
                'Extension uiBundle filename is unsafe — skipping'
              )
            } else {
              const bundlePath = join(dirPath, manifest.uiBundle)
              if (existsSync(bundlePath)) {
                ctx.app.get(`/api/extensions/${extId}/ui.js`, async (_req, reply) => {
                  reply.type('application/javascript')
                  return reply.send(createReadStream(bundlePath))
                })
              }
            }
          }
        }
      } catch (err) {
        ctx.logger.warn({ entry, err }, 'Failed to parse extension manifest.json')
      }
    }

    ctx.logger.info({ id: ext.id, enabled }, 'Extension loaded')
  } catch (err) {
    ctx.logger.error({ err, entry }, 'Failed to load extension')
    extensionRegistry.set(entry, {
      id: entry,
      status: 'error',
      enabled: false,
      path: dirPath,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// ─── Initial load ─────────────────────────────────────────────────────────────

export async function loadExtensions(
  ctx: Omit<
    ExtensionContext,
    | 'hooks'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'auth'
    | 'flows'
    | 'events'
    | 'chatBot'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'integrity'
    | 'mail'
    | 'links'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'notificationSources'
    | 'notes'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
  >
) {
  registerExtensionSettingsReadiness()
  let entries: string[]
  try {
    entries = await readdir(EXTENSIONS_DIR)
  } catch {
    ctx.logger.debug('No extensions directory, skipping')
    return
  }

  const config = readConfig()
  // Filter out hidden files/dirs (like .config.json itself)
  const dirs = entries.filter((e) => !e.startsWith('.') && !isParkedBuildDir(e))

  // Dependencies (#426): pre-import every module to read `requires`, then
  // topologically order the load. A missing/failed dependency turns its
  // dependents into explicit errors instead of half-working extensions.
  const meta = new Map<string, { dir: string; requires: string[] }>()
  const dirById = new Map<string, string>()
  for (const dir of dirs) {
    try {
      const entryFile = await resolveIndexPath(join(EXTENSIONS_DIR, dir))
      if (!entryFile) continue
      const mod = (await import(entryFile)) as { default?: Extension }
      const id = mod.default?.id
      if (id) {
        meta.set(id, {
          dir,
          requires: Array.isArray(mod.default?.requires) ? mod.default.requires.map(String) : []
        })
        dirById.set(id, dir)
      } else {
        meta.set(`__dir:${dir}`, { dir, requires: [] })
      }
    } catch {
      // Import error — loadExtension will surface it properly below.
      meta.set(`__dir:${dir}`, { dir, requires: [] })
    }
  }
  const ordered: string[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()
  const failedDeps = new Map<string, string>()
  const visit = (id: string): void => {
    if (done.has(id)) return
    if (visiting.has(id)) {
      failedDeps.set(id, 'circular dependency')
      done.add(id)
      return
    }
    visiting.add(id)
    const m = meta.get(id)
    if (m) {
      for (const dep of m.requires) {
        if (!meta.has(dep)) {
          failedDeps.set(id, `missing dependency "${dep}"`)
        } else {
          visit(dep)
          if (failedDeps.has(dep)) failedDeps.set(id, `dependency "${dep}" failed`)
        }
      }
    }
    visiting.delete(id)
    done.add(id)
    if (m) ordered.push(m.dir)
  }
  for (const id of meta.keys()) visit(id)

  for (const dir of ordered) {
    const failedId = [...failedDeps.entries()].find(([fid]) => dirById.get(fid) === dir)?.[0]
    if (failedId) {
      const reason = failedDeps.get(failedId) ?? 'dependency failure'
      ctx.logger.error(`Extension "${failedId}" not loaded: ${reason}`)
      extensionRegistry.set(failedId, {
        id: failedId,
        status: 'error',
        enabled: false,
        path: join(EXTENSIONS_DIR, dir),
        error: reason
      })
      continue
    }
    await loadExtension(dir, ctx, config)
  }

  // Surface any IDs in config that didn't resolve to a real folder
  for (const id of Object.keys(config)) {
    if (!extensionRegistry.has(id)) {
      extensionRegistry.set(id, {
        id,
        status: 'missing',
        enabled: false,
        path: join(EXTENSIONS_DIR, id)
      })
    }
  }
}

// ─── Cloud extensions ─────────────────────────────────────────────────────────
// Loads internal cloud extensions from api/cloud-extensions/.
// Always-enabled — no .config.json, no extensionRegistry entries (hidden from
// the /api/extensions endpoint), no UI bundle routes (cloud-internal only).

export async function loadCloudExtensions(
  ctx: Omit<
    ExtensionContext,
    | 'hooks'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'auth'
    | 'flows'
    | 'events'
    | 'chatBot'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'notificationSources'
    | 'notes'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'integrity'
    | 'mail'
    | 'links'
  >
) {
  let entries: string[]
  try {
    entries = await readdir(CLOUD_EXTENSIONS_DIR)
  } catch {
    ctx.logger.debug('No cloud-extensions directory, skipping')
    return
  }

  const dirs = entries.filter((e) => !e.startsWith('.') && !isParkedBuildDir(e))

  for (const entry of dirs) {
    const dirPath = join(CLOUD_EXTENSIONS_DIR, entry)

    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) continue
    } catch {
      continue
    }

    let indexPath: string | null = null
    for (const name of ['index.js', 'index.ts']) {
      const p = join(dirPath, name)
      if (existsSync(p)) {
        indexPath = p
        break
      }
    }
    if (!indexPath) {
      ctx.logger.warn({ entry }, 'Cloud extension has no index file, skipping')
      continue
    }

    try {
      const mod = (await import(`${indexPath}?t=${Date.now()}`)) as { default: Extension }
      const ext = mod.default

      if (!ext?.id || typeof ext.register !== 'function') {
        ctx.logger.warn({ entry }, 'Cloud extension missing id or register(), skipping')
        continue
      }

      const extId = ext.id

      const scopedCtx: ExtensionContext = {
        ...ctx,
        callExternalApi,
        events: {
          publish: (eventType, payload) => publishExtensionEvent(extId, eventType, payload),
          on: (eventType, fn) => registerExtensionEventHandler(extId, eventType, fn)
        },
        approvalBrief: {
          registerLine: (collection, fn) => registerBriefLine(ext.id ?? 'extension', collection, fn)
        },
        digest: {
          registerSection: (fn) => registerDigestSection(fn)
        },
        readiness: {
          registerCheck: (check) => registerReadinessCheck(check)
        },
        integrity: {
          registerCheck: (check) => registerIntegrityCheck(check)
        },
        links: {
          register: (reg) => registerPortalLinks(reg)
        },
        mail: {
          registerType: (def) => registerMailType(def),
          renderViaFlow: (flowName, payload) => renderViaFlow(flowName, payload),
          renderTemplate: (name, data) => renderMailTemplate(name, data)
        },
        notifyUser: (userId, opts) =>
          notifyUser(ctx.app, userId, opts).then(
            () => undefined,
            () => undefined
          ),
        sql: {
          runLong: (sql, opts) => runLongSql(sql, { ...opts, knex: ctx.database as never })
        },
        logActivity: (entry) =>
          logActivity({
            action: `${extId}:${entry.action}`,
            user: entry.user ?? null,
            collection: entry.collection,
            item: entry.item != null ? String(entry.item) : undefined,
            comment: entry.comment,
            origin: entry.origin ?? (entry.user ? 'person' : 'machine')
          }),
        auth: { authenticate, requireAuth, requireAdmin },
        hooks: {
          before: (collection, action, fn) =>
            hooks.before(collection, action, fn, { extensionId: extId }),
          after: (collection, action, fn) =>
            hooks.after(collection, action, fn, { extensionId: extId })
        },
        cron: {
          schedule: (id, expression, fn) =>
            ctx.app.cron.schedule(`cloud-ext:${extId}:${id}`, expression, fn, {
              extensionId: extId
            }),
          unschedule: (id) => ctx.app.cron.unschedule(`cloud-ext:${extId}:${id}`),
          annotate: (id, meta) => ctx.app.cron.annotate(`cloud-ext:${extId}:${id}`, meta)
        },
        bulkActions: { register: (def) => bulkActionRegistry.register(def) },
        itemActions: { register: (def) => itemActionRegistry.register(def) },
        notificationChannels: { register: (def) => notificationChannelRegistry.register(def) },
        notificationSources: {
          register: (provider) => notificationSourceRegistry.register(provider)
        },
        notes: {
          registerSource: (provider) => relatedNoteRegistry.register(provider),
          registerMachineMarkers: (set) => relatedNoteRegistry.registerMachineMarkers(extId, set)
        },
        dashboardWidgets: { register: (def) => dashboardWidgetRegistry.register(def) },
        storage: {
          register: (name, adapter) => storageAdapterRegistry.register(name, adapter),
          setActive: (name) => storageAdapterRegistry.setActive(name)
        },
        fieldTypes: { register: (def) => fieldTypeRegistry.register(def) },
        collectionViews: { register: (def) => collectionViewRegistry.register(def) },
        importParsers: { register: (def) => importParserRegistry.register(def) },
        validators: { register: (def) => validatorRegistry.register(def) },
        flows: {
          registerOperation: (op) => registerOp(op),
          registerTrigger: (trigger) => registerTrigger(trigger),
          emit: (triggerType, payload) => emitTrigger(triggerType, payload, ctx.logger)
        },
        chatBot: {
          registerTool: (def) => {
            void import('../services/chat-bot.js')
              .then(({ registerBotTool }) => registerBotTool(def))
              .catch(() => {})
          }
        }
      }

      await ext.register(scopedCtx)

      // Load optional manifest.json for UI bundle support
      const manifestPath = join(dirPath, 'manifest.json')
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
          extensionRegistry.set(extId, {
            id: extId,
            status: 'loaded',
            enabled: true,
            path: dirPath,
            manifest,
            cloud: true
          })
          // Validate extId is safe before embedding it in a route path.
          const SAFE_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/
          if (!SAFE_ID.test(extId)) {
            ctx.logger.warn(
              { extId },
              'Cloud extension id contains unsafe characters — skipping UI bundle route'
            )
          } else if (manifest.uiBundle) {
            const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/
            if (!SAFE_FILENAME.test(manifest.uiBundle)) {
              ctx.logger.warn(
                { uiBundle: manifest.uiBundle },
                'Cloud extension uiBundle filename is unsafe — skipping'
              )
            } else {
              const bundlePath = join(dirPath, manifest.uiBundle)
              if (existsSync(bundlePath)) {
                ctx.app.get(`/api/extensions/${extId}/ui.js`, async (_req, reply) => {
                  reply.type('application/javascript')
                  return reply.send(createReadStream(bundlePath))
                })
              }
            }
          }
        } catch (err) {
          ctx.logger.warn({ entry, err }, 'Failed to parse cloud extension manifest.json')
        }
      }

      ctx.logger.info({ id: extId }, 'Cloud extension loaded')
    } catch (err) {
      ctx.logger.error({ err, entry }, 'Failed to load cloud extension')
    }
  }
}

// ─── Enable / disable ─────────────────────────────────────────────────────────

// Set by server.ts after app is built — gives loader access to app.cron
let _app: FastifyInstance | null = null
export function setApp(app: FastifyInstance) {
  _app = app
}

export function setExtensionEnabled(id: string, enabled: boolean): boolean {
  const entry = extensionRegistry.get(id)
  if (!entry || entry.status !== 'loaded') return false

  entry.enabled = enabled
  hooks.setExtensionEnabled(id, enabled)
  _app?.cron.setExtensionEnabled(id, enabled)

  const config = readConfig()
  config[id] = enabled
  writeConfig(config)

  return true
}

// ─── Remove a missing/stale entry ────────────────────────────────────────────

export function removeExtension(id: string): boolean {
  const entry = extensionRegistry.get(id)
  if (!entry) return false

  extensionRegistry.delete(id)
  hooks.removeExtensionHooks(id)

  const config = readConfig()
  delete config[id]
  writeConfig(config)

  return true
}

// ─── Hot-scan: load any NEW extensions added since startup ────────────────────

export async function scanNewExtensions(
  ctx: Omit<
    ExtensionContext,
    | 'hooks'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'auth'
    | 'flows'
    | 'events'
    | 'chatBot'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'notificationSources'
    | 'notes'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'integrity'
    | 'mail'
    | 'links'
  >
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(EXTENSIONS_DIR)
  } catch {
    return []
  }

  const config = readConfig()
  const loaded: string[] = []

  for (const entry of entries) {
    if (entry.startsWith('.') || isParkedBuildDir(entry)) continue
    // Skip already registered extensions (by folder name match or id)
    const alreadyLoaded = [...extensionRegistry.values()].some(
      (e) => e.path === join(EXTENSIONS_DIR, entry)
    )
    if (alreadyLoaded) continue

    await loadExtension(entry, ctx, config)
    if (extensionRegistry.has(entry)) loaded.push(entry)
  }

  return loaded
}

// ── Readiness (#17) — declared settings vs their production expectation ─────
// Registered once, runs over every loaded extension's declarations at check
// time, so it needs no per-extension wiring.
let settingsReadinessRegistered = false
export function registerExtensionSettingsReadiness(): void {
  if (settingsReadinessRegistered) return
  settingsReadinessRegistered = true
  registerReadinessCheck({
    id: 'extension-settings-expectations',
    label: 'Extension settings match their production expectations',
    description:
      'Every extension setting declared with production_expect holds that value on this instance.',
    group: 'Configuration',
    run: async () => {
      const expected: Array<{ ext: string; key: string; label: string; expect: string }> = []
      for (const [ext, decls] of extensionSettingsDecls) {
        for (const d of decls) {
          if (d.production_expect !== undefined) {
            expected.push({ ext, key: d.key, label: d.label, expect: d.production_expect })
          }
        }
      }
      if (expected.length === 0) {
        return { status: 'skip', detail: 'No extension declares a production expectation.' }
      }
      const blockers: string[] = []
      for (const e of expected) {
        const live = (await readExtensionSettings(e.ext))[e.key]
        const liveStr = live == null ? '' : String(live)
        if (liveStr !== e.expect) {
          blockers.push(`${e.ext} · ${e.key} = "${liveStr}" (production expects "${e.expect}")`)
        }
      }
      return blockers.length === 0
        ? { status: 'pass', detail: `${expected.length} expectation(s) hold.` }
        : {
            status: 'warn',
            detail: `${blockers.length} of ${expected.length} differ from production.`,
            blockers
          }
    }
  })
}

// ── Registry page (#40) — everything an extension registered, by kind ────────
export async function describeExtensionRegistry(
  extId: string,
  cron: {
    list(): Array<{
      id: string
      expression: string
      extensionId?: string
      nextRun: Date | null
      paused?: boolean
    }>
  }
): Promise<Record<string, unknown>> {
  const { hooks } = await import('../hooks/registry.js')
  return {
    hooks: hooks.listForExtension(extId),
    crons: cron
      .list()
      .filter((c) => c.extensionId === extId)
      .map((c) => ({
        id: c.id,
        expression: c.expression,
        next_run: c.nextRun,
        paused: !!c.paused
      })),
    registrations: getExtensionRegistrations(extId),
    settings: getExtensionSettingsSchema(extId).map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      has_validate: !!d.has_validate,
      has_on_change: !!d.has_on_change,
      production_expect: d.production_expect ?? null
    })),
    observed_capabilities: getObservedCapabilities(extId),
    health_check: extensionHealthChecks.has(extId),
    staged: await stagedBuildStatus(extId)
  }
}

// ── Staged builds (#76, blue/green-lite) ─────────────────────────────────────
// A build dropped at api/extensions/<id>.next is validated in place (its
// entry module imports and exports the same id) and then SWAPPED with the
// live directory; the previous build is kept at <id>.prev for rollback. The
// running process keeps serving the OLD build until it restarts — hooks and
// crons registered by a module cannot be torn down safely mid-flight — so
// the switch is "validated now, live on the next restart", never a surprise.
export interface StagedBuildStatus {
  id: string
  live_dir: string
  live_entry: string | null
  live_mtime: string | null
  next_present: boolean
  next_entry: string | null
  next_mtime: string | null
  prev_present: boolean
  prev_mtime: string | null
}

async function dirMtime(dir: string): Promise<string | null> {
  try {
    const { stat } = await import('node:fs/promises')
    const entry = await resolveIndexPath(dir)
    if (!entry) return null
    return (await stat(entry)).mtime.toISOString()
  } catch {
    return null
  }
}

export async function stagedBuildStatus(id: string): Promise<StagedBuildStatus> {
  const live = join(EXTENSIONS_DIR, id)
  const next = `${live}.next`
  const prev = `${live}.prev`
  return {
    id,
    live_dir: live,
    live_entry: await resolveIndexPath(live),
    live_mtime: await dirMtime(live),
    next_present: existsSync(next),
    next_entry: existsSync(next) ? await resolveIndexPath(next) : null,
    next_mtime: existsSync(next) ? await dirMtime(next) : null,
    prev_present: existsSync(prev),
    prev_mtime: existsSync(prev) ? await dirMtime(prev) : null
  }
}

/** Import the staged entry in isolation and check it is the same extension. */
export async function validateStagedBuild(id: string): Promise<{ ok: boolean; detail: string }> {
  const next = join(EXTENSIONS_DIR, `${id}.next`)
  const entry = await resolveIndexPath(next)
  if (!entry) return { ok: false, detail: `No index.ts/index.js in ${id}.next` }
  try {
    const mod = (await import(`${entry}?staged=${Date.now()}`)) as {
      default?: { id?: string; register?: unknown }
    }
    const ext = mod.default
    if (!ext || typeof ext !== 'object')
      return { ok: false, detail: 'The staged module has no default export' }
    if (ext.id !== id)
      return {
        ok: false,
        detail: `The staged module declares id "${String(ext.id)}", expected "${id}"`
      }
    if (typeof ext.register !== 'function')
      return { ok: false, detail: 'The staged module has no register() function' }
    return {
      ok: true,
      detail: `${entry.endsWith('.ts') ? 'index.ts' : 'index.js'} imports cleanly and declares "${id}"`
    }
  } catch (err) {
    return { ok: false, detail: `Import failed: ${(err as Error).message}` }
  }
}

export async function promoteStagedBuild(
  id: string
): Promise<{ promoted: boolean; detail: string }> {
  const check = await validateStagedBuild(id)
  if (!check.ok) return { promoted: false, detail: check.detail }
  const { rename, rm } = await import('node:fs/promises')
  const live = join(EXTENSIONS_DIR, id)
  const next = `${live}.next`
  const prev = `${live}.prev`
  if (existsSync(prev)) await rm(prev, { recursive: true, force: true })
  if (existsSync(live)) await rename(live, prev)
  await rename(next, live)
  return {
    promoted: true,
    detail: `${check.detail}; the previous build is kept at ${id}.prev. Restart the API to run it.`
  }
}

export async function rollbackStagedBuild(
  id: string
): Promise<{ rolled_back: boolean; detail: string }> {
  const { rename, rm } = await import('node:fs/promises')
  const live = join(EXTENSIONS_DIR, id)
  const prev = `${live}.prev`
  const next = `${live}.next`
  if (!existsSync(prev)) return { rolled_back: false, detail: `No previous build kept for ${id}` }
  if (existsSync(next)) await rm(next, { recursive: true, force: true })
  if (existsSync(live)) await rename(live, next)
  await rename(prev, live)
  return {
    rolled_back: true,
    detail: `Previous build restored; the promoted one is parked at ${id}.next. Restart the API to run it.`
  }
}

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { registerDigestSection } from '../services/daily-digest.js'
import { registerReadinessCheck } from '../services/readiness.js'
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
import { type CallOptions, type CallResult, callExternalApi } from '../services/external-apis.js'
import { logActivity } from '../services/activity.js'
import { registerMailTemplateRoot } from '../services/mail.js'
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
import { type StorageAdapter, storageAdapterRegistry } from './storage-adapters.js'
import { type ValidatorDef, validatorRegistry } from './validators.js'
import '../plugin-types.js'

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
  /** Admin-editable extension settings (#112) — declared on the export. */
  settings?: {
    get(key: string): Promise<string | null>
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
  logActivity(entry: {
    action: string
    user?: string | null
    collection?: string
    item?: string | number
    comment?: string
  }): Promise<number | null>
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
    schedule(id: string, expression: string, fn: () => void | Promise<void>): void
    /** Cancel a previously scheduled job. */
    unschedule(id: string): void
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
  digest: {
    /** Add a per-user section to the daily action digest email. */
    registerSection(fn: import('../services/daily-digest.js').DigestSectionProvider): void
  }
  readiness: {
    /** Register a scored check on the go-live readiness scorecard. */
    registerCheck(check: import('../services/readiness.js').ReadinessCheck): void
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
  /** Admin-editable settings (#112), stored in nivaro_extension_settings. */
  settings?: Array<{
    key: string
    label: string
    type?: 'string' | 'number' | 'boolean'
    default?: string
    secret?: boolean
  }>
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
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const EXTENSIONS_DIR = new URL('../../extensions', import.meta.url).pathname
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

// ── Extension settings (#112) ────────────────────────────────────────────────
export const extensionSettingsDecls = new Map<string, NonNullable<Extension['settings']>>()
const settingsCache = new Map<string, { values: Record<string, string | null>; at: number }>()
export function bustExtensionSettingsCache(extId?: string): void {
  if (extId) settingsCache.delete(extId)
  else settingsCache.clear()
}
async function readExtensionSettings(extId: string): Promise<Record<string, string | null>> {
  const hit = settingsCache.get(extId)
  if (hit && Date.now() - hit.at < 60_000) return hit.values
  const { db } = await import('../db/index.js')
  const decls = extensionSettingsDecls.get(extId) ?? []
  const values: Record<string, string | null> = {}
  for (const d of decls) values[d.key] = d.default ?? null
  try {
    const rows = (await db('nivaro_extension_settings')
      .where({ extension_id: extId })
      .select('key', 'value')) as Array<{ key: string; value: string | null }>
    for (const r of rows) values[r.key] = r.value
  } catch {
    /* table missing pre-migration — declared defaults stand */
  }
  settingsCache.set(extId, { values, at: Date.now() })
  return values
}

// ── Health probes (#262) ─────────────────────────────────────────────────────
export const extensionHealthChecks = new Map<string, () => Promise<{ ok: boolean; note?: string }>>()

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
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
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
    | 'auth'
    | 'flows'
    | 'digest'
    | 'readiness'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
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

    // Scoped hooks + cron context — all entries are tagged with this extension's id
    const scopedCtx: ExtensionContext = {
      ...ctx,
      // Log channels (#427): every line tagged {extension} + ring-buffered.
      logger: channelLogger(ctx.logger, extId),
      settings: {
        get: async (key: string) => (await readExtensionSettings(extId))[key] ?? null
      },
      callExternalApi,
      logActivity: (entry) =>
        logActivity({
          action: `${extId}:${entry.action}`,
          user: entry.user ?? null,
          collection: entry.collection,
          item: entry.item != null ? String(entry.item) : undefined,
          comment: entry.comment
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
          ctx.app.cron.schedule(`ext:${extId}:${id}`, expression, fn, { extensionId: extId }),
        unschedule: (id) => ctx.app.cron.unschedule(`ext:${extId}:${id}`)
      },
      bulkActions: {
        register: (def) => bulkActionRegistry.register(def)
      },
      itemActions: {
        register: (def) => itemActionRegistry.register(def)
      },
      notificationChannels: {
        register: (def) => notificationChannelRegistry.register(def)
      },
      dashboardWidgets: {
        register: (def) => dashboardWidgetRegistry.register(def)
      },
      storage: {
        register: (name, adapter) => storageAdapterRegistry.register(name, adapter),
        setActive: (name) => storageAdapterRegistry.setActive(name)
      },
      fieldTypes: {
        register: (def) => fieldTypeRegistry.register(def)
      },
      collectionViews: {
        register: (def) => collectionViewRegistry.register(def)
      },
      importParsers: {
        register: (def) => importParserRegistry.register(def)
      },
      validators: {
        register: (def) => validatorRegistry.register(def)
      },
      digest: {
        registerSection: (fn) => registerDigestSection(fn)
      },
      readiness: {
        registerCheck: (check) => registerReadinessCheck(check)
      },
      flows: {
        registerOperation: (op) => registerOp(op),
        registerTrigger: (trigger) => registerTrigger(trigger),
        emit: (triggerType, payload) => emitTrigger(triggerType, payload, ctx.logger)
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
      has_health_check: typeof ext.healthCheck === 'function'
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
    | 'auth'
    | 'flows'
    | 'digest'
    | 'readiness'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
  >
) {
  let entries: string[]
  try {
    entries = await readdir(EXTENSIONS_DIR)
  } catch {
    ctx.logger.debug('No extensions directory, skipping')
    return
  }

  const config = readConfig()
  // Filter out hidden files/dirs (like .config.json itself)
  const dirs = entries.filter((e) => !e.startsWith('.'))

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
    | 'auth'
    | 'flows'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
    | 'digest'
    | 'readiness'
  >
) {
  let entries: string[]
  try {
    entries = await readdir(CLOUD_EXTENSIONS_DIR)
  } catch {
    ctx.logger.debug('No cloud-extensions directory, skipping')
    return
  }

  const dirs = entries.filter((e) => !e.startsWith('.'))

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
        digest: {
          registerSection: (fn) => registerDigestSection(fn)
        },
        readiness: {
          registerCheck: (check) => registerReadinessCheck(check)
        },
        logActivity: (entry) =>
          logActivity({
            action: `${extId}:${entry.action}`,
            user: entry.user ?? null,
            collection: entry.collection,
            item: entry.item != null ? String(entry.item) : undefined,
            comment: entry.comment
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
          unschedule: (id) => ctx.app.cron.unschedule(`cloud-ext:${extId}:${id}`)
        },
        bulkActions: { register: (def) => bulkActionRegistry.register(def) },
        itemActions: { register: (def) => itemActionRegistry.register(def) },
        notificationChannels: { register: (def) => notificationChannelRegistry.register(def) },
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
    | 'auth'
    | 'flows'
    | 'bulkActions'
    | 'itemActions'
    | 'notificationChannels'
    | 'dashboardWidgets'
    | 'storage'
    | 'fieldTypes'
    | 'collectionViews'
    | 'importParsers'
    | 'validators'
    | 'digest'
    | 'readiness'
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
    if (entry.startsWith('.')) continue
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

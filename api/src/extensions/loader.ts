import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Inngest } from 'inngest'
import type { Knex } from 'knex'
import type { Database } from '../db/index.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
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
import { type CallOptions, type CallResult, callExternalApi } from '../services/external-apis.js'
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
  /** Call a configured external API by name or numeric ID. Auth resolved automatically. */
  callExternalApi(nameOrId: string | number, options?: CallOptions): Promise<CallResult>
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
      callExternalApi,
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

    extensionRegistry.set(ext.id, {
      id: ext.id,
      status: 'loaded',
      enabled,
      path: dirPath
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

  for (const entry of dirs) {
    await loadExtension(entry, ctx, config)
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
      if (existsSync(p)) { indexPath = p; break }
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
        auth: { authenticate, requireAuth, requireAdmin },
        hooks: {
          before: (collection, action, fn) =>
            hooks.before(collection, action, fn, { extensionId: extId }),
          after: (collection, action, fn) =>
            hooks.after(collection, action, fn, { extensionId: extId })
        },
        cron: {
          schedule: (id, expression, fn) =>
            ctx.app.cron.schedule(`cloud-ext:${extId}:${id}`, expression, fn, { extensionId: extId }),
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
            manifest
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

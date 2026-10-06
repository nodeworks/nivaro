import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  emitTrigger,
  type OpFieldSchema,
  type OpHandler,
  registerOp,
  registerTrigger
} from '../flows/registry.js'
import { hooks } from '../hooks/registry.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { registerPortalLinks } from '../services/app-links.js'
import { registerBriefLine } from '../services/approval-brief-lines.js'
import { currentChain } from '../services/chain.js'
import { type ChainTable, chainFields } from '../services/chain-columns.js'
import { beginChainRoot } from '../services/chain-roots.js'
import { registerConfigSeed } from '../services/config-seeds.js'
import { registerDigestSection } from '../services/daily-digest.js'
import { registerTuningObserver } from '../services/db-tuning/observers/registry.js'
import {
  publishExtensionEvent,
  registerExtensionEventHandler
} from '../services/extension-events.js'
import {
  declareSchemaStep,
  extensionsWithSchemaSteps,
  runSchemaChecks,
  runSchemaSteps
} from '../services/extension-schema-steps.js'
import { type CallOptions, callExternalApi } from '../services/external-apis.js'
import { registerImportProcessor } from '../services/import-processors.js'
import { registerEventSource } from '../services/integration-event-sources.js'
import { registerIntegrityCheck } from '../services/integrity-checks.js'
import { registerMailTemplateRoot, renderMailTemplate } from '../services/mail.js'
import { registerMailType, renderViaFlow } from '../services/mail-types.js'
import { notifyUser } from '../services/notification-channels.js'
import { registerOpsTask } from '../services/ops-tasks.js'
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
import { notificationSourceRegistry } from './notification-sources.js'
import { relatedNoteRegistry } from './related-notes.js'
import { type StorageAdapter, storageAdapterRegistry } from './storage-adapters.js'
import { type ValidatorDef, validatorRegistry } from './validators.js'
import '../plugin-types.js'
import {
  deprecationMessage,
  type ExtensionContext,
  type ExtensionDefinition,
  type ExtensionEnvDecl,
  type ExtensionRunbookDecl,
  type ExtensionSettingDecl,
  KIT_DEPRECATIONS,
  type KitDeprecation,
  watchDeprecatedMembers
} from '@nivaro/extension-kit'
import { runLongSql } from '../services/run-long.js'
import { registerExtensionSignal, registerExtensionSignalAction } from './signal-registration.js'

export type {
  ExtensionContext,
  ExtensionDefinition,
  ExtensionEnvDecl,
  ExtensionSettingDecl,
  ExtensionSettingValue,
  FlowOpRegistration,
  FlowTriggerRegistration
} from '@nivaro/extension-kit'

import { registerTrafficNode, type TrafficNodeDef } from '../services/traffic-taps/nodes.js'
export type Extension = ExtensionDefinition

/** Every extension call lands in the external API's Call Logs. A caller that
 *  names its own trigger (`_log.triggeredBy`) keeps it; one that passes nothing
 *  is logged as `extension:<id>` rather than skipped — the log is how an admin
 *  sees what a scheduled job actually sent and got back. */
function withExtensionLog(extId: string, options?: CallOptions): CallOptions {
  const opts = options ?? {}
  return {
    ...opts,
    _log: { ...opts._log, triggeredBy: opts._log?.triggeredBy ?? `extension:${extId}` }
  }
}

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

/** Runbooks every loaded extension declared (#720), by extension id. */
export const extensionRunbooks = new Map<string, ExtensionRunbookDecl[]>()

const RUNBOOK_KEY = /^[a-z0-9][a-z0-9-]{0,60}$/
const ARG = /^[A-Za-z0-9_.,:=@/-]{1,200}$/

/** Runbook declarations that name a script inside the extension's own folder. */
export function normalizeRunbooks(extId: string, raw: unknown): ExtensionRunbookDecl[] {
  if (!Array.isArray(raw)) return []
  const out: ExtensionRunbookDecl[] = []
  const args = (a: unknown) =>
    Array.isArray(a) ? a.filter((x) => typeof x === 'string' && ARG.test(x)) : []
  for (const r of raw.slice(0, 20)) {
    const key = typeof r?.key === 'string' ? r.key : ''
    const script = typeof r?.script === 'string' ? r.script : ''
    if (!RUNBOOK_KEY.test(key)) continue
    if (
      !script.startsWith(`extensions/${extId}/`) ||
      script.includes('..') ||
      !/\.(ts|mjs|js)$/.test(script)
    )
      continue
    out.push({
      key,
      label: typeof r.label === 'string' ? r.label.slice(0, 120) : key,
      description: typeof r.description === 'string' ? r.description.slice(0, 600) : undefined,
      script,
      dry_args: args(r.dry_args),
      go_args: args(r.go_args),
      resume_flag:
        typeof r.resume_flag === 'string' && /^--[a-z-]{1,30}$/.test(r.resume_flag)
          ? r.resume_flag
          : undefined,
      target_env:
        typeof r.target_env === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(r.target_env)
          ? r.target_env
          : undefined,
      refuse_targets: Array.isArray(r.refuse_targets)
        ? r.refuse_targets.filter((t: unknown) => typeof t === 'string').slice(0, 20)
        : undefined
    })
  }
  return out
}

/** The declared environment of every loaded extension, by extension id. */
export const extensionEnvDecls = new Map<string, ExtensionEnvDecl[]>()

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,120}$/

function normalizeEnvDecls(raw: unknown): ExtensionEnvDecl[] {
  if (!Array.isArray(raw)) return []
  const out: ExtensionEnvDecl[] = []
  for (const d of raw.slice(0, 60)) {
    const name = typeof d?.name === 'string' ? d.name.trim() : ''
    if (!ENV_NAME.test(name)) continue
    out.push({
      name,
      required: d.required === true,
      description: typeof d.description === 'string' ? d.description.slice(0, 300) : undefined,
      secret: d.secret === true
    })
  }
  return out
}

/** What the environment holds for each declared variable, never the value. */
export function describeExtensionEnv(
  extId: string
): Array<ExtensionEnvDecl & { set: boolean; missing: boolean }> {
  return (extensionEnvDecls.get(extId) ?? []).map((d) => {
    const v = process.env[d.name]
    const set = v !== undefined && v !== ''
    return { ...d, set, missing: !set && d.required === true }
  })
}

/** Every required variable no loaded extension has, `<ext>: NAME`. */
export function missingExtensionEnv(): Array<{ extension: string; name: string }> {
  const out: Array<{ extension: string; name: string }> = []
  for (const [ext] of extensionEnvDecls) {
    for (const d of describeExtensionEnv(ext))
      if (d.missing) out.push({ extension: ext, name: d.name })
  }
  return out
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
  /** #1089 — which build of the extension is loaded: the export's `build`,
   *  else the `.release-sha` file a deploy writes beside it; null = unknown. */
  build?: string | null
}

/** #1089 — the loaded build's identity (≤64 chars, trimmed). */
export function resolveExtensionBuild(declared: unknown, dirPath: string): string | null {
  const clean = (v: unknown) => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t ? t.slice(0, 64) : null
  }
  const fromExport = clean(declared)
  if (fromExport) return fromExport
  try {
    const p = join(dirPath, '.release-sha')
    return existsSync(p) ? clean(readFileSync(p, 'utf-8')) : null
  } catch {
    return null
  }
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

export const extensionSettingsDecls = new Map<string, NonNullable<Extension['settings']>>()

const CHAIN_TABLES: ReadonlySet<string> = new Set<ChainTable>([
  'nivaro_activity',
  'nivaro_api_logs',
  'nivaro_erp_submissions',
  'nivaro_erp_submission_attempts',
  'nivaro_external_api_logs',
  'nivaro_workflow_history',
  'nivaro_flow_runs',
  'nivaro_notifications',
  'nivaro_mail_log'
])

/** ctx.chain — shared by the self-hosted and cloud ctx builds. */
export function buildChainContext(): ExtensionContext['chain'] {
  return {
    begin: (root, fn) => beginChainRoot({ source: root.source, ref: root.ref }, fn),
    // A copy: the live store is the whole request's chain context, and an
    // extension that mutated it would re-parent every later write.
    current: () => {
      const cur = currentChain()
      return cur ? { ...cur } : null
    },
    fields: async (table, opts) =>
      CHAIN_TABLES.has(table) ? chainFields(table as ChainTable, opts) : {}
  }
}

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
// ── Extension routes (#813) — every route an extension registers, with the
// gate it carries. An extension's `app.register(plugin, {prefix})` is
// wrapped so an `onRoute` hook inside that scope attributes the plugin's
// routes; a route added straight on the root app is read off its arguments.
export type ExtensionRouteGate = 'public' | 'public-declared' | 'authenticated' | 'admin' | 'custom'

export interface ExtensionRouteRecord {
  method: string
  url: string
  gate: ExtensionRouteGate
  /** The custom gate's function name(s), when `gate` is custom. */
  detail?: string
  /** #770 — `config: { scope: 'enforced' | 'not-scoped' }` on the route: the
   *  extension's own word on whether its read applies User Scopes. Absent =
   *  not declared, listed as unreviewed by the raw-SQL scope coverage report. */
  scope?: 'enforced' | 'not-scoped'
}

export const extensionRoutes = new Map<string, ExtensionRouteRecord[]>()

/** Extension id → display label (the id is the honest label; manifests carry no separate name). */
export function loadedExtensionLabels(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of extensionRoutes.keys()) out[id] = id
  return out
}

type GateFn = (...a: unknown[]) => unknown
const GATE_HOOKS = new Set(['onRequest', 'preValidation', 'preHandler'])

function gateOf(
  route: {
    config?: unknown
    onRequest?: unknown
    preHandler?: unknown
    preValidation?: unknown
  },
  scopeGates: GateFn[] = []
): { gate: ExtensionRouteGate; detail?: string } {
  const list = (v: unknown): GateFn[] =>
    (Array.isArray(v) ? v : v ? [v] : []).filter((f) => typeof f === 'function')
  // A gate added at plugin scope (`f.addHook('preHandler', requireAuth)`)
  // guards every route of that scope and its children exactly like a
  // route-level one — most extensions gate a whole plugin that way.
  const fns = [
    ...scopeGates,
    ...list(route.onRequest),
    ...list(route.preValidation),
    ...list(route.preHandler)
  ]
  if ((route.config as { public?: unknown } | undefined)?.public === true)
    return { gate: 'public-declared' }
  if (fns.includes(requireAdmin as never)) return { gate: 'admin' }
  if (fns.includes(requireAuth as never) || fns.includes(authenticate as never))
    return { gate: 'authenticated' }
  if (fns.length > 0)
    return { gate: 'custom', detail: fns.map((f) => f.name || 'anonymous').join(', ') }
  return { gate: 'public' }
}

function recordRoute(
  extId: string,
  route: { method: string | string[]; url: string } & Parameters<typeof gateOf>[0],
  scopeGates: GateFn[] = []
): void {
  const list = extensionRoutes.get(extId) ?? []
  const { gate, detail } = gateOf(route, scopeGates)
  const declared = (route.config as { scope?: unknown } | undefined)?.scope
  const scope = declared === 'enforced' || declared === 'not-scoped' ? declared : undefined
  for (const m of Array.isArray(route.method) ? route.method : [route.method]) {
    const method = String(m).toUpperCase()
    if (method === 'HEAD') continue
    if (list.some((r) => r.method === method && r.url === route.url)) continue
    list.push({
      method,
      url: route.url,
      gate,
      ...(detail ? { detail } : {}),
      ...(scope ? { scope } : {})
    })
  }
  extensionRoutes.set(extId, list)
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'])

/**
 * The extension's view of a Fastify instance (or of one of its plugin
 * scopes): every route added through it is recorded with its gate. A
 * scope-level gate hook (`f.addHook('preHandler', requireAuth)`) is kept on
 * the scope and counts for the routes registered after it there and in the
 * scopes it registers; `register` hands the plugin a wrapped child scope;
 * `route()` and the direct route methods are read off their arguments.
 * Everything else passes through. `onRegister` (a capability note) is
 * optional.
 */
export function routeRecordingApp(
  extId: string,
  app: FastifyInstance,
  onRegister?: () => void,
  scopeGates: GateFn[] = []
): FastifyInstance {
  const gates = scopeGates
  return new Proxy(app, {
    get(target, prop) {
      if (prop === 'register') {
        return (plugin: unknown, opts?: unknown) => {
          onRegister?.()
          const wrapped = async (f: FastifyInstance, o: unknown) => {
            // A child scope inherits the gates in force here and keeps its own.
            const child = routeRecordingApp(extId, f, undefined, [...gates])
            await (plugin as (f: FastifyInstance, o: unknown) => unknown)(child, o)
          }
          return (target.register as (p: unknown, o?: unknown) => unknown).call(
            target,
            wrapped,
            opts
          )
        }
      }
      if (prop === 'addHook') {
        return (name: string, fn: unknown) => {
          if (GATE_HOOKS.has(name) && typeof fn === 'function') gates.push(fn as GateFn)
          return (target.addHook as (n: string, f: unknown) => unknown).call(target, name, fn)
        }
      }
      if (prop === 'route') {
        return (opts: { method: string | string[]; url: string }) => {
          recordRoute(extId, withPrefix(target, opts) as never, gates)
          return (target.route as (o: unknown) => unknown).call(target, opts)
        }
      }
      if (typeof prop === 'string' && ROUTE_METHODS.has(prop)) {
        return (url: string, a: unknown, b?: unknown) => {
          const routeOpts = typeof a === 'function' ? {} : ((a as object) ?? {})
          recordRoute(
            extId,
            withPrefix(target, {
              method: prop === 'all' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : prop,
              url,
              ...routeOpts
            }) as never,
            gates
          )
          return (target[prop as 'get'] as (...x: unknown[]) => unknown).call(target, url, a, b)
        }
      }
      return Reflect.get(target, prop)
    }
  }) as FastifyInstance
}

/** The scope's registered prefix folded onto a route read off its arguments. */
function withPrefix<T extends { url: string }>(scope: FastifyInstance, route: T): T {
  const prefix = (scope as unknown as { prefix?: string }).prefix ?? ''
  if (!prefix || route.url.startsWith(prefix)) return route
  return { ...route, url: `${prefix}${route.url}` }
}

/** Every route with no gate at all, `<ext>: METHOD /url`, for readiness. */
export function ungatedExtensionRoutes(): Array<{
  extension: string
  method: string
  url: string
}> {
  const out: Array<{ extension: string; method: string; url: string }> = []
  for (const [ext, list] of extensionRoutes)
    for (const r of list)
      if (r.gate === 'public') out.push({ extension: ext, method: r.method, url: r.url })
  return out
}

/**
 * The registration members of an extension's context — every `register…`
 * the core accepts, each stamping the capability note and the ledger (#40)
 * — shared by the self-hosted and cloud context builds so the two cannot
 * drift (#812: the cloud build used to skip the ledger entirely).
 */
/**
 * `ctx.integrations.registerTrafficNode` (#1114): an extension names the business system behind
 * its partner calls (MDSi, MWF, a warehouse) as its own Traffic Map node. Ledger kind
 * `traffic_nodes`. A malformed id is logged and skipped — never a throw out of register().
 */
function trafficNodeMembers(
  extId: string,
  note: (capability: string) => void,
  own: (kind: string, label: string) => void
): { registerTrafficNode: (def: TrafficNodeDef) => void } {
  return {
    registerTrafficNode: (def) => {
      note('integrations')
      try {
        const id = registerTrafficNode(extId, def)
        own('traffic_nodes', `${def.id} · ${def.label} (${id})`)
      } catch (err) {
        console.warn(`[extensions] ${extId}: traffic node skipped —`, (err as Error).message)
      }
    }
  }
}

export function registrationMembers(
  extId: string,
  ctx: Pick<ExtensionContext, 'app' | 'logger' | 'database'>,
  opts: {
    note: (capability: string) => void
    own: (kind: string, label: string) => void
    cronPrefix: string
    /** Run long SQL on the handed-in (tenant) connection, not the default pool. */
    runLongOnTenant?: boolean
  }
): Omit<ExtensionContext, 'app' | 'database' | 'logger' | 'settings' | 'cloud'> {
  const { note, own, cronPrefix, runLongOnTenant } = opts
  return {
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
      return callExternalApi(nameOrId, withExtensionLog(extId, options))
    },
    notifyUser: (userId, opts) => {
      note('notifications')
      return notifyUser(ctx.app, userId, opts).then(
        () => undefined,
        () => undefined
      )
    },
    chat: {
      post: async (room, text, o) => {
        note('chat')
        try {
          const { parseRoom, channels } = await import('../services/chat.js')
          const parsed = parseRoom(room)
          if (parsed.kind === 'dm' || parsed.kind === 'unknown') return null
          if (parsed.kind === 'channel') {
            const ch = (await channels()).get(parsed.channelKey ?? '')
            if (!ch || ch.is_archived) return null
          }
          if (parsed.kind === 'entity') {
            const { roomTypes } = await import('../services/chat-records.js')
            if (!(await roomTypes()).some((t) => t.prefix === parsed.prefix)) return null
          }
          const { botUserId, chatBotName } = await import('../services/chat-bot.js')
          const botName = o?.as === 'system' ? null : await chatBotName()
          const botId = botName ? await botUserId().catch(() => null) : null
          const { postChatMessage } = await import('../services/chat-send.js')
          const row = await postChatMessage(
            ctx.app,
            botId
              ? { user: null, senderId: botId, senderName: botName, skipVisibility: true }
              : {
                  user: null,
                  senderId: null,
                  senderName: 'Nivaro',
                  system: true,
                  skipVisibility: true
                },
            { room, message: String(text ?? ''), parentId: o?.parent_id ?? null }
          )
          void logActivity({
            action: `${extId}:chat-post`,
            user: botId,
            collection: 'chat_messages',
            item: String(row.id),
            comment: `room ${room}`,
            origin: 'machine'
          })
          return row.id
        } catch {
          return null
        }
      }
    },
    sql: {
      runLong: (sql, o) =>
        runLongSql(sql, runLongOnTenant ? { ...o, knex: ctx.database as never } : o)
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
        ctx.app.cron.schedule(`${cronPrefix}${id}`, expression, fn, {
          extensionId: extId,
          ...(opts ?? {})
        })
      },
      unschedule: (id) => ctx.app.cron.unschedule(`${cronPrefix}${id}`),
      annotate: (id, meta) => ctx.app.cron.annotate(`${cronPrefix}${id}`, meta)
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
            (def as { id?: string; key?: string }).id ?? (def as { key?: string }).key ?? 'channel'
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
            (def as { type?: string; id?: string }).type ?? (def as { id?: string }).id ?? 'widget'
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
            (def as { id?: string; type?: string }).id ?? (def as { type?: string }).type ?? 'view'
          )
        )
        collectionViewRegistry.register(def)
      }
    },
    importProcessors: {
      register: (def) => {
        note('import-processors')
        own('import_processors', `${def.key} · ${def.label}`)
        registerImportProcessor(def)
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
    tasks: {
      register: (def) => {
        note('tasks')
        own('ops_tasks', `${def.key} · ${def.label}`)
        registerOpsTask(def, extId)
      }
    },
    tuning: {
      registerObserver: (def) => {
        note('tuning')
        own('tuning_observers', `${def.id} · ${def.kind}`)
        registerTuningObserver(def, extId)
      }
    },
    seeds: {
      register: (def) => {
        note('seeds')
        own('config_seeds', `${def.key} · ${def.collection} (${def.mode})`)
        registerConfigSeed(def, extId)
      }
    },
    schema: {
      step: (id, def) => {
        note('schema')
        own('schema_steps', `${id} · ${def.description}`)
        declareSchemaStep(extId, { id, ...def })
      }
    },
    chain: buildChainContext(),
    integrations: {
      // #1114 (spread: the member is typed in the kit source; a build of the kit is not needed)
      ...trafficNodeMembers(extId, note, own),
      registerObligationKind: (def) => {
        void import('../services/integration-obligations.js').then(({ registerObligationKind }) =>
          registerObligationKind(def)
        )
      },
      openObligation: async (ctx, opts) => {
        const { openObligationForTrigger } = await import('../services/integration-obligations.js')
        return openObligationForTrigger(ctx, opts)
      },
      resolveObligation: async (id, patch) => {
        const { resolveObligation } = await import('../services/integration-obligations.js')
        return resolveObligation(id, patch)
      },
      registerSignal: (def) => {
        note('integrations')
        own('integration_signals', `${def.id} · ${def.label}`)
        void registerExtensionSignal(def, extId, ctx.logger)
      },
      registerSignalAction: (def) => {
        void registerExtensionSignalAction(def, extId, ctx.logger)
      },
      registerEventSource: (def) => {
        note('integrations')
        own('event_sources', `${def.id} · ${def.label}`)
        registerEventSource(def)
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
}

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

// ── Deprecated kit members (#1303) ───────────────────────────────────────────
// The kit lists the ctx members on their way out (KIT_DEPRECATIONS — a JSDoc
// tag is invisible at runtime). The context handed to register() watches
// them: the first use per extension per boot logs a warning; every use is
// counted for the registry sheet and the readiness check.
export interface DeprecatedMemberUse {
  member: string
  replacement: string
  removed_in: string
  note: string | null
  message: string
  first_used_at: string
  uses: number
}
export const deprecatedMemberUses = new Map<string, Map<string, DeprecatedMemberUse>>()

export function withDeprecationWarnings<T extends object>(
  extId: string,
  ctx: T,
  logger?: { warn: (...args: unknown[]) => void },
  deprecations: readonly KitDeprecation[] = KIT_DEPRECATIONS
): T {
  deprecatedMemberUses.delete(extId)
  return watchDeprecatedMembers(ctx, deprecations, (d) => {
    let uses = deprecatedMemberUses.get(extId)
    if (!uses) {
      uses = new Map()
      deprecatedMemberUses.set(extId, uses)
    }
    const seen = uses.get(d.member)
    if (seen) {
      seen.uses++
      return
    }
    const message = deprecationMessage(extId, d)
    uses.set(d.member, {
      member: d.member,
      replacement: d.replacement,
      removed_in: d.removedIn,
      note: d.note ?? null,
      message,
      first_used_at: new Date().toISOString(),
      uses: 1
    })
    try {
      if (logger) logger.warn({ extension: extId, member: d.member }, message)
      else console.warn(`[extensions] ${message}`)
    } catch {
      // a logger failure must never break the extension using the member
    }
  })
}

export function describeDeprecatedUses(extId: string): DeprecatedMemberUse[] {
  return [...(deprecatedMemberUses.get(extId)?.values() ?? [])]
}

/** The readiness verdict over every extension's recorded uses. */
export function deprecatedMembersReadiness(deprecatedCount: number): {
  status: 'pass' | 'warn' | 'skip'
  detail: string
  blockers?: string[]
} {
  if (deprecatedCount === 0)
    return { status: 'skip', detail: 'The extension kit deprecates no context member.' }
  const blockers: string[] = []
  for (const uses of deprecatedMemberUses.values())
    for (const u of uses.values()) blockers.push(u.message)
  return blockers.length === 0
    ? {
        status: 'pass',
        detail: `${deprecatedCount} deprecated member(s); no loaded extension has used one since boot.`
      }
    : {
        status: 'warn',
        detail: `${blockers.length} use(s) of a deprecated kit member since boot.`,
        blockers
      }
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
    | 'chain'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'chat'
    | 'auth'
    | 'flows'
    | 'events'
    | 'chatBot'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'tasks'
    | 'tuning'
    | 'seeds'
    | 'schema'
    | 'integrations'
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
    | 'importProcessors'
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
    extensionRoutes.delete(extId)

    // Capability manifest (#660): the ctx members register() touches are noted
    // as observed capabilities, compared against the declared list in the UI.
    const note = (cap: string) => noteCapability(extId, cap)
    const own = (kind: string, label: string) => recordRegistration(extId, kind, label)
    // app.register → 'routes' (a capability note), and every route the
    // extension adds is recorded with its gate (#813).
    const observedApp = routeRecordingApp(extId, ctx.app, () => note('routes'))

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
      ...registrationMembers(extId, ctx, { note, own, cronPrefix: `ext:${extId}:` })
    }

    await ext.register(withDeprecationWarnings(extId, scopedCtx, scopedCtx.logger))
    // Schema steps the extension declared run now, in order, under the
    // migration lock (#826) — a failure is recorded, logged and does not
    // stop the extension loading: its readiness check says what is wrong.
    await runSchemaSteps(extId, ctx.database, { logger: scopedCtx.logger })

    // Respect initial enabled state from config
    if (!enabled) {
      hooks.setExtensionEnabled(extId, false)
      ctx.app.cron.setExtensionEnabled(extId, false)
    }

    if (Array.isArray(ext.settings) && ext.settings.length > 0)
      extensionSettingsDecls.set(extId, ext.settings)
    const runbooks = normalizeRunbooks(extId, ext.runbooks)
    if (runbooks.length > 0) extensionRunbooks.set(extId, runbooks)
    else extensionRunbooks.delete(extId)
    const envDecls = normalizeEnvDecls(ext.env)
    if (envDecls.length > 0) extensionEnvDecls.set(extId, envDecls)
    else extensionEnvDecls.delete(extId)
    for (const d of envDecls) {
      if (d.required && !(process.env[d.name] ?? '')) {
      }
    }
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
        : undefined,
      build: resolveExtensionBuild(ext.build, dirPath)
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
    | 'chain'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'chat'
    | 'auth'
    | 'flows'
    | 'events'
    | 'chatBot'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'tasks'
    | 'tuning'
    | 'seeds'
    | 'schema'
    | 'integrations'
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
    | 'importProcessors'
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
    | 'chain'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'chat'
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
    | 'importProcessors'
    | 'validators'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'tasks'
    | 'tuning'
    | 'seeds'
    | 'schema'
    | 'integrations'
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
        app: routeRecordingApp(extId, ctx.app, () => noteCapability(extId, 'routes')),
        ...registrationMembers(extId, ctx, {
          note: (cap) => noteCapability(extId, cap),
          own: (kind, label) => recordRegistration(extId, kind, label),
          cronPrefix: `cloud-ext:${extId}:`,
          runLongOnTenant: true
        })
      }

      await ext.register(withDeprecationWarnings(extId, scopedCtx, ctx.logger))
      await runSchemaSteps(extId, ctx.database, { logger: ctx.logger })

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
  if (entry?.status !== 'loaded') return false

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
    | 'chain'
    | 'cron'
    | 'logActivity'
    | 'sql'
    | 'notifyUser'
    | 'chat'
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
    | 'importProcessors'
    | 'validators'
    | 'digest'
    | 'approvalBrief'
    | 'readiness'
    | 'tasks'
    | 'tuning'
    | 'seeds'
    | 'schema'
    | 'integrations'
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
    id: 'extension-environment',
    label: 'Extensions have the environment they declare',
    description:
      'Every variable an extension declares as required is set on this instance (values are never read here).',
    group: 'Configuration',
    run: async () => {
      const declared = [...extensionEnvDecls.values()].reduce((n, l) => n + l.length, 0)
      if (declared === 0)
        return { status: 'skip', detail: 'No extension declares its environment.' }
      const missing = missingExtensionEnv()
      return missing.length === 0
        ? { status: 'pass', detail: `${declared} declared variable(s); every required one is set.` }
        : {
            status: 'fail',
            detail: `${missing.length} required variable(s) missing.`,
            blockers: missing.map((m) => `${m.extension} needs ${m.name}`)
          }
    }
  })
  registerReadinessCheck({
    id: 'extension-deprecated-members',
    label: 'Extensions avoid deprecated kit members',
    description:
      'No loaded extension reads a context member the extension kit has deprecated — each one leaves the kit in a named version.',
    group: 'Configuration',
    run: async () => deprecatedMembersReadiness(KIT_DEPRECATIONS.length)
  })
  registerReadinessCheck({
    id: 'extension-route-gates',
    label: 'Extension routes carry a gate',
    description:
      'Every route an extension registered runs behind authenticate / requireAuth / requireAdmin or a custom handler; a route meant to be public says so with `config: { public: true }`.',
    group: 'Configuration',
    run: async () => {
      const total = [...extensionRoutes.values()].reduce((n, l) => n + l.length, 0)
      if (total === 0) return { status: 'skip', detail: 'No extension registered a route.' }
      const open = ungatedExtensionRoutes()
      return open.length === 0
        ? {
            status: 'pass',
            detail: `${total} route(s); every one carries a gate or is declared public.`
          }
        : {
            status: 'warn',
            detail: `${open.length} of ${total} route(s) have no gate and are not declared public.`,
            blockers: open.map((r) => `${r.extension}: ${r.method} ${r.url}`)
          }
    }
  })
  registerReadinessCheck({
    id: 'extension-schema-steps',
    label: 'Extension schema steps applied and intact',
    description:
      "Every schema step an extension declared (`ctx.schema.step`) has run on this database, and each step's check still finds what it built.",
    group: 'Configuration',
    run: async () => {
      const exts = extensionsWithSchemaSteps()
      if (exts.length === 0)
        return { status: 'skip', detail: 'No extension declared a schema step.' }
      const blockers: string[] = []
      const drift: string[] = []
      let total = 0
      for (const ext of exts) {
        for (const st of await runSchemaChecks(ext)) {
          total++
          if (st.status === 'error')
            blockers.push(`${ext}: ${st.step} failed — ${st.error ?? 'unknown error'}`)
          else if (st.status === 'pending')
            blockers.push(`${ext}: ${st.step} has not run on this database`)
          else if (st.check_ok === false)
            drift.push(`${ext}: ${st.step} — ${st.check_detail ?? 'check reports drift'}`)
        }
      }
      if (blockers.length)
        return {
          status: 'fail',
          detail: `${blockers.length} of ${total} step(s) not applied.`,
          blockers: [...blockers, ...drift]
        }
      if (drift.length)
        return {
          status: 'warn',
          detail: `${drift.length} of ${total} applied step(s) report drift.`,
          blockers: drift
        }
      return { status: 'pass', detail: `${total} step(s) applied; every check passes.` }
    }
  })
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
    env: describeExtensionEnv(extId),
    routes: extensionRoutes.get(extId) ?? [],
    schema_steps: await runSchemaChecks(extId),
    observed_capabilities: getObservedCapabilities(extId),
    deprecated_members: describeDeprecatedUses(extId),
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

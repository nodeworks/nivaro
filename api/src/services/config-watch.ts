import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { registerAppKeyed } from './app-forget.js'
import { getIo } from './io-holder.js'
import { opsRoom } from './ops-live.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Config editors and shared dashboards follow each other live (rt4 #14 / #18).
 *
 * Every open pipeline, flow, rule, external API or payload template editor joins the ops topic
 * `cfg-<kind>:<id>` (administrators only, like the editors' routes); an open dashboard or report
 * joins `cfg-dashboard:<id>` / `cfg-report:<id>` (only people the dashboard is visible to — the
 * GET route's rule). When a write route changes that object, the topic gets
 *
 *   ops:changed { topic, part, by?, at }
 *
 * `part` names WHAT moved (a state, a transition, the owner matrix, a step, a widget …) — never
 * a value. `by` ({id, name}) rides only the administrator topics: the editor says "Beth changed
 * a state 1 min ago · Show" and skips its own writes; a dashboard viewer is told nothing about
 * who, it just re-reads quietly through its own route.
 *
 * Wiring is ONE pair of hooks (routes/index.ts): preHandler resolves the object a write is about
 * BEFORE the handler runs (a deleted state still names its pipeline), onResponse pokes on 2xx.
 * Read-like POSTs (preview, test, simulate, drill …) are skipped. Pokes are coalesced per topic
 * (a burst of owner-matrix edits is one notice).
 *
 * Saves that overwrite a whole object (flow, rule, external API and pipeline settings) honour an
 * optional `x-nivaro-base-rev` header — the `updated_at` the editor loaded. A save made over
 * someone else's newer save answers 409 CONFIG_STALE instead of overwriting it (staleConfigRefusal).
 */

export const CONFIG_KINDS = [
  'pipeline',
  'flow',
  'rule',
  'external-api',
  'payload',
  'dashboard',
  'report'
] as const
export type ConfigKind = (typeof CONFIG_KINDS)[number]

/** Kinds whose topic only administrators join (their editors are admin-only). */
const ADMIN_KINDS = new Set<ConfigKind>(['pipeline', 'flow', 'rule', 'external-api', 'payload'])

export const isAdminConfigKind = (k: ConfigKind) => ADMIN_KINDS.has(k)

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/
const TOPIC_RE =
  /^cfg-(pipeline|flow|rule|external-api|payload|dashboard|report):([A-Za-z0-9_.-]{1,80})$/

export function configTopic(kind: ConfigKind, id: string): string {
  return `cfg-${kind}:${id}`
}

/** A `cfg-<kind>:<id>` topic → its parts, or null. */
export function parseConfigTopic(topic: unknown): { kind: ConfigKind; id: string } | null {
  if (typeof topic !== 'string') return null
  const m = TOPIC_RE.exec(topic)
  return m ? { kind: m[1] as ConfigKind, id: m[2] } : null
}

// ── Which object a write is about ────────────────────────────────────────────

/** How a write names its object: directly, or through a child row looked up before the write. */
export type ConfigTarget =
  | { kind: ConfigKind; id: string; part: string }
  | { kind: ConfigKind; lookup: { table: string; column: string; key: string }; part: string }
  | {
      kind: 'pipeline'
      lookup2: { table: string; column: string; key: string; parent: string; parentColumn: string }
      part: string
    }

/** Path endings that read or run, never change the object. */
const READ_LIKE =
  /\/(preview|check|test|test-send|simulate|simulate-impact|owner-impact|drill|rows|explain-trend|drill-row|replay|trigger|run|contracts?|email|reset-cache|ai-filters|record-search|recent|convert|lint|explain)(\/|$)/

const SEG = '([A-Za-z0-9_.-]{1,80})'

type Rule = {
  re: RegExp
  /** null = a write that is not about the object (records, runs, new objects): stop here. */
  to: ((m: RegExpExecArray) => ConfigTarget) | null
}

const r = (src: string) => new RegExp(`^${src.replaceAll('{id}', SEG)}$`)

/** First match wins; order matters (child routes before the object's own `/:id`). */
const RULES: Rule[] = [
  // ── Pipelines (+ the workflow template splits) ──
  {
    re: r('/api/pipelines/states/{id}/owner-groups'),
    to: (m) => ({
      kind: 'pipeline',
      lookup: lookup('nivaro_workflow_states', 'template', m[1]),
      part: 'owners'
    })
  },
  {
    re: r('/api/pipelines/states/{id}(/.*)?'),
    to: (m) => ({
      kind: 'pipeline',
      lookup: lookup('nivaro_workflow_states', 'template', m[1]),
      part: 'state'
    })
  },
  {
    re: r('/api/pipelines/transitions/{id}'),
    to: (m) => ({
      kind: 'pipeline',
      lookup: lookup('nivaro_workflow_transitions', 'template', m[1]),
      part: 'transition'
    })
  },
  {
    re: r('/api/pipelines/bindings/{id}/dimensions'),
    to: (m) => ({
      kind: 'pipeline',
      lookup: lookup('nivaro_workflow_bindings', 'template', m[1]),
      part: 'owners'
    })
  },
  {
    re: r('/api/pipelines/bindings/{id}'),
    to: (m) => ({
      kind: 'pipeline',
      lookup: lookup('nivaro_workflow_bindings', 'template', m[1]),
      part: 'binding'
    })
  },
  {
    re: r('/api/pipelines/dimensions/{id}'),
    to: (m) => ({
      kind: 'pipeline',
      lookup2: {
        table: 'nivaro_pipeline_owner_dimensions',
        column: 'binding',
        key: m[1],
        parent: 'nivaro_workflow_bindings',
        parentColumn: 'template'
      },
      part: 'owners'
    })
  },
  {
    re: r('/api/pipelines/owner-groups/{id}(/.*)?'),
    to: (m) => ({
      kind: 'pipeline',
      lookup: lookup('nivaro_pipeline_owner_groups', 'template', m[1]),
      part: 'owners'
    })
  },
  {
    re: r('/api/pipelines/owner-group-users/{id}'),
    to: (m) => ({
      kind: 'pipeline',
      lookup2: {
        table: 'nivaro_pipeline_owner_group_users',
        column: 'group',
        key: m[1],
        parent: 'nivaro_pipeline_owner_groups',
        parentColumn: 'template'
      },
      part: 'owners'
    })
  },
  // Record-level (instances, owners on a record) and template-less routes are not config, nor
  // are writes to records made from a pipeline (starting missing instances, migrating them).
  { re: r('/api/pipelines/(instance|instance-owners|simulate|import)(/.*)?'), to: null },
  { re: r('/api/pipelines/{id}/(start-missing|migrate-instances)(/.*)?'), to: null },
  {
    re: r('/api/pipelines/{id}(/(.*))?'),
    to: (m) => ({ kind: 'pipeline', id: m[1], part: pipelinePart(m[3] ?? '') })
  },
  {
    re: r('/api/workflows/templates/{id}/splits(/.*)?'),
    to: (m) => ({ kind: 'pipeline', id: m[1], part: 'settings' })
  },

  // ── Flows ──
  { re: r('/api/flows/(webhook|import|dead-letters|registered-[a-z]+)(/.*)?'), to: null },
  {
    re: r('/api/flows/{id}/operations(/.*)?'),
    to: (m) => ({ kind: 'flow', id: m[1], part: 'step' })
  },
  {
    re: r('/api/flows/{id}/versions/.+/restore'),
    to: (m) => ({ kind: 'flow', id: m[1], part: 'version' })
  },
  { re: r('/api/flows/{id}'), to: (m) => ({ kind: 'flow', id: m[1], part: 'settings' }) },

  // ── Rules ──
  { re: r('/api/rules/{id}'), to: (m) => ({ kind: 'rule', id: m[1], part: 'settings' }) },

  // ── External APIs ──
  { re: r('/api/external-apis/logs(/.*)?'), to: null },
  {
    re: r('/api/external-apis/endpoints/{id}'),
    to: (m) => ({
      kind: 'external-api',
      lookup: lookup('nivaro_external_api_endpoints', 'api_id', m[1]),
      part: 'endpoint'
    })
  },
  { re: r('/api/external-apis/{id}/logs(/.*)?'), to: null },
  {
    re: r('/api/external-apis/{id}/(endpoints|import-spec|schemas)(/.*)?'),
    to: (m) => ({ kind: 'external-api', id: m[1], part: 'endpoint' })
  },
  {
    re: r('/api/external-apis/{id}(/.*)?'),
    to: (m) => ({ kind: 'external-api', id: m[1], part: 'settings' })
  },

  // ── Payload templates ──
  {
    re: r('/api/payload-templates/{id}(/(.*))?'),
    to: (m) => ({ kind: 'payload', id: m[1], part: payloadPart(m[3] ?? '') })
  },

  // ── Dashboards ──
  {
    re: r('/api/dashboards/widgets/{id}'),
    to: (m) => ({
      kind: 'dashboard',
      lookup: lookup('nivaro_dashboard_widgets', 'dashboard', m[1]),
      part: 'widget'
    })
  },
  { re: r('/api/dashboards/(ai-build|widgets)(/.*)?'), to: null },
  {
    re: r('/api/dashboards/{id}/widgets'),
    to: (m) => ({ kind: 'dashboard', id: m[1], part: 'widget' })
  },
  {
    re: r('/api/dashboards/{id}'),
    to: (m) => ({ kind: 'dashboard', id: m[1], part: 'settings' })
  },

  // ── Reports (Report Studio) ──
  {
    re: r('/api/report-studio/(widget-presets|templates|from-template|drill-row)(/.*)?'),
    to: null
  },
  {
    re: r('/api/report-studio/{id}/versions/.+/restore'),
    to: (m) => ({ kind: 'report', id: m[1], part: 'version' })
  },
  {
    re: r('/api/report-studio/{id}/widgets'),
    to: (m) => ({ kind: 'report', id: m[1], part: 'widget' })
  },
  {
    re: r('/api/report-studio/{id}'),
    to: (m) => ({ kind: 'report', id: m[1], part: 'settings' })
  }
]

function pipelinePart(rest: string): string {
  if (rest.startsWith('states')) return 'state'
  if (rest.startsWith('transitions')) return 'transition'
  if (rest.startsWith('bind')) return 'binding'
  if (rest.startsWith('versions')) return 'version'
  if (rest.startsWith('owner')) return 'owners'
  return 'settings'
}

function payloadPart(rest: string): string {
  if (rest.startsWith('draft')) return 'draft'
  if (/^(publish|versions|reset-default)/.test(rest)) return 'published'
  return 'settings'
}

/**
 * The object a write request changes, or null. `path` is the URL path without the query.
 * Pure — exported for tests. Creating a NEW object (POST to a collection root, import, clone)
 * is not announced: nobody has it open yet.
 */
export function configTargetOf(method: string, path: string): ConfigTarget | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  if (!path.startsWith('/api/')) return null
  if (READ_LIKE.test(path)) return null
  for (const rule of RULES) {
    const m = rule.re.exec(path)
    if (m) return rule.to ? rule.to(m) : null
  }
  return null
}

function lookup(table: string, column: string, key: string) {
  return { table, column, key }
}

/** Resolve a target to the object's id (one or two indexed reads; only for child-row routes). */
export async function resolveConfigTarget(
  t: ConfigTarget
): Promise<{ kind: ConfigKind; id: string; part: string } | null> {
  if ('id' in t) return ID_RE.test(t.id) ? { kind: t.kind, id: t.id, part: t.part } : null
  try {
    if ('lookup' in t) {
      const row = (await db(t.lookup.table).where({ id: t.lookup.key }).first(t.lookup.column)) as
        | Record<string, unknown>
        | undefined
      const id = row?.[t.lookup.column]
      return id != null && ID_RE.test(String(id))
        ? { kind: t.kind, id: String(id), part: t.part }
        : null
    }
    const l = t.lookup2
    const child = (await db(l.table).where({ id: l.key }).first(l.column)) as
      | Record<string, unknown>
      | undefined
    const parentKey = child?.[l.column]
    if (parentKey == null) return null
    const parent = (await db(l.parent).where({ id: parentKey }).first(l.parentColumn)) as
      | Record<string, unknown>
      | undefined
    const id = parent?.[l.parentColumn]
    return id != null && ID_RE.test(String(id))
      ? { kind: t.kind, id: String(id), part: t.part }
      : null
  } catch {
    // A child id of the wrong type (a uuid column read with a number) — nothing to announce.
    return null
  }
}

// ── Coalesced pokes ──────────────────────────────────────────────────────────

const SETTLE_MS = 300
const COOLDOWN_MS = 1000

export interface ConfigPoke {
  part: string
  by: { id: string; name: string } | null
}

interface PokeState {
  pending: ConfigPoke | null
  timer: ReturnType<typeof setTimeout>
}
const pokes = registerAppKeyed(new Map<string, PokeState>())

/** Two pokes in one window: the same part stays, different parts read "several". */
export function mergePokes(a: ConfigPoke | null, b: ConfigPoke): ConfigPoke {
  if (!a) return b
  const sameBy = a.by?.id === b.by?.id
  return {
    part: a.part === b.part ? a.part : 'several',
    by: sameBy ? b.by : (b.by ?? a.by)
  }
}

function fire(tenant: string, topic: string, kind: ConfigKind, poke: ConfigPoke): void {
  try {
    getIo()
      ?.to(opsRoom(topic, tenant))
      .emit('ops:changed', {
        topic,
        part: poke.part,
        // Who did it only reaches administrator rooms (the editors); a dashboard room does not.
        ...(isAdminConfigKind(kind) && poke.by ? { by: poke.by } : {}),
        at: Date.now()
      })
  } catch {
    /* best-effort: a live notice never affects the write that caused it */
  }
}

export function pokeConfig(
  kind: ConfigKind,
  id: string,
  poke: ConfigPoke,
  tenant: string = currentTenantKey()
): void {
  if (!ID_RE.test(id)) return
  const topic = configTopic(kind, id)
  const key = `${tenant}|${topic}`
  const cur = pokes.get(key)
  if (cur) {
    cur.pending = mergePokes(cur.pending, poke)
    return
  }
  const state: PokeState = { pending: poke } as PokeState
  const flush = () => {
    const p = state.pending
    state.pending = null
    if (p) {
      fire(tenant, topic, kind, p)
      state.timer = setTimeout(flush, COOLDOWN_MS)
      state.timer.unref?.()
    } else pokes.delete(key)
  }
  state.timer = setTimeout(flush, SETTLE_MS)
  state.timer.unref?.()
  pokes.set(key, state)
}

export function _resetConfigWatchForTests(): void {
  for (const s of pokes.values()) clearTimeout(s.timer)
  pokes.clear()
}

// ── The two hooks ────────────────────────────────────────────────────────────

type WatchedRequest = FastifyRequest & {
  nvrConfigTarget?: Promise<{ kind: ConfigKind; id: string; part: string } | null>
}

const PREFIX_RE =
  /^\/api\/(pipelines|workflows\/templates|flows|rules|external-apis|payload-templates|dashboards|report-studio)\//

/** preHandler: name the object a config write is about while its rows still exist. */
export async function configWatchPreHandler(req: FastifyRequest): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
  const path = req.url.split('?')[0]
  if (!PREFIX_RE.test(path)) return
  // Every config write needs a credential; a bare anonymous write is refused later anyway, so
  // it never costs a lookup here.
  if (!req.headers.authorization && !req.headers.cookie) return
  const target = configTargetOf(req.method, path)
  if (!target) return
  // Started now, awaited on response: a child-row lookup never delays the write itself.
  const resolving = resolveConfigTarget(target)
  resolving.catch(() => null)
  ;(req as WatchedRequest).nvrConfigTarget = resolving
}

function displayName(u: unknown): string {
  const user = (u ?? {}) as {
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  }
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Someone'
}

/** onResponse: a successful write pokes its object's topic. */
export async function configWatchOnResponse(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const pending = (req as WatchedRequest).nvrConfigTarget
  if (!pending || reply.statusCode >= 400) return
  const target = await pending.catch(() => null)
  if (!target) return
  const user = req.user as { id?: string } | undefined
  pokeConfig(
    target.kind,
    target.id,
    { part: target.part, by: user?.id ? { id: String(user.id), name: displayName(user) } : null },
    (req as unknown as { nvrTenantId?: string }).nvrTenantId ?? currentTenantKey()
  )
}

// ── Join gate for the dashboard / report topics ──────────────────────────────

/**
 * Whether this person may follow a dashboard's or report's changes: the same rule as the GET
 * route that serves it (owner, administrator, or shared — optionally to one role).
 */
export async function canFollowSharedView(
  kind: 'dashboard' | 'report',
  id: string,
  user: { id: string; role?: string | null },
  isAdmin: boolean
): Promise<boolean> {
  if (!ID_RE.test(id)) return false
  try {
    const table = kind === 'dashboard' ? 'nivaro_dashboards' : 'nivaro_report_defs'
    const ownerCol = kind === 'dashboard' ? 'user' : 'owner'
    const row = (await db(table).where({ id }).first(ownerCol, 'is_shared', 'role_id')) as
      | Record<string, unknown>
      | undefined
    if (!row) return false
    if (isAdmin) return true
    if (String(row[ownerCol] ?? '').toLowerCase() === String(user.id).toLowerCase()) return true
    if (!row.is_shared) return false
    return !row.role_id || String(row.role_id) === String(user.role ?? '')
  } catch {
    return false
  }
}

// ── Base revision (no silent overwrite) ──────────────────────────────────────

export const BASE_REV_HEADER = 'x-nivaro-base-rev'

/**
 * A whole-object save made from an older copy: the editor sent the `updated_at` it loaded and
 * the row has moved on since. Returns the 409 body, or null (no header, unreadable header, or
 * still current). Datetime columns round to ~3 ms on SQL Server, so 3 ms counts as equal.
 */
export function staleConfigRefusal(
  req: { headers: Record<string, unknown> },
  current: Date | string | null | undefined
): { error: string; code: 'CONFIG_STALE'; updated_at: string | null } | null {
  const raw = req.headers[BASE_REV_HEADER]
  const base = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  if (!Number.isFinite(base) || current == null) return null
  const now = new Date(current).getTime()
  if (!Number.isFinite(now) || Math.abs(now - base) <= 3) return null
  return {
    error:
      'Someone else saved this since you opened it. Show their version first, or save yours over it.',
    code: 'CONFIG_STALE',
    updated_at: new Date(now).toISOString()
  }
}

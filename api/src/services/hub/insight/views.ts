import { db } from '../../../db/index.js'
import { appEnvironments, productionMap } from '../owner-access.js'
import { loadInsightSettings } from './settings.js'

/**
 * Hub insight reads (enhancements 36 + 37): usage and the dependency map, from the Hub's own
 * tables (the collect job fills them; a page view never calls an app). Scoped like every Hub
 * read: an administrator sees every app, an app owner only the apps they own.
 */

export interface Viewer {
  userId: string
  isAdmin: boolean
}

/** App ids the viewer may read: null = all (an administrator). */
export async function visibleAppIds(who: Viewer): Promise<number[] | null> {
  if (who.isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: who.userId })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

export async function mayReadApp(who: Viewer, appId: number): Promise<boolean> {
  const ids = await visibleAppIds(who)
  return ids === null || ids.includes(appId)
}

interface EnvBase {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  env_key: string
  position: number
  base_url: string
  db_ref: string | null
  placement_kind: string | null
  driver_id: number | null
  shared_deployment_id: number | null
}

async function visibleEnvironments(who: Viewer, appId?: number | null): Promise<EnvBase[]> {
  const ids = await visibleAppIds(who)
  if (ids && !ids.length) return []
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .whereNot('e.status', 'archived')
    .orderBy('a.key', 'asc')
    .orderBy('e.position', 'asc')
    .orderBy('e.id', 'asc')
    .select(
      'e.id',
      'e.app_id',
      'a.key as app_key',
      'a.name as app_name',
      'e.key as env_key',
      'e.position',
      'e.base_url',
      'e.db_ref',
      'p.kind as placement_kind',
      'p.driver_id',
      'p.shared_deployment_id'
    )
  if (ids) q.whereIn('e.app_id', ids)
  if (appId != null) q.where('e.app_id', appId)
  const rows = (await q) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    environment_id: Number(r.id),
    app_id: Number(r.app_id),
    app_key: String(r.app_key),
    app_name: String(r.app_name ?? r.app_key),
    env_key: String(r.env_key),
    position: Number(r.position ?? 0),
    base_url: String(r.base_url ?? ''),
    db_ref: (r.db_ref as string | null) ?? null,
    placement_kind: (r.placement_kind as string | null) ?? null,
    driver_id: r.driver_id == null ? null : Number(r.driver_id),
    shared_deployment_id: r.shared_deployment_id == null ? null : Number(r.shared_deployment_id)
  }))
}

async function productionOf(appIds: number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>()
  for (const appId of appIds)
    for (const [id, p] of productionMap(await appEnvironments(appId))) out.set(id, p)
  return out
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const intOrNull = (v: unknown) => (v == null ? null : Number(v))

// ─── Usage ───────────────────────────────────────────────────────────────────────────────────

export interface UsageWeek {
  /** Monday of the ISO week (UTC), YYYY-MM-DD. */
  week: string
  /** Average different people per day over the days with a figure; null if none had one. */
  avg_people: number | null
  /** Days of the week with a figure (under-floor days are not counted). */
  days: number
}

export interface EnvUsage {
  environment_id: number
  env_key: string
  production: boolean
  state: string | null
  collected_at: string | null
  people_7d: number | null
  people_window: number | null
  accounts: number | null
  /** people_7d / accounts, 0–1; null when either is unknown. */
  adoption: number | null
  daily: Array<{ day: string; people: number | null; views: number | null; under_floor: boolean }>
  weekly: UsageWeek[]
  screens: Array<{ route: string; people: number; views: number }>
  screens_hidden: number | null
  period_days: number | null
}

export interface AppUsage {
  app_id: number
  app_key: string
  app_name: string
  environments: EnvUsage[]
}

/** Monday (UTC) of the week a YYYY-MM-DD day falls in. Pure. */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  const dow = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10)
}

/** Weekly averages of the daily figures (days under the floor never count). Pure. */
export function weeklyOf(daily: EnvUsage['daily']): UsageWeek[] {
  const acc = new Map<string, { sum: number; n: number }>()
  for (const d of daily) {
    const w = weekOf(d.day)
    const a = acc.get(w) ?? { sum: 0, n: 0 }
    if (d.people != null && !d.under_floor) {
      a.sum += d.people
      a.n++
    }
    acc.set(w, a)
  }
  return [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, a]) => ({
      week,
      avg_people: a.n ? Math.round((a.sum / a.n) * 10) / 10 : null,
      days: a.n
    }))
}

export async function usageView(
  who: Viewer,
  opts: { appId?: number | null; days?: number; now?: Date } = {}
): Promise<{ floor: number; apps: AppUsage[] }> {
  const settings = await loadInsightSettings()
  const envs = await visibleEnvironments(who, opts.appId)
  const days = Math.max(7, Math.min(400, opts.days ?? 90))
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const envIds = envs.map((e) => e.environment_id)
  const prod = await productionOf([...new Set(envs.map((e) => e.app_id))])
  const dailyBy = new Map<number, EnvUsage['daily']>()
  const screensBy = new Map<number, EnvUsage['screens']>()
  const periodBy = new Map<number, number>()
  const stateBy = new Map<number, Record<string, unknown>>()
  for (let i = 0; i < envIds.length; i += 500) {
    const chunk = envIds.slice(i, i + 500)
    const dRows = (await db('nivaro_hub_usage_days')
      .whereIn('environment_id', chunk)
      .where('day', '>=', since)
      .orderBy('day', 'asc')
      .select('environment_id', 'day', 'people', 'views', 'under_floor')) as Array<
      Record<string, unknown>
    >
    for (const r of dRows) {
      const id = Number(r.environment_id)
      const list = dailyBy.get(id) ?? []
      const under = r.under_floor === true || Number(r.under_floor) === 1
      list.push({
        day: String(r.day),
        people: under ? null : intOrNull(r.people),
        views: under ? null : intOrNull(r.views),
        under_floor: under
      })
      dailyBy.set(id, list)
    }
    const sRows = (await db('nivaro_hub_usage_screens')
      .whereIn('environment_id', chunk)
      .orderBy('people', 'desc')
      .select('environment_id', 'route', 'people', 'views', 'period_days')) as Array<
      Record<string, unknown>
    >
    for (const r of sRows) {
      const id = Number(r.environment_id)
      const list = screensBy.get(id) ?? []
      // The floor may have been raised since the collect: a screen under today's floor is held.
      if (Number(r.people) < settings.usage.floor) continue
      list.push({ route: String(r.route), people: Number(r.people), views: Number(r.views) })
      screensBy.set(id, list)
      periodBy.set(id, Number(r.period_days))
    }
    const st = (await db('nivaro_hub_insight_state')
      .whereIn('environment_id', chunk)
      .select('*')) as Array<Record<string, unknown>>
    for (const r of st) stateBy.set(Number(r.environment_id), r)
  }
  const floorNow = (n: number | null) =>
    n == null || n === 0 || n >= settings.usage.floor ? n : null
  const byApp = new Map<number, AppUsage>()
  for (const e of envs) {
    const st = stateBy.get(e.environment_id)
    const daily = (dailyBy.get(e.environment_id) ?? []).map((d) =>
      d.people != null && d.people > 0 && d.people < settings.usage.floor
        ? { ...d, people: null, views: null, under_floor: true }
        : d
    )
    const p7 = floorNow(intOrNull(st?.people_7d))
    const accounts = floorNow(intOrNull(st?.accounts))
    const app = byApp.get(e.app_id) ?? {
      app_id: e.app_id,
      app_key: e.app_key,
      app_name: e.app_name,
      environments: []
    }
    app.environments.push({
      environment_id: e.environment_id,
      env_key: e.env_key,
      production: prod.get(e.environment_id) ?? true,
      state: (st?.usage_state as string | null) ?? null,
      collected_at: iso(st?.usage_at),
      people_7d: p7,
      people_window: floorNow(intOrNull(st?.people_window)),
      accounts,
      adoption: p7 != null && accounts ? Math.min(1, p7 / accounts) : null,
      daily,
      weekly: weeklyOf(daily),
      screens: screensBy.get(e.environment_id) ?? [],
      screens_hidden: intOrNull(st?.screens_hidden),
      period_days: periodBy.get(e.environment_id) ?? null
    })
    byApp.set(e.app_id, app)
  }
  return { floor: settings.usage.floor, apps: [...byApp.values()] }
}

// ─── Dependency map ──────────────────────────────────────────────────────────────────────────

export type DepNodeKind =
  | 'app'
  | 'partner_api'
  | 'webhook'
  | 'mail'
  | 'signin'
  | 'tracker'
  | 'extension'
  | 'database'
  | 'shared'
  | 'driver'

export interface DepNode {
  /** `app:<id>` or `<kind>:<target>`. */
  id: string
  kind: DepNodeKind
  /** The host (`api.partner.com`), the extension id, a database server or deployment name. */
  target: string
  label: string
  /** How many environments use it (0 for an app node). */
  environments: number
}

export interface DepEdge {
  from: string
  to: string
  /** Environment keys of the app that use it. */
  envs: string[]
  /** Extra words from the app's answer ("off", "3 configs") or the Hub's record. */
  detail: string | null
}

export interface DepUse {
  node: string
  app_id: number
  app_name: string
  environment_id: number
  env_key: string
  production: boolean
  label: string | null
  detail: string | null
  source: 'app' | 'hub'
}

export interface DependencyMap {
  nodes: DepNode[]
  edges: DepEdge[]
  uses: DepUse[]
  /** When each environment's list was last read, and how it went. */
  states: Array<{ environment_id: number; state: string | null; at: string | null }>
}

const nodeId = (kind: DepNodeKind, target: string) => `${kind}:${target}`

/** Hub-side dependencies from its own records: database server, shared deployment, driver. */
interface RawUse {
  node: string
  environment_id: number
  kind: DepNodeKind
  target: string
  label: string | null
  detail: string | null
  source: 'app' | 'hub'
}

async function hubSideUses(envs: EnvBase[]): Promise<RawUse[]> {
  const out: RawUse[] = []
  const dbIds = new Map<number, number>()
  for (const e of envs) {
    const m = /^hub-db:(\d+)$/.exec(String(e.db_ref ?? ''))
    if (m) dbIds.set(e.environment_id, Number(m[1]))
  }
  const dbRows = dbIds.size
    ? ((await db('nivaro_hub_databases')
        .whereIn('id', [...new Set(dbIds.values())])
        .select('id', 'server_id', 'engine', 'host', 'port')) as Array<Record<string, unknown>>)
    : []
  const serverIds = [
    ...new Set(dbRows.map((r) => r.server_id).filter((v) => v != null))
  ] as number[]
  const servers = serverIds.length
    ? new Map(
        (
          (await db('nivaro_hub_db_servers')
            .whereIn('id', serverIds)
            .select('id', 'name')) as Array<{ id: number; name: string }>
        ).map((s) => [Number(s.id), String(s.name)])
      )
    : new Map<number, string>()
  const dbById = new Map(dbRows.map((r) => [Number(r.id), r]))
  const sharedIds = [
    ...new Set(envs.map((e) => e.shared_deployment_id).filter((v) => v != null))
  ] as number[]
  const shared = sharedIds.length
    ? new Map(
        (
          (await db('nivaro_hub_shared_deployments')
            .whereIn('id', sharedIds)
            .select('id', 'key', 'name')) as Array<{ id: number; key: string; name: string }>
        ).map((s) => [Number(s.id), s])
      )
    : new Map<number, { id: number; key: string; name: string }>()
  const driverIds = [...new Set(envs.map((e) => e.driver_id).filter((v) => v != null))] as number[]
  const drivers = driverIds.length
    ? new Map(
        (
          (await db('nivaro_hub_drivers')
            .whereIn('id', driverIds)
            .select('id', 'kind', 'name')) as Array<{ id: number; kind: string; name: string }>
        ).map((d) => [Number(d.id), d])
      )
    : new Map<number, { id: number; kind: string; name: string }>()

  for (const e of envs) {
    const dbId = dbIds.get(e.environment_id)
    const d = dbId != null ? dbById.get(dbId) : undefined
    if (d) {
      const host = String(d.host ?? '').toLowerCase()
      const target = d.port ? `${host}:${Number(d.port)}` : host
      if (target) {
        const sid = d.server_id == null ? null : Number(d.server_id)
        out.push({
          node: nodeId('database', target),
          environment_id: e.environment_id,
          kind: 'database',
          target,
          label: (sid != null ? servers.get(sid) : null) ?? String(d.engine ?? 'Database'),
          detail: String(d.engine ?? '') || null,
          source: 'hub'
        })
      }
    }
    if (e.placement_kind === 'shared' && e.shared_deployment_id != null) {
      const s = shared.get(e.shared_deployment_id)
      if (s)
        out.push({
          node: nodeId('shared', s.key),
          environment_id: e.environment_id,
          kind: 'shared',
          target: s.key,
          label: s.name || s.key,
          detail: 'Shared deployment',
          source: 'hub'
        })
    } else if (e.driver_id != null) {
      const d2 = drivers.get(e.driver_id)
      if (d2)
        out.push({
          node: nodeId('driver', String(d2.id)),
          environment_id: e.environment_id,
          kind: 'driver',
          target: String(d2.id),
          label: d2.name || `${d2.kind} driver`,
          detail:
            d2.kind === 'docker'
              ? 'Docker driver'
              : d2.kind === 'gitlab'
                ? 'GitLab driver'
                : d2.kind,
          source: 'hub'
        })
    }
  }
  return out
}

const KIND_LABEL: Record<string, string> = {
  partner_api: 'Partner API',
  webhook: 'Webhook',
  mail: 'Mail relay',
  signin: 'Sign-in',
  tracker: 'Issue tracker',
  extension: 'Extension'
}

export async function dependencyMap(
  who: Viewer,
  opts: { appId?: number | null } = {}
): Promise<DependencyMap> {
  const envs = await visibleEnvironments(who, opts.appId)
  const envById = new Map(envs.map((e) => [e.environment_id, e]))
  const prod = await productionOf([...new Set(envs.map((e) => e.app_id))])
  const uses: DepUse[] = []
  const nodes = new Map<string, DepNode & { envSet: Set<number> }>()
  const addNode = (kind: DepNodeKind, target: string, label: string) => {
    const id = nodeId(kind, target)
    if (!nodes.has(id))
      nodes.set(id, { id, kind, target, label, environments: 0, envSet: new Set() })
    return nodes.get(id) as DepNode & { envSet: Set<number> }
  }
  const envIds = envs.map((e) => e.environment_id)
  const stored: Array<Record<string, unknown>> = []
  const states: DependencyMap['states'] = []
  for (let i = 0; i < envIds.length; i += 500) {
    const chunk = envIds.slice(i, i + 500)
    stored.push(
      ...((await db('nivaro_hub_dependencies')
        .whereIn('environment_id', chunk)
        .where({ source: 'app' })
        .select('environment_id', 'kind', 'target', 'label', 'detail')) as Array<
        Record<string, unknown>
      >)
    )
    for (const r of (await db('nivaro_hub_insight_state')
      .whereIn('environment_id', chunk)
      .select('environment_id', 'deps_state', 'deps_at')) as Array<Record<string, unknown>>)
      states.push({
        environment_id: Number(r.environment_id),
        state: (r.deps_state as string | null) ?? null,
        at: iso(r.deps_at)
      })
  }
  const all = [
    ...stored.map((r) => ({
      environment_id: Number(r.environment_id),
      kind: String(r.kind) as DepNodeKind,
      target: String(r.target),
      label: (r.label as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      source: 'app' as const
    })),
    ...(await hubSideUses(envs))
  ]
  for (const u of all) {
    const e = envById.get(u.environment_id)
    if (!e) continue
    const nodeLabel =
      u.kind === 'extension'
        ? u.target
        : u.kind === 'database' || u.kind === 'shared' || u.kind === 'driver'
          ? (u.label ?? u.target)
          : u.target
    const n = addNode(u.kind, u.target, nodeLabel)
    n.envSet.add(e.environment_id)
    uses.push({
      node: n.id,
      app_id: e.app_id,
      app_name: e.app_name,
      environment_id: e.environment_id,
      env_key: e.env_key,
      production: prod.get(e.environment_id) ?? true,
      label:
        u.kind === 'extension'
          ? u.label
            ? `v${u.label.replace(/^v/i, '')}`
            : null
          : (u.label ?? KIND_LABEL[u.kind] ?? null),
      detail: u.detail,
      source: u.source
    })
  }
  const edges = new Map<string, DepEdge>()
  for (const e of envs) addNode('app', String(e.app_id), e.app_name)
  for (const u of uses) {
    const from = nodeId('app', String(u.app_id))
    const k = `${from}>${u.node}`
    const edge = edges.get(k) ?? { from, to: u.node, envs: [], detail: u.detail }
    if (!edge.envs.includes(u.env_key)) edge.envs.push(u.env_key)
    edges.set(k, edge)
  }
  const outNodes: DepNode[] = [...nodes.values()].map(({ envSet, ...n }) => ({
    ...n,
    environments: n.kind === 'app' ? 0 : envSet.size
  }))
  outNodes.sort(
    (a, b) =>
      (a.kind === 'app' ? 0 : 1) - (b.kind === 'app' ? 0 : 1) ||
      b.environments - a.environments ||
      a.label.localeCompare(b.label)
  )
  return { nodes: outNodes, edges: [...edges.values()], uses, states }
}

export interface ImpactAnswer {
  node: DepNode | null
  /** Everything that would feel a change to this node, production first. */
  affected: DepUse[]
  apps: number
  production: number
}

/** Who depends on one node (`partner_api:api.example.com`, `database:sql1:1433`, …). */
export async function impactOf(who: Viewer, node: string): Promise<ImpactAnswer> {
  const map = await dependencyMap(who)
  const n = map.nodes.find((x) => x.id === node && x.kind !== 'app') ?? null
  const affected = n
    ? map.uses
        .filter((u) => u.node === node)
        .sort(
          (a, b) =>
            Number(b.production) - Number(a.production) ||
            a.app_name.localeCompare(b.app_name) ||
            a.env_key.localeCompare(b.env_key)
        )
    : []
  return {
    node: n,
    affected,
    apps: new Set(affected.map((a) => a.app_id)).size,
    production: affected.filter((a) => a.production).length
  }
}

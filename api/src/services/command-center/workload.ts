import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { selectInChunks } from '../db-batch.js'
import { sharedGatedRead } from '../read-gate.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { liveOpenWork } from './open-work.js'
import { readCcScope } from './scope.js'
import { tenantMemo, Viewer } from './work-access.js'
import { DAY_MS, median, workloadStatus } from './work-math.js'

/**
 * CC-32 workload: per person, the open records they own now against their usual load.
 *
 * Who may read it: administrators (everyone), and managers — people with at least one active
 * direct report (nivaro_users.manager_id, the team views' rule) — who see their direct reports
 * only. Everyone else gets 403. A manager's counts are narrowed to records the manager can open.
 *
 * "Open owned" = open pipeline instances whose current state resolves to the person as an owner
 * (owner groups, manual owners, delegates — the queues' resolver), over the newest OWNER_CAP open
 * instances of the shared open-work index.
 *
 * "Usual" — owner history is not stored (owners resolve from rules, not rows), so the median of
 * the last 28 days is approximated from a daily sample the board keeps itself: each time the owner
 * map is built, today's open-owned count per person is written to Redis
 * (nvr:cc:wl:<tenant>:<yyyy-mm-dd>, kept 35 days). With five or more sampled days the usual is
 * that person's median; before that it is the median across the people listed (usual_source
 * 'team'). For a manager the usual is scaled by the share of that person's records the manager can
 * see today, so a narrowed count is compared with a narrowed usual.
 */
export interface WorkloadRow {
  user_id: string
  name: string
  open: number
  usual: number
  status: 'over' | 'normal' | 'idle'
  out: boolean
  usual_source?: 'history' | 'team'
}

export const OWNER_CAP = 8000
const HISTORY_DAYS = 28
const MIN_HISTORY_DAYS = 5
const MAX_ROWS = 60

type RedisLike = {
  hset?: (key: string, values: Record<string, string>) => Promise<unknown>
  expire?: (key: string, s: number) => Promise<unknown>
  hmget?: (key: string, ...fields: string[]) => Promise<Array<string | null>>
  hkeys?: (key: string) => Promise<string[]>
}

const U = (v: unknown) => String(v ?? '').toUpperCase()
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayKey = (tenant: string, day: string) => `nvr:cc:wl:${tenant || '-'}:${day}`

interface OwnerMap {
  built_at: number
  truncated: boolean
  /** person (upper) → owned open records */
  owned: Map<string, Array<{ collection: string; item: string }>>
}

async function buildOwnerMap(redis: RedisLike | null): Promise<OwnerMap> {
  const index = await liveOpenWork()
  const owned = new Map<string, Array<{ collection: string; item: string }>>()
  if (!index) return { built_at: Date.now(), truncated: false, owned }
  const sample = [...index.open].sort((a, b) => b.started_at - a.started_at).slice(0, OWNER_CAP)
  const { resolveStateOwnersBatch } = await import('../pipeline-engine.js')
  const owners = await resolveStateOwnersBatch(
    sample.map((o) => ({
      key: o.instance_id,
      stateId: o.state_id,
      instanceId: o.instance_id,
      collection: o.collection,
      itemId: o.item
    }))
  )
  for (const o of sample)
    for (const p of owners.get(o.instance_id) ?? [])
      owned.set(U(p.id), [
        ...(owned.get(U(p.id)) ?? []),
        { collection: o.collection, item: o.item }
      ])
  // Today's sample for the "usual" history.
  if (redis?.hset && owned.size > 0) {
    const key = dayKey(currentTenantKey(), ymd(Date.now()))
    const values: Record<string, string> = {}
    for (const [id, list] of owned) values[id] = String(list.length)
    try {
      await redis.hset(key, values)
      await redis.expire?.(key, 35 * 86_400)
    } catch {
      /* history is best-effort */
    }
  }
  return {
    built_at: Date.now(),
    truncated: index.open.length > OWNER_CAP || index.truncated,
    owned
  }
}

async function historyFor(
  redis: RedisLike | null,
  ids: string[]
): Promise<{ byPerson: Map<string, number[]> }> {
  const byPerson = new Map<string, number[]>()
  if (!redis?.hmget || ids.length === 0) return { byPerson }
  const tenant = currentTenantKey()
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => ymd(Date.now() - i * DAY_MS))
  await Promise.all(
    days.map(async (d) => {
      try {
        const vals = await redis.hmget!(dayKey(tenant, d), ...ids)
        vals.forEach((v, i) => {
          if (v == null) return
          const n = Number(v)
          if (Number.isFinite(n)) byPerson.set(ids[i], [...(byPerson.get(ids[i]) ?? []), n])
        })
      } catch {
        /* missing day */
      }
    })
  )
  return { byPerson }
}

/**
 * Pure assembly (tests): people + their counts → rows with usual and status. `history` holds each
 * person's sampled daily counts; people with fewer than MIN_HISTORY_DAYS use the team median.
 */
export function assembleWorkload(
  people: Array<{
    id: string
    name: string
    open: number
    fullOpen: number
    out: boolean
    history: number[]
  }>
): WorkloadRow[] {
  const team = median(people.map((p) => p.fullOpen)) ?? 0
  return people.map((p) => {
    const own = p.history.length >= MIN_HISTORY_DAYS ? median(p.history) : null
    const fullUsual = own ?? team
    const share = p.fullOpen > 0 ? p.open / p.fullOpen : 1
    const usual = Math.round(fullUsual * share * 10) / 10
    return {
      user_id: p.id,
      name: p.name,
      open: p.open,
      usual,
      status: workloadStatus(p.open, usual),
      out: p.out,
      usual_source: own != null ? 'history' : 'team'
    }
  })
}

export class WorkloadForbidden extends Error {}

export async function workloadForRequest(
  app: FastifyInstance,
  req: FastifyRequest
): Promise<{ rows: WorkloadRow[]; region_applies: boolean | null; truncated: boolean }> {
  const isAdmin = !!req.isAdmin
  const me = String(req.user!.id)
  const { hasReports, reportsOf } = await import('../team.js')
  let allowedIds: Set<string> | null = null
  if (!isAdmin) {
    if (!(await hasReports(me)))
      throw new WorkloadForbidden('Workload is for administrators and managers')
    allowedIds = new Set((await reportsOf(me)).map((r) => U(r.id)))
  }
  const redis = ((app as unknown as { redis?: RedisLike }).redis ?? null) as RedisLike | null
  const map = await tenantMemo(
    'cc:workload-owners',
    5 * 60_000,
    async () =>
      (
        await sharedGatedRead('cc:workload-owners', 'command-center', () => buildOwnerMap(redis), {
          label: 'cc:workload'
        })
      ).value
  )
  if (!map) return { rows: [], region_applies: null, truncated: false }

  const scope = readCcScope(req.query)
  let regionPeople: Set<string> | null = null
  if (scope.region) {
    const { userIdsInRegion } = await import('./regions.js')
    const set = await userIdsInRegion(scope.region).catch(() => null)
    regionPeople = set ? new Set([...set].map(U)) : null
  }

  let ids = allowedIds ? [...allowedIds] : [...map.owned.keys()]
  if (!allowedIds && redis?.hkeys) {
    // People who had work yesterday and none now are the idle ones — keep them in the list.
    try {
      const keys = await redis.hkeys(dayKey(currentTenantKey(), ymd(Date.now() - DAY_MS)))
      ids = [...new Set([...ids, ...keys.map(U)])]
    } catch {
      /* no sample yesterday */
    }
  }
  if (regionPeople) ids = ids.filter((id) => regionPeople!.has(id))

  const users = (await selectInChunks(ids, 2000, (chunk) =>
    db('nivaro_users')
      .whereIn('id', chunk)
      .where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
      .select(
        'id',
        'first_name',
        'last_name',
        'email',
        'status',
        'is_out_of_office',
        'ooo_start',
        'ooo_end'
      )
  )) as Array<Record<string, unknown>>
  const now = Date.now()
  const active = users.filter((u) => u.status == null || u.status === 'active')
  const { byPerson } = await historyFor(
    redis,
    active.map((u) => U(u.id))
  )

  // Narrow counts to what the viewer can open (managers); admins see the full counts.
  const viewer = new Viewer(req.user!, isAdmin, null)
  const people = []
  for (const u of active) {
    const id = U(u.id)
    const list = map.owned.get(id) ?? []
    let open = list.length
    if (!isAdmin && list.length > 0) {
      open = 0
      const byCollection = new Map<string, string[]>()
      for (const r of list)
        byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r.item])
      for (const [collection, items] of byCollection)
        open += (await viewer.visibleUpper(collection, items)).size
    }
    const oooStart = u.ooo_start ? new Date(u.ooo_start as Date).getTime() : null
    const oooEnd = u.ooo_end ? new Date(u.ooo_end as Date).getTime() : null
    const out =
      u.is_out_of_office === true ||
      u.is_out_of_office === 1 ||
      (oooStart != null && oooStart <= now && (oooEnd == null || oooEnd >= now))
    people.push({
      id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? 'Unknown'),
      open,
      fullOpen: list.length,
      out,
      history: byPerson.get(id) ?? []
    })
  }
  const rows = assembleWorkload(people)
    .sort(
      (a, b) =>
        Number(b.status === 'over') - Number(a.status === 'over') ||
        b.open - a.open ||
        a.name.localeCompare(b.name)
    )
    .slice(0, MAX_ROWS)
  return {
    rows,
    region_applies: scope.region ? regionPeople !== null : null,
    truncated: map.truncated
  }
}

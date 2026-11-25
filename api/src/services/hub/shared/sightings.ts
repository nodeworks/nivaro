import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { getApp } from '../../io-holder.js'
import type { SharedDeployment } from './store.js'

/**
 * Nivaro Hub phase 6: what the Hub has seen of each process of a shared deployment.
 *
 * Every process of a shared deployment polls `GET /api/hub/shared/<key>/tenants` with
 * `X-Nivaro-Instance` (its INSTANCE_ID, one per process, ruling B4) and `X-Nivaro-Version`. Each
 * poll is a sighting: the instance, its version, the tenant-list ETag it now holds and when. They
 * live in the Redis hash `nvr:hub:shared:<id>:seen` (field = instance, 10 min TTL), so every Hub
 * process reads the same ones. `replicasHolding` answers "does every live replica (seen in the
 * last 2 min) hold this list?", which a move waits on before it trusts a maintenance switch.
 *
 * `last_seen_at` on the deployment row is written at most once a minute (a Redis NX key).
 *
 * A registered deployment is upgraded outside the Hub; when every live sighting agrees on a
 * version other than `version_pin`, `noteObservedVersion` records an `observed` shared deploy, a
 * `shared` deploy row per listed environment, and moves the pins (Decision 3). Once per
 * (deployment, version): a Redis NX key plus a compare-and-set on `version_pin`. Never while the
 * Hub itself upgrades a registered deployment through GitLab (status `upgrading`).
 *
 * No value here is a secret: an ETag is a hash, a version is public. Hub-only (HUB=on, never
 * cloud mode), so the keys carry no tenant (as every nvr:hub:* key). Without Redis (a
 * single-process dev Hub) the same data is kept in this process.
 */

/** A sighting is kept this long after its last poll. */
export const SIGHTING_TTL_MS = 10 * 60_000
/** A replica seen within this window is live (a poll is every 30 s; four missed = gone). */
export const LIVE_WINDOW_MS = 120_000
/** `last_seen_at` on the deployment row is written at most this often. */
const LAST_SEEN_EVERY_MS = 60_000
/** The observed-version guard: one attempt per (deployment, version) in this window. */
const OBSERVE_GUARD_MS = 60_000
/** At most this many instances are kept per deployment; the oldest go first. */
const MAX_INSTANCES = 200

const INSTANCE_RE = /^[A-Za-z0-9._:-]{1,100}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/
/** An ETag as the tenants route makes them: a quoted sha256 (strong). */
const ETAG_RE = /^"[0-9a-f]{64}"$/

const SHARED = 'nivaro_hub_shared_deployments'
const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'
const DEPLOYS = 'nivaro_hub_deploys'
const ENVS = 'nivaro_hub_environments'

export interface Sighting {
  instance: string
  version: string | null
  etag: string | null
  at: string
}

export const sightingsKey = (sharedId: number) => `nvr:hub:shared:${sharedId}:seen`
const lastSeenKey = (sharedId: number) => `nvr:hub:shared:${sharedId}:seen-db`
const observeKey = (sharedId: number, version: string) =>
  `nvr:hub:shared:${sharedId}:observed:${version}`

/** The slice of ioredis sightings need. */
export interface SightingsRedis {
  hset(key: string, field: string, value: string): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>
}

/** No Redis: the same keys in this process (expiry judged on read). */
export function memorySightingsRedis(now: () => number = Date.now): SightingsRedis {
  const hashes = new Map<string, { fields: Map<string, string>; until: number }>()
  const keys = new Map<string, number>()
  const hash = (key: string) => {
    const h = hashes.get(key)
    if (h && h.until <= now()) {
      hashes.delete(key)
      return null
    }
    return h ?? null
  }
  return {
    async hset(key, field, value) {
      const h = hash(key) ?? { fields: new Map(), until: Number.POSITIVE_INFINITY }
      h.fields.set(field, value)
      hashes.set(key, h)
      return 1
    },
    async hgetall(key) {
      return Object.fromEntries(hash(key)?.fields ?? [])
    },
    async hdel(key, ...fields) {
      const h = hash(key)
      for (const f of fields) h?.fields.delete(f)
      return fields.length
    },
    async pexpire(key, ms) {
      const h = hash(key)
      if (h) h.until = now() + ms
      return h ? 1 : 0
    },
    async set(key, _value, _px, ms) {
      const until = keys.get(key)
      if (until !== undefined && until > now()) return null
      keys.set(key, now() + ms)
      return 'OK'
    }
  }
}

const deps: { redis?: SightingsRedis | null; now: () => number } = { now: Date.now }
let memory: SightingsRedis | null = null

/** Test seam: a Redis (or null = this process only) and a clock. */
export function _setSightingsDepsForTests(
  o: { redis?: SightingsRedis | null; now?: () => number } = {}
): void {
  deps.redis = o.redis
  deps.now = o.now ?? Date.now
  memory = null
}

function store(): SightingsRedis {
  const r = deps.redis !== undefined ? deps.redis : (getApp()?.redis as SightingsRedis | undefined)
  if (r) return r
  if (!memory) {
    // Only a single-process Hub may run like this: with several processes each would see only
    // the polls it answered, and replicasHolding would judge from a part of the replicas.
    if (deps.redis === undefined)
      getApp()?.log?.warn(
        'hub shared sightings: no Redis — replica sightings are kept in this process only'
      )
    memory = memorySightingsRedis(() => deps.now())
  }
  return memory
}

/** A header value as a sighting field: trimmed, matching `re`, else null. */
function clean(v: unknown, re: RegExp): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && re.test(s) ? s : null
}

/** An instance name a sighting may carry (≤ 100 characters of [A-Za-z0-9._:-]), else null. */
export function sightingInstance(v: unknown): string | null {
  return clean(v, INSTANCE_RE)
}

function parse(instance: string, raw: string): Sighting | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const at = typeof v.at === 'string' ? v.at : null
    if (!at || Number.isNaN(new Date(at).getTime())) return null
    return {
      instance,
      version: clean(v.version, VERSION_RE),
      etag: clean(v.etag, ETAG_RE),
      at
    }
  } catch {
    return null
  }
}

/** Every stored sighting of a deployment, newest first. Throws when Redis fails. */
async function allSightings(sharedId: number): Promise<Sighting[]> {
  const raw = await store().hgetall(sightingsKey(sharedId))
  const out: Sighting[] = []
  for (const [instance, value] of Object.entries(raw ?? {})) {
    const s = parse(instance, value)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.instance.localeCompare(b.instance))
}

/**
 * Records one poll. Best effort: a sighting that cannot be stored (Redis down) is dropped, never
 * failing the tenants answer. An instance name that is not one is ignored; a version or ETag that
 * is not one is stored as null.
 */
export async function recordSighting(sharedId: number, s: Sighting): Promise<void> {
  const instance = sightingInstance(s.instance)
  if (!instance) return
  const at = Number.isNaN(new Date(s.at).getTime())
    ? new Date(deps.now()).toISOString()
    : new Date(s.at).toISOString()
  const value = JSON.stringify({
    version: clean(s.version, VERSION_RE),
    etag: clean(s.etag, ETAG_RE),
    at
  })
  const r = store()
  const key = sightingsKey(sharedId)
  try {
    await r.hset(key, instance, value)
    await r.pexpire(key, SIGHTING_TTL_MS)
    await prune(sharedId)
  } catch {
    return
  }
  try {
    if (await r.set(lastSeenKey(sharedId), '1', 'PX', LAST_SEEN_EVERY_MS, 'NX'))
      await db(SHARED)
        .where({ id: sharedId })
        .update({ last_seen_at: new Date(at) })
  } catch {
    // last_seen_at is a hint for the admin page; the sighting itself is stored
  }
}

/** Drops instances not seen for the TTL, and the oldest past MAX_INSTANCES. */
async function prune(sharedId: number): Promise<void> {
  const all = await allSightings(sharedId)
  const cutoff = deps.now() - SIGHTING_TTL_MS
  const gone = all
    .filter((s, i) => i >= MAX_INSTANCES || new Date(s.at).getTime() < cutoff)
    .map((s) => s.instance)
  if (gone.length) await store().hdel(sightingsKey(sharedId), ...gone)
}

/**
 * The instances seen in the last `withinMs` (default 2 min), sorted by name. Throws when Redis
 * fails: an empty answer would read as "nobody is behind".
 */
export async function liveSightings(
  sharedId: number,
  withinMs: number = LIVE_WINDOW_MS
): Promise<Sighting[]> {
  const cutoff = deps.now() - withinMs
  return (await allSightings(sharedId))
    .filter((s) => new Date(s.at).getTime() >= cutoff)
    .sort((a, b) => a.instance.localeCompare(b.instance))
}

/**
 * Of the live instances, which hold the list with this ETag and which are behind (an older list,
 * or none yet). Throws when Redis fails. No live instance at all = both empty: the caller decides
 * what that means (nobody is serving, or nobody polled yet).
 */
export async function replicasHolding(
  sharedId: number,
  etag: string
): Promise<{ holding: string[]; behind: string[] }> {
  const live = await liveSightings(sharedId)
  return {
    holding: live.filter((s) => s.etag === etag).map((s) => s.instance),
    behind: live.filter((s) => s.etag !== etag).map((s) => s.instance)
  }
}

/** The environments a deployment lists, as the observed-version write needs them. */
export interface ListedEnv {
  id: number
  app_id: number
  version_pin: string | null
}

/**
 * A registered deployment upgraded outside the Hub: when every live sighting reports the same
 * version and it is not `version_pin`, records it — one `observed` shared deploy, one `shared`
 * deploy row per listed environment, and the new pin on the deployment and those environments.
 * Answers the version recorded, else null. Docker deployments are deployed by the Hub, never
 * observed. Errors are thrown (the caller logs them without values).
 */
export async function noteObservedVersion(
  shared: SharedDeployment,
  envs: ListedEnv[]
): Promise<string | null> {
  if (shared.mode !== 'registered' || shared.status === 'retired') return null
  // A Hub upgrade through GitLab is running (status `upgrading`): its own run records the version
  // when it ends, so the replicas it rolls are not an outside upgrade.
  if (shared.status === 'upgrading') return null
  const live = await liveSightings(shared.id)
  if (!live.length) return null
  const version = live[0].version
  if (!version || live.some((s) => s.version !== version)) return null
  if (version === shared.version_pin) return null
  // One attempt per (deployment, version) at a time across Hub processes; the compare-and-set
  // below makes it once per change.
  if (!(await store().set(observeKey(shared.id, version), '1', 'PX', OBSERVE_GUARD_MS, 'NX')))
    return null

  const from = shared.version_pin
  const at = new Date(deps.now())
  return db.transaction(async (trx) => {
    const q = trx(SHARED).where({ id: shared.id }).whereNot({ status: 'upgrading' })
    if (from === null) q.whereNull('version_pin')
    else q.where({ version_pin: from })
    const changed = await q.update({ version_pin: version, updated_at: at })
    if (Number(changed) !== 1) return null
    const id = await insertReturningId(trx, SHARED_DEPLOYS, {
      shared_deployment_id: shared.id,
      kind: 'observed',
      version,
      from_version: from,
      status: 'success',
      started_at: at,
      finished_at: at
    })
    const sharedDeployId = id == null ? null : Number(id)
    for (const env of envs) {
      await trx(DEPLOYS).insert({
        app_id: env.app_id,
        environment_id: env.id,
        kind: 'shared',
        version,
        from_version: env.version_pin,
        status: 'success',
        shared_deploy_id: sharedDeployId,
        started_at: at,
        finished_at: at
      })
      await trx(ENVS).where({ id: env.id }).update({ version_pin: version, updated_at: at })
    }
    return version
  })
}

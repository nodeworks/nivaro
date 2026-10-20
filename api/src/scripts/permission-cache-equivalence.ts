/**
 * Compiled permission cache (#2442) — equivalence + saving check. READ ONLY.
 *
 *   PERMISSION_CACHE_CHECK_REDIS=redis://localhost:6379/11 \
 *     pnpm --filter @nivaro/api run permission-cache:check [--collections 12] [--execute 40]
 *
 * For every active user × a set of collections (all of them for one user per
 * role) × read/create/update/delete it asks can(), getAllowedFields(),
 * getRowFilter() and the User Scope enforcement three times — cache off, cache
 * on (cold) and cache on (warm) — and compiles the read query each answer
 * produces (row filter + scopes → SQL + bindings). Every answer must be
 * identical. Users are visited collection-major, so thousands of people's
 * entries sit in the cache together (a key collision would show here). A
 * sample of compiled reads is also executed (TOP 20 ids) both ways.
 *
 * Uncached answers for can / fields / row filter depend only on the role (the
 * functions read nothing else from the user), so they are computed once per
 * role and compared against every user of that role; scope enforcement is
 * computed per user. Writes nothing to the database; Redis writes stay in the
 * db index named by PERMISSION_CACHE_CHECK_REDIS (only version reads).
 */
import { Redis } from 'ioredis'
import { _staticDb, db } from '../db/index.js'
import { metadataQueryCacheStats } from '../db/metadata-query-cache.js'
import {
  bodyTouchesAccess,
  notePermissionStatement,
  notePrincipalKind,
  permissionCacheStats,
  setPermissionCacheEnabled,
  setPermissionCacheProcLookup,
  setPermissionCacheRedis
} from '../services/permission-cache.js'
import {
  type Action,
  applyRowFilter,
  can,
  getAllowedFields,
  getRowFilter
} from '../services/permissions.js'
import { applyScopeEnforcement, getUserScopeEnforcement } from '../services/user-scopes.js'
import type { User } from '../types.js'

const ACTIONS: Action[] = ['read', 'create', 'update', 'delete']
const SYSTEM = ['nivaro_users', 'nivaro_policies', 'nivaro_roles', 'directus_users']

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) || fallback : fallback
}

interface Answer {
  can: boolean
  fields: string[] | null
  filter: unknown
}

let sent = 0
const client = (_staticDb as unknown as { client: { on: (e: string, f: () => void) => void } })
  .client
client.on('query', () => {
  sent++
})
/** Statements that reached the database (the driver-seam config cache answers some itself). */
function roundTrips(): number {
  const m = metadataQueryCacheStats()
  return sent - Number(m.hits ?? 0) - Number(m.shared ?? 0)
}

async function roleAnswers(user: User, collection: string): Promise<Record<Action, Answer>> {
  const out = {} as Record<Action, Answer>
  for (const action of ACTIONS) {
    const [c, f, r] = await Promise.all([
      can(user, action, collection),
      getAllowedFields(user, action, collection),
      getRowFilter(user, action, collection)
    ])
    out[action] = { can: c, fields: f, filter: r }
  }
  return out
}

async function compiledRead(user: User, collection: string): Promise<string> {
  const filter = await getRowFilter(user, 'read', collection)
  const scope = await getUserScopeEnforcement(user, collection)
  const q = db(collection).select(`${collection}.id`)
  if (filter) applyRowFilter(q, filter, user)
  applyScopeEnforcement(q, collection, scope)
  const native = q.toSQL().toNative()
  return JSON.stringify({ sql: native.sql, bindings: native.bindings, deny: scope.deny })
}

/** Run `fn` over `items` with `n` in flight (the shared DB answers each read in ~20 ms). */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) await fn(items[next++])
    })
  )
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function main() {
  const redisUrl = process.env.PERMISSION_CACHE_CHECK_REDIS
  if (!redisUrl) throw new Error('Set PERMISSION_CACHE_CHECK_REDIS (a Redis db index of its own)')
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  await redis.connect()
  setPermissionCacheRedis(redis)

  const sampleSize = arg('collections', 12)
  const executeSample = arg('execute', 40)
  const concurrency = arg('concurrency', 6)
  const users = (await db('nivaro_users')
    .where({ status: 'active' })
    .whereNotNull('role')
    .select('*')) as User[]
  const allCollections = (
    (await db('nivaro_collections').select('collection')) as Array<{ collection: string }>
  )
    .map((r) => r.collection)
    .filter((c) => !c.startsWith('nivaro_') && !c.startsWith('directus_'))
  const tables = new Set(
    (
      (await db('information_schema.tables').select('table_name')) as Array<{ table_name: string }>
    ).map((r) => r.table_name.toLowerCase())
  )
  const sample = allCollections
    .filter((c) => tables.has(c.toLowerCase()))
    .sort()
    .filter((_c, i, arr) => i % Math.max(1, Math.floor(arr.length / sampleSize)) === 0)
    .slice(0, sampleSize)
  const roles = [...new Set(users.map((u) => String(u.role)))]
  const fullPerRole = new Set(roles.map((r) => String(users.find((u) => String(u.role) === r)?.id)))
  console.log(
    `${users.length} active users, ${roles.length} roles, ${allCollections.length} collections (${sample.length} sampled for everyone, all for one user per role)`
  )

  if (process.argv.includes('--mixed-only')) {
    await mixedLoadProbe(users, sample)
    await redis.quit()
    await db.destroy()
    process.exit(0)
  }

  // ── 1. uncached reference answers ──────────────────────────────────────────
  setPermissionCacheEnabled(false)
  const refRole = new Map<string, Record<Action, Answer>>()
  const refRead = new Map<string, string>()
  const collectionsFor = (u: User) =>
    fullPerRole.has(String(u.id)) ? [...allCollections, ...SYSTEM] : [...sample, ...SYSTEM]
  const t0 = performance.now()
  let s0 = roundTrips()
  let offCalls = 0
  const rolePairs = roles.flatMap((role) =>
    [...allCollections, ...SYSTEM].map((c) => [role, c] as const)
  )
  await pool(rolePairs, concurrency, async ([role, c]) => {
    const u = users.find((x) => String(x.role) === role) as User
    refRole.set(`${role}|${c}`, await roleAnswers({ ...u }, c))
    offCalls++
  })
  const offRoleMs = performance.now() - t0
  const offRoleStatements = roundTrips() - s0
  s0 = roundTrips()
  await pool(users, concurrency, async (u) => {
    for (const c of collectionsFor(u)) refRead.set(`${u.id}|${c}`, await compiledRead({ ...u }, c))
  })
  console.log(`uncached reads compiled for every person (${refRead.size})`)
  console.log(
    `uncached: ${offCalls} role×collection sets (${offCalls * 12} answers) in ${offRoleMs.toFixed(0)} ms, ${offRoleStatements} round trips (${(offRoleStatements / offCalls).toFixed(1)} per collection × 4 actions)`
  )

  // ── 2. cached: cold then warm, collection-major ────────────────────────────
  setPermissionCacheEnabled(true)
  let compared = 0
  let mismatches = 0
  const report = (what: string, u: User, c: string, want: unknown, got: unknown) => {
    mismatches++
    if (mismatches <= 20)
      console.log(`MISMATCH ${what} user=${u.id} role=${u.role} ${c}`, { want, got })
  }
  // Cold then warm per collection, back to back: the warm pass lands inside the TTL, and a
  // collection's entries for every person fit in the cache at once.
  const passStatements = [0, 0]
  const passMs = [0, 0]
  const everyCollection = [...allCollections, ...SYSTEM]
  for (const c of everyCollection) {
    const who = users.filter((base) => collectionsFor(base).includes(c))
    for (const [i, pass] of ['cold', 'warm'].entries()) {
      const start = performance.now()
      const st = roundTrips()
      await pool(who, concurrency, async (base) => {
        // A fresh user object per "request", tagged like authenticate does.
        const u = { ...base } as User
        notePrincipalKind(u, 'session::::')
        const want = refRole.get(`${base.role}|${c}`) as Record<Action, Answer>
        const got = await roleAnswers(u, c)
        for (const a of ACTIONS) {
          compared += 3
          if (!same(want[a], got[a])) report(`${pass} ${a}`, base, c, want[a], got[a])
        }
        const read = await compiledRead(u, c)
        compared++
        if (read !== refRead.get(`${base.id}|${c}`))
          report(`${pass} compiled read`, base, c, refRead.get(`${base.id}|${c}`), read)
      })
      passMs[i] += performance.now() - start
      passStatements[i] += roundTrips() - st
    }
    if (who.length > 10) console.log(`  ${c}: ${who.length} people`)
  }
  console.log(
    `cached: cold ${passMs[0].toFixed(0)} ms / ${passStatements[0]} round trips, warm ${passMs[1].toFixed(0)} ms / ${passStatements[1]} round trips`,
    permissionCacheStats()
  )

  // ── 3. key separation: API-key restrictions + View-as kinds ─────────────────
  const scoped = (await db('nivaro_user_scopes')
    .where({ mode: 'restrict' })
    .select('dimension', 'values')
    .limit(1)) as Array<{ dimension: string; values: string }>
  if (scoped[0]) {
    const restriction = [
      { dimension: scoped[0].dimension, values: JSON.parse(scoped[0].values ?? '[]') }
    ]
    for (const base of users.slice(0, 50)) {
      for (const c of sample) {
        setPermissionCacheEnabled(false)
        const keyUser = { ...base, api_key_scope_restrictions: restriction } as User
        const want = await compiledRead(keyUser, c)
        setPermissionCacheEnabled(true)
        for (const kind of ['api_key:1::::', 'masquerade::admin::', 'oauth:::client:grant']) {
          const u = { ...base, api_key_scope_restrictions: restriction } as User
          notePrincipalKind(u, kind)
          compared++
          const got = await compiledRead(u, c)
          if (got !== want) report(`key-restricted ${kind}`, base, c, want, got)
          // and the same person without the key restriction still gets their own answer
          const plain = { ...base } as User
          compared++
          if ((await compiledRead(plain, c)) !== refRead.get(`${base.id}|${c}`))
            report('plain after key-restricted', base, c, refRead.get(`${base.id}|${c}`), '')
        }
      }
    }
  }

  // ── 4. executed sample: the compiled reads return the same ids ────────────
  let executed = 0
  const pairs: Array<[User, string]> = []
  for (const u of users) {
    for (const c of sample) {
      const r = refRead.get(`${u.id}|${c}`) ?? ''
      if (r.includes('exists') || r.includes('in (') || r.includes('=')) pairs.push([u, c])
    }
  }
  const step = Math.max(1, Math.floor(pairs.length / Math.max(1, executeSample)))
  for (let i = 0; i < pairs.length && executed < executeSample; i += step) {
    const [base, c] = pairs[i]
    const run = async (on: boolean) => {
      setPermissionCacheEnabled(on)
      const u = { ...base } as User
      const filter = await getRowFilter(u, 'read', c)
      const scope = await getUserScopeEnforcement(u, c)
      const q = db(c).select(`${c}.id`).orderBy(`${c}.id`).limit(20)
      if (filter) applyRowFilter(q, filter, u)
      applyScopeEnforcement(q, c, scope)
      return JSON.stringify(await q)
    }
    const off = await run(false)
    const on = await run(true)
    compared++
    executed++
    if (off !== on) report('executed', base, c, off.slice(0, 200), on.slice(0, 200))
  }

  // ── 5. per-request saving: one list read's permission work ─────────────────
  const probeUsers = users.slice(0, 200)
  const probe = async (on: boolean) => {
    setPermissionCacheEnabled(on)
    // warm the cache first when on (a person's second request onwards)
    const c = sample[0]
    if (on) for (const base of probeUsers) await listReadWork({ ...base } as User, c)
    const st = roundTrips()
    const start = performance.now()
    for (const base of probeUsers) await listReadWork({ ...base } as User, c)
    return {
      ms_per_read: (performance.now() - start) / probeUsers.length,
      round_trips_per_read: (roundTrips() - st) / probeUsers.length
    }
  }
  const off = await probe(false)
  const on = await probe(true)
  console.log('one list read (can + fields + row filter + scopes):', { off, on_warm: on })

  await mixedLoadProbe(users, sample)

  console.log(
    `\nRESULT: ${compared} comparisons, ${mismatches} mismatches, ${executed} executed reads; cold ${passStatements[0]} / warm ${passStatements[1]} round trips`
  )
  await redis.quit()
  await db.destroy()
  process.exit(mismatches === 0 ? 0 : 1)
}

/**
 * Warm under mixed load: report-procedure EXECs between item reads. The statements are only
 * CLASSIFIED (bodies read with OBJECT_DEFINITION), never run. Procedures whose body may
 * touch access inputs are counted and left out of the mix: running one must move the version.
 */
async function mixedLoadProbe(users: User[], sample: string[]): Promise<void> {
  setPermissionCacheEnabled(true)
  const body = async (name: string) => {
    const rows = (await db.raw('SELECT OBJECT_DEFINITION(OBJECT_ID(?)) AS body', [name])) as Array<{
      body: string | null
    }>
    return rows?.[0]?.body ?? null
  }
  setPermissionCacheProcLookup(body)
  const all = (
    (await db.raw(
      "SELECT s.name + '.' + p.name AS name FROM sys.procedures p JOIN sys.schemas s ON s.schema_id = p.schema_id ORDER BY p.name"
    )) as Array<{ name: string }>
  ).map((r) => r.name)
  const reports: string[] = []
  let touching = 0
  for (const name of all) {
    if (bodyTouchesAccess(await body(name))) touching++
    else if (reports.length < 40) reports.push(name)
  }
  const mixUsers = users.slice(0, 100)
  const mixStatements = reports.map((n) => `INSERT INTO #rows EXEC ${n} @p0, @p1`)
  // First look at every procedure (unknown = may change access, once each).
  for (const sql of mixStatements) notePermissionStatement(sql, false)
  await new Promise((r) => setTimeout(r, 3_000))
  // Warm the people's entries, then measure.
  for (const [i, base] of mixUsers.entries())
    await listReadWork({ ...base } as User, sample[i % sample.length])
  const before = permissionCacheStats()
  let flagged = 0
  let sentRoundTrips = roundTrips()
  const mixStart = performance.now()
  for (let round = 0; round < 5; round++) {
    for (const [i, base] of mixUsers.entries()) {
      const sql = mixStatements[i % mixStatements.length]
      if (notePermissionStatement(sql, false)) flagged++
      notePermissionStatement(sql, true)
      await listReadWork({ ...base } as User, sample[i % sample.length])
    }
  }
  sentRoundTrips = roundTrips() - sentRoundTrips
  const after = permissionCacheStats()
  const delta = (k: string) => Number(after[k]) - Number(before[k])
  console.log('warm under mixed load (5 rounds × 100 people, one report EXEC per item read):', {
    procedures: all.length,
    may_touch_access: touching,
    report_procedures_in_mix: reports.length,
    statements_that_bumped: flagged,
    resets: delta('resets'),
    bumps: delta('bumps'),
    hits: delta('hits'),
    misses: delta('misses'),
    round_trips: sentRoundTrips,
    ms: Math.round(performance.now() - mixStart)
  })
}

/** What items.ts readByQuery asks per list read (plus the expanded relations ask again). */
async function listReadWork(user: User, collection: string): Promise<void> {
  await Promise.all([
    can(user, 'read', collection),
    getAllowedFields(user, 'read', collection),
    getRowFilter(user, 'read', collection)
  ])
  await getUserScopeEnforcement(user, collection)
}

void main().catch(async (err) => {
  console.error(err)
  await db.destroy().catch(() => {})
  process.exit(2)
})

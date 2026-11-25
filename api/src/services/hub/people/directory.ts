import { db } from '../../../db/index.js'

/**
 * Nivaro Hub people directory: who the Hub has seen sign in where (nivaro_hub_signins, the
 * switcher's own table), grouped per person. Nothing here asks an app anything; the live
 * per-app lookup is services/hub/people/access.ts.
 *
 * A person is
 *   u:<HUB USER ID>   every row the Hub tied to one Hub account (hub_user_id), plus rows under
 *                     an identity key (or the email) one of those rows carries
 *   k:<row id>        an identity key no Hub account owns (app reports of people who never
 *                     signed in through the Hub); <row id> = the lowest sign-in row id with it
 * The key is opaque: emails never travel in a URL.
 *
 * Built from the newest DIRECTORY_SCAN rows (sign-ins older than 180 days are pruned anyway).
 */

const SIGNINS = 'nivaro_hub_signins'
export const DIRECTORY_SCAN = 20_000
const MAX_IDS = 5

export interface DirectoryEnvironment {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  via: 'hub' | 'direct'
  last_seen: string | null
}

export interface DirectoryPerson {
  key: string
  name: string | null
  email: string | null
  hub_user_id: string | null
  last_seen: string | null
  environments: DirectoryEnvironment[]
}

export interface PersonIdentity {
  emails: string[]
  entra: Array<{ oid: string; tid: string | null }>
}

interface SigninRow {
  id: number
  identity_key: string
  hub_user_id: string | null
  email: string | null
  environment_id: number
  app_id: number
  via: string
  last_seen: unknown
  env_key: string | null
  app_key: string | null
  app_name: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const upper = (v: unknown) => String(v).toUpperCase()

async function readRows(where?: (q: ReturnType<typeof db>) => void): Promise<SigninRow[]> {
  const q = db(`${SIGNINS} as s`)
    .leftJoin('nivaro_hub_environments as e', 'e.id', 's.environment_id')
    .leftJoin('nivaro_hub_apps as a', 'a.id', 's.app_id')
    .select(
      's.id',
      's.identity_key',
      's.hub_user_id',
      's.email',
      's.environment_id',
      's.app_id',
      's.via',
      's.last_seen',
      'e.key as env_key',
      'a.key as app_key',
      'a.name as app_name'
    )
    .orderBy('s.id', 'desc')
    .limit(DIRECTORY_SCAN)
  if (where) where(q as unknown as ReturnType<typeof db>)
  return (await q) as SigninRow[]
}

/** Groups rows into people (see the header). Pure. */
export function groupPeople(rows: SigninRow[]): Map<string, SigninRow[]> {
  const keyOwner = new Map<string, string>()
  const claim = (key: string, owner: string) => {
    const had = keyOwner.get(key)
    // A key two accounts carry belongs to neither (emails are not unique).
    keyOwner.set(key, had !== undefined && had !== owner ? '' : owner)
  }
  for (const r of rows) {
    if (!r.hub_user_id) continue
    const owner = upper(r.hub_user_id)
    claim(r.identity_key, owner)
    // The email a Hub row recorded (an Entra-keyed row carries it too) is that account's.
    if (r.email) claim(`email:${String(r.email).trim().toLowerCase()}`, owner)
  }
  const firstRow = new Map<string, number>()
  for (const r of rows) {
    const id = Number(r.id)
    const had = firstRow.get(r.identity_key)
    if (had === undefined || id < had) firstRow.set(r.identity_key, id)
  }
  const groups = new Map<string, SigninRow[]>()
  for (const r of rows) {
    const owner = r.hub_user_id ? upper(r.hub_user_id) : keyOwner.get(r.identity_key) || null
    const key = owner ? `u:${owner}` : `k:${firstRow.get(r.identity_key)}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  return groups
}

interface HubUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  entra_oid?: string | null
  entra_tid?: string | null
}

async function hubUsers(ids: string[]): Promise<Map<string, HubUser>> {
  const out = new Map<string, HubUser>()
  if (!ids.length) return out
  const hasEntra = await db.schema.hasColumn('nivaro_users', 'entra_oid')
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db('nivaro_users')
      .whereIn('id', ids.slice(i, i + 500))
      .select(
        'id',
        'first_name',
        'last_name',
        'email',
        ...(hasEntra ? ['entra_oid', 'entra_tid'] : [])
      )) as HubUser[]
    for (const u of rows) out.set(upper(u.id), u)
  }
  return out
}

function emailOfKey(key: string): string | null {
  return key.startsWith('email:') ? key.slice('email:'.length) : null
}

function personOf(key: string, rows: SigninRow[], user: HubUser | undefined): DirectoryPerson {
  const envs = new Map<number, DirectoryEnvironment>()
  let last: string | null = null
  for (const r of rows) {
    const seen = iso(r.last_seen)
    if (seen && (!last || seen > last)) last = seen
    const id = Number(r.environment_id)
    const had = envs.get(id)
    const via = r.via === 'hub' ? 'hub' : 'direct'
    if (!had) {
      envs.set(id, {
        environment_id: id,
        app_id: Number(r.app_id),
        app_key: String(r.app_key ?? ''),
        app_name: String(r.app_name ?? r.app_key ?? ''),
        environment_key: String(r.env_key ?? ''),
        via,
        last_seen: seen
      })
    } else {
      if (seen && (!had.last_seen || seen > had.last_seen)) had.last_seen = seen
      if (via === 'hub') had.via = 'hub'
    }
  }
  const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ').trim() : ''
  const email =
    user?.email?.trim().toLowerCase() ||
    rows.map((r) => r.email || emailOfKey(r.identity_key)).find(Boolean) ||
    null
  return {
    key,
    name: name || null,
    email,
    hub_user_id: user ? String(user.id) : key.startsWith('u:') ? key.slice(2) : null,
    last_seen: last,
    environments: [...envs.values()].sort(
      (a, b) =>
        a.app_name.localeCompare(b.app_name) || a.environment_key.localeCompare(b.environment_key)
    )
  }
}

/** The directory, newest sign-in first, filtered by name / email (case-insensitive). */
export async function listPeople(
  opts: { q?: string; limit?: number; offset?: number } = {}
): Promise<{ data: DirectoryPerson[]; total: number }> {
  const rows = await readRows()
  const groups = groupPeople(rows)
  const users = await hubUsers(
    [...groups.keys()].filter((k) => k.startsWith('u:')).map((k) => k.slice(2))
  )
  const q = (opts.q ?? '').trim().toLowerCase()
  const people = [...groups.entries()]
    .map(([key, list]) => personOf(key, list, users.get(key.slice(2))))
    .filter(
      (p) =>
        !q ||
        (p.email ?? '').includes(q) ||
        (p.name ?? '').toLowerCase().includes(q) ||
        p.environments.some((e) => e.app_name.toLowerCase().includes(q))
    )
    .sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''))
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  const offset = Math.max(0, opts.offset ?? 0)
  return { data: people.slice(offset, offset + limit), total: people.length }
}

const KEY_RE = /^(u:[0-9A-Fa-f-]{36}|k:\d{1,15})$/

export function isPersonKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v)
}

/**
 * One person by key with what every app is asked about them, or null (no such person). A Hub
 * account without any sign-in row is a person too (`u:` key, no environments).
 */
export async function readPerson(
  key: string
): Promise<{ person: DirectoryPerson; identity: PersonIdentity } | null> {
  if (!isPersonKey(key)) return null
  let rows: SigninRow[]
  let user: HubUser | undefined
  if (key.startsWith('u:')) {
    const id = key.slice(2)
    user = (await hubUsers([id])).get(upper(id))
    const own = await readRows((q) => q.where('s.hub_user_id', id))
    const keys = [
      ...new Set([
        ...own.map((r) => r.identity_key),
        ...own.filter((r) => r.email).map((r) => `email:${String(r.email).trim().toLowerCase()}`)
      ])
    ]
    const shared = keys.length
      ? await readRows((q) => q.whereIn('s.identity_key', keys).whereNull('s.hub_user_id'))
      : []
    rows = [...own, ...shared]
    if (!rows.length && !user) return null
  } else {
    const first = (await db(SIGNINS)
      .where({ id: Number(key.slice(2)) })
      .first('identity_key', 'hub_user_id')) as
      | { identity_key: string; hub_user_id: string | null }
      | undefined
    if (!first) return null
    if (first.hub_user_id) return readPerson(`u:${upper(first.hub_user_id)}`)
    rows = await readRows((q) => q.where('s.identity_key', first.identity_key))
    // The key may belong to an account through another row; then that account is the person.
    const owned = rows.find((r) => r.hub_user_id)
    if (owned) return readPerson(`u:${upper(owned.hub_user_id)}`)
  }
  const person = personOf(key, rows, user)
  return { person, identity: identityOf(rows, user) }
}

/** The emails and Entra ids every app is asked about (at most 5 of each). Pure. */
export function identityOf(rows: SigninRow[], user?: HubUser): PersonIdentity {
  const emails: string[] = []
  const entra: PersonIdentity['entra'] = []
  const addEmail = (e: unknown) => {
    if (typeof e !== 'string') return
    const s = e.trim().toLowerCase()
    if (s && !emails.includes(s) && emails.length < MAX_IDS) emails.push(s)
  }
  const addEntra = (oid: unknown, tid: unknown) => {
    if (typeof oid !== 'string' || !oid) return
    const o = oid.toLowerCase()
    if (entra.some((x) => x.oid === o) || entra.length >= MAX_IDS) return
    entra.push({ oid: o, tid: typeof tid === 'string' && tid ? tid.toLowerCase() : null })
  }
  if (user) {
    addEntra(user.entra_oid, user.entra_tid)
    addEmail(user.email)
  }
  for (const r of rows) {
    const k = r.identity_key
    if (k.startsWith('entra:')) {
      const [, tid, oid] = k.split(':')
      addEntra(oid, tid)
    } else addEmail(emailOfKey(k))
    addEmail(r.email)
  }
  return { emails, entra }
}

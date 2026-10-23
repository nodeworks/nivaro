#!/usr/bin/env node
// Seed the realtime CI stack THROUGH THE API, signed in as the bootstrap administrator rtci.sh
// inserted. Idempotent: run it again and it reuses what exists. Writes ids + tokens to
// deploy/realtime-ci/.state/seed.json for the suites.
//
//   node tests/realtime/seed.mjs [--load-users 250]
//
// What it makes (inside the stack's own database only):
//   collections rt_items (members read/write), rt_secret (admins only)
//   roles RTCI Member (rt_items read/create/update), RTCI Reader (rt_items read)
//   users admin2 (admin), alice + bob (members), carol (reader), dave (no role), each with a
//         static token; --load-users N adds load-0001… members for the load suite
//   API keys: alice's read-only key on rt_items, and one to revoke in the auth suite
//   rows: a handful of rt_items and one rt_secret
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cfg, stateDir } from './lib/config.mjs'
import { adminClient, waitHttp } from './lib/http.mjs'

const argv = process.argv.slice(2)
const loadUsers = Number(argv[argv.indexOf('--load-users') + 1] || 0) * (argv.includes('--load-users') ? 1 : 0)
const seedFile = resolve(stateDir, 'seed.json')
const prior = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : {}

await waitHttp(`${cfg.base}/api/ready`, { timeoutMs: 300_000 })
const admin = adminClient()

async function ensureTable(name, columns) {
  const made = await admin.post('/api/data-model/tables', { name })
  if (!made.ok && made.status !== 409) throw new Error(`table ${name}: ${made.status} ${made.text}`)
  for (const c of columns) {
    const r = await admin.post(`/api/data-model/tables/${name}/columns`, c)
    if (!r.ok && r.status !== 409 && !/exist/i.test(r.text)) throw new Error(`column ${name}.${c.name}: ${r.text}`)
  }
  await admin.must('POST', `/api/data-model/tables/${name}/register`, { display_name: name })
  const fields = (await admin.get(`/api/collections/${name}/fields`)).json?.data ?? []
  const have = new Set(fields.map((f) => f.field))
  for (const [i, c] of [{ name: 'id', type: 'integer' }, ...columns].entries()) {
    if (have.has(c.name)) continue
    const r = await admin.post(`/api/data-model/tables/${name}/fields`, {
      field: c.name,
      type: c.type,
      sort: i,
      ...(c.name === 'id' ? { readonly: true, hidden: false } : {})
    })
    if (!r.ok && !/exist/i.test(r.text)) throw new Error(`field ${name}.${c.name}: ${r.text}`)
  }
}

async function ensureRole(name, policies) {
  const roles = (await admin.must('GET', '/api/roles')) ?? []
  let role = roles.find((r) => r.name === name)
  if (!role) role = await admin.must('POST', '/api/roles', { name, admin_access: false, app_access: true })
  const have = (await admin.must('GET', `/api/roles/${role.id}/policies`)) ?? []
  for (const p of policies) {
    if (have.some((h) => h.collection === p.collection && h.action === p.action)) continue
    await admin.must('POST', `/api/roles/${role.id}/policies`, { ...p, fields: ['*'] })
  }
  return role
}

async function ensureUser(key, email, roleId, names = {}) {
  const users = prior.users?.[key]
  let user = users ? (await admin.get(`/api/users/${users.id}`)).json?.data : null
  if (!user) {
    const list = (await admin.get(`/api/users?filter[email][_eq]=${encodeURIComponent(email)}`)).json?.data ?? []
    user = list.find((u) => u.email === email)
  }
  if (!user)
    user = await admin.must('POST', '/api/users', {
      email,
      first_name: names.first ?? key,
      last_name: names.last ?? 'RTCI',
      role: roleId
    })
  const token = users?.token ?? (await admin.must('POST', `/api/users/${user.id}/token`)).token
  return { id: user.id, email, token, role: roleId }
}

const t0 = Date.now()
await ensureTable('rt_items', [
  { name: 'title', type: 'string', nullable: true },
  { name: 'status', type: 'string', nullable: true },
  { name: 'n', type: 'integer', nullable: true }
])
await ensureTable('rt_secret', [{ name: 'title', type: 'string', nullable: true }])

// user_presence is a legacy table (deploy/realtime-ci/legacy-tables.sql): registered as a
// collection like EFP has it, so the typing indicator's PATCH works.
await admin.must('POST', '/api/data-model/tables/user_presence/register', { display_name: 'User presence' })
{
  const have = new Set(((await admin.get('/api/collections/user_presence/fields')).json?.data ?? []).map((f) => f.field))
  const cols = [['id', 'integer'], ['user_id', 'string'], ['last_seen', 'timestamp'], ['display_name', 'string'], ['current_path', 'string'], ['typing_room', 'string'], ['is_idle', 'boolean'], ['last_active', 'timestamp'], ['is_online', 'boolean'], ['app', 'string']]
  for (const [i, [field, type]] of cols.entries())
    if (!have.has(field)) await admin.post('/api/data-model/tables/user_presence/fields', { field, type, sort: i })
}

const adminRole = (await admin.must('GET', '/api/roles')).find((r) => r.name === 'RTCI Admin')
const member = await ensureRole('RTCI Member', [
  { collection: 'rt_items', action: 'read' },
  { collection: 'rt_items', action: 'create' },
  { collection: 'rt_items', action: 'update' },
  { collection: 'user_presence', action: 'read' },
  { collection: 'user_presence', action: 'update' }
])
const reader = await ensureRole('RTCI Reader', [{ collection: 'rt_items', action: 'read' }])

const me = (await admin.must('GET', '/api/users/me')) ?? {}
const users = {
  admin: { id: me.id, email: me.email, token: cfg.adminToken, role: adminRole?.id },
  admin2: await ensureUser('admin2', 'rtci-admin2@example.test', adminRole?.id, { first: 'Second', last: 'Admin' }),
  alice: await ensureUser('alice', 'rtci-alice@example.test', member.id, { first: 'Alice' }),
  bob: await ensureUser('bob', 'rtci-bob@example.test', member.id, { first: 'Bob' }),
  carol: await ensureUser('carol', 'rtci-carol@example.test', reader.id, { first: 'Carol' }),
  dave: await ensureUser('dave', 'rtci-dave@example.test', null, { first: 'Dave' })
}

const load = [...(prior.load ?? [])]
for (let i = load.length; i < loadUsers; i++) {
  const n = String(i + 1).padStart(4, '0')
  load.push(await ensureUser(`load-${n}`, `rtci-load-${n}@example.test`, member.id, { first: `Load${n}` }))
  if ((i + 1) % 50 === 0) console.log(`seed: ${i + 1}/${loadUsers} load users`)
}

async function ensureKey(name, userId, scopes) {
  const have = prior.keys?.[name]
  if (have) return have
  const k = await admin.must('POST', '/api/api-keys', { name, user: userId, scopes })
  return { id: k.id, key: k.key, user: userId }
}
const keys = {
  aliceRead: await ensureKey('rtci alice read', users.alice.id, [{ collection: 'rt_items', actions: ['read'] }]),
  aliceRevoke: await ensureKey('rtci alice revoke-me', users.alice.id, [{ collection: '*', actions: ['*'] }])
}

const items = prior.items ?? []
while (items.length < 5) {
  const row = await admin.must('POST', '/api/items/rt_items', { title: `seed ${items.length + 1}`, status: 'open', n: 0 })
  items.push(row.id)
}
const secret = prior.secret ?? (await admin.must('POST', '/api/items/rt_secret', { title: 'top secret' })).id

mkdirSync(stateDir, { recursive: true })
const seed = {
  seeded_at: new Date().toISOString(),
  mode: cfg.mode,
  roles: { admin: adminRole?.id, member: member.id, reader: reader.id },
  users,
  load,
  keys,
  items,
  secret
}
writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`)
console.log(
  `seed: ${Object.keys(users).length} users + ${load.length} load users, ${items.length} rt_items, keys ${Object.keys(keys).join('/')} in ${Math.round((Date.now() - t0) / 1000)} s → ${seedFile}`
)

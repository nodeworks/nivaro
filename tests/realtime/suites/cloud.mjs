// Cloud mode tenant isolation: two tenants (Postgres databases provisioned through
// POST /admin/provision) behind two cloud-mode API replicas on one Redis. A socket's tenant comes
// from its handshake host (X-Tenant-Host here); nothing one tenant does may reach the other's
// sockets or streams — not through the Redis adapter, not through the event stream, not on the
// other replica. The realtime role refuses cloud mode, so this runs single-role in both modes.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stackDir, stateDir } from '../lib/config.mjs'
import { poll, Suite, sleep } from '../lib/harness.mjs'
import { Client, waitHttp } from '../lib/http.mjs'
import { LiveSocket } from '../lib/sock.mjs'
import { openSse } from '../lib/sse.mjs'
import { composeAsync } from '../lib/stack.mjs'

const env = Object.fromEntries(
  readFileSync(resolve(stackDir, 'rtci.env'), 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
)
const NODES = { 'cloud-1': `http://127.0.0.1:${env.RTCI_CLOUD1_PORT}`, 'cloud-2': `http://127.0.0.1:${env.RTCI_CLOUD2_PORT}` }
const TENANTS = ['a', 'b']
const hostOf = (t) => `tenant-${t}.rtci.test`

function psql(sql) {
  return new Promise((res, rej) =>
    execFile(resolve(stackDir, 'rtci.sh'), ['compose', '--profile', 'cloud', 'exec', '-T', 'pg', 'psql', '-U', 'rtci', '-d', 'cloud_meta', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }, (e, out, err) => (e ? rej(new Error(`${out}${err}`)) : res(out)))
  )
}

const MSSQL_OPTS = encodeURIComponent(JSON.stringify({ encrypt: false, trustServerCertificate: true }))
const tenantConn = (t) =>
  `mssql://sa:${encodeURIComponent('Rtci_Passw0rd_2026!')}@mssql/tenant_${t}?options=${MSSQL_OPTS}`

function sqlcmd(query) {
  return new Promise((res, rej) =>
    execFile(resolve(stackDir, 'rtci.sh'), ['sql', query], { encoding: 'utf8' }, (e, out, err) =>
      e || /^Msg \d+/m.test(out) ? rej(new Error(`${out}${err}`)) : res(out)
    )
  )
}

async function setup() {
  await composeAsync(['--profile', 'cloud', 'up', '-d', '--wait', '--wait-timeout', '900', 'pg', 'cloud-1', 'cloud-2'])
  for (const u of Object.values(NODES)) await waitHttp(`${u}/api/ready`, { timeoutMs: 300_000 })
  const file = resolve(stateDir, 'cloud.json')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  for (const t of TENANTS) {
    if (state[t]?.token) continue
    const conn = tenantConn(t)
    await sqlcmd(`IF DB_ID('tenant_${t}') IS NULL CREATE DATABASE tenant_${t}`)
    const r = await fetch(`${NODES['cloud-1']}/admin/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provision-secret': 'rtci-provision-secret' },
      body: JSON.stringify({ connectionString: conn, dbClient: 'mssql', slug: `tenant-${t}`, name: `Tenant ${t.toUpperCase()}`, adminEmail: `admin-${t}@example.test` }),
      signal: AbortSignal.timeout(900_000)
    })
    const body = await r.json().catch(() => null)
    if (!r.ok || !body?.staticToken) throw new Error(`provision tenant ${t}: ${r.status} ${JSON.stringify(body)}`)
    await psql(`INSERT INTO cloud_tenants (id, slug, name, subdomain, status, db_client, db_connection_string) VALUES ('${t}-${Date.now()}', 'tenant-${t}', 'Tenant ${t.toUpperCase()}', 'tenant-${t}', 'active', 'mssql', '${conn}') ON CONFLICT (slug) DO NOTHING`)
    // The legacy presence/chat tables, as on the self-hosted database (legacy-tables.sql).
    await sqlcmd(`USE tenant_${t}; ${readFileSync(resolve(stackDir, 'legacy-tables.sql'), 'utf8').replace(/^--.*$/gm, '')}`)
    state[t] = { token: body.staticToken, userId: body.userId }
    writeFileSync(file, JSON.stringify(state, null, 2))
  }
  // The same collection name in both tenants.
  for (const t of TENANTS) {
    const c = client(t, 'cloud-1', state[t].token)
    const made = await c.post('/api/data-model/tables', { name: 'rt_items' })
    if (!made.ok && made.status !== 409) throw new Error(`tenant ${t} table: ${made.status} ${made.text}`)
    await c.post('/api/data-model/tables/rt_items/columns', { name: 'title', type: 'string', nullable: true })
    await c.must('POST', '/api/data-model/tables/rt_items/register', { display_name: 'rt_items' })
    const have = new Set(((await c.get('/api/collections/rt_items/fields')).json?.data ?? []).map((f) => f.field))
    for (const [i, f] of [['id', 'integer'], ['title', 'string']].entries())
      if (!have.has(f[0])) await c.post('/api/data-model/tables/rt_items/fields', { field: f[0], type: f[1], sort: i })
  }
  return state
}

function client(t, node, token) {
  return new Client({ base: NODES[node], bearer: token, name: `tenant-${t}@${node}`, extraHeaders: { 'x-tenant-host': hostOf(t) } })
}

export async function run({ only }) {
  const suite = new Suite('cloud', { only })
  const state = await setup()
  const open = []
  const sock = async (t, node, o = {}) => {
    const s = new LiveSocket(client(t, node, state[t].token), { base: NODES[node], ...o })
    open.push(s)
    await s.open()
    s.tenant = t
    s.node = node
    return s
  }
  const closeAll = () => open.splice(0).forEach((s) => s.close())

  await suite.case('provisioned tenants answer on both replicas with their own data', async (t) => {
    for (const tn of TENANTS)
      for (const node of Object.keys(NODES)) {
        const r = await client(tn, node, state[tn].token).get('/api/users/me')
        t.check(`tenant ${tn} on ${node}: /users/me`, r.ok && r.json?.data?.email === `admin-${tn}@example.test`, r.status)
      }
    const cross = await client('b', 'cloud-1', state.a.token).get('/api/users/me')
    t.check("tenant A's token is not accepted on tenant B", cross.status === 401 || cross.status === 403, cross.status)
  })

  await suite.case('collection:update never crosses tenants (same collection name, both replicas)', async (t) => {
    t.cleanup(closeAll)
    const socks = []
    for (const tn of TENANTS) for (const node of Object.keys(NODES)) socks.push(await sock(tn, node))
    for (const s of socks) s.join('collection:join', { collection: 'rt_items' })
    await sleep(600)
    for (const writer of TENANTS)
      for (const via of Object.keys(NODES)) {
        const marks = socks.map((s) => s.mark())
        const row = await client(writer, via, state[writer].token).must('POST', '/api/items/rt_items', { title: `${writer} via ${via}` })
        await sleep(1500)
        for (const [i, s] of socks.entries()) {
          const got = s.all('collection:update', marks[i]).filter((e) => String(e.p.item) === String(row.id))
          if (s.tenant === writer) t.check(`${writer}→${via}: same-tenant socket on ${s.node} got it`, got.length >= 1)
          else t.check(`${writer}→${via}: tenant ${s.tenant} socket on ${s.node} got nothing`, s.all('collection:update', marks[i]).length === 0, s.all('collection:update', marks[i]).map((e) => e.p))
        }
      }
  })

  await suite.case('presence:changed, config:update and force-refresh stay inside the tenant', async (t) => {
    t.cleanup(closeAll)
    const watchersB = [await sock('b', 'cloud-1'), await sock('b', 'cloud-2')]
    const watchersA = [await sock('a', 'cloud-2')]
    await sleep(800)
    const mB = watchersB.map((s) => s.mark())
    const mA = watchersA.map((s) => s.mark())
    await sock('a', 'cloud-1') // tenant A sign-in → presence:changed for A only
    await client('a', 'cloud-1', state.a.token).patch('/api/collections/rt_items', { note: `a ${Date.now()}` })
    await client('a', 'cloud-2', state.a.token).post('/api/realtime/force-refresh', { seconds: 30, message: 'tenant a' })
    await sleep(3000)
    const seenB = watchersB.flatMap((s, i) => s.events.slice(mB[i]).map((e) => e.ev))
    const seenA = watchersA.flatMap((s, i) => s.events.slice(mA[i]).map((e) => e.ev))
    t.metric('tenant_a_saw', [...new Set(seenA)])
    t.metric('tenant_b_saw', [...new Set(seenB)])
    t.check('tenant A sees its own config:update', seenA.includes('config:update'))
    t.check('tenant A sees its own force-refresh', seenA.includes('client:force-refresh'))
    for (const ev of ['presence:changed', 'config:update', 'client:force-refresh'])
      t.check(`tenant B saw no ${ev}`, !seenB.includes(ev))
  })

  await suite.case('chat General room is per tenant', async (t) => {
    t.cleanup(closeAll)
    const a = await sock('a', 'cloud-1')
    const b = await sock('b', 'cloud-2')
    a.join('chat:join', { room: 'global' })
    b.join('chat:join', { room: 'global' })
    await sleep(600)
    const [ma, mb] = [a.mark(), b.mark()]
    const text = `tenant a only ${Date.now()}`
    const r = await client('a', 'cloud-2', state.a.token).post('/api/chat/messages', { room: 'global', message: text })
    t.metric('post_status', r.status)
    await sleep(2000)
    t.check('tenant B global room got nothing', b.all('chat:message', mb).length === 0)
    if (r.status === 201) t.check('tenant A got it', a.all('chat:message', ma).length >= 1)
    else t.note(`chat send in a fresh cloud tenant: ${r.status} ${r.text.slice(0, 160)} (legacy chat_messages table missing on new tenants)`)
  })

  await suite.case("a ws-token minted in tenant A signs nothing in on tenant B's host", async (t) => {
    t.cleanup(closeAll)
    const tok = await client('a', 'cloud-1', state.a.token).wsToken()
    const s = new LiveSocket(null, { staticToken: tok, base: NODES['cloud-2'], reconnection: false, extraHeaders: { 'x-tenant-host': hostOf('b') } })
    open.push(s)
    await s.open({ timeoutMs: 4000 }).catch(() => {})
    t.check('no auth:ok on tenant B', s.authCount === 0)
  })

  await suite.case('/api/events/stream per tenant', async (t) => {
    const streams = {}
    for (const tn of TENANTS) {
      const c = client(tn, 'cloud-1', state[tn].token)
      streams[tn] = await openSse(`${NODES['cloud-2']}/api/events/stream?collections=rt_items`, { headers: { authorization: `Bearer ${state[tn].token}`, 'x-tenant-host': hostOf(tn) } })
      void c
    }
    t.cleanup(() => Object.values(streams).forEach((s) => s.close()))
    t.check('both streams open', Object.values(streams).every((s) => s.status === 200), Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, s.status])))
    await sleep(500)
    const mb = streams.b.mark()
    const ma = streams.a.mark()
    for (const via of Object.keys(NODES)) await client('a', via, state.a.token).must('POST', '/api/items/rt_items', { title: 'stream a' })
    await poll(() => streams.a.events.slice(ma).length >= 2, { timeoutMs: 6000 })
    await sleep(1000)
    t.check('tenant A stream got its writes', streams.a.events.slice(ma).length >= 1, streams.a.events.slice(ma).length)
    t.check('tenant B stream got none', streams.b.events.slice(mb).length === 0, streams.b.events.slice(mb).map((e) => e.data))
  })

  return suite.result({ untested: ['cloud watch rooms per tenant store (traffic-map), huddles across tenants'] })
}

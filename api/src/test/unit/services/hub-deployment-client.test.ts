import { describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 3: the Hub's client for a shared deployment's link
// (routes/hub-deployment-link.ts on the deployment). A fake fetch stands in for the deployment.
// The bearer is the HMAC of the deployment token (ruling R7), never the token; on a 401 inside
// the rotation grace the call is tried once more with the previous token's bearer. No redirect
// is followed, every call is bounded, and nothing the client throws or answers holds a token, a
// ticket or a database connection.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { deploymentClient, DeploymentLinkError, DEPLOYMENT_LINK_TIMEOUT_MS, linkedKeyFingerprint } =
  await import('../../../services/hub/shared/deployment-client.js')
const { deploymentLinkBearer } = await import('../../../services/hub/shared/store.js')

const TOKEN = 'current-Deployment-Token-0123456789-abcdefghijkl'
const PREV = 'previous-Deployment-Token-0123456789-abcdefghij'
const SHARED = { id: 3, key: 'shared-one', link_url: 'https://shared-one.internal.example.com' }
const CONN = 'postgres://acme:pw-Secret-Plain-77@db.internal:5432/acme_db'

type Call = { url: string; init: RequestInit }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function fakeFetch(answer: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return answer(call, calls.length)
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

function client(
  answer: Parameters<typeof fakeFetch>[0],
  opts: { previous?: string | null; current?: string | null; timeoutMs?: number } = {}
) {
  const f = fakeFetch(answer)
  const c = deploymentClient(SHARED, {
    fetch: f.fn,
    tokens: async () => ({
      current: opts.current === undefined ? TOKEN : opts.current,
      previous: opts.previous ?? null
    }),
    timeoutMs: opts.timeoutMs
  })
  return { c, calls: f.calls }
}

function header(call: Call, name: string): string | null {
  const h = new Headers(call.init.headers as ConstructorParameters<typeof Headers>[0])
  return h.get(name)
}

const STATUS = {
  version: '0.3.210',
  instance: 'web-1:abc',
  registry: {
    count: 2,
    loaded_at: '2026-11-22T10:00:00.000Z',
    etag: `"${'a'.repeat(64)}"`,
    stale: false,
    dropped: []
  },
  apps: [
    { id: 'acme-e7', schema: { state: 'ok', version: '0.3.210', error: null } },
    { id: 'beta-e9', schema: { state: 'pending', version: null, error: null } }
  ],
  extensions: ['efp-ops'],
  oidc: { issuer_host: 'login.microsoftonline.com', tenant: 'contoso' },
  process: { uptime_s: 12 }
}

const APP_STATUS = {
  id: 'acme-e7',
  version: '0.3.210',
  preflight: { status: 'ok', failing: [] },
  readiness_score: 97,
  busy: { imports: 0, exports: 1, renders: 0 },
  files: { count: 3, bytes: 300, local: 3 },
  key_fp: 'f'.repeat(32),
  maintenance: false
}

async function caught(p: Promise<unknown>): Promise<InstanceType<typeof DeploymentLinkError>> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(DeploymentLinkError)
    return err as InstanceType<typeof DeploymentLinkError>
  }
  throw new Error('expected a DeploymentLinkError')
}

describe('deploymentClient — the call itself', () => {
  it('sends the HMAC bearer of the token (never the token) and never follows a redirect', async () => {
    const { c, calls } = client(() => json(200, STATUS))
    await c.status()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://shared-one.internal.example.com/api/hub-deployment/status')
    expect(header(calls[0], 'authorization')).toBe(`Bearer ${deploymentLinkBearer(TOKEN)}`)
    expect(JSON.stringify(calls[0])).not.toContain(TOKEN)
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a redirect answer is refused, never followed', async () => {
    const { c, calls } = client(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } })
    )
    const err = await caught(c.status())
    expect(err.code).toBe('LINK_REFUSED')
    expect(calls).toHaveLength(1)
  })

  it('a fetch that throws on a redirect (redirect: error) is LINK_REFUSED', async () => {
    const { c } = client(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('unexpected redirect')
      })
    })
    expect((await caught(c.status())).code).toBe('LINK_REFUSED')
  })

  it('401 → LINK_REFUSED; 403 and 429 too', async () => {
    for (const status of [401, 403, 429]) {
      const { c } = client(() => json(status, { code: 'DEPLOYMENT_LINK_REFUSED' }))
      const err = await caught(c.status())
      expect(err.code).toBe('LINK_REFUSED')
      expect(err.status).toBe(status)
    }
  })

  it('on 401 retries once with the previous token inside the grace', async () => {
    const { c, calls } = client(
      (call) =>
        header(call, 'authorization') === `Bearer ${deploymentLinkBearer(PREV)}`
          ? json(200, STATUS)
          : json(401, { code: 'DEPLOYMENT_LINK_REFUSED' }),
      { previous: PREV }
    )
    const st = await c.status()
    expect(st.version).toBe('0.3.210')
    expect(calls).toHaveLength(2)
    expect(header(calls[1], 'authorization')).toBe(`Bearer ${deploymentLinkBearer(PREV)}`)
  })

  it('without a previous token a 401 is not retried; a second 401 stays refused', async () => {
    const a = client(() => json(401, {}))
    expect((await caught(a.c.status())).code).toBe('LINK_REFUSED')
    expect(a.calls).toHaveLength(1)
    const b = client(() => json(401, {}), { previous: PREV })
    expect((await caught(b.c.status())).code).toBe('LINK_REFUSED')
    expect(b.calls).toHaveLength(2)
  })

  it('a 503 is never retried with the previous token', async () => {
    const { c, calls } = client(() => json(503, { code: 'REGISTRY_NOT_READY' }), { previous: PREV })
    expect((await caught(c.status())).code).toBe('REGISTRY_NOT_READY')
    expect(calls).toHaveLength(1)
  })

  it('no stored token → LINK_REFUSED without a call', async () => {
    const { c, calls } = client(() => json(200, STATUS), { current: null })
    expect((await caught(c.status())).code).toBe('LINK_REFUSED')
    expect(calls).toHaveLength(0)
  })

  it('a timeout → LINK_UNREACHABLE (bounded even when fetch ignores the signal)', async () => {
    const { c } = client(() => new Promise<Response>(() => {}), { timeoutMs: 30 })
    const t0 = Date.now()
    const err = await caught(c.status())
    expect(err.code).toBe('LINK_UNREACHABLE')
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('the default timeout is 8 s', () => {
    expect(DEPLOYMENT_LINK_TIMEOUT_MS).toBe(8_000)
  })

  it('a network error → LINK_UNREACHABLE', async () => {
    const { c } = client(() => {
      throw new TypeError('fetch failed')
    })
    expect((await caught(c.status())).code).toBe('LINK_UNREACHABLE')
  })

  it('a malformed body → LINK_BAD_ANSWER', async () => {
    for (const bad of [
      () => new Response('<html>not json</html>', { status: 200 }),
      () => json(200, { version: 3 }),
      () => json(200, { ...STATUS, apps: 'none' }),
      () => json(200, { ...STATUS, registry: { ...STATUS.registry, count: 'x' } })
    ]) {
      const { c } = client(bad)
      expect((await caught(c.status())).code).toBe('LINK_BAD_ANSWER')
    }
  })

  it('a body over the cap → LINK_BAD_ANSWER', async () => {
    const { c } = client(() => new Response(`{"x":"${'a'.repeat(2_100_000)}"}`, { status: 200 }))
    expect((await caught(c.status())).code).toBe('LINK_BAD_ANSWER')
  })

  it('a link address that is not one the Hub may call → LINK_UNREACHABLE without a call', async () => {
    const f = fakeFetch(() => json(200, STATUS))
    const c = deploymentClient(
      { ...SHARED, link_url: 'http://example.com' },
      { fetch: f.fn, tokens: async () => ({ current: TOKEN, previous: null }) }
    )
    expect((await caught(c.status())).code).toBe('LINK_UNREACHABLE')
    expect(f.calls).toHaveLength(0)
  })

  it('a 404 without UNKNOWN_APP → LINK_MISSING (no deployment link there)', async () => {
    const { c } = client(() => json(404, { message: 'Not Found' }))
    expect((await caught(c.status())).code).toBe('LINK_MISSING')
  })

  it('error messages are plain sentences with no token, bearer or body text', async () => {
    const { c } = client(() => json(500, { message: `boom ${TOKEN}`, code: 'SOMETHING' }))
    const err = await caught(c.status())
    expect(err.code).toBe('LINK_BAD_ANSWER')
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain(deploymentLinkBearer(TOKEN))
    expect(err.message).not.toContain('boom')
  })
})

describe('deploymentClient — each route', () => {
  it('status() returns the deployment status', async () => {
    const { c } = client(() => json(200, STATUS))
    const st = await c.status()
    expect(st.apps.map((a) => a.id)).toEqual(['acme-e7', 'beta-e9'])
    expect(st.registry.etag).toBe(STATUS.registry.etag)
  })

  it('appStatus() reads one app; 404 UNKNOWN_APP → UNKNOWN_APP; 503 APP_UNREACHABLE passes through', async () => {
    const ok = client(() => json(200, APP_STATUS))
    expect((await ok.c.appStatus('acme-e7')).key_fp).toBe('f'.repeat(32))
    expect(ok.calls[0].url).toBe(
      'https://shared-one.internal.example.com/api/hub-deployment/apps/acme-e7/status'
    )
    const unknown = client(() => json(404, { code: 'UNKNOWN_APP' }))
    expect((await caught(unknown.c.appStatus('nope-e1'))).code).toBe('UNKNOWN_APP')
    const down = client(() => json(503, { code: 'APP_UNREACHABLE' }))
    expect((await caught(down.c.appStatus('acme-e7'))).code).toBe('APP_UNREACHABLE')
  })

  it('appStatus() refuses a tenant id that is not one, without a call', async () => {
    const { c, calls } = client(() => json(200, APP_STATUS))
    expect((await caught(c.appStatus('../status'))).code).toBe('UNKNOWN_APP')
    expect(calls).toHaveLength(0)
  })

  it('firstAdmin() posts the body; 201 → {user_id, created}; refusals carry the reason', async () => {
    const { c, calls } = client(() => json(201, { user_id: 'u-1', created: true }))
    expect(await c.firstAdmin('acme-e7', { email: 'a@b.c' })).toEqual({
      user_id: 'u-1',
      created: true
    })
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'a@b.c' })
    const has = client(() => json(409, { code: 'HAS_ADMIN', message: 'x' }))
    const err = await caught(has.c.firstAdmin('acme-e7', { email: 'a@b.c' }))
    expect(err.code).toBe('FIRST_ADMIN_REFUSED')
    expect(err.reason).toBe('HAS_ADMIN')
    const maint = client(() => json(503, { code: 'MAINTENANCE' }))
    expect((await caught(maint.c.firstAdmin('acme-e7', {}))).code).toBe('MAINTENANCE')
    const failed = client(() => json(500, { code: 'FIRST_ADMIN_FAILED' }))
    expect((await caught(failed.c.firstAdmin('acme-e7', {}))).code).toBe('FIRST_ADMIN_FAILED')
  })

  it('refresh() posts and accepts 202', async () => {
    const { c, calls } = client(() => json(202, { accepted: true, every_replica: true }))
    await c.refresh()
    expect(calls[0].url).toMatch(/\/api\/hub-deployment\/refresh$/)
    expect(calls[0].init.method).toBe('POST')
  })

  it('dbCheck() sends the connection only in the body and returns db_identity', async () => {
    const { c, calls } = client(() =>
      json(200, {
        reachable: true,
        ledger: { count: 540, latest: '553_hub_moves.ts' },
        db_identity: 'pg|db.internal|5432|acme_db',
        error: null
      })
    )
    const out = await c.dbCheck({ client: 'pg', connection: CONN })
    expect(out).toEqual({
      reachable: true,
      ledger: { count: 540, latest: '553_hub_moves.ts' },
      db_identity: 'pg|db.internal|5432|acme_db',
      error: null
    })
    expect(calls[0].url).not.toContain('acme')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ client: 'pg', connection: CONN })
  })

  it('dbCheck() never puts the connection into an error text', async () => {
    // The deployment echoes it (an old or broken one): the answer's error is scrubbed again.
    const echo = client(() =>
      json(200, {
        reachable: false,
        ledger: null,
        db_identity: null,
        error: `cannot reach ${CONN}`
      })
    )
    const out = await echo.c.dbCheck({ client: 'pg', connection: CONN })
    expect(out.reachable).toBe(false)
    expect(out.error).not.toContain(CONN)
    expect(out.error).not.toContain('pw-Secret-Plain-77')
    // A refusal whose body echoes it: the thrown error never carries it either.
    for (const answer of [
      () => json(400, { code: 'BAD_DB_CONNECTION', message: CONN }),
      () => json(500, { message: CONN }),
      () => {
        throw new Error(`connect failed ${CONN}`)
      }
    ]) {
      const { c } = client(answer)
      const err = await caught(c.dbCheck({ client: 'pg', connection: CONN }))
      expect(`${err.message} ${err.reason ?? ''} ${JSON.stringify(err)}`).not.toContain(
        'pw-Secret-Plain-77'
      )
      expect(err.message).not.toContain(CONN)
    }
    const bad = client(() => json(400, { code: 'BAD_DB_CLIENT' }))
    expect((await caught(bad.c.dbCheck({ client: 'x', connection: CONN }))).code).toBe(
      'BAD_DB_CLIENT'
    )
  })

  it('fileTicket(), pullFiles() and pullStatus() call the per-app file routes', async () => {
    const TICKET = `nvt_${'T'.repeat(43)}`
    const { c, calls } = client((call) => {
      if (call.url.endsWith('/files/ticket'))
        return json(200, { ticket: TICKET, expires_at: '2026-11-22T16:00:00.000Z' })
      if (call.url.endsWith('/files/pull')) return json(202, { run_id: 'run-1' })
      return json(200, {
        state: 'running',
        total: 4,
        copied: 1,
        skipped: 1,
        failed: 0,
        missing: [],
        bytes: 10,
        error: null
      })
    })
    expect((await c.fileTicket('acme-e7')).ticket).toBe(TICKET)
    expect(
      await c.pullFiles('acme-e7', {
        source: 'https://acme.example.com/api/hub-transfer/files',
        ticket: TICKET,
        mode: 'full'
      })
    ).toEqual({ run_id: 'run-1' })
    expect((await c.pullStatus('acme-e7', 'run-1')).copied).toBe(1)
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/api/hub-deployment/apps/acme-e7/files/ticket',
      '/api/hub-deployment/apps/acme-e7/files/pull',
      '/api/hub-deployment/apps/acme-e7/files/pull/run-1'
    ])
  })

  it('a refused pull never carries the ticket in its error', async () => {
    const TICKET = `nvt_${'Q'.repeat(43)}`
    const { c } = client(() => json(400, { code: 'BAD_SOURCE', message: `bad ${TICKET}` }))
    const err = await caught(
      c.pullFiles('acme-e7', { source: 'http://example.com/x', ticket: TICKET, mode: 'full' })
    )
    expect(JSON.stringify({ m: err.message, r: err.reason })).not.toContain(TICKET)
  })
})

describe('linkedKeyFingerprint — what a dedicated app says its key is', () => {
  const ENV = {
    id: 4,
    base_url: 'https://acme.example.com',
    hub_token: null as string | null
  }

  it('reads key_fp from GET /api/hub-link/shared-readiness with the env hub token', async () => {
    const f = fakeFetch(() => json(200, { key_fp: 'c'.repeat(32), codes: [] }))
    const out = await linkedKeyFingerprint(ENV, 'hub-Link-Token-0123456789-abcdefghijkl', {
      fetch: f.fn
    })
    expect(out).toEqual({ ok: true, fp: 'c'.repeat(32) })
    expect(f.calls[0].url).toBe('https://acme.example.com/api/hub-link/shared-readiness')
    expect(header(f.calls[0], 'authorization')).toBe(
      'Bearer hub-Link-Token-0123456789-abcdefghijkl'
    )
    expect(f.calls[0].init.redirect).toBe('error')
  })

  it('an app without the route (404) or unreachable → not ok, with a code', async () => {
    const missing = fakeFetch(() => json(404, {}))
    expect(await linkedKeyFingerprint(ENV, 'tok', { fetch: missing.fn })).toEqual({
      ok: false,
      code: 'HUB_LINK_MISSING'
    })
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    expect(await linkedKeyFingerprint(ENV, 'tok', { fetch: down.fn })).toEqual({
      ok: false,
      code: 'UNREACHABLE'
    })
    const refused = fakeFetch(() => json(401, {}))
    expect(await linkedKeyFingerprint(ENV, 'tok', { fetch: refused.fn })).toEqual({
      ok: false,
      code: 'HUB_LINK_REFUSED'
    })
  })
})

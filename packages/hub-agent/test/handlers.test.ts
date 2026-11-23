import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/config.js'
import { makeHandlers } from '../src/handlers.js'
import { createLog } from '../src/log.js'
import { baseHandlers } from '../src/main.js'
import { createServer } from '../src/server.js'
import { FakeEngine } from './fake-engine.js'

const TOKEN = 'agent-token-0123456789-abcdefghij'
const IMAGE = `nodeworks/nivaro@sha256:${'1'.repeat(64)}`
const REDIS = `redis@sha256:${'c'.repeat(64)}`
const SECRET = 'S3cr3t-value-7f3a9e1c-never-to-be-seen'
const SECRET_B64 = Buffer.from(SECRET).toString('base64')

let root: string
let cfg: AgentConfig
let fake: FakeEngine
let server: http.Server
let port = 0
let lines: string[]
const answers: string[] = []

const body = (over: Record<string, unknown> = {}) => ({
  owner: { app: 'acme' },
  environment: 'staging',
  image: IMAGE,
  roles: [{ role: 'web', replicas: 1 }],
  env: { DB_HOST: 'db.internal' },
  secrets: { DB_PASSWORD: SECRET },
  hostnames: ['acme.apps.corp'],
  redis: 'bundled',
  extensions: {},
  ...over
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hub-agent-handlers-'))
  cfg = loadAgentConfig(
    {
      HUB_AGENT_TOKEN_FILE: '/t',
      HUB_AGENT_EDGE_NETWORK: 'edge',
      HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
      HUB_AGENT_REDIS_IMAGE: REDIS,
      HUB_AGENT_EXTENSIONS_ROOT: root
    },
    () => TOKEN
  )
  fake = new FakeEngine(cfg)
  lines = []
  const log = createLog((l) => lines.push(l))
  const facts = { engineApi: '1.45', nodeId: 'node-agent-1' }
  const handlers = makeHandlers(fake, cfg, {
    nodeId: facts.nodeId,
    health: baseHandlers(cfg, facts, fake).health,
    log,
    sleep: async () => {}
  })
  server = createServer(cfg, handlers, { log }) as http.Server
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(root, { recursive: true, force: true })
})

function req(method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json))
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {})
        }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => {
          answers.push(text)
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null })
        })
      }
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

describe('stack routes', () => {
  it('PUT applies (202), GET reports, GET /v1/stacks lists, DELETE needs the name', async () => {
    const put = await req('PUT', '/v1/stacks/acme-st', body())
    expect(put.status).toBe(202)
    expect(put.body.spec_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(put.body.changed).toEqual(['acme-st_redis', 'acme-st_web'])

    const get = await req('GET', `/v1/stacks/acme-st?expect=${put.body.spec_hash}`)
    expect(get.status).toBe(200)
    expect(get.body.state).toBe('converged')

    const list = await req('GET', '/v1/stacks')
    expect(list).toEqual({
      status: 200,
      body: {
        data: [
          {
            name: 'acme-st',
            owner: { app: 'acme' },
            environment: 'staging',
            image: IMAGE,
            services: 2
          }
        ]
      }
    })

    const restart = await req('POST', '/v1/stacks/acme-st/restart', body())
    expect(restart).toEqual({ status: 202, body: { services: ['acme-st_redis', 'acme-st_web'] } })

    const noConfirm = await req('DELETE', '/v1/stacks/acme-st')
    expect(noConfirm.status).toBe(400)
    expect(noConfirm.body.code).toBe('CONFIRM_REQUIRED')
    const wrong = await req('DELETE', '/v1/stacks/acme-st?confirm=acme')
    expect(wrong.body.code).toBe('CONFIRM_REQUIRED')
    expect(fake.serviceNames()).toEqual(['acme-st_redis', 'acme-st_web'])

    for (const q of [
      '',
      '&app=acme',
      '&environment=staging',
      '&app=acme&shared=acme&environment=staging',
      '&app=Acme&environment=staging'
    ]) {
      const r = await req('DELETE', `/v1/stacks/acme-st?confirm=acme-st${q}`)
      expect([q, r.status, r.body.code]).toEqual([q, 400, 'OWNER_REQUIRED'])
    }
    const other = await req(
      'DELETE',
      '/v1/stacks/acme-st?confirm=acme-st&remove_volumes=1&app=acme&environment=production'
    )
    expect([other.status, other.body.code]).toEqual([409, 'STACK_OWNER_MISMATCH'])
    expect(fake.serviceNames()).toEqual(['acme-st_redis', 'acme-st_web'])

    const noOwner = await req('GET', '/v1/stacks/acme-st/leftovers')
    expect([noOwner.status, noOwner.body.code]).toEqual([400, 'OWNER_REQUIRED'])
    const left = await req('GET', '/v1/stacks/acme-st/leftovers?app=acme&environment=staging')
    expect(left.status).toBe(200)
    expect(left.body.services).toEqual(['acme-st_redis', 'acme-st_web'])
    expect(left.body.volumes).toEqual(['nvh_acme-st_redis', 'nvh_acme-st_uploads'])
    const leftOther = await req(
      'GET',
      '/v1/stacks/acme-st/leftovers?app=acme&environment=production'
    )
    expect([leftOther.status, leftOther.body.code]).toEqual([409, 'STACK_OWNER_MISMATCH'])

    const del = await req(
      'DELETE',
      '/v1/stacks/acme-st?confirm=acme-st&remove_volumes=1&app=acme&environment=staging'
    )
    expect(del.status).toBe(200)
    expect(del.body.removed.services).toEqual(['acme-st_redis', 'acme-st_web'])
    expect(del.body.removed.networks).toEqual(['nvh_acme-st'])
    expect(del.body.removed.volumes).toEqual(['nvh_acme-st_redis', 'nvh_acme-st_uploads'])
    for (const k of ['services', 'secrets', 'networks', 'volumes']) {
      expect(del.body.removed[k].every((x: unknown) => typeof x === 'string')).toBe(true)
    }

    expect((await req('GET', '/v1/stacks/acme-st')).body.code).toBe('STACK_NOT_FOUND')
  })

  it('an invalid spec is 400 SPEC_INVALID with fields; nothing is written', async () => {
    const r = await req('PUT', '/v1/stacks/acme-st', {
      ...body(),
      binds: ['/:/host'],
      privileged: true
    })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('SPEC_INVALID')
    expect(r.body.fields).toEqual(
      expect.arrayContaining([
        { field: 'binds', code: 'UNKNOWN_FIELD' },
        { field: 'privileged', code: 'UNKNOWN_FIELD' }
      ])
    )
    expect(fake.calls).toEqual([])
  })

  it('a key outside the allow-list is 400 SPEC_INVALID naming it, no value; nothing is written', async () => {
    const r = await req('PUT', '/v1/stacks/acme-st', {
      ...body(),
      env: { DB_HOST: 'db.internal', GCONV_PATH: '/tmp/x', GREETING: 'hello-value' },
      secrets: { DB_PASSWORD: SECRET, EFP_KEY: SECRET }
    })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('SPEC_INVALID')
    expect(r.body.fields).toEqual(
      expect.arrayContaining([
        { field: 'env.GCONV_PATH', code: 'ENV_FORBIDDEN' },
        { field: 'env.GREETING', code: 'ENV_NOT_ALLOWED' },
        { field: 'secrets.EFP_KEY', code: 'ENV_NOT_ALLOWED' }
      ])
    )
    const text = JSON.stringify(r.body)
    expect(text).not.toContain('hello-value')
    expect(text).not.toContain(SECRET)
    expect(fake.calls).toEqual([])
  })

  it("EFP's stack: PUT, restart, DELETE and GET answer 409 STACK_NOT_HUB with no write", async () => {
    fake.preexisting('efp_web', { 'com.docker.stack.namespace': 'efp' })
    for (const [m, p, b] of [
      ['PUT', '/v1/stacks/efp', body()],
      ['POST', '/v1/stacks/efp/restart', body()],
      [
        'DELETE',
        '/v1/stacks/efp?confirm=efp&remove_volumes=1&app=acme&environment=staging',
        undefined
      ],
      ['GET', '/v1/stacks/efp', undefined]
    ] as const) {
      const r = await req(m, p, b)
      expect(r.status).toBe(409)
      expect(r.body).toEqual({ error: expect.any(String), code: 'STACK_NOT_HUB' })
    }
    expect(fake.writes()).toEqual([])
    const list = await req('GET', '/v1/stacks')
    expect(list.body.data).toEqual([])
    expect(answers.join('\n')).not.toContain('efp-env-value')
  })

  it('restart needs a valid spec (400 SPEC_INVALID) and the one the stack runs (409 SPEC_MISMATCH)', async () => {
    await req('PUT', '/v1/stacks/acme-st', body())
    fake.calls.length = 0
    const none = await req('POST', '/v1/stacks/acme-st/restart')
    expect(none.status).toBe(400)
    const bad = await req('POST', '/v1/stacks/acme-st/restart', { ...body(), privileged: true })
    expect(bad).toMatchObject({ status: 400, body: { code: 'SPEC_INVALID' } })
    const other = await req('POST', '/v1/stacks/acme-st/restart', body({ env: { DB_HOST: 'x' } }))
    expect(other).toMatchObject({ status: 409, body: { code: 'SPEC_MISMATCH' } })
    expect(fake.writes()).toEqual([])
  })

  it('owner mismatch is 409 STACK_OWNER_MISMATCH; a taken hostname 409 HOSTNAME_TAKEN', async () => {
    await req('PUT', '/v1/stacks/acme-st', body())
    const r = await req('PUT', '/v1/stacks/acme-st', body({ owner: { app: 'beta' } }))
    expect(r).toMatchObject({ status: 409, body: { code: 'STACK_OWNER_MISMATCH' } })
    const h = await req('PUT', '/v1/stacks/beta-st', body({ owner: { app: 'beta' } }))
    expect(h).toMatchObject({
      status: 409,
      body: { code: 'HOSTNAME_TAKEN', fields: [{ field: 'hostnames[0]', code: 'HOSTNAME_TAKEN' }] }
    })
  })

  it('a malformed expect is 400; an Engine failure is 502 ENGINE_ERROR with no Engine text', async () => {
    expect((await req('GET', '/v1/stacks/acme-st?expect=xyz')).body.code).toBe('EXPECT_INVALID')
    await req('PUT', '/v1/stacks/acme-st', body())
    fake.failNextUpdate('error')
    const r = await req('PUT', '/v1/stacks/acme-st', body({ env: { DB_HOST: 'other' } }))
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: expect.any(String), code: 'ENGINE_ERROR' })
    expect(JSON.stringify(r.body)).not.toContain('rpc error')
    fake.setUnreachable(true)
    const u = await req('GET', '/v1/stacks/acme-st')
    expect(u).toEqual({ status: 502, body: { error: expect.any(String), code: 'ENGINE_ERROR' } })
  })

  it('a secret value appears in no log line, no answer and no Engine call but the secret create', async () => {
    answers.length = 0
    const put = await req('PUT', '/v1/stacks/acme-st', body())
    expect(put.status).toBe(202)
    await req('GET', `/v1/stacks/acme-st?expect=${put.body.spec_hash}`)
    await req('GET', '/v1/stacks')
    await req('POST', '/v1/stacks/acme-st/restart', body())
    await req('PUT', '/v1/stacks/acme-st', body({ secrets: { DB_PASSWORD: `${SECRET}-2` } }))
    await req('PUT', '/v1/stacks/acme-st', body({ owner: { app: 'beta' } }))
    fake.failNextUpdate('error')
    await req('PUT', '/v1/stacks/acme-st', body({ env: { DB_HOST: 'x' } }))
    await req(
      'DELETE',
      '/v1/stacks/acme-st?confirm=acme-st&remove_volumes=1&app=acme&environment=staging'
    )

    const everything = [...lines, ...answers]
    for (const s of everything) {
      expect(s).not.toContain(SECRET)
      expect(s).not.toContain(SECRET_B64)
      expect(s).not.toContain(TOKEN)
    }
    expect(lines.length).toBeGreaterThan(0)
    for (const c of fake.calls) {
      const text = JSON.stringify(c)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(TOKEN)
      if (!(c.method === 'POST' && c.path === '/secrets/create')) {
        expect(text).not.toContain(SECRET_B64)
      }
    }
    const creates = fake.calls.filter((c) => c.path === '/secrets/create')
    expect(creates.some((c) => (c.body as any).Data === SECRET_B64)).toBe(true)
  })
})

// Hub P6-45 round 3 (agent 0.2.1): a Finish that stops an old stack must see its containers stop,
// not only its services go, and a remove that fails part way must never leave an app process
// running without its Redis (the maintenance freeze).
describe('0.2.1: stopping a stack — tasks_active and Redis last', () => {
  const owner = '?app=acme&environment=staging'
  it('leftovers counts the stack’s tasks that have not ended, draining ones included', async () => {
    expect((await req('PUT', '/v1/stacks/acme-st', body())).status).toBe(202)
    // Another app's stack: never counted.
    expect(
      (await req('PUT', '/v1/stacks/other-st', body({ owner: { app: 'other' }, hostnames: [] })))
        .status
    ).toBe(202)
    const before = await req('GET', `/v1/stacks/acme-st/leftovers${owner}`)
    // web + redis, one replica each (the shut-down task of an earlier version is running too).
    expect(before.body.tasks_active).toBeGreaterThanOrEqual(2)

    const del = await req(
      'DELETE',
      `/v1/stacks/acme-st?confirm=acme-st&app=acme&environment=staging`
    )
    expect(del.status).toBe(200)
    // The services are gone, their containers still shutting down: not stopped yet.
    const draining = await req('GET', `/v1/stacks/acme-st/leftovers${owner}`)
    expect(draining.body.services).toEqual([])
    expect(draining.body.tasks_active).toBe(2)
    expect((await req('GET', '/v1/stacks/acme-st')).status).toBe(404)
    fake.finishDraining()
    const done = await req('GET', `/v1/stacks/acme-st/leftovers${owner}`)
    expect(done.body.tasks_active).toBe(0)
    // Volumes kept (remove_volumes not asked).
    expect(done.body.volumes).toEqual(['nvh_acme-st_redis', 'nvh_acme-st_uploads'])
  })

  it('removes the app services first and Redis last; a failure part way keeps Redis', async () => {
    expect(
      (
        await req(
          'PUT',
          '/v1/stacks/acme-st',
          body({
            roles: [
              { role: 'web', replicas: 1 },
              { role: 'worker', replicas: 1 }
            ]
          })
        )
      ).status
    ).toBe(202)
    fake.failDelete.add('acme-st_worker')
    const del = await req(
      'DELETE',
      `/v1/stacks/acme-st?confirm=acme-st&app=acme&environment=staging`
    )
    expect(del.status).toBe(502)
    // Redis is still there: the surviving worker can still read its freeze.
    expect(fake.serviceNames()).toEqual(['acme-st_redis', 'acme-st_worker'])
    fake.failDelete.clear()
    expect(
      (await req('DELETE', `/v1/stacks/acme-st?confirm=acme-st&app=acme&environment=staging`))
        .status
    ).toBe(200)
    const order = fake.calls
      .filter((c) => c.method === 'DELETE' && c.path.startsWith('/services/'))
      .map((c) => c.path)
    expect(order.at(-1)).toBe('/services/acme-st_redis')
    expect(order.indexOf('/services/acme-st_redis')).toBeGreaterThan(
      order.indexOf('/services/acme-st_web')
    )
  })
})

describe('P4-33: health says how many nodes the swarm has and the volume driver', () => {
  it('one node, local volumes', async () => {
    const r = await req('GET', '/v1/health')
    expect(r.status).toBe(200)
    expect(r.body.swarm).toEqual({ manager: true, node_id: 'node-agent-1', nodes: 1 })
    expect(r.body.volume_driver).toBe('local')
  })

  it('three nodes are read live from the Engine (/info)', async () => {
    fake.swarmNodes = 3
    const r = await req('GET', '/v1/health')
    expect(r.body.swarm.nodes).toBe(3)
  })
})

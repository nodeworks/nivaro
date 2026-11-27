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
import { SCALE_CAPS, scaledSpec, validateScaleRequest } from '../src/scale.js'
import { createServer } from '../src/server.js'
import type { StackSpec } from '../src/spec.js'
import { applyStack, StackError, scaleStack, stackHash, stackStatus } from '../src/stacks.js'
import { FakeEngine } from './fake-engine.js'

const IMAGE = `nodeworks/nivaro@sha256:${'1'.repeat(64)}`
const REDIS = `redis@sha256:${'c'.repeat(64)}`
const TOKEN = 'agent-token-0123456789-abcdefghij'
const NODE = 'node-agent-1'
const S = 'acme-st'

let root: string
let cfg: AgentConfig
let fake: FakeEngine

const spec = (over: Partial<StackSpec> = {}): StackSpec => ({
  owner: { app: 'acme' },
  environment: 'staging',
  image: IMAGE,
  roles: [
    { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
    { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
    { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 1024 },
    { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 }
  ],
  env: { DB_HOST: 'db.internal', NODE_ENV: 'production' },
  secrets: { DB_PASSWORD: 'pw-one' },
  hostnames: ['acme-staging.apps.corp'],
  redis: 'bundled',
  extensions: {},
  ...over
})

const deps = { nodeId: NODE, sleep: async () => {} }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-agent-scale-'))
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
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const codes = (r: ReturnType<typeof validateScaleRequest>) =>
  r.ok ? [] : r.fields.map((f) => `${f.field}:${f.code}`)

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof StackError) return err.code
    throw err
  }
  return 'NO_ERROR'
}

describe('validateScaleRequest', () => {
  it('builds the next spec with only replicas and limits replaced', () => {
    const r = validateScaleRequest(
      { spec: spec(), roles: [{ role: 'web', replicas: 5, memory_mb: 4096 }] },
      cfg
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const web = r.next.roles.find((x) => x.role === 'web')
    expect(web).toEqual({
      role: 'web',
      replicas: 5,
      cpus: 2,
      memory_mb: 4096,
      env: { SOCKETS: 'off' }
    })
    // Everything else is the spec as sent.
    expect({ ...r.next, roles: [] }).toEqual({ ...spec(), roles: [] })
    expect(r.next.roles.filter((x) => x.role !== 'web')).toEqual(
      spec().roles.filter((x) => x.role !== 'web')
    )
  })

  it('refuses anything but replicas and limits of roles the stack runs', () => {
    const r = validateScaleRequest(
      {
        spec: spec(),
        roles: [
          { role: 'exporter', replicas: 1 },
          { role: 'web', replicas: 2, image: 'x' }
        ],
        env: {}
      },
      cfg
    )
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        'env:UNKNOWN_FIELD',
        'roles[0].role:ROLE_NOT_IN_STACK',
        'roles[1].image:UNKNOWN_FIELD'
      ])
    )
  })

  it('keeps one worker, at least one web, and realtime while web runs SOCKETS=off', () => {
    const r = validateScaleRequest(
      {
        spec: spec(),
        roles: [
          { role: 'worker', replicas: 2 },
          { role: 'web', replicas: 0 },
          { role: 'realtime', replicas: 0 }
        ]
      },
      cfg
    )
    expect(codes(r)).toEqual([
      'roles[0].replicas:REPLICAS_FIXED',
      'roles[1].replicas:LAST_WEB',
      'roles[2].replicas:REALTIME_NEEDED'
    ])
    // The worker's limits may change; its replicas, unchanged, may be repeated.
    expect(
      validateScaleRequest({ spec: spec(), roles: [{ role: 'worker', replicas: 1, cpus: 3 }] }, cfg)
        .ok
    ).toBe(true)
  })

  it('holds limits to the caps and the next spec to every apply rule (30 replicas)', () => {
    expect(
      codes(
        validateScaleRequest(
          { spec: spec(), roles: [{ role: 'web', cpus: 99, memory_mb: 64, replicas: 11 }] },
          cfg
        )
      )
    ).toEqual([
      'roles[0].replicas:REPLICAS_BAD',
      'roles[0].cpus:LIMIT_BAD',
      'roles[0].memory_mb:LIMIT_BAD'
    ])
    const wide = spec({
      roles: [
        { role: 'web', replicas: 10 },
        { role: 'worker', replicas: 1 },
        { role: 'realtime', replicas: 10 },
        { role: 'importer', replicas: 9 }
      ]
    })
    const r = validateScaleRequest({ spec: wide, roles: [{ role: 'importer', replicas: 10 }] }, cfg)
    expect(codes(r)).toEqual(['roles:REPLICAS_BAD'])
    expect(SCALE_CAPS.max_total_replicas).toBe(30)
  })

  it('a spec that is not valid is SPEC_INVALID with spec. field paths', () => {
    const r = validateScaleRequest(
      { spec: { ...spec(), privileged: true }, roles: [{ role: 'web', replicas: 2 }] },
      cfg
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('SPEC_INVALID')
    expect(r.fields).toEqual([{ field: 'spec.privileged', code: 'UNKNOWN_FIELD' }])
  })

  it('a role named with nothing to change is refused', () => {
    expect(codes(validateScaleRequest({ spec: spec(), roles: [{ role: 'web' }] }, cfg))).toEqual([
      'roles[0]:NOTHING_TO_CHANGE'
    ])
  })
})

describe('scaleStack', () => {
  it('replicas only: updates the service, restarts no task, stamps the new hash everywhere', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    const restarts = new Map(fake.restarts)
    const next = scaledSpec(spec(), [{ role: 'web', replicas: 5 }])
    const r = await scaleStack(fake, cfg, S, spec(), next, deps)
    expect(r.already).toBe(false)
    expect(r.spec_hash).toBe(stackHash(next, cfg, NODE))
    expect(r.changed).toEqual([`${S}_web`])
    expect(fake.restarts).toEqual(restarts)
    const web = [...fake.services.values()].find((s) => s.Spec.Name === `${S}_web`)
    expect(web?.Spec.Mode.Replicated.Replicas).toBe(5)
    expect(web?.Spec.UpdateConfig).toMatchObject({ Order: 'start-first', Parallelism: 1 })
    for (const s of fake.services.values())
      expect(s.Spec.Labels['nivaro.hub.spec-hash']).toBe(r.spec_hash)
    fake.completeUpdates()
    const st = await stackStatus(fake, S, r.spec_hash)
    expect(st.services.find((s) => s.role === 'web')?.replicas.desired).toBe(5)
  })

  it('a limit change rolls that role only (start-first), nothing is created or removed', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    const before = new Map(fake.restarts)
    fake.calls.length = 0
    const next = scaledSpec(spec(), [{ role: 'realtime', memory_mb: 2048 }])
    const r = await scaleStack(fake, cfg, S, spec(), next, deps)
    expect(r.changed).toEqual([`${S}_realtime`])
    expect(fake.restarts.get(`${S}_realtime`)).toBe((before.get(`${S}_realtime`) ?? 0) + 1)
    expect(fake.restarts.get(`${S}_web`)).toBe(before.get(`${S}_web`))
    const writes = fake.calls.filter((c) => c.method !== 'GET')
    expect(writes.every((c) => /^\/services\/[^/]+\/update$/.test(c.path))).toBe(true)
  })

  it('the same request again answers already and writes nothing', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    const next = scaledSpec(spec(), [{ role: 'web', replicas: 4 }])
    await scaleStack(fake, cfg, S, spec(), next, deps)
    fake.calls.length = 0
    const again = await scaleStack(fake, cfg, S, spec(), next, deps)
    expect(again.already).toBe(true)
    expect(again.changed).toEqual([])
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a stack that runs another spec is SPEC_MISMATCH with no write', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.calls.length = 0
    const other = spec({ env: { DB_HOST: 'db2.internal', NODE_ENV: 'production' } })
    expect(
      await codeOf(
        scaleStack(fake, cfg, S, other, scaledSpec(other, [{ role: 'web', replicas: 4 }]), deps)
      )
    ).toBe('SPEC_MISMATCH')
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([])
    const elsewhere = spec({ hostnames: ['nope.apps.corp'] })
    expect(await codeOf(scaleStack(fake, cfg, 'nope', elsewhere, elsewhere, deps))).toBe(
      'STACK_NOT_FOUND'
    )
  })

  it('after swarm rolled one role back (mixed hashes), the step can be scaled back to where it was', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    const next = scaledSpec(spec(), [{ role: 'web', replicas: 5, memory_mb: 4096 }])
    await scaleStack(fake, cfg, S, spec(), next, deps)
    // Swarm rolled web back: its labels are the spec before again, the others carry next's hash.
    const webSvc = [...fake.services.values()].find((x) => x.Spec.Name === `${S}_web`)
    if (webSvc) webSvc.Spec.Labels['nivaro.hub.spec-hash'] = stackHash(spec(), cfg, NODE)
    const back = await scaleStack(fake, cfg, S, next, spec(), deps)
    expect(back.spec_hash).toBe(stackHash(spec(), cfg, NODE))
    for (const x of fake.services.values())
      expect(x.Spec.Labels['nivaro.hub.spec-hash']).toBe(back.spec_hash)
    // A third spec still never passes.
    const other = spec({ env: { DB_HOST: 'db9.internal', NODE_ENV: 'production' } })
    expect(
      await codeOf(
        scaleStack(fake, cfg, S, other, scaledSpec(other, [{ role: 'web', replicas: 2 }]), deps)
      )
    ).toBe('SPEC_MISMATCH')
  })

  it('a stack labelled for another owner is refused before any write', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.calls.length = 0
    const beta = spec({ owner: { app: 'beta' } })
    expect(
      await codeOf(
        scaleStack(fake, cfg, S, beta, scaledSpec(beta, [{ role: 'web', replicas: 4 }]), deps)
      )
    ).toBe('STACK_OWNER_MISMATCH')
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})

describe('POST /v1/stacks/:name/scale', () => {
  let server: http.Server
  let port = 0

  beforeEach(async () => {
    const log = createLog(() => {})
    const facts = { engineApi: '1.45', nodeId: NODE }
    const handlers = makeHandlers(fake, cfg, {
      nodeId: NODE,
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
  })

  function req(
    method: string,
    path: string,
    json?: unknown
  ): Promise<{ status: number; body: any }> {
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
            ...(payload ? { 'content-type': 'application/json' } : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null })
          })
        }
      )
      r.on('error', reject)
      if (payload) r.write(payload)
      r.end()
    })
  }

  it('202 on a change, 200 already on a repeat, 400 and 409 refusals with codes', async () => {
    expect((await req('PUT', `/v1/stacks/${S}`, spec())).status).toBe(202)
    const body = { spec: spec(), roles: [{ role: 'web', replicas: 4 }] }
    const first = await req('POST', `/v1/stacks/${S}/scale`, body)
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ changed: [`${S}_web`], already: false })
    const again = await req('POST', `/v1/stacks/${S}/scale`, body)
    expect(again.status).toBe(200)
    expect(again.body.already).toBe(true)
    const bad = await req('POST', `/v1/stacks/${S}/scale`, {
      spec: spec(),
      roles: [{ role: 'worker', replicas: 3 }]
    })
    expect(bad).toMatchObject({
      status: 400,
      body: {
        code: 'SCALE_INVALID',
        fields: [{ field: 'roles[0].replicas', code: 'REPLICAS_FIXED' }]
      }
    })
    const stale = await req('POST', `/v1/stacks/${S}/scale`, {
      spec: spec(),
      roles: [{ role: 'web', replicas: 6 }]
    })
    expect(stale).toMatchObject({ status: 409, body: { code: 'SPEC_MISMATCH' } })
  })

  it('health answers the scale caps', async () => {
    const h = await req('GET', '/v1/health')
    expect(h.body.agent_version).toBe('0.2.5')
    expect(h.body.scale).toEqual({
      max_replicas: 10,
      max_total_replicas: 30,
      cpus: [0.1, 16],
      memory_mb: [128, 65536],
      fixed_replica_roles: ['worker', 'all']
    })
  })
})

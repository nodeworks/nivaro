import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pack } from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/config.js'
import type { StackSpec } from '../src/spec.js'
import {
  applyStack,
  listStacks,
  removeStack,
  restartStack,
  StackError,
  stackHash,
  stackStatus
} from '../src/stacks.js'
import { FakeEngine, type Recorded } from './fake-engine.js'

const IMAGE = `nodeworks/nivaro@sha256:${'1'.repeat(64)}`
const IMAGE2 = `nodeworks/nivaro@sha256:${'2'.repeat(64)}`
const REDIS = `redis@sha256:${'c'.repeat(64)}`
const TOKEN = 'agent-token-0123456789-abcdefghij'
const NODE = 'node-agent-1'

let root: string

function makeCfg(over: Record<string, string> = {}): AgentConfig {
  return loadAgentConfig(
    {
      HUB_AGENT_TOKEN_FILE: '/t',
      HUB_AGENT_EDGE_NETWORK: 'edge',
      HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
      HUB_AGENT_REDIS_IMAGE: REDIS,
      HUB_AGENT_EXTENSIONS_ROOT: root,
      HUB_AGENT_EXTENSIONS_HOST_ROOT: '/srv/ext',
      ...over
    },
    () => TOKEN
  )
}

const spec = (over: Partial<StackSpec> = {}): StackSpec => ({
  owner: { app: 'acme' },
  environment: 'staging',
  image: IMAGE,
  roles: [
    { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
    { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
  ],
  env: { DB_HOST: 'db.internal', NODE_ENV: 'production' },
  secrets: { DB_PASSWORD: 'pw-one', SESSION_SECRET: 's'.repeat(64) },
  hostnames: ['acme-staging.apps.corp'],
  redis: 'bundled',
  extensions: {},
  ...over
})

const deps = { nodeId: NODE, sleep: async () => {} }
const S = 'acme-st'

let cfg: AgentConfig
let fake: FakeEngine

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-agent-stacks-'))
  cfg = makeCfg()
  fake = new FakeEngine(cfg)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const isWrite = (c: Recorded) => c.method !== 'GET'
const updates = (f: FakeEngine) =>
  f.calls.filter((c) => c.method === 'POST' && /^\/services\/[^/]+\/update$/.test(c.path))
const creates = (f: FakeEngine) =>
  f.calls.filter((c) => c.method === 'POST' && c.path === '/services/create')

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof StackError) return err.code
    throw err
  }
  return 'NO_ERROR'
}

const MANAGED = (stack: string, owner = 'acme', env = 'staging') => ({
  'nivaro.hub.managed': '1',
  'com.docker.stack.namespace': stack,
  'nivaro.hub.app': owner,
  'nivaro.hub.env': env
})

describe('applyStack on an empty swarm', () => {
  it('creates network, two volumes, secrets and services, all labelled', async () => {
    const r = await applyStack(fake, cfg, S, spec(), deps)
    expect(r.spec_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(r.changed).toEqual([`${S}_redis`, `${S}_web`, `${S}_worker`])
    expect(r.unchanged).toEqual([])

    const net = fake.networks.get(`nvh_${S}`)
    expect(net).toMatchObject({ Driver: 'overlay', Labels: MANAGED(S) })
    expect(net?.Attachable).toBe(false)
    expect([...fake.volumes.keys()].sort()).toEqual([`nvh_${S}_redis`, `nvh_${S}_uploads`])
    for (const v of fake.volumes.values()) {
      expect(v.Labels).toEqual(MANAGED(S))
      expect(v.Driver).toBe('local')
    }
    const secrets = [...fake.secrets.values()]
    expect(secrets).toHaveLength(2)
    for (const s of secrets) {
      expect(s.Spec.Name.startsWith(`nvh_${S}_`)).toBe(true)
      expect(s.Spec.Labels).toEqual(MANAGED(S))
    }
    expect(fake.serviceNames()).toEqual([`${S}_redis`, `${S}_web`, `${S}_worker`])
    for (const svc of fake.services.values()) {
      expect(svc.Spec.Labels).toMatchObject({ ...MANAGED(S), 'nivaro.hub.spec-hash': r.spec_hash })
      expect(svc.Spec.TaskTemplate.ContainerSpec.Labels).toMatchObject(MANAGED(S))
    }
    expect(fake.refused).toEqual([])
  })

  it('applying the same spec again changes nothing and sends no update', async () => {
    const first = await applyStack(fake, cfg, S, spec(), deps)
    fake.calls.length = 0
    const again = await applyStack(fake, cfg, S, spec(), deps)
    expect(again.spec_hash).toBe(first.spec_hash)
    expect(again.changed).toEqual([])
    expect(again.unchanged).toEqual([`${S}_redis`, `${S}_web`, `${S}_worker`])
    expect(updates(fake)).toEqual([])
    expect(fake.writes()).toEqual([])
  })

  it('one env change updates only the affected services, with their current Version.Index', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    const before = new Map([...fake.services.values()].map((s) => [s.Spec.Name, s.Version.Index]))
    const redisCreate = creates(fake).find((c) => (c.body as any).Name === `${S}_redis`)
    fake.calls.length = 0

    const r = await applyStack(
      fake,
      cfg,
      S,
      spec({ env: { DB_HOST: 'db2.internal', NODE_ENV: 'production' } }),
      deps
    )
    expect(r.changed).toEqual([`${S}_web`, `${S}_worker`])
    expect(r.unchanged).toEqual([`${S}_redis`])
    for (const u of updates(fake)) {
      const name = u.path.split('/')[2]
      expect(String(u.query?.version)).toBe(String(before.get(name)))
    }
    // Redis gets the new stack hash on the SERVICE only: its task template is
    // untouched, so swarm does not restart it.
    const redisUpdate = updates(fake).find((u) => u.path === `/services/${S}_redis/update`)
    expect(redisUpdate).toBeTruthy()
    expect((redisUpdate?.body as any).TaskTemplate).toEqual((redisCreate?.body as any).TaskTemplate)
    expect((redisUpdate?.body as any).Labels['nivaro.hub.spec-hash']).toBe(r.spec_hash)
    // The container labels never carry the stack hash.
    for (const u of updates(fake)) {
      expect(
        (u.body as any).TaskTemplate.ContainerSpec.Labels['nivaro.hub.spec-hash']
      ).toBeUndefined()
    }
  })

  it('update bodies name networks by name, never by the ids inspect returns', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    // The fake stores ids, like Docker.
    const stored = fake.service(`${S}_web`)?.Spec.TaskTemplate.Networks
    expect(
      stored.every((n: any) => n.Target.startsWith('id') || n.Target.startsWith('edgeid'))
    ).toBe(true)
    await applyStack(fake, cfg, S, spec({ image: IMAGE2 }), deps)
    const ups = updates(fake)
    expect(ups.length).toBeGreaterThan(0)
    for (const u of ups) {
      for (const n of (u.body as any).TaskTemplate.Networks) {
        expect([`nvh_${S}`, 'edge']).toContain(n.Target)
      }
    }
    expect(fake.refused).toEqual([])
  })

  it('a changed secret value gets a new secret; the old one is pruned once the update is done', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    const oldName = [...fake.secrets.values()].find((s) => s.Spec.Name.includes('_DB_PASSWORD_'))
      ?.Spec.Name
    fake.completeUpdates()
    await applyStack(
      fake,
      cfg,
      S,
      spec({ secrets: { DB_PASSWORD: 'pw-two', SESSION_SECRET: 's'.repeat(64) } }),
      deps
    )
    const names = [...fake.secrets.values()].map((s) => s.Spec.Name)
    const newName = names.find((n) => n.includes('_DB_PASSWORD_') && n !== oldName)
    expect(newName).toBeTruthy()
    // Still there while the update runs: swarm's automatic rollback needs it.
    expect(names).toContain(oldName)
    const web = fake.service(`${S}_web`)
    expect(web?.Spec.TaskTemplate.ContainerSpec.Secrets.map((x: any) => x.SecretName)).toContain(
      newName
    )

    fake.completeUpdates()
    fake.calls.length = 0
    await applyStack(
      fake,
      cfg,
      S,
      spec({ secrets: { DB_PASSWORD: 'pw-two', SESSION_SECRET: 's'.repeat(64) } }),
      deps
    )
    expect([...fake.secrets.values()].map((s) => s.Spec.Name)).not.toContain(oldName)
    expect(fake.writes()).toEqual([{ method: 'DELETE', path: `/secrets/${oldName}` }])
  })

  it('a secret the Engine says is in use is left for later, the apply still succeeds', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    const oldName = [...fake.secrets.values()].find((s) => s.Spec.Name.includes('_DB_PASSWORD_'))
      ?.Spec.Name as string
    fake.secretInUse(oldName)
    fake.completeUpdates()
    const two = spec({ secrets: { DB_PASSWORD: 'pw-two', SESSION_SECRET: 's'.repeat(64) } })
    await applyStack(fake, cfg, S, two, deps)
    fake.completeUpdates()
    await expect(applyStack(fake, cfg, S, two, deps)).resolves.toMatchObject({ changed: [] })
    expect([...fake.secrets.values()].map((s) => s.Spec.Name)).toContain(oldName)
  })

  it('a large → small change removes the services no longer rendered', async () => {
    const large = spec({
      roles: [
        { role: 'web', replicas: 3, env: { SOCKETS: 'off' } },
        { role: 'worker', replicas: 1 },
        { role: 'realtime', replicas: 2 },
        { role: 'importer', replicas: 1 }
      ]
    })
    await applyStack(fake, cfg, S, large, deps)
    expect(fake.serviceNames()).toEqual([
      `${S}_importer`,
      `${S}_realtime`,
      `${S}_redis`,
      `${S}_web`,
      `${S}_worker`
    ])
    const r = await applyStack(fake, cfg, S, spec({ roles: [{ role: 'all', replicas: 1 }] }), deps)
    expect(fake.serviceNames()).toEqual([`${S}_all`, `${S}_redis`])
    expect(r.changed).toEqual([
      `${S}_all`,
      `${S}_importer`,
      `${S}_realtime`,
      `${S}_web`,
      `${S}_worker`
    ])
    const deletes = fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)
    expect(deletes).toEqual(
      expect.arrayContaining([
        `/services/${S}_web`,
        `/services/${S}_worker`,
        `/services/${S}_realtime`,
        `/services/${S}_importer`
      ])
    )
  })

  it('an extension is unpacked once and bound read-only, services pinned to the agent node', async () => {
    const ext = `nodeworks/nivaro@sha256:${'9'.repeat(64)}`
    const tar = await new Promise<Buffer>((resolve) => {
      const p = pack()
      const chunks: Buffer[] = []
      p.on('data', (c: Buffer) => chunks.push(c))
      p.on('end', () => resolve(Buffer.concat(chunks)))
      p.entry({ name: 'extension/index.js' }, 'export default {}')
      p.finalize()
    })
    fake.archive(ext, tar)
    const r = await applyStack(fake, cfg, S, spec({ extensions: { tools: ext } }), deps)
    expect(existsSync(join(root, S, 'tools@999999999999', 'index.js'))).toBe(true)
    for (const name of [`${S}_web`, `${S}_worker`]) {
      const svc = fake.service(name)
      expect(svc?.Spec.TaskTemplate.ContainerSpec.Mounts).toContainEqual({
        Type: 'bind',
        Source: `/srv/ext/${S}/tools@999999999999`,
        Target: '/app/api/extensions/tools',
        ReadOnly: true
      })
      expect(svc?.Spec.TaskTemplate.Placement).toEqual({ Constraints: [`node.id==${NODE}`] })
    }
    expect(fake.containers.size).toBe(0)
    expect(fake.refused).toEqual([])
    fake.calls.length = 0
    const again = await applyStack(fake, cfg, S, spec({ extensions: { tools: ext } }), deps)
    expect(again.spec_hash).toBe(r.spec_hash)
    expect(fake.writes()).toEqual([])
  })

  it('an invalid extension stops the apply before any service is created', async () => {
    const ext = `nodeworks/nivaro@sha256:${'8'.repeat(64)}`
    const tar = await new Promise<Buffer>((resolve) => {
      const p = pack()
      const chunks: Buffer[] = []
      p.on('data', (c: Buffer) => chunks.push(c))
      p.on('end', () => resolve(Buffer.concat(chunks)))
      p.entry({ name: 'extension/evil', type: 'symlink', linkname: '/var/run/docker.sock' })
      p.finalize()
    })
    fake.archive(ext, tar)
    expect(await codeOf(applyStack(fake, cfg, S, spec({ extensions: { tools: ext } }), deps))).toBe(
      'EXTENSION_INVALID'
    )
    expect(fake.serviceNames()).toEqual([])
  })

  it('external redis: no redis service, no redis volume', async () => {
    await applyStack(
      fake,
      cfg,
      S,
      spec({ redis: 'external', env: { REDIS_URL: 'redis://r:6379' } }),
      deps
    )
    expect(fake.serviceNames()).toEqual([`${S}_web`, `${S}_worker`])
    expect([...fake.volumes.keys()]).toEqual([`nvh_${S}_uploads`])
  })

  it('volumes carry the configured driver config on the service mount', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    const m = fake.service(`${S}_web`)?.Spec.TaskTemplate.ContainerSpec.Mounts[0]
    expect(m).toMatchObject({ Type: 'volume', Source: `nvh_${S}_uploads` })
    expect(fake.refused).toEqual([])
  })
})

describe('ownership', () => {
  beforeEach(() => {
    fake.preexisting('efp_web', { 'com.docker.stack.namespace': 'efp' })
    fake.preexisting('efp_worker', { 'com.docker.stack.namespace': 'efp' })
  })

  it('a stack name used by unlabelled services: PUT, restart, DELETE and GET answer STACK_NOT_HUB, no writes', async () => {
    expect(await codeOf(applyStack(fake, cfg, 'efp', spec(), deps))).toBe('STACK_NOT_HUB')
    expect(await codeOf(restartStack(fake, cfg, 'efp', spec(), deps))).toBe('STACK_NOT_HUB')
    expect(await codeOf(removeStack(fake, cfg, 'efp', { removeVolumes: true }, deps))).toBe(
      'STACK_NOT_HUB'
    )
    expect(await codeOf(stackStatus(fake, 'efp'))).toBe('STACK_NOT_HUB')
    expect(fake.calls.filter(isWrite)).toEqual([])
    expect(fake.service('efp_web')?.Spec.Labels).toEqual({ 'com.docker.stack.namespace': 'efp' })
  })

  it('one unlabelled service among managed ones is still STACK_NOT_HUB', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.preexisting(`${S}_sidecar`, {})
    fake.calls.length = 0
    expect(await codeOf(applyStack(fake, cfg, S, spec({ image: IMAGE2 }), deps))).toBe(
      'STACK_NOT_HUB'
    )
    expect(await codeOf(removeStack(fake, cfg, S, { removeVolumes: false }, deps))).toBe(
      'STACK_NOT_HUB'
    )
    expect(fake.writes()).toEqual([])
  })

  it('a network or volume squatting the stack names without our labels is STACK_NOT_HUB', async () => {
    fake.volumes.set(`nvh_${S}_uploads`, {
      Name: `nvh_${S}_uploads`,
      Driver: 'local',
      Labels: {},
      Options: {},
      Scope: 'local'
    })
    expect(await codeOf(applyStack(fake, cfg, S, spec(), deps))).toBe('STACK_NOT_HUB')
    expect(fake.writes()).toEqual([])
  })

  it('labelled for app a, PUT for app b: STACK_OWNER_MISMATCH; another environment too', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.calls.length = 0
    expect(await codeOf(applyStack(fake, cfg, S, spec({ owner: { app: 'other' } }), deps))).toBe(
      'STACK_OWNER_MISMATCH'
    )
    expect(await codeOf(applyStack(fake, cfg, S, spec({ owner: { shared: 'acme' } }), deps))).toBe(
      'STACK_OWNER_MISMATCH'
    )
    expect(await codeOf(applyStack(fake, cfg, S, spec({ environment: 'production' }), deps))).toBe(
      'STACK_OWNER_MISMATCH'
    )
    expect(fake.writes()).toEqual([])
  })

  it('a hostname already routed by another managed stack is refused (no capture)', async () => {
    await applyStack(fake, cfg, 'one-st', spec(), deps)
    fake.calls.length = 0
    const err = await applyStack(fake, cfg, 'two-st', spec({ owner: { app: 'beta' } }), deps).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(StackError)
    expect(err.code).toBe('HOSTNAME_TAKEN')
    expect(err.status).toBe(409)
    expect(err.fields).toEqual([{ field: 'hostnames[0]', code: 'HOSTNAME_TAKEN' }])
    expect(fake.writes()).toEqual([])
    // The stack that already routes the name may keep it.
    await expect(
      applyStack(fake, cfg, 'one-st', spec({ image: IMAGE2 }), deps)
    ).resolves.toBeTruthy()
  })

  it('a hostname routed by a service the agent does not own is refused too', async () => {
    fake.preexisting('efp_edge', {
      'traefik.http.routers.efp.rule': 'Host(`efp.apps.corp`) || Host(`x.apps.corp`)'
    })
    expect(await codeOf(applyStack(fake, cfg, S, spec({ hostnames: ['x.apps.corp'] }), deps))).toBe(
      'HOSTNAME_TAKEN'
    )
    expect(fake.writes()).toEqual([])
  })

  it.each([
    ['double quotes', 'Host("x.apps.corp")'],
    ['escaped double quotes', 'Host(\\"x.apps.corp\\")'],
    ['HostHeader', 'HostHeader(`x.apps.corp`)'],
    ['HostHeader with double quotes', 'PathPrefix(`/a`) && HostHeader("x.apps.corp")'],
    ['several args', 'Host(`a.apps.corp`, "x.apps.corp")'],
    ['upper case', 'Host(`X.APPS.CORP`)'],
    ['a syntax the parser does not know (substring, fail closed)', 'HostRegexp(`x.apps.corp`)']
  ])('a hostname in a foreign rule with %s is taken', async (_n, rule) => {
    fake.preexisting('other_web', { 'traefik.http.routers.other.rule': rule })
    expect(await codeOf(applyStack(fake, cfg, S, spec({ hostnames: ['x.apps.corp'] }), deps))).toBe(
      'HOSTNAME_TAKEN'
    )
    expect(fake.writes()).toEqual([])
  })

  it('a managed service of the stack whose name lacks the <stack>_ prefix is STACK_NOT_HUB', async () => {
    fake.preexisting('odd-name', MANAGED(S))
    expect(await codeOf(applyStack(fake, cfg, S, spec(), deps))).toBe('STACK_NOT_HUB')
    expect(await codeOf(removeStack(fake, cfg, S, { removeVolumes: true }, deps))).toBe(
      'STACK_NOT_HUB'
    )
    expect(fake.writes()).toEqual([])
  })

  it('stack names that share a prefix stay apart', async () => {
    await applyStack(fake, cfg, 'ab', spec({ hostnames: ['ab.apps.corp'] }), deps)
    await applyStack(
      fake,
      cfg,
      'ab-c',
      spec({ owner: { app: 'other' }, hostnames: ['abc.apps.corp'] }),
      deps
    )
    await removeStack(fake, cfg, 'ab', { removeVolumes: true }, deps)
    expect(fake.serviceNames().filter((n) => n.startsWith('ab-c_'))).toHaveLength(3)
    expect([...fake.secrets.values()].every((s) => s.Spec.Name.startsWith('nvh_ab-c_'))).toBe(true)
    expect(fake.volumes.has('nvh_ab-c_uploads')).toBe(true)
  })
})

describe('stackStatus', () => {
  it('converged when every service carries the expected hash and runs as desired', async () => {
    const r = await applyStack(fake, cfg, S, spec(), deps)
    const st = await stackStatus(fake, S, r.spec_hash)
    expect(st).toMatchObject({
      name: S,
      owner: { app: 'acme' },
      environment: 'staging',
      spec_hash: r.spec_hash,
      image: IMAGE,
      state: 'converged',
      published_port: null
    })
    const web = st.services.find((s) => s.name === `${S}_web`)
    expect(web).toEqual({
      name: `${S}_web`,
      role: 'web',
      image: IMAGE,
      replicas: { desired: 2, running: 2 },
      update: 'none',
      message: null
    })
  })

  it('updating while the hash differs or an update runs; converged once done', async () => {
    const r1 = await applyStack(fake, cfg, S, spec(), deps)
    const r2 = await applyStack(fake, cfg, S, spec({ image: IMAGE2 }), deps)
    expect((await stackStatus(fake, S, r1.spec_hash)).state).toBe('updating')
    expect((await stackStatus(fake, S, r2.spec_hash)).state).toBe('updating')
    fake.completeUpdates()
    expect((await stackStatus(fake, S, r2.spec_hash)).state).toBe('converged')
  })

  it('rolled_back when swarm rolled an update back', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.failNextUpdate('rollback')
    const r = await applyStack(
      fake,
      cfg,
      S,
      spec({
        image: IMAGE2,
        roles: [
          { role: 'web', replicas: 2 },
          { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
        ]
      }),
      deps
    )
    expect((await stackStatus(fake, S, r.spec_hash)).state).toBe('rolled_back')
  })

  it('degraded when the hash matches but tasks do not run', async () => {
    const r = await applyStack(fake, cfg, S, spec(), deps)
    fake.taskState(`${S}_web`, 'starting')
    const st = await stackStatus(fake, S, r.spec_hash)
    expect(st.state).toBe('degraded')
    expect(st.services.find((s) => s.name === `${S}_web`)?.replicas).toEqual({
      desired: 2,
      running: 0
    })
  })

  it('paused when an update is paused', async () => {
    const r = await applyStack(fake, cfg, S, spec(), deps)
    const web = fake.service(`${S}_web`)
    if (web) web.UpdateStatus = { State: 'paused', Message: 'update paused' }
    expect((await stackStatus(fake, S, r.spec_hash)).state).toBe('paused')
  })

  it('unknown stack: STACK_NOT_FOUND (404)', async () => {
    const err = await stackStatus(fake, 'nope', null).catch((e) => e)
    expect(err).toMatchObject({ code: 'STACK_NOT_FOUND', status: 404 })
  })

  it('publish mode reports the published port', async () => {
    const pcfg = makeCfg({ HUB_AGENT_EDGE: 'publish', HUB_AGENT_PUBLISH_PORTS: '3110-3119' })
    const pf = new FakeEngine(pcfg)
    const r = await applyStack(pf, pcfg, S, spec({ hostnames: [], publish_port: 3112 }), deps)
    const st = await stackStatus(pf, S, r.spec_hash)
    expect(st.published_port).toBe(3112)
  })
})

describe('spec hash', () => {
  it('covers the agent edge mode and redis image, so a config change re-applies', async () => {
    const r1 = await applyStack(fake, cfg, S, spec(), deps)
    const cfg2 = makeCfg({ HUB_AGENT_REDIS_IMAGE: `redis@sha256:${'d'.repeat(64)}` })
    const f2 = new FakeEngine(cfg2)
    f2.services = fake.services
    f2.secrets = fake.secrets
    f2.networks = fake.networks
    f2.volumes = fake.volumes
    const r2 = await applyStack(f2, cfg2, S, spec(), deps)
    expect(r2.spec_hash).not.toBe(r1.spec_hash)
    expect(r2.changed).toEqual([`${S}_redis`])
    expect(stackHash(spec(), cfg, NODE)).toBe(r1.spec_hash)
    const pcfg = makeCfg({ HUB_AGENT_EDGE: 'publish', HUB_AGENT_PUBLISH_PORTS: '3110-3119' })
    expect(stackHash(spec({ hostnames: [] }), pcfg, NODE)).not.toBe(
      stackHash(spec({ hostnames: [] }), cfg, NODE)
    )
  })
})

describe('restartStack', () => {
  it('forces one update per service with ForceUpdate + 1, network names, current version', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    const before = new Map([...fake.services.values()].map((s) => [s.Spec.Name, s.Version.Index]))
    fake.calls.length = 0
    const r = await restartStack(fake, cfg, S, spec(), deps)
    expect(r.services).toEqual([`${S}_redis`, `${S}_web`, `${S}_worker`])
    const ups = updates(fake)
    expect(ups).toHaveLength(3)
    for (const u of ups) {
      const name = u.path.split('/')[2]
      expect(String(u.query?.version)).toBe(String(before.get(name)))
      expect((u.body as any).TaskTemplate.ForceUpdate).toBe(1)
      for (const n of (u.body as any).TaskTemplate.Networks)
        expect([`nvh_${S}`, 'edge']).toContain(n.Target)
    }
    expect(fake.refused).toEqual([])
    fake.calls.length = 0
    await restartStack(fake, cfg, S, spec(), deps)
    for (const u of updates(fake)) expect((u.body as any).TaskTemplate.ForceUpdate).toBe(2)
  })

  it('restart bodies are rendered fresh: equal to the apply body but for ForceUpdate', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    const created = new Map(creates(fake).map((c) => [(c.body as any).Name, c.body as any]))
    fake.calls.length = 0
    await restartStack(fake, cfg, S, spec(), deps)
    for (const u of updates(fake)) {
      const body = structuredClone(u.body as any)
      expect(body.TaskTemplate.ForceUpdate).toBe(1)
      delete body.TaskTemplate.ForceUpdate
      expect(body).toEqual(created.get(body.Name))
    }
  })

  it('a stack that does not exist is STACK_NOT_FOUND', async () => {
    expect(await codeOf(restartStack(fake, cfg, 'nope', spec(), deps))).toBe('STACK_NOT_FOUND')
  })

  it('a spec the stack does not run is SPEC_MISMATCH, nothing written', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.calls.length = 0
    expect(await codeOf(restartStack(fake, cfg, S, spec({ image: IMAGE2 }), deps))).toBe(
      'SPEC_MISMATCH'
    )
    expect(
      await codeOf(
        restartStack(
          fake,
          cfg,
          S,
          spec({ secrets: { DB_PASSWORD: 'other', SESSION_SECRET: 's'.repeat(64) } }),
          deps
        )
      )
    ).toBe('SPEC_MISMATCH')
    expect(fake.writes()).toEqual([])
  })

  it('restart runs the apply checks: owner mismatch and taken hostnames refuse', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    expect(await codeOf(restartStack(fake, cfg, S, spec({ owner: { app: 'beta' } }), deps))).toBe(
      'STACK_OWNER_MISMATCH'
    )
    fake.preexisting('efp_edge', {
      'traefik.http.routers.efp.rule': 'Host("acme-staging.apps.corp")'
    })
    fake.calls.length = 0
    expect(await codeOf(restartStack(fake, cfg, S, spec(), deps))).toBe('HOSTNAME_TAKEN')
    expect(fake.writes()).toEqual([])
  })

  it('an apply after a restart keeps the live ForceUpdate: unchanged services do not restart', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    await restartStack(fake, cfg, S, spec(), deps)
    fake.completeUpdates()
    const restartsBefore = new Map(fake.restarts)
    expect(restartsBefore.get(`${S}_redis`)).toBe(1)
    fake.calls.length = 0
    await applyStack(
      fake,
      cfg,
      S,
      spec({ env: { DB_HOST: 'db2.internal', NODE_ENV: 'production' } }),
      deps
    )
    const redisUpdate = updates(fake).find((u) => u.path === `/services/${S}_redis/update`)
    expect((redisUpdate?.body as any).TaskTemplate.ForceUpdate).toBe(1)
    // Redis was relabelled only: no new restart. Web and worker changed: one each.
    expect(fake.restarts.get(`${S}_redis`)).toBe(1)
    expect(fake.restarts.get(`${S}_web`)).toBe((restartsBefore.get(`${S}_web`) ?? 0) + 1)
    expect(fake.restarts.get(`${S}_worker`)).toBe((restartsBefore.get(`${S}_worker`) ?? 0) + 1)
  })
})

describe('removeStack', () => {
  it('removes services, secrets and the network; keeps volumes; answers names', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    mkdirSync(join(root, S, 'x@0123456789ab'), { recursive: true })
    writeFileSync(join(root, S, 'x@0123456789ab', 'index.js'), '')
    const secretNames = [...fake.secrets.values()].map((s) => s.Spec.Name).sort()
    const r = await removeStack(fake, cfg, S, { removeVolumes: false }, deps)
    expect(r.removed).toEqual({
      services: [`${S}_redis`, `${S}_web`, `${S}_worker`],
      secrets: secretNames,
      networks: [`nvh_${S}`],
      volumes: []
    })
    expect(fake.serviceNames()).toEqual([])
    expect(fake.secrets.size).toBe(0)
    expect(fake.networks.has(`nvh_${S}`)).toBe(false)
    expect([...fake.volumes.keys()].sort()).toEqual([`nvh_${S}_redis`, `nvh_${S}_uploads`])
    expect(existsSync(join(root, S))).toBe(false)
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/volumes/'))).toBe(
      false
    )
  })

  it('removes the managed volumes with the flag, and only those', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    fake.volumes.set(`nvh_${S}_foreign`, {
      Name: `nvh_${S}_foreign`,
      Driver: 'local',
      Labels: {},
      Options: {},
      Scope: 'local'
    })
    const r = await removeStack(fake, cfg, S, { removeVolumes: true }, deps)
    expect(r.removed.volumes).toEqual([`nvh_${S}_redis`, `nvh_${S}_uploads`])
    expect([...fake.volumes.keys()]).toEqual([`nvh_${S}_foreign`])
  })

  it('an object still in use is retried (400/403/409 only), then ENGINE_ERROR', async () => {
    await applyStack(fake, cfg, S, spec(), deps)
    const name = [...fake.secrets.values()][0].Spec.Name as string
    fake.secretInUse(name)
    let slept = 0
    const err = await removeStack(
      fake,
      cfg,
      S,
      { removeVolumes: false },
      { sleep: async () => void slept++, removeAttempts: 4 }
    ).catch((e) => e)
    expect(err).toMatchObject({ code: 'ENGINE_ERROR', status: 502 })
    expect(
      fake.calls.filter((c) => c.method === 'DELETE' && c.path === `/secrets/${name}`)
    ).toHaveLength(4)
    expect(slept).toBe(4)
  })

  it('a stack with nothing left answers empty lists', async () => {
    const r = await removeStack(fake, cfg, 'nope', { removeVolumes: true }, deps)
    expect(r.removed).toEqual({ services: [], secrets: [], networks: [], volumes: [] })
  })
})

describe('listStacks', () => {
  it('lists managed stacks only, never unlabelled ones', async () => {
    fake.preexisting('efp_web', { 'com.docker.stack.namespace': 'efp' })
    await applyStack(fake, cfg, S, spec(), deps)
    await applyStack(
      fake,
      cfg,
      'tools-p',
      spec({
        owner: { shared: 'tools' },
        environment: 'production',
        hostnames: ['tools.apps.corp'],
        redis: 'external',
        roles: [{ role: 'all', replicas: 1 }]
      }),
      deps
    )
    const list = await listStacks(fake)
    expect(list).toEqual([
      { name: S, owner: { app: 'acme' }, environment: 'staging', image: IMAGE, services: 3 },
      {
        name: 'tools-p',
        owner: { shared: 'tools' },
        environment: 'production',
        image: IMAGE,
        services: 1
      }
    ])
    expect(JSON.stringify(list)).not.toContain('efp')
  })
})

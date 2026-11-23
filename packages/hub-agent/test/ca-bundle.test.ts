// HUB_AGENT_CA_BUNDLE_FILE: the agent hands every app service of every stack (app stacks and Hub
// shared deployments) its company CA bundle as a swarm secret + NODE_EXTRA_CA_CERTS. Redis and
// the extension-unpack container never get it, and an agent WITHOUT a bundle renders and hashes
// exactly as before the option existed (pinned below).
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/config.js'
import { checkEngineCall } from '../src/engine.js'
import { caBundleSecretName, SECRET_NAME_MAX } from '../src/names.js'
import {
  CA_BUNDLE_ENV,
  type EngineServiceSpec,
  type RenderContext,
  renderServices
} from '../src/render.js'
import { forbiddenEnvKey, type StackSpec } from '../src/spec.js'
import { applyStack, restartStack, StackError, stackHash } from '../src/stacks.js'
import { FakeEngine } from './fake-engine.js'

const IMAGE = `nodeworks/nivaro@sha256:${'1'.repeat(64)}`
const REDIS = `redis@sha256:${'c'.repeat(64)}`
const TOKEN = 'agent-token-0123456789-abcdefghij'
const NODE = 'node-agent-1'
const EXT_ROOT = '/var/lib/nivaro-hub-agent/extensions'
const PEM_A = '-----BEGIN CERTIFICATE-----\nQ09SUC1ST09ULUE=\n-----END CERTIFICATE-----\n'
const PEM_B = '-----BEGIN CERTIFICATE-----\nQ09SUC1ST09ULUI=\n-----END CERTIFICATE-----\n'
const sha = (v: string) => createHash('sha256').update(v).digest('hex')
const shaJson = (v: unknown) => sha(JSON.stringify(v))

function makeCfg(over: Record<string, string> = {}, pem?: string, root = EXT_ROOT): AgentConfig {
  const files: Record<string, string> = { '/t': TOKEN }
  if (pem !== undefined) files['/ca.pem'] = pem
  return loadAgentConfig(
    {
      HUB_AGENT_TOKEN_FILE: '/t',
      HUB_AGENT_EDGE_NETWORK: 'edge',
      HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
      HUB_AGENT_REDIS_IMAGE: REDIS,
      HUB_AGENT_EXTENSIONS_ROOT: root,
      ...(pem !== undefined ? { HUB_AGENT_CA_BUNDLE_FILE: '/ca.pem' } : {}),
      ...over
    },
    (p) => {
      if (p in files) return files[p]
      throw new Error('ENOENT')
    }
  )
}

const appSpec = (over: Partial<StackSpec> = {}): StackSpec => ({
  owner: { app: 'acme' },
  environment: 'staging',
  image: IMAGE,
  roles: [
    { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
    { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
    { role: 'realtime', replicas: 1 },
    { role: 'importer', replicas: 1 }
  ],
  env: { DB_HOST: 'db.internal', NODE_ENV: 'production' },
  secrets: { DB_PASSWORD: 'pw-one', SESSION_SECRET: 's'.repeat(64) },
  hostnames: ['acme-staging.apps.corp'],
  redis: 'bundled',
  extensions: {},
  ...over
})

const sharedSpec = (over: Partial<StackSpec> = {}): StackSpec => ({
  owner: { shared: 'tools' },
  environment: 'shared',
  image: IMAGE,
  roles: [
    { role: 'web', replicas: 2 },
    { role: 'worker', replicas: 1 }
  ],
  env: { HUB_SHARED_DEPLOYMENT: 'tools', HUB_URL: 'https://hub.apps.corp' },
  secrets: { HUB_DEPLOYMENT_TOKEN: 't'.repeat(40) },
  hostnames: [],
  host_pattern: '*.apps.corp',
  redis: 'bundled',
  extensions: {},
  ...over
})

const ctx = (keys: string[], over: Partial<RenderContext> = {}): RenderContext => ({
  hash: 'h'.repeat(64),
  secretIds: Object.fromEntries(
    keys.map((k, i) => [k, { id: `sec${i}`, name: `nvh_st_${k}_0123456789ab` }])
  ),
  extensionPaths: {},
  agentNodeId: NODE,
  network: 'nvh_st',
  ...over
})

const envOf = (s: EngineServiceSpec | Record<string, any>): Record<string, string> =>
  Object.fromEntries(
    (s.TaskTemplate.ContainerSpec.Env as string[]).map((e) => [
      e.slice(0, e.indexOf('=')),
      e.slice(e.indexOf('=') + 1)
    ])
  )
const secretNames = (s: EngineServiceSpec | Record<string, any>): string[] =>
  (s.TaskTemplate.ContainerSpec.Secrets as Array<{ SecretName: string }>).map((x) => x.SecretName)

/**
 * Taken from the code BEFORE HUB_AGENT_CA_BUNDLE_FILE existed (agent 0.2.1, commit 3e7f721cb),
 * with these exact fixtures: an agent without a bundle must keep producing them, or every
 * running stack would show a different spec after the agent upgrade.
 */
const PINNED = {
  appRender: '2b1e85f0c515420eed109b793d691f4db6c395308b4e532251abdfcd19e19cab',
  sharedRender: '5d1ed03deec53b141dac6a7cae15708366ca9c846957b7c6e3e8c4977bead745',
  appHash: '290ee12f395c91661003bfd880986757c6f9cff8ff3858f866689397e105037b',
  sharedHash: '4dfba37d48be74212cc3df6fa14e35d538b5fdf81c54367e804b72f4da485662'
}

describe('CA bundle: an agent without one is unchanged', () => {
  const cfg = makeCfg()

  it('renders byte-identical services (app stack and shared deployment)', () => {
    expect(cfg.caBundle).toBeNull()
    const app = appSpec()
    const shared = sharedSpec()
    expect(shaJson(renderServices('st', app, cfg, ctx(Object.keys(app.secrets))))).toBe(
      PINNED.appRender
    )
    expect(shaJson(renderServices('st', shared, cfg, ctx(Object.keys(shared.secrets))))).toBe(
      PINNED.sharedRender
    )
  })

  it('keeps the stack hash exactly', () => {
    expect(stackHash(appSpec(), cfg, NODE)).toBe(PINNED.appHash)
    expect(stackHash(sharedSpec(), cfg, NODE)).toBe(PINNED.sharedHash)
  })

  it('no service carries NODE_EXTRA_CA_CERTS or a CA secret', () => {
    const svcs = renderServices('st', appSpec(), cfg, ctx(['DB_PASSWORD', 'SESSION_SECRET']))
    for (const s of svcs) {
      expect(envOf(s)[CA_BUNDLE_ENV]).toBeUndefined()
      expect(secretNames(s).some((n) => n.includes('_ca-'))).toBe(false)
    }
  })
})

describe('CA bundle: the stack hash', () => {
  it('covers the bundle: set, and changed, both give another hash', () => {
    const none = makeCfg()
    const a = makeCfg({}, PEM_A)
    const b = makeCfg({}, PEM_B)
    for (const spec of [appSpec(), sharedSpec()]) {
      const h0 = stackHash(spec, none, NODE)
      const ha = stackHash(spec, a, NODE)
      const hb = stackHash(spec, b, NODE)
      expect(new Set([h0, ha, hb]).size).toBe(3)
      // The same bundle read again is the same hash.
      expect(stackHash(spec, makeCfg({}, PEM_A), NODE)).toBe(ha)
    }
  })
})

describe('CA bundle: secret name', () => {
  it('nvh_<stack>_ca-<sha12>, ≤ 64 characters for the longest stack name', () => {
    const h = sha(PEM_A)
    expect(caBundleSecretName('acme-st', h)).toBe(`nvh_acme-st_ca-${h.slice(0, 12)}`)
    const longest = `a${'b'.repeat(40)}`
    expect(caBundleSecretName(longest, h).length).toBeLessThanOrEqual(SECRET_NAME_MAX)
    expect(() => caBundleSecretName('Bad_Stack', h)).toThrow()
    expect(() => caBundleSecretName('acme-st', 'nothex')).toThrow()
  })

  it('is not an env name, so Nivaro never reads the mounted file as a setting', () => {
    expect(/^[A-Z][A-Z0-9_]*$/.test(caBundleSecretName('acme-st', sha(PEM_A)))).toBe(false)
  })
})

describe('CA bundle: render', () => {
  const cfg = makeCfg({}, PEM_A)
  const CA = { id: 'caid0001', name: `nvh_st_ca-${sha(PEM_A).slice(0, 12)}` }

  it('every app role gets the secret (0400, uid/gid 1000) and NODE_EXTRA_CA_CERTS; Redis does not', () => {
    const spec = appSpec()
    const svcs = renderServices('st', spec, cfg, ctx(Object.keys(spec.secrets), { caBundle: CA }))
    expect(svcs.map((s) => s.Name)).toEqual([
      'st_web',
      'st_worker',
      'st_realtime',
      'st_importer',
      'st_redis'
    ])
    for (const s of svcs.filter((x) => x.Name !== 'st_redis')) {
      expect(envOf(s)[CA_BUNDLE_ENV]).toBe(`/run/secrets/${CA.name}`)
      const ref = s.TaskTemplate.ContainerSpec.Secrets.find((x) => x.SecretName === CA.name)
      expect(ref).toEqual({
        SecretID: CA.id,
        SecretName: CA.name,
        File: { Name: CA.name, UID: '1000', GID: '1000', Mode: 0o400 }
      })
      // The spec's own secrets are still there, in their order, the CA one last.
      expect(secretNames(s)).toEqual([
        'nvh_st_DB_PASSWORD_0123456789ab',
        'nvh_st_SESSION_SECRET_0123456789ab',
        CA.name
      ])
    }
    const redis = svcs.find((x) => x.Name === 'st_redis') as EngineServiceSpec
    expect(redis.TaskTemplate.ContainerSpec.Env).toEqual([])
    expect(redis.TaskTemplate.ContainerSpec.Secrets).toEqual([])
    // Redis renders exactly as it does without a bundle.
    const plain = renderServices('st', spec, makeCfg(), ctx(Object.keys(spec.secrets)))
    expect(redis).toEqual(plain.find((x) => x.Name === 'st_redis'))
  })

  it("the 'all' role (small) gets it too", () => {
    const spec = appSpec({ roles: [{ role: 'all', replicas: 1 }], redis: 'external' })
    const [all] = renderServices('st', spec, cfg, ctx(Object.keys(spec.secrets), { caBundle: CA }))
    expect(all.Name).toBe('st_all')
    expect(envOf(all)[CA_BUNDLE_ENV]).toBe(`/run/secrets/${CA.name}`)
    expect(secretNames(all)).toContain(CA.name)
  })

  it('a shared deployment: web and worker get it, Redis does not', () => {
    const spec = sharedSpec()
    const svcs = renderServices('st', spec, cfg, ctx(Object.keys(spec.secrets), { caBundle: CA }))
    for (const s of svcs) {
      if (s.Name === 'st_redis') {
        expect(secretNames(s)).toEqual([])
        expect(envOf(s)[CA_BUNDLE_ENV]).toBeUndefined()
      } else {
        expect(envOf(s)[CA_BUNDLE_ENV]).toBe(`/run/secrets/${CA.name}`)
        expect(secretNames(s)).toEqual(['nvh_st_HUB_DEPLOYMENT_TOKEN_0123456789ab', CA.name])
      }
    }
  })

  it('the bundle contents never appear in a rendered service', () => {
    const spec = appSpec()
    const svcs = renderServices('st', spec, cfg, ctx(Object.keys(spec.secrets), { caBundle: CA }))
    expect(JSON.stringify(svcs)).not.toContain('Q09SUC1ST09ULUE=')
  })

  it("refuses a CA secret that is not this stack's", () => {
    const spec = appSpec()
    expect(() =>
      renderServices(
        'st',
        spec,
        cfg,
        ctx(Object.keys(spec.secrets), { caBundle: { id: 'x1', name: 'nvh_other_ca-abc' } })
      )
    ).toThrow(/CA bundle/)
  })

  it('the engine guard accepts every rendered service', () => {
    for (const spec of [appSpec(), sharedSpec()]) {
      const svcs = renderServices('st', spec, cfg, ctx(Object.keys(spec.secrets), { caBundle: CA }))
      for (const body of svcs) {
        expect(() => checkEngineCall(cfg, 'POST', '/services/create', { body })).not.toThrow()
        expect(() =>
          checkEngineCall(cfg, 'POST', `/services/${body.Name}/update`, {
            query: { version: 3 },
            body
          })
        ).not.toThrow()
      }
    }
  })

  it('the spec still may not set NODE_EXTRA_CA_CERTS, as env or as a secret / _FILE', () => {
    for (const redis of ['bundled', 'external'])
      for (const k of [CA_BUNDLE_ENV, `${CA_BUNDLE_ENV}_FILE`])
        expect(forbiddenEnvKey(k, redis)).toBe(true)
  })
})

describe('CA bundle: apply, restart, rotation', () => {
  const S = 'acme-st'
  const SH = 'tools-sh'
  const deps = { nodeId: NODE, sleep: async () => {} }
  let root: string
  let cfg: AgentConfig
  let fake: FakeEngine

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hub-agent-ca-'))
    cfg = makeCfg({}, PEM_A, root)
    fake = new FakeEngine(cfg)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const secretByName = (f: FakeEngine, n: string) =>
    [...f.secrets.values()].find((s) => s.Spec.Name === n)

  it('creates one labelled secret per stack holding the PEM; app services reference it, Redis not', async () => {
    const r = await applyStack(fake, cfg, S, appSpec(), deps)
    expect(r.spec_hash).toBe(stackHash(appSpec(), cfg, NODE))
    const caName = caBundleSecretName(S, sha(PEM_A))
    const sec = secretByName(fake, caName)
    expect(sec?.Spec.Labels).toEqual({
      'nivaro.hub.managed': '1',
      'com.docker.stack.namespace': S,
      'nivaro.hub.app': 'acme',
      'nivaro.hub.env': 'staging'
    })
    expect(Buffer.from(sec?.Spec.Data, 'base64').toString('utf8')).toBe(PEM_A)
    for (const n of fake.serviceNames()) {
      const s = fake.service(n)?.Spec as Record<string, any>
      if (n === `${S}_redis`) {
        expect(secretNames(s)).toEqual([])
        expect(envOf(s)[CA_BUNDLE_ENV]).toBeUndefined()
      } else {
        expect(secretNames(s)).toContain(caName)
        expect(envOf(s)[CA_BUNDLE_ENV]).toBe(`/run/secrets/${caName}`)
      }
    }
    // Every call passed the real allow-list and body guard.
    expect(fake.refused).toEqual([])
    // Applying again changes nothing and creates no second CA secret.
    fake.completeUpdates()
    fake.calls.length = 0
    const again = await applyStack(fake, cfg, S, appSpec(), deps)
    expect(again.changed).toEqual([])
    expect(fake.writes()).toEqual([])
  })

  it('a shared deployment stack gets it the same way', async () => {
    await applyStack(fake, cfg, SH, sharedSpec(), deps)
    const caName = caBundleSecretName(SH, sha(PEM_A))
    expect(secretByName(fake, caName)?.Spec.Labels).toMatchObject({
      'nivaro.hub.managed': '1',
      'com.docker.stack.namespace': SH,
      'nivaro.hub.shared': 'tools'
    })
    expect(secretNames(fake.service(`${SH}_web`)?.Spec as object)).toContain(caName)
    expect(secretNames(fake.service(`${SH}_worker`)?.Spec as object)).toContain(caName)
    expect(secretNames(fake.service(`${SH}_redis`)?.Spec as object)).toEqual([])
    expect(fake.refused).toEqual([])
  })

  it('restart works while the bundle is unchanged', async () => {
    await applyStack(fake, cfg, S, appSpec(), deps)
    fake.completeUpdates()
    await expect(restartStack(fake, cfg, S, appSpec(), deps)).resolves.toBeTruthy()
    expect(fake.refused).toEqual([])
  })

  it('a changed bundle: restart is SPEC_MISMATCH; apply makes a new secret and prunes the old', async () => {
    await applyStack(fake, cfg, S, appSpec(), deps)
    fake.completeUpdates()
    const oldName = caBundleSecretName(S, sha(PEM_A))
    const cfgB = makeCfg({}, PEM_B, root)
    const fb = new FakeEngine(cfgB)
    fb.services = fake.services
    fb.secrets = fake.secrets
    fb.networks = fake.networks
    fb.volumes = fake.volumes

    const err = await restartStack(fb, cfgB, S, appSpec(), deps).catch((e) => e)
    expect(err).toBeInstanceOf(StackError)
    expect(err.code).toBe('SPEC_MISMATCH')
    expect(fb.writes()).toEqual([])

    const r = await applyStack(fb, cfgB, S, appSpec(), deps)
    const newName = caBundleSecretName(S, sha(PEM_B))
    expect(newName).not.toBe(oldName)
    // Redis is only relabelled (its task template has no bundle), the app services change.
    expect(r.changed).toEqual([`${S}_importer`, `${S}_realtime`, `${S}_web`, `${S}_worker`])
    expect(r.unchanged).toEqual([`${S}_redis`])
    const names = [...fb.secrets.values()].map((s) => s.Spec.Name)
    expect(names).toContain(newName)
    // Kept while the update runs (swarm's automatic rollback needs it) …
    expect(names).toContain(oldName)
    fb.completeUpdates()
    fb.calls.length = 0
    await applyStack(fb, cfgB, S, appSpec(), deps)
    // … and pruned like any rotated secret once nothing can roll back to it.
    expect([...fb.secrets.values()].map((s) => s.Spec.Name)).not.toContain(oldName)
    expect(fb.writes()).toEqual([{ method: 'DELETE', path: `/secrets/${oldName}` }])
    expect(fb.refused).toEqual([])
  })

  it('turning the bundle off removes the env + secret from app services and prunes it', async () => {
    await applyStack(fake, cfg, S, appSpec(), deps)
    fake.completeUpdates()
    const caName = caBundleSecretName(S, sha(PEM_A))
    const off = makeCfg({}, undefined, root)
    const fo = new FakeEngine(off)
    fo.services = fake.services
    fo.secrets = fake.secrets
    fo.networks = fake.networks
    fo.volumes = fake.volumes
    const r = await applyStack(fo, off, S, appSpec(), deps)
    expect(r.spec_hash).toBe(stackHash(appSpec(), off, NODE))
    for (const n of fo.serviceNames()) {
      const s = fo.service(n)?.Spec as Record<string, any>
      expect(envOf(s)[CA_BUNDLE_ENV]).toBeUndefined()
      expect(secretNames(s)).not.toContain(caName)
    }
    fo.completeUpdates()
    await applyStack(fo, off, S, appSpec(), deps)
    expect([...fo.secrets.values()].map((s) => s.Spec.Name)).not.toContain(caName)
    expect(fo.refused).toEqual([])
  })
})

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StackSpec } from '../../../services/hub/docker/agent-types.js'
import {
  explicitHostsFor,
  patternCovers,
  type RenderSharedInput,
  recordedSharedRoles,
  renderSharedSpec,
  SharedRenderError,
  sharedRealtimeFits,
  sharedRedisPrefix,
  sharedRoles
} from '../../../services/hub/shared/stack-render.js'
import { type SharedDeployment, validateSharedInput } from '../../../services/hub/shared/store.js'

// Nivaro Hub phase 6, Task 5: the StackSpec of a Docker shared deployment. Pure. Every spec the
// renderer emits must pass the Hub agent's OWN validator (packages/hub-agent/src/spec.ts, loaded by
// a computed path so the API's tsc never compiles the agent), shared owner included.

type AgentSpecModule = {
  validateStackSpec: (
    body: unknown,
    cfg: {
      images: readonly string[]
      edge: 'traefik' | 'publish'
      hostSuffixes: readonly string[]
      publishPorts: readonly [number, number] | null
      redisImage: string | null
    }
  ) => { ok: true; spec: StackSpec } | { ok: false; fields: Array<{ field: string; code: string }> }
}

const AGENT_SPEC = resolve(import.meta.dirname, '../../../../../packages/hub-agent/src/spec.ts')
const agent = (await import(/* @vite-ignore */ pathToFileURL(AGENT_SPEC).href)) as AgentSpecModule

const TOKEN = 'dep-Token-0123456789-abcdefghijklmnopqrstu'
const SESSION = 's'.repeat(8) + '0123456789abcdef'.repeat(4)
const ENC = 'ab'.repeat(32)
const IMAGE = `nodeworks/nivaro@sha256:${'a'.repeat(64)}`
const EXT = `registry.example.com/acme/tools-ext@sha256:${'b'.repeat(64)}`
const EXT2 = `registry.example.com/acme/tools-ext@sha256:${'c'.repeat(64)}`

function shared(over: Partial<SharedDeployment> = {}): SharedDeployment {
  return {
    id: 1,
    key: 'shared-one',
    name: 'Shared one',
    mode: 'docker',
    driver_id: 3,
    stack: 'shared-one',
    version_pin: '0.3.209',
    extensions: ['reports', 'alpha'],
    extension_pins: {},
    host_pattern: '*.apps.example.com',
    link_url: 'https://shared-one.internal.example.com',
    pool_budget: 60,
    status: 'active',
    settings: {},
    token: '••••••',
    last_seen_at: null,
    created_at: null,
    updated_at: null,
    ...over
  }
}

function input(over: Partial<RenderSharedInput> = {}): RenderSharedInput {
  return {
    shared: shared(),
    driver: {
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_target: null
    },
    edge: 'traefik',
    secrets: { SESSION_SECRET: SESSION, ENCRYPTION_KEY: ENC },
    token: TOKEN,
    version: '0.3.210',
    image: IMAGE,
    extensions: { reports: EXT, alpha: EXT2 },
    hubPublicUrl: 'https://hub.example.com/',
    explicitHosts: ['crm.example.com'],
    ...over
  }
}

const cfg = (edge: 'traefik' | 'publish') => ({
  images: ['nodeworks/nivaro', 'registry.example.com/acme/tools-ext'],
  edge,
  hostSuffixes: ['.example.com'],
  publishPorts: [31000, 31099] as const,
  redisImage: `redis@sha256:${'3'.repeat(64)}`
})

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof SharedRenderError) return err.code
    throw err
  }
  throw new Error('expected a SharedRenderError')
}

describe('renderSharedSpec', () => {
  it('a shared owner with the deployment key as env and the token only under secrets', () => {
    const spec = renderSharedSpec(input())
    expect(spec.owner).toEqual({ shared: 'shared-one' })
    expect(spec.environment).toBe('shared')
    expect(spec.env.HUB_SHARED_DEPLOYMENT).toBe('shared-one')
    expect(spec.secrets.HUB_DEPLOYMENT_TOKEN).toBe(TOKEN)
    expect(spec.env.HUB_DEPLOYMENT_TOKEN).toBeUndefined()
    expect(JSON.stringify(spec.env)).not.toContain(TOKEN)
    expect(spec.secrets.SESSION_SECRET).toBe(SESSION)
    expect(spec.secrets.ENCRYPTION_KEY).toBe(ENC)
    expect(JSON.stringify(spec.env)).not.toContain(ENC)
    expect(spec.env.HUB_URL).toBe('https://hub.example.com')
    expect(spec.env.TRUST_PROXY).toBe('1')
    expect(spec.env.REDIS_CHANNEL_PREFIX).toBe(sharedRedisPrefix('shared-one'))
  })

  it('no DB_ key anywhere: every app brings its own database through the list', () => {
    const spec = renderSharedSpec(input())
    expect(Object.keys(spec.env).filter((k) => k.startsWith('DB_'))).toEqual([])
    expect(Object.keys(spec.secrets).filter((k) => k.startsWith('DB_'))).toEqual([])
  })

  it('joins the allow-listed extensions (sorted) and pins each one', () => {
    const spec = renderSharedSpec(input())
    expect(spec.env.HUB_SHARED_EXTENSIONS).toBe('alpha,reports')
    expect(spec.extensions).toEqual({ alpha: EXT2, reports: EXT })
    expect(code(() => renderSharedSpec(input({ extensions: { reports: EXT } })))).toBe(
      'EXTENSION_UNPINNED'
    )
  })

  it('routes the pattern as host_pattern and a placed name outside it as a hostname', () => {
    const spec = renderSharedSpec(
      input({ explicitHosts: ['a.apps.example.com', 'crm.example.com', 'CRM.example.com'] })
    )
    expect(spec.host_pattern).toBe('*.apps.example.com')
    expect(spec.hostnames).toEqual(['crm.example.com'])
  })

  it('small: one all-role service, exactly as before', () => {
    const spec = renderSharedSpec(input({ shared: shared({ settings: { size: 'small' } }) }))
    expect(spec.roles).toEqual([{ role: 'all', replicas: 1, cpus: 2, memory_mb: 4096 }])
    expect(sharedRoles('small')).toEqual(spec.roles)
  })

  it('medium and large split the roles: web, worker (the only cron ticker), importer, exporter', () => {
    for (const [size, web] of [
      ['medium', 2],
      ['large', 3]
    ] as const) {
      const spec = renderSharedSpec(input({ shared: shared({ settings: { size } }) }))
      expect(spec.roles, size).toEqual([
        { role: 'web', replicas: web, cpus: 2, memory_mb: 4096, env: { CRON_TICKS: 'off' } },
        { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
        { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 },
        { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }
      ])
      expect(spec.roles.some((r) => r.role === 'all' || r.role === 'realtime')).toBe(false)
      // Every role serves every app: one env block (the deployment key included), one set of
      // secrets; a role carries only its own role keys.
      expect(spec.env.HUB_SHARED_DEPLOYMENT).toBe('shared-one')
      for (const r of spec.roles)
        expect(Object.keys(r.env ?? {}).every((k) => k === 'CRON_TICKS')).toBe(true)
      // The worker is the one role that ticks crons: the importer and the exporter are
      // role-gated (cron-ticks.ts), every other role says CRON_TICKS=off.
      for (const r of spec.roles) if (r.role === 'web') expect(r.env?.CRON_TICKS).toBe('off')
      for (const r of ['importer', 'exporter'])
        expect(spec.roles.find((x) => x.role === r)?.env).toBeUndefined()
      expect(spec.roles.find((r) => r.role === 'worker')?.env).toBeUndefined()
    }
  })

  it('sharedRoles is the one list, and every render gets its own copy', () => {
    for (const size of ['small', 'medium', 'large'] as const)
      expect(renderSharedSpec(input({ shared: shared({ settings: { size } }) })).roles).toEqual(
        sharedRoles(size)
      )
    const a = renderSharedSpec(input({ shared: shared({ settings: { size: 'medium' } }) }))
    a.roles[0].replicas = 9
    if (a.roles[0].env) a.roles[0].env.CRON_TICKS = 'on'
    expect(sharedRoles('medium')[0]).toMatchObject({ replicas: 2, env: { CRON_TICKS: 'off' } })
  })

  it('golden: a small stack renders byte-for-byte as before the role split', () => {
    const sha = (spec: StackSpec) => createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    expect(sha(renderSharedSpec(input()))).toBe(
      '66bf884c6a31ef245749048b288dc53ff94893440c4dd810bf24808f584e8af2'
    )
    expect(
      sha(
        renderSharedSpec(
          input({ shared: shared({ settings: { size: 'small', env: { MAIL_FROM: 'a@b.c' } } }) })
        )
      )
    ).toBe('865025cf07b9a57091dfddf0f92f9533efe7b680821e1ef9a87028e5405bc1b1')
    expect(
      sha(
        renderSharedSpec(
          input({
            edge: 'publish',
            shared: shared({
              settings: { size: 'small', redis: 'external', publish_port: 31005 }
            }),
            secrets: {
              SESSION_SECRET: SESSION,
              ENCRYPTION_KEY: ENC,
              REDIS_URL: 'redis://:pw@redis.internal:6379'
            }
          })
        )
      )
    ).toBe('ed6cf0c2f27147928f165acf00e4bd700b3bc7b146ebb06b28da4e31086c70d9')
  })

  it('every spec passes the agent’s own validator (sizes × edges × redis modes)', () => {
    for (const size of ['small', 'medium', 'large'])
      for (const edge of ['traefik', 'publish'] as const)
        for (const redis of ['bundled', 'external']) {
          const spec = renderSharedSpec(
            input({
              edge,
              shared: shared({ settings: { size, redis, publish_port: 31005 } }),
              secrets: {
                SESSION_SECRET: SESSION,
                ENCRYPTION_KEY: ENC,
                ...(redis === 'external' ? { REDIS_URL: 'redis://:pw@redis.internal:6379' } : {})
              }
            })
          )
          const v = agent.validateStackSpec(JSON.parse(JSON.stringify(spec)), cfg(edge))
          expect(v, `${size}/${edge}/${redis}: ${JSON.stringify(v)}`).toMatchObject({ ok: true })
        }
  })

  it('large with realtime: realtime ×2 (1 CPU, 2 GB), web SOCKETS=off; the agent takes it', () => {
    const roles = sharedRoles('large', { realtime: true })
    expect(roles).toEqual([
      {
        role: 'web',
        replicas: 3,
        cpus: 2,
        memory_mb: 4096,
        env: { CRON_TICKS: 'off', SOCKETS: 'off' }
      },
      { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
      { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 2048 },
      { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 },
      { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }
    ])
    // Medium never runs realtime; without the flag large keeps sockets on web.
    expect(sharedRoles('medium', { realtime: true }).map((r) => r.role)).not.toContain('realtime')
    expect(sharedRoles('large')[0].env).toEqual({ CRON_TICKS: 'off' })
    for (const explicitHosts of [['a.example.com'], []]) {
      const spec = renderSharedSpec(
        input({ shared: shared({ settings: { size: 'large' } }), explicitHosts, roles })
      )
      expect(
        agent.validateStackSpec(JSON.parse(JSON.stringify(spec)), cfg('traefik'))
      ).toMatchObject({ ok: true })
    }
  })

  it('sharedRealtimeFits: image from 0.3.212, Traefik edge, not v2', () => {
    expect(sharedRealtimeFits('0.3.212', 'traefik', 3)).toBe(true)
    expect(sharedRealtimeFits('0.3.300', 'traefik', null)).toBe(true)
    expect(sharedRealtimeFits('v0.4.0', 'traefik')).toBe(true)
    expect(sharedRealtimeFits('0.3.211', 'traefik', 3)).toBe(false)
    expect(sharedRealtimeFits('0.3.212', 'traefik', 2)).toBe(false)
    expect(sharedRealtimeFits('0.3.212', 'publish', 3)).toBe(false)
    expect(sharedRealtimeFits('latest', 'traefik', 3)).toBe(false)
    expect(sharedRealtimeFits(null, 'traefik', 3)).toBe(false)
  })

  it('recorded roles with realtime rebuild web with SOCKETS=off', () => {
    const roles = recordedSharedRoles([
      { role: 'web', replicas: 3 },
      { role: 'worker', replicas: 1 },
      { role: 'realtime', replicas: 2 }
    ])
    expect(roles?.[0].env).toEqual({ CRON_TICKS: 'off', SOCKETS: 'off' })
    expect(roles?.[2]).toEqual({ role: 'realtime', replicas: 2, cpus: 1, memory_mb: 2048 })
    expect(
      recordedSharedRoles([
        { role: 'web', replicas: 3 },
        { role: 'worker', replicas: 1 }
      ])?.[0].env
    ).toEqual({ CRON_TICKS: 'off' })
  })

  it('a pattern-only stack (no explicit names) passes the agent too', () => {
    const spec = renderSharedSpec(input({ explicitHosts: [] }))
    expect(spec.hostnames).toEqual([])
    expect(agent.validateStackSpec(JSON.parse(JSON.stringify(spec)), cfg('traefik'))).toMatchObject(
      { ok: true }
    )
  })

  it('refuses what the agent would refuse, with codes', () => {
    expect(
      code(() =>
        renderSharedSpec(
          input({ explicitHosts: Array.from({ length: 11 }, (_, i) => `n${i}.example.com`) })
        )
      )
    ).toBe('TOO_MANY_HOSTNAMES')
    expect(
      code(() =>
        renderSharedSpec(input({ shared: shared({ host_pattern: null }), explicitHosts: [] }))
      )
    ).toBe('NO_ROUTE')
    expect(code(() => renderSharedSpec(input({ explicitHosts: ['bad_name.example.com'] })))).toBe(
      'HOSTNAME_INVALID'
    )
    expect(
      code(() => renderSharedSpec(input({ shared: shared({ settings: { redis: 'external' } }) })))
    ).toBe('REDIS_URL_MISSING')
    expect(code(() => renderSharedSpec(input({ edge: 'publish' })))).toBe('PUBLISH_PORT_REQUIRED')
    expect(code(() => renderSharedSpec(input({ hubPublicUrl: '' })))).toBe('HUB_URL_UNUSABLE')
  })

  it('HUB_URL is the origin of the Hub address, never a path (review minor 2)', () => {
    expect(
      renderSharedSpec(input({ hubPublicUrl: 'https://hub.example.com/x/y?z=1' })).env.HUB_URL
    ).toBe('https://hub.example.com')
    expect(code(() => renderSharedSpec(input({ hubPublicUrl: 'not a url' })))).toBe(
      'HUB_URL_UNUSABLE'
    )
    expect(code(() => renderSharedSpec(input({ hubPublicUrl: 'ftp://hub.example.com' })))).toBe(
      'HUB_URL_UNUSABLE'
    )
  })

  it('refuses a spec without the deployment secrets (review minor 1)', () => {
    expect(code(() => renderSharedSpec(input({ secrets: { ENCRYPTION_KEY: ENC } })))).toBe(
      'SECRETS_MISSING'
    )
    expect(code(() => renderSharedSpec(input({ secrets: { SESSION_SECRET: SESSION } })))).toBe(
      'SECRETS_MISSING'
    )
  })

  it('the publish edge sends no names and no pattern', () => {
    const spec = renderSharedSpec(
      input({ edge: 'publish', shared: shared({ settings: { publish_port: 31001 } }) })
    )
    expect(spec.hostnames).toEqual([])
    expect(spec.host_pattern).toBeUndefined()
    expect(spec.publish_port).toBe(31001)
    expect(spec.env.COOKIE_SECURE).toBeUndefined()
  })
})

describe('extension pins as the PATCH stores them (ruling P6-16)', () => {
  it('a pin that passes validateSharedInput renders; a version string never does', () => {
    const v = validateSharedInput({
      key: 'shared-one',
      name: 'Shared one',
      link_url: 'https://shared-one.internal.example.com',
      extensions: ['reports'],
      extension_pins: { reports: EXT }
    })
    if (!v.ok) throw new Error(v.code)
    const spec = renderSharedSpec(
      input({
        shared: shared({ extensions: v.row.extensions, extension_pins: v.row.extension_pins }),
        extensions: v.row.extension_pins
      })
    )
    expect(spec.extensions).toEqual({ reports: EXT })
    expect(agent.validateStackSpec(JSON.parse(JSON.stringify(spec)), cfg('traefik'))).toMatchObject(
      { ok: true }
    )
    expect(
      code(() =>
        renderSharedSpec(
          input({ shared: shared({ extensions: ['reports'] }), extensions: { reports: '1.2.3' } })
        )
      )
    ).toBe('EXTENSION_UNPINNED')
  })
})

describe('pattern helpers', () => {
  it('a pattern covers exactly one label in front of its name', () => {
    expect(patternCovers('*.apps.example.com', 'a.apps.example.com')).toBe(true)
    expect(patternCovers('*.apps.example.com', 'A-1.apps.example.com')).toBe(true)
    expect(patternCovers('*.apps.example.com', 'a.b.apps.example.com')).toBe(false)
    expect(patternCovers('*.apps.example.com', 'apps.example.com')).toBe(false)
    expect(patternCovers('*.apps.example.com', 'a.apps.example.com.evil.com')).toBe(false)
    expect(patternCovers(null, 'a.apps.example.com')).toBe(false)
  })

  it('explicitHostsFor keeps names outside the pattern, each once', () => {
    expect(
      explicitHostsFor(
        ['a.apps.example.com', 'crm.example.com', ' CRM.example.com ', 'x.y.apps.example.com'],
        '*.apps.example.com'
      )
    ).toEqual(['crm.example.com', 'x.y.apps.example.com'])
  })
})

describe('deployment-wide variables (settings.env)', () => {
  it('reach the stack env, pass the agent, and never override a Hub key', () => {
    const spec = renderSharedSpec(
      input({ shared: shared({ settings: { env: { CREATE_SCOPE_GUARD: 'on' } } }) })
    )
    expect(spec.env.CREATE_SCOPE_GUARD).toBe('on')
    expect(spec.env.HUB_SHARED_DEPLOYMENT).toBe('shared-one')
    expect(agent.validateStackSpec(spec, cfg('traefik')).ok).toBe(true)
  })

  it('the flow script switch (FLOW_SCRIPTS_ON_SHARED) is off unless saved, and reaches the stack when on', () => {
    expect(
      renderSharedSpec(input({ shared: shared({}) })).env.FLOW_SCRIPTS_ON_SHARED
    ).toBeUndefined()
    const spec = renderSharedSpec(
      input({ shared: shared({ settings: { env: { FLOW_SCRIPTS_ON_SHARED: 'on' } } }) })
    )
    expect(spec.env.FLOW_SCRIPTS_ON_SHARED).toBe('on')
    expect(agent.validateStackSpec(spec, cfg('traefik')).ok).toBe(true)
  })

  it('a Hub key in settings.env is refused at render and at save', () => {
    expect(
      code(() =>
        renderSharedSpec(
          input({ shared: shared({ settings: { env: { HUB_URL: 'https://x.example.com' } } }) })
        )
      )
    ).toBe('KEY_REFUSED')
    const saved = validateSharedInput({
      key: 'shared-two',
      name: 'Shared two',
      mode: 'registered',
      link_url: 'https://shared-two.example.com',
      settings: { env: { NODE_ENV: 'development' } }
    })
    expect(saved.ok).toBe(false)
  })

  it('save judges keys as stack settings: unknown, credential-like and multi-line values refused', () => {
    const base = {
      key: 'shared-two',
      name: 'Shared two',
      mode: 'registered',
      link_url: 'https://shared-two.example.com'
    }
    expect(
      validateSharedInput({ ...base, settings: { env: { CREATE_SCOPE_GUARD: 'on' } } }).ok
    ).toBe(true)
    expect(validateSharedInput({ ...base, settings: { env: { NOT_A_NIVARO_KEY: 'x' } } }).ok).toBe(
      false
    )
    expect(validateSharedInput({ ...base, settings: { env: { DB_PASSWORD: 'x' } } }).ok).toBe(false)
    expect(validateSharedInput({ ...base, settings: { env: ['x'] } }).ok).toBe(false)
  })

  it('no settings.env: the stack env is unchanged', () => {
    const before = renderSharedSpec(input())
    const after = renderSharedSpec(input({ shared: shared({ settings: { env: {} } }) }))
    expect(after.env).toEqual(before.env)
  })
})

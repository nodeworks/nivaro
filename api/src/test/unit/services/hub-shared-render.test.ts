import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StackSpec } from '../../../services/hub/docker/agent-types.js'
import {
  explicitHostsFor,
  patternCovers,
  type RenderSharedInput,
  renderSharedSpec,
  SharedRenderError,
  sharedRedisPrefix
} from '../../../services/hub/shared/stack-render.js'
import type { SharedDeployment } from '../../../services/hub/shared/store.js'

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

  it('one all-role service by size, never a realtime role', () => {
    for (const [size, replicas] of [
      ['small', 1],
      ['medium', 2],
      ['large', 3]
    ] as const) {
      const spec = renderSharedSpec(input({ shared: shared({ settings: { size } }) }))
      expect(spec.roles).toHaveLength(1)
      expect(spec.roles[0]).toMatchObject({ role: 'all', replicas })
      expect(spec.roles.some((r) => r.role === 'realtime')).toBe(false)
    }
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

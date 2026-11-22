import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DockerDriverConfig } from '../../../services/hub/docker/driver-config.js'
import { hostnameProblems, renderStackSpec } from '../../../services/hub/docker/render-spec.js'
import { agentRefusesEnvKey, databaseEnvFor } from '../../../services/hub/docker/stack-env.js'
import type { StackSettingsRow } from '../../../services/hub/docker/stack-settings.js'
import { STACK_TEMPLATES, templateFor } from '../../../services/hub/docker/templates.js'
import type { HubEnvironmentRow } from '../../../services/hub/promote-types.js'

// Nivaro Hub phase 4, Task 7: the Hub-side renderer. Its output for the fixture input must be
// exactly the agent's committed contract example (packages/hub-agent/contract).

type RenderInput = Parameters<typeof renderStackSpec>[0]

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const FIXTURE = readJson('../../fixtures/hub-render-input.json') as RenderInput
const EXAMPLE = readJson('../../../../../packages/hub-agent/contract/stack-spec.example.json')

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  ...structuredClone(FIXTURE),
  ...over
})
const withEnv = (over: Partial<HubEnvironmentRow>) =>
  input({ env: { ...structuredClone(FIXTURE.env), ...over } })
const withRow = (over: Partial<StackSettingsRow>) =>
  input({ row: { ...structuredClone(FIXTURE.row), ...over } })

describe('templateFor', () => {
  it('picks the highest template at or below the version', () => {
    expect(templateFor('0.3.208')).toBe(STACK_TEMPLATES.find((t) => t.from === '0.3.0'))
    expect(templateFor('0.3.0').from).toBe('0.3.0')
    expect(templateFor('1.0.0').from).toBe('0.3.0')
  })

  it('refuses a version below every template with TEMPLATE_NONE', () => {
    expect(() => templateFor('0.2.9')).toThrow(expect.objectContaining({ code: 'TEMPLATE_NONE' }))
  })

  it('has the Decision 7 sizes', () => {
    const t = templateFor('0.3.208').sizes
    expect(t.small).toEqual([{ role: 'all', replicas: 1, cpus: 2, memory_mb: 3072 }])
    expect(t.medium).toEqual([
      { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
      { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
    ])
    expect(t.large).toEqual([
      { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
      { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
      { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 1024 },
      { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 }
    ])
  })
})

describe('renderStackSpec', () => {
  it('renders the fixture into exactly the agent contract example', () => {
    expect(renderStackSpec(input())).toEqual(EXAMPLE)
  })

  it('emits no key the agent refuses, as env or as a secret', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const spec = renderStackSpec(withRow({ size }))
      for (const k of Object.keys(spec.env)) {
        expect(agentRefusesEnvKey(k, spec.redis), k).toBe(false)
        expect(Object.hasOwn(spec.secrets, k), k).toBe(false)
      }
      for (const k of Object.keys(spec.secrets))
        expect(agentRefusesEnvKey(k, spec.redis)).toBe(false)
    }
  })

  it('keeps a TRUST_PROXY the settings set, adds HUB_URL when given', () => {
    const row = structuredClone(FIXTURE.row)
    row.settings.TRUST_PROXY = '10.0.0.0/8'
    const spec = renderStackSpec({
      ...input({ row }),
      hubPublicUrl: 'https://hub.example.com/'
    })
    expect(spec.env.TRUST_PROXY).toBe('10.0.0.0/8')
    expect(spec.env.HUB_URL).toBe('https://hub.example.com')
    expect(renderStackSpec(input()).env).not.toHaveProperty('HUB_URL')
  })

  it('names the environment for Nivaro, other for an unknown key', () => {
    expect(renderStackSpec(withEnv({ key: 'production' })).env.NIVARO_ENVIRONMENT).toBe(
      'production'
    )
    expect(renderStackSpec(withEnv({ key: 'test' })).env.NIVARO_ENVIRONMENT).toBe('test')
    expect(renderStackSpec(withEnv({ key: 'prod' })).env.NIVARO_ENVIRONMENT).toBe('other')
  })

  it('takes PUBLIC_URL / ADMIN_URL from base_url without a trailing slash', () => {
    const spec = renderStackSpec(withEnv({ base_url: 'https://x.apps.example.com/' }))
    expect(spec.env.PUBLIC_URL).toBe('https://x.apps.example.com')
    expect(spec.env.ADMIN_URL).toBe('https://x.apps.example.com')
  })

  it('unites hostnames with the base_url host, lower-case and once each', () => {
    const spec = renderStackSpec(
      withEnv({
        hostnames: ['Alt.apps.example.com', 'acme-staging.apps.example.com', 'ALT.apps.example.com']
      })
    )
    expect(spec.hostnames).toEqual(['acme-staging.apps.example.com', 'alt.apps.example.com'])
  })

  it('sends publish_port only when set', () => {
    expect(renderStackSpec(input())).not.toHaveProperty('publish_port')
    expect(renderStackSpec(withRow({ publish_port: 31000 })).publish_port).toBe(31000)
  })

  it('takes roles from the template for the version and size, as copies', () => {
    const spec = renderStackSpec(withRow({ size: 'large' }))
    expect(spec.roles.map((r) => `${r.role}x${r.replicas}`)).toEqual([
      'webx3',
      'workerx1',
      'realtimex2',
      'importerx1'
    ])
    spec.roles[0].replicas = 9
    if (spec.roles[0].env) spec.roles[0].env.SOCKETS = 'on'
    expect(templateFor('0.3.208').sizes.large[0]).toEqual({
      role: 'web',
      replicas: 3,
      cpus: 2,
      memory_mb: 3072,
      env: { SOCKETS: 'off' }
    })
    expect(() => renderStackSpec(input({ version: '0.2.1' }))).toThrow(
      expect.objectContaining({ code: 'TEMPLATE_NONE' })
    )
  })

  it('carries the settings secrets and the hub token as secrets, never as env', () => {
    const spec = renderStackSpec(input())
    const env = JSON.stringify(spec.env)
    for (const v of [...Object.values(FIXTURE.secrets), FIXTURE.hubToken]) {
      expect(env).not.toContain(v)
    }
    expect(spec.secrets.HUB_TOKEN).toBe(FIXTURE.hubToken)
  })
})

describe('databaseEnvFor (phase 3 seam)', () => {
  it('answers the DB_* settings in phase 4', () => {
    expect(
      databaseEnvFor(FIXTURE.env, { DB_CLIENT: 'pg', DB_HOST: 'h', CACHE_WARM: 'off' })
    ).toEqual({ DB_CLIENT: 'pg', DB_HOST: 'h' })
  })
})

describe('hostnameProblems', () => {
  const auto: DockerDriverConfig = {
    agent_url: 'https://agent.example.com',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com',
    edge_target: null
  }
  it('automatic: every name must end with the wildcard domain', () => {
    expect(hostnameProblems(['a.apps.example.com', 'B.Apps.Example.com'], auto)).toEqual([])
    const p = hostnameProblems(['apps.example.com', 'a.other.com', 'xapps.example.com'], auto)
    expect(p).toHaveLength(3)
    expect(p[1]).toContain('a.other.com')
  })
  it('manual: any name', () => {
    const manual: DockerDriverConfig = {
      ...auto,
      dns_mode: 'manual',
      wildcard_domain: null,
      edge_target: 'edge.example.com'
    }
    expect(hostnameProblems(['a.other.com'], manual)).toEqual([])
  })
})

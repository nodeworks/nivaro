import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DockerDriverConfig } from '../../../services/hub/docker/driver-config.js'
import {
  environmentNames,
  hostnameProblems,
  hostnameRefusals,
  renderStackSpec,
  stackHostnames
} from '../../../services/hub/docker/render-spec.js'
import {
  agentRefusesEnvKey,
  databaseEnvFor,
  databaseRecordId
} from '../../../services/hub/docker/stack-env.js'
import type { StackSettingsRow } from '../../../services/hub/docker/stack-settings.js'
import {
  agentVersionAtLeast,
  EXPORTER_AGENT_MIN_VERSION,
  STACK_TEMPLATES,
  stackRoles,
  templateFor
} from '../../../services/hub/docker/templates.js'
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
    expect(templateFor('0.3.183')).toBe(STACK_TEMPLATES.find((t) => t.from === '0.3.0'))
    expect(templateFor('0.3.0').from).toBe('0.3.0')
    expect(templateFor('0.3.184').from).toBe('0.3.184')
    expect(templateFor('0.3.208').from).toBe('0.3.184')
    expect(templateFor('1.0.0').from).toBe('0.3.184')
  })

  it('refuses a version below every template with TEMPLATE_NONE', () => {
    expect(() => templateFor('0.2.9')).toThrow(expect.objectContaining({ code: 'TEMPLATE_NONE' }))
  })

  it('has the Decision 7 sizes', () => {
    const t = templateFor('0.3.183').sizes
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

  it('Task 15: from 0.3.184 (NIVARO_ROLE=exporter) large adds an exporter; small and medium unchanged', () => {
    const before = templateFor('0.3.183').sizes
    const t = templateFor('0.3.208').sizes
    expect(t.small).toEqual(before.small)
    expect(t.medium).toEqual(before.medium)
    // Limits like the importer's; one replica; no role env (it ticks no crons by its role).
    expect(t.large).toEqual([
      ...before.large,
      { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }
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

  it('sends publish_port only on the publish edge', () => {
    expect(renderStackSpec(input())).not.toHaveProperty('publish_port')
    const row = { ...structuredClone(FIXTURE.row), publish_port: 31000 }
    expect(renderStackSpec(input({ edge: 'publish', row })).publish_port).toBe(31000)
  })

  it('controller ruling: the exporter only for an agent at 0.2.2 or later; unknown or older → none', () => {
    expect(EXPORTER_AGENT_MIN_VERSION).toBe('0.2.2')
    const names = (agentVersion: string | null | undefined) =>
      renderStackSpec({ ...withRow({ size: 'large' }), agentVersion }).roles.map((r) => r.role)
    for (const v of [undefined, null, '', 'garbage', '0.2.1', '0.1.0'])
      expect(names(v), String(v)).toEqual(['web', 'worker', 'realtime', 'importer'])
    for (const v of ['0.2.2', '0.2.10', '0.3.0', '0.2.2-rc.1', 'v0.2.2'])
      expect(names(v), v).toEqual(['web', 'worker', 'realtime', 'importer', 'exporter'])
    // Small and medium never change, whatever the agent.
    for (const size of ['small', 'medium'] as const)
      expect(stackRoles('0.3.208', size, '0.2.2')).toEqual(stackRoles('0.3.208', size, null))
    expect(agentVersionAtLeast('0.2.2', '0.2.2')).toBe(true)
    expect(agentVersionAtLeast(7, '0.2.2')).toBe(false)
  })

  it('takes roles from the template for the version and size, as copies', () => {
    const spec = renderStackSpec({ ...withRow({ size: 'large' }), agentVersion: '0.2.2' })
    expect(spec.roles.map((r) => `${r.role}x${r.replicas}`)).toEqual([
      'webx3',
      'workerx1',
      'realtimex2',
      'importerx1',
      'exporterx1'
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
  it('answers DB_* settings as env and the DB password only as a secret', () => {
    expect(
      databaseEnvFor(
        FIXTURE.env,
        { DB_CLIENT: 'pg', DB_HOST: 'h', CACHE_WARM: 'off' },
        { DB_PASSWORD: 'p', MAIL_PASS: 'm' }
      )
    ).toEqual({ env: { DB_CLIENT: 'pg', DB_HOST: 'h' }, secrets: { DB_PASSWORD: 'p' } })
    // a credential-looking DB_* key never lands in env, whichever map it came from
    expect(databaseEnvFor(FIXTURE.env, { DB_PASSWORD: 'p' }, {})).toEqual({
      env: {},
      secrets: { DB_PASSWORD: 'p' }
    })
  })

  it('the rendered spec carries DB_PASSWORD in secrets, never in env', () => {
    const spec = renderStackSpec(input())
    expect(spec.secrets.DB_PASSWORD).toBe(FIXTURE.secrets.DB_PASSWORD)
    expect(spec.env).not.toHaveProperty('DB_PASSWORD')
  })

  it('a phase 3 database record wins: DB_CLIENT as env, DB_URL only as a secret', () => {
    const record = { client: 'pg', url: 'postgres://app:pw@db.example.com:5432/acme' }
    expect(
      databaseEnvFor(
        FIXTURE.env,
        { DB_CLIENT: 'mssql', DB_HOST: 'h' },
        { DB_PASSWORD: 'p' },
        record
      )
    ).toEqual({ env: { DB_CLIENT: 'pg' }, secrets: { DB_URL: record.url } })
    const spec = renderStackSpec(input({ database: record }))
    expect(spec.env.DB_CLIENT).toBe('pg')
    expect(spec.secrets.DB_URL).toBe(record.url)
    // No DB_* stack setting rides along with the record's connection.
    for (const k of [...Object.keys(spec.env), ...Object.keys(spec.secrets)])
      if (k.startsWith('DB_')) expect(['DB_CLIENT', 'DB_URL']).toContain(k)
    expect(JSON.stringify(spec.env)).not.toContain('pw@')
  })

  it('databaseRecordId reads only hub-db:<id>', () => {
    expect(databaseRecordId('hub-db:12')).toBe(12)
    for (const v of [null, undefined, '', 'hub-db:', 'hub-db:x', 'other:12', ' hub-db:12'])
      expect(databaseRecordId(v)).toBeNull()
  })
})

describe('renderer refusals', () => {
  it('respects an explicit empty TRUST_PROXY', () => {
    const row = structuredClone(FIXTURE.row)
    row.settings.TRUST_PROXY = ''
    expect(renderStackSpec(input({ row })).env.TRUST_PROXY).toBe('')
  })

  it('throws ENV_SECRET_CLASH rather than send a key as env and secret', () => {
    expect(() =>
      renderStackSpec(input({ secrets: { ...FIXTURE.secrets, TRUST_PROXY: '1' } }))
    ).toThrow(expect.objectContaining({ code: 'ENV_SECRET_CLASH' }))
  })

  it('traefik: a base host that is no DNS name is refused', () => {
    expect(() => renderStackSpec(withEnv({ base_url: 'http://localhost:3110' }))).toThrow(
      expect.objectContaining({ code: 'HOSTNAME_INVALID' })
    )
  })

  it('publish: the base host is left out, the port is required', () => {
    const env = {
      ...structuredClone(FIXTURE.env),
      base_url: 'http://localhost:3110',
      hostnames: []
    }
    const row = { ...structuredClone(FIXTURE.row), publish_port: 3111 }
    const spec = renderStackSpec(input({ edge: 'publish', env, row }))
    expect(spec.hostnames).toEqual([])
    expect(spec.publish_port).toBe(3111)
    expect(() =>
      renderStackSpec(input({ edge: 'publish', env, row: { ...row, publish_port: null } }))
    ).toThrow(expect.objectContaining({ code: 'PUBLISH_PORT_REQUIRED' }))
  })

  it('traefik never sends publish_port', () => {
    expect(renderStackSpec(withRow({ publish_port: 31000 }))).not.toHaveProperty('publish_port')
  })

  it('caps hostnames at 10 including the base host', () => {
    const names = Array.from({ length: 10 }, (_, i) => `n${i}.apps.example.com`)
    expect(() => renderStackSpec(withEnv({ hostnames: names }))).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_HOSTNAMES' })
    )
    expect(renderStackSpec(withEnv({ hostnames: names.slice(0, 9) })).hostnames).toHaveLength(10)
  })
})

describe('stack names', () => {
  it('stackHostnames: base host first on traefik, left out on publish', () => {
    const env = {
      base_url: 'https://A.apps.example.com',
      hostnames: ['b.apps.example.com', 'a.apps.example.com']
    }
    expect(stackHostnames(env)).toEqual(['a.apps.example.com', 'b.apps.example.com'])
    expect(stackHostnames(env, 'publish')).toEqual(['b.apps.example.com', 'a.apps.example.com'])
    expect(environmentNames(env)).toEqual(['a.apps.example.com', 'b.apps.example.com'])
  })
})

describe('hostnameProblems / hostnameRefusals', () => {
  const auto: DockerDriverConfig = {
    agent_url: 'https://agent.example.com',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com',
    edge_target: null
  }
  const manual: DockerDriverConfig = {
    ...auto,
    dns_mode: 'manual',
    wildcard_domain: null,
    edge_target: 'edge.example.com'
  }
  const codes = (hs: string[], d: DockerDriverConfig, o = {}) =>
    hostnameRefusals(hs, d, o).map((p) => `${p.code}:${p.hostname}`)

  it('automatic: every name must end with the wildcard domain', () => {
    expect(hostnameProblems(['a.apps.example.com', 'B.Apps.Example.com'], auto)).toEqual([])
    const p = hostnameProblems(['apps.example.com', 'a.other.com', 'xapps.example.com'], auto)
    expect(p).toHaveLength(3)
    expect(p[1]).toContain('a.other.com')
  })

  it('manual: any DNS name', () => {
    expect(hostnameProblems(['a.other.com'], manual)).toEqual([])
  })

  it("runs the agent's DNS-name rule", () => {
    expect(
      codes(['a_b.example.com', 'trailing.example.com.', 'localhost', '-x.example.com'], manual)
    ).toEqual([
      'HOSTNAME_INVALID:a_b.example.com',
      'HOSTNAME_INVALID:trailing.example.com.',
      'HOSTNAME_INVALID:localhost',
      'HOSTNAME_INVALID:-x.example.com'
    ])
  })

  it('caps the list at 10', () => {
    const names = Array.from({ length: 11 }, (_, i) => `n${i}.example.com`)
    expect(codes(names, manual)).toEqual(['TOO_MANY_HOSTNAMES:null'])
  })

  it("checks the agent's host suffixes on the traefik edge only", () => {
    const o = { hostSuffixes: ['.apps.corp'] }
    expect(codes(['a.example.com'], manual, o)).toEqual(['HOSTNAME_NOT_ALLOWED:a.example.com'])
    expect(codes(['a.example.com'], manual, { ...o, edge: 'publish' })).toEqual([])
  })

  it('refuses a name another Hub environment claims (HOSTNAME_TAKEN)', () => {
    const other = environmentNames({
      base_url: 'https://acme.apps.example.com',
      hostnames: ['www.acme.apps.example.com']
    })
    expect(
      codes(['ACME.apps.example.com', 'www.acme.apps.example.com', 'mine.apps.example.com'], auto, {
        taken: other
      })
    ).toEqual(['HOSTNAME_TAKEN:acme.apps.example.com', 'HOSTNAME_TAKEN:www.acme.apps.example.com'])
  })
})

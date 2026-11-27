import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap G-D (agent 0.2.5): an ACME certificate served by Traefik on Docker hosts. Its outputs
// bind to the stack secrets EDGE_TLS_CERT / EDGE_TLS_KEY; the renderer sends them as the spec's
// `edge_tls` (never as app secrets) to an agent that serves them, and the agent's own validator
// takes what the renderer sends. Real SQLite for the stack-settings half.

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up546 } = await import('../../../db/migrations/546_hub_stack_settings.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const S = await import('../../../services/hub/docker/stack-settings.js')
const { renderStackSpec, StackRenderError } = await import(
  '../../../services/hub/docker/render-spec.js'
)
const T = await import('../../../services/hub/docker/edge-tls.js')
const { PART_BINDINGS } = await import('../../../services/hub/create/provider-parts.js')
const { HUB_MASK } = await import('../../../services/hub/secrets.js')
const { environmentFromRow } = await import('../../../services/hub/apps.js')

type RenderInput = Parameters<typeof renderStackSpec>[0]
type Env = import('../../../services/hub/promote-types.js').HubEnvironmentRow

// The agent's own validator and its throwaway test certificates (outside the API's rootDir).
const AGENT = resolve(import.meta.dirname, '../../../../../packages/hub-agent')
const agentSpec = (await import(
  /* @vite-ignore */ pathToFileURL(join(AGENT, 'src/spec.ts')).href
)) as {
  validateStackSpec: (
    body: unknown,
    cfg: Record<string, unknown>
  ) =>
    | { ok: true; spec: Record<string, unknown> }
    | { ok: false; fields: Array<{ field: string; code: string }> }
}
const pem = (f: string) => readFileSync(join(AGENT, 'test/fixtures/edge-tls', f), 'utf8')
const A = { cert: pem('a.crt'), key: pem('a.key') }
const B = { cert: pem('b.crt'), key: pem('b.key') }
const keyBody = (k: string) =>
  k
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('')

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/hub-render-input.json'), 'utf8')
) as RenderInput

/** The fixture, on the names the test certificates cover, on an agent that serves them. */
function input(tls: { cert: string; key: string } | null, over: Partial<RenderInput> = {}) {
  const i = structuredClone(FIXTURE)
  i.env.base_url = 'https://acme-staging.apps.corp'
  i.env.hostnames = ['www.acme-staging.apps.corp']
  i.driver = { ...i.driver, wildcard_domain: 'apps.corp' }
  i.agentVersion = '0.2.5'
  i.agentEdgeTls = true
  if (tls) {
    i.secrets.EDGE_TLS_CERT = tls.cert
    i.secrets.EDGE_TLS_KEY = tls.key
  }
  return { ...i, ...over }
}
const agentCfg = (over: Record<string, unknown> = {}) => ({
  images: ['nodeworks/nivaro', 'registry.example.com/acme/tools-ext'],
  edge: 'traefik',
  hostSuffixes: ['.apps.corp'],
  publishPorts: [31000, 31099],
  redisImage: `redis@sha256:${'3'.repeat(64)}`,
  traefikDynamicDir: '/srv/traefik/dynamic',
  ...over
})
function refusal(i: RenderInput): string {
  try {
    renderStackSpec(i)
    return 'NO_ERROR'
  } catch (err) {
    if (err instanceof StackRenderError) return err.code
    throw err
  }
}

describe('renderStackSpec: the stack certificate', () => {
  it('goes as edge_tls, never as an app secret, and the agent takes it', () => {
    const spec = renderStackSpec(input(A))
    expect(spec.edge_tls).toEqual(A)
    expect(Object.keys(spec.secrets)).not.toContain('EDGE_TLS_CERT')
    expect(Object.keys(spec.secrets)).not.toContain('EDGE_TLS_KEY')
    expect(JSON.stringify({ ...spec, edge_tls: undefined })).not.toContain(keyBody(A.key))
    const r = agentSpec.validateStackSpec(structuredClone(spec), agentCfg())
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.spec.edge_tls).toEqual(A)
  })

  it('without the two secrets the spec is exactly the one before 0.2.5', () => {
    const spec = renderStackSpec(input(null))
    expect('edge_tls' in spec).toBe(false)
    // An older agent renders the same (nothing new asked of it).
    expect(
      renderStackSpec(input(null, { agentVersion: '0.2.4', agentEdgeTls: undefined }))
    ).toEqual(spec)
  })

  it('a renewal changes edge_tls only', () => {
    const a = renderStackSpec(input(A))
    const b = renderStackSpec(input(B))
    expect({ ...b, edge_tls: undefined }).toEqual({ ...a, edge_tls: undefined })
    expect(b.edge_tls).toEqual(B)
  })

  it('one of the two: EDGE_TLS_INCOMPLETE', () => {
    const i = input(A)
    delete i.secrets.EDGE_TLS_KEY
    expect(refusal(i)).toBe('EDGE_TLS_INCOMPLETE')
    const j = input(A)
    j.secrets.EDGE_TLS_CERT = ''
    expect(refusal(j)).toBe('EDGE_TLS_INCOMPLETE')
  })

  it('an agent that cannot serve it: publish edge, before 0.2.5, no dynamic folder', () => {
    expect(
      refusal(input(A, { edge: 'publish', row: { ...input(A).row, publish_port: 31000 } }))
    ).toBe('EDGE_TLS_NEEDS_TRAEFIK')
    expect(refusal(input(A, { agentVersion: '0.2.4' }))).toBe('AGENT_TOO_OLD')
    expect(refusal(input(A, { agentVersion: null }))).toBe('AGENT_TOO_OLD')
    expect(refusal(input(A, { agentEdgeTls: false }))).toBe('EDGE_TLS_NOT_CONFIGURED')
    expect(refusal(input(A, { agentEdgeTls: undefined }))).toBe('EDGE_TLS_NOT_CONFIGURED')
  })

  it('a name it does not cover, a key of another certificate, not PEM: refused with words only', () => {
    const more = input(A)
    more.env.hostnames = ['www.acme-staging.apps.corp', 'other.apps.corp']
    let msg = ''
    try {
      renderStackSpec(more)
    } catch (e) {
      msg = (e as Error).message
      expect((e as InstanceType<typeof StackRenderError>).code).toBe('EDGE_TLS_NAME_NOT_COVERED')
    }
    expect(msg).toContain('other.apps.corp')
    expect(msg).not.toContain(keyBody(A.cert))
    expect(refusal(input({ cert: A.cert, key: B.key }))).toBe('EDGE_TLS_KEY_MISMATCH')
    expect(refusal(input({ cert: 'not a certificate', key: A.key }))).toBe('EDGE_TLS_INVALID')
  })

  it('a plan’s dry render over masks judges the agent, not the content', () => {
    const masked = input({ cert: HUB_MASK, key: HUB_MASK }, { maskedSecrets: true })
    expect(refusal(masked)).toBe('NO_ERROR')
    expect(refusal({ ...masked, agentEdgeTls: false })).toBe('EDGE_TLS_NOT_CONFIGURED')
  })
})

describe('edgeTlsAgentProblem', () => {
  it('fails closed on anything but a 0.2.5+ traefik agent that says edge_tls: true', () => {
    expect(T.edgeTlsAgentProblem({ agent_version: '0.2.5', edge: 'traefik', edge_tls: true })).toBe(
      null
    )
    expect(T.edgeTlsAgentProblem({ agent_version: '0.3.0', edge_tls: true })).toBe(null)
    expect(T.edgeTlsAgentProblem(null)?.code).toBe('AGENT_TOO_OLD')
    expect(T.edgeTlsAgentProblem({ agent_version: '0.2.4', edge_tls: true })?.code).toBe(
      'AGENT_TOO_OLD'
    )
    expect(T.edgeTlsAgentProblem({ agent_version: '0.2.5' })?.code).toBe('EDGE_TLS_NOT_CONFIGURED')
    expect(
      T.edgeTlsAgentProblem({ agent_version: '0.2.5', edge: 'publish', edge_tls: true })?.code
    ).toBe('EDGE_TLS_NEEDS_TRAEFIK')
  })
})

describe('Create app: an ACME part binds its chain and key to the stack certificate', () => {
  it('fullchain → EDGE_TLS_CERT, private_key → EDGE_TLS_KEY, both stack secrets', () => {
    expect(PART_BINDINGS['acme.certificate']).toEqual([
      {
        resource: 'part',
        output_key: 'fullchain',
        target: 'stack_secret',
        target_key: 'EDGE_TLS_CERT'
      },
      {
        resource: 'part',
        output_key: 'private_key',
        target: 'stack_secret',
        target_key: 'EDGE_TLS_KEY'
      }
    ])
  })
})

// ── stack settings: where a binding push lands ───────────────────────────

const KEY = 'a'.repeat(64)
const driver = {
  agent_url: 'https://agent.example.com',
  dns_mode: 'manual' as const,
  wildcard_domain: null,
  edge_target: null
}
let prevKey: string | undefined
let envSeq = 0

async function newEnv(): Promise<Env> {
  const [row] = await db('nivaro_hub_environments')
    .insert({
      app_id: 1,
      key: `e${++envSeq}`,
      base_url: `https://e${envSeq}.apps.corp`,
      hostnames: '[]'
    })
    .returning('id')
  const id = typeof row === 'object' ? (row as { id: number }).id : row
  return environmentFromRow(await db('nivaro_hub_environments').where({ id }).first()) as Env
}

describe('stack settings: EDGE_TLS_CERT / EDGE_TLS_KEY', () => {
  beforeAll(async () => {
    prevKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    await up542(db)
    await up546(db)
    await up551(db)
    await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme' })
  })
  afterAll(async () => {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
    await db.destroy()
  })
  let env: Env
  beforeEach(async () => {
    env = await newEnv()
  })

  it('are taken as secrets (multi-line PEM), sealed, and never ask the agent for prefixes', async () => {
    let asked = 0
    const v = await S.validateStackSettings(
      { secrets: { EDGE_TLS_CERT: A.cert, EDGE_TLS_KEY: A.key } },
      null,
      {
        driver,
        env,
        envPrefixes: async () => {
          asked++
          return { prefixes: [], known: true }
        }
      }
    )
    expect(v.ok).toBe(true)
    expect(asked).toBe(0)
    if (!v.ok) return
    await S.saveStackSettings(env.id, v.row.fields, v.row.extension_pins)
    const stored = await S.readStackSettings(env.id)
    expect(String(stored?.secrets)).not.toContain(keyBody(A.key))
    expect(S.openStackSecrets(stored)).toMatchObject({ EDGE_TLS_CERT: A.cert, EDGE_TLS_KEY: A.key })
  })

  it('are refused as plain settings (SECRET_IN_SETTINGS)', async () => {
    for (const k of ['EDGE_TLS_CERT', 'EDGE_TLS_KEY']) {
      const v = await S.validateStackSettings({ settings: { [k]: 'x' } }, null, { driver, env })
      expect(v).toMatchObject({ ok: false, code: 'SECRET_IN_SETTINGS' })
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 4): the Hub's client for the Hub agent, against a fetch stub. The agent
// token travels only in the Authorization header and never in an error.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  AGENT_TIMEOUTS,
  AgentError,
  agentApply,
  agentHealth,
  agentRemove,
  agentRestart,
  agentStack,
  describeAgentError
} from '../../../services/hub/docker/agent-client.js'
import type { StackSpec } from '../../../services/hub/docker/agent-types.js'
import { sealSecret } from '../../../services/hub/secrets.js'

const KEY = 'c'.repeat(64)
const TOKEN = 'agent-token-Zq81-very-secret'
const ORIGIN = 'https://agent.example.com:8443'

const HEALTH = {
  api: 1,
  agent_version: '0.1.0',
  engine_api: '1.44',
  swarm: { manager: true, node_id: 'n1' },
  images: ['nodeworks/nivaro'],
  host_suffixes: ['apps.example.com'],
  edge: 'traefik',
  publish_ports: null,
  extensions_shared: false,
  redis_bundled: true
}

const SPEC: StackSpec = {
  owner: { app: 'efp' },
  environment: 'prod',
  image: `nodeworks/nivaro@sha256:${'a'.repeat(64)}`,
  roles: [{ role: 'all', replicas: 1 }],
  env: { PUBLIC_URL: 'https://efp.apps.example.com' },
  secrets: { SESSION_SECRET: 'x'.repeat(64) },
  hostnames: ['efp.apps.example.com'],
  redis: 'bundled',
  extensions: {}
}

type Seen = { url: string; init: RequestInit }
let seen: Seen[] = []
let answer: (url: string, init: RequestInit) => Promise<Response> | Response

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let prevKey: string | undefined
let driver: { config: Record<string, unknown>; secret: string | null }

beforeEach(() => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  seen = []
  answer = () => json(200, HEALTH)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return answer(String(url), init)
    })
  )
  driver = {
    config: {
      agent_url: ORIGIN,
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_target: null
    },
    secret: sealSecret(TOKEN)
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})

const d = () => driver as never

/** Runs `fn`, expects an AgentError, and checks the token is nowhere in it. */
async function refusal(fn: () => Promise<unknown>): Promise<AgentError> {
  let caught: unknown
  try {
    await fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(AgentError)
  const e = caught as AgentError
  for (const text of [e.message, JSON.stringify(e), String(e), e.stack ?? ''])
    expect(text).not.toContain(TOKEN)
  return e
}

describe('hub agent client', () => {
  it('every call sends redirect:error, the bearer, a timeout signal and the right route', async () => {
    answer = (url, init) => {
      if (url.endsWith('/v1/health')) return json(200, HEALTH)
      if (init.method === 'PUT')
        return json(202, { spec_hash: 'h', changed: ['web'], unchanged: [] })
      if (url.includes('/restart')) return json(202, { services: ['efp-prod_web'] })
      if (init.method === 'DELETE')
        return json(200, { removed: { services: [], secrets: [], networks: [], volumes: [] } })
      return json(200, { name: 'efp-prod', state: 'converged', services: [] })
    }
    await agentHealth(d())
    await agentStack(d(), 'efp-prod', 'abc123')
    await agentApply(d(), 'efp-prod', SPEC)
    await agentRestart(d(), 'efp-prod', SPEC)
    await agentRemove(d(), 'efp-prod', {
      removeVolumes: true,
      owner: { app: 'efp', environment: 'production' }
    })
    await agentRemove(d(), 'efp-prod', {
      removeVolumes: false,
      owner: { app: 'efp', environment: 'production' }
    })

    expect(seen.map((s) => [s.init.method, s.url])).toEqual([
      ['GET', `${ORIGIN}/v1/health`],
      ['GET', `${ORIGIN}/v1/stacks/efp-prod?expect=abc123`],
      ['PUT', `${ORIGIN}/v1/stacks/efp-prod`],
      ['POST', `${ORIGIN}/v1/stacks/efp-prod/restart`],
      [
        'DELETE',
        `${ORIGIN}/v1/stacks/efp-prod?confirm=efp-prod&app=efp&environment=production&remove_volumes=1`
      ],
      ['DELETE', `${ORIGIN}/v1/stacks/efp-prod?confirm=efp-prod&app=efp&environment=production`]
    ])
    for (const s of seen) {
      expect(s.init.redirect).toBe('error')
      expect((s.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
      expect(s.init.signal).toBeInstanceOf(AbortSignal)
      expect(s.url).not.toContain(TOKEN)
    }
    expect(JSON.parse(String(seen[2].init.body))).toEqual(SPEC)
    // Restart sends the freshly rendered spec too (ruling P4-16), never an empty body.
    expect(JSON.parse(String(seen[3].init.body))).toEqual(SPEC)
    expect((seen[3].init.headers as Record<string, string>)['content-type']).toBe(
      'application/json'
    )
    expect((seen[2].init.headers as Record<string, string>)['content-type']).toBe(
      'application/json'
    )
  })

  it('uses the contract timeouts', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    answer = (url, init) => {
      if (url.endsWith('/v1/health')) return json(200, HEALTH)
      if (init.method === 'DELETE')
        return json(200, { removed: { services: 1, secrets: 0, networks: 1, volumes: 0 } })
      return json(202, { services: [], spec_hash: 'h', changed: [], unchanged: [] })
    }
    await agentHealth(d())
    await agentHealth(d(), { timeoutMs: 1234 })
    await agentStack(d(), 'efp-prod')
    await agentApply(d(), 'efp-prod', SPEC)
    await agentRestart(d(), 'efp-prod', SPEC)
    await agentRemove(d(), 'efp-prod', {
      removeVolumes: false,
      owner: { app: 'efp', environment: 'production' }
    })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([5_000, 1234, 10_000, 300_000, 30_000, 120_000])
    expect(AGENT_TIMEOUTS).toEqual({
      health: 5_000,
      stack: 10_000,
      apply: 300_000,
      restart: 30_000,
      remove: 120_000
    })
    spy.mockRestore()
  })

  it('agentStack answers null for 404', async () => {
    answer = () => json(404, { error: 'no such stack', code: 'STACK_NOT_FOUND' })
    expect(await agentStack(d(), 'efp-prod')).toBeNull()
  })

  it('401 and 429 → AGENT_REFUSED', async () => {
    answer = () => json(401, { error: `bad token ${TOKEN}`, code: 'UNAUTHORIZED' })
    expect(await refusal(() => agentHealth(d()))).toMatchObject({
      code: 'AGENT_REFUSED',
      status: 401
    })
    answer = () => json(429, { error: 'slow down', code: 'TOO_MANY_BAD_TOKENS' })
    expect(await refusal(() => agentStack(d(), 'efp-prod'))).toMatchObject({
      code: 'AGENT_REFUSED',
      status: 429
    })
  })

  it('a network error or a timeout → AGENT_UNREACHABLE', async () => {
    answer = () => {
      throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${TOKEN}`) })
    }
    const e = await refusal(() => agentHealth(d()))
    expect(e).toMatchObject({ code: 'AGENT_UNREACHABLE', status: 0 })
    answer = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }
    const t = await refusal(() => agentApply(d(), 'efp-prod', SPEC))
    expect(t.code).toBe('AGENT_UNREACHABLE')
    expect(t.message).toMatch(/300 s/)
  })

  it('a 302, or fetch refusing a redirect → AGENT_REDIRECT', async () => {
    answer = () =>
      new Response(null, { status: 302, headers: { location: `https://evil.example/?t=${TOKEN}` } })
    expect(await refusal(() => agentHealth(d()))).toMatchObject({
      code: 'AGENT_REDIRECT',
      status: 302
    })
    answer = () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    }
    expect((await refusal(() => agentRestart(d(), 'efp-prod', SPEC))).code).toBe('AGENT_REDIRECT')
  })

  it('health with api 2, or no JSON → AGENT_INCOMPATIBLE', async () => {
    answer = () => json(200, { ...HEALTH, api: 2 })
    expect((await refusal(() => agentHealth(d()))).code).toBe('AGENT_INCOMPATIBLE')
    answer = () => new Response('<html>hello</html>', { status: 200 })
    expect((await refusal(() => agentHealth(d()))).code).toBe('AGENT_INCOMPATIBLE')
  })

  it("the agent's own code and fields pass through; its body text does not", async () => {
    answer = () =>
      json(400, {
        error: `spec bad near ${TOKEN} and SECRET-BODY-TEXT`,
        code: 'SPEC_INVALID',
        fields: [
          { field: 'image', code: 'IMAGE_NOT_ALLOWED' },
          { field: 'binds', code: 'UNKNOWN_FIELD', extra: 'SECRET-BODY-TEXT' },
          'junk'
        ]
      })
    const e = await refusal(() => agentApply(d(), 'efp-prod', SPEC))
    expect(e).toMatchObject({ code: 'SPEC_INVALID', status: 400 })
    expect(e.fields).toEqual([
      { field: 'image', code: 'IMAGE_NOT_ALLOWED' },
      { field: 'binds', code: 'UNKNOWN_FIELD' }
    ])
    expect(JSON.stringify(e)).not.toContain('SECRET-BODY-TEXT')
    expect(e.message).not.toContain('SECRET-BODY-TEXT')

    answer = () => json(409, { error: 'x', code: 'STACK_NOT_HUB' })
    expect((await refusal(() => agentRestart(d(), 'efp', SPEC))).code).toBe('STACK_NOT_HUB')
    answer = () => json(500, { error: 'boom', code: 'lower case nonsense' })
    expect((await refusal(() => agentStack(d(), 'efp-prod'))).code).toBe('AGENT_ERROR')
  })

  it('a body past 4 MB is not read to the end → AGENT_INCOMPATIBLE', async () => {
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    answer = () =>
      new Response(
        new ReadableStream({
          pull(ctl) {
            pulled++
            if (pulled > 50) ctl.close()
            else ctl.enqueue(chunk)
          }
        }),
        { status: 200 }
      )
    expect((await refusal(() => agentHealth(d()))).code).toBe('AGENT_INCOMPATIBLE')
    expect(pulled).toBeLessThan(10)
  })

  it('a timeout while reading the body → AGENT_UNREACHABLE', async () => {
    answer = () =>
      new Response(
        new ReadableStream({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode('{"api":'))
          },
          pull(ctl) {
            ctl.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
          }
        }),
        { status: 200 }
      )
    const e = await refusal(() => agentStack(d(), 'efp-prod'))
    expect(e.code).toBe('AGENT_UNREACHABLE')
    expect(e.message).toMatch(/10 s/)
  })

  it('never puts the URL query in an error', async () => {
    answer = () => {
      throw new TypeError('fetch failed')
    }
    const e = await refusal(() =>
      agentRemove(d(), 'efp-prod', {
        removeVolumes: true,
        owner: { app: 'efp', environment: 'production' }
      })
    )
    expect(e.message).not.toContain('confirm=')
    expect(e.message).not.toContain('remove_volumes')
    expect(e.message).toContain(ORIGIN)
  })

  it('refuses a stack name the agent would not accept, before any call', async () => {
    for (const bad of ['../etc', 'A', 'efp/prod', 'x'])
      expect((await refusal(() => agentStack(d(), bad))).code).toBe('BAD_STACK_NAME')
    expect(seen).toEqual([])
  })

  it('no token, or an unusable address → DRIVER_MISCONFIGURED, nothing sent', async () => {
    driver.secret = null
    await expect(agentHealth(d())).rejects.toMatchObject({ code: 'DRIVER_MISCONFIGURED' })
    driver.secret = sealSecret(TOKEN)
    driver.config.agent_url = 'http://agent.example.com'
    await expect(agentHealth(d())).rejects.toMatchObject({ code: 'DRIVER_MISCONFIGURED' })
    expect(seen).toEqual([])
  })

  it('plain http is fine for a private address', async () => {
    driver.config.agent_url = 'http://10.0.0.5:8088'
    await agentHealth(d())
    expect(seen[0].url).toBe('http://10.0.0.5:8088/v1/health')
  })
})

describe('describeAgentError', () => {
  const err = (code: string, fields?: Array<{ field: string; code: string }>) =>
    new AgentError(
      code,
      409,
      `the Hub agent at ${ORIGIN} refused apply efp-prod: ${code} (409)`,
      fields
    )

  it('says each new agent code in plain words, naming the stack and the taken names', () => {
    const ctx = { stack: 'efp-prod', hostnames: ['efp.apps.example.com', 'efp2.apps.example.com'] }
    expect(
      describeAgentError(
        err('HOSTNAME_TAKEN', [{ field: 'hostnames[1]', code: 'HOSTNAME_TAKEN' }]),
        ctx
      )
    ).toBe(
      'another stack on the swarm already routes efp2.apps.example.com — the agent never takes a name from another stack'
    )
    expect(describeAgentError(err('EXPECT_INVALID'), ctx)).toMatch(/spec hash the Hub sent/)
    expect(describeAgentError(err('ENGINE_FORBIDDEN'), ctx)).toMatch(/nothing was sent to Docker/)
    expect(describeAgentError(err('STACK_NAME_INVALID'), ctx)).toBe(
      'the agent does not accept efp-prod as a stack name'
    )
    expect(describeAgentError(err('STACK_NOT_HUB'), ctx)).toMatch(
      /already runs a stack named efp-prod that the Hub did not create/
    )
    expect(describeAgentError(err('STACK_OWNER_MISMATCH'), ctx)).toBe(
      'the stack efp-prod belongs to another Hub app or environment'
    )
    expect(describeAgentError(err('SPEC_MISMATCH'), ctx)).toMatch(/deploy it instead of restarting/)
    expect(
      describeAgentError(err('SPEC_INVALID', [{ field: 'env.PATH', code: 'ENV_FORBIDDEN' }]), ctx)
    ).toBe('the agent refused the stack spec: env.PATH (ENV_FORBIDDEN)')
  })

  it('an unknown code keeps the client message (no agent body text, no token)', () => {
    const e = err('SOMETHING_NEW')
    expect(describeAgentError(e)).toBe(e.message)
    expect(describeAgentError(e)).not.toContain(TOKEN)
  })
})

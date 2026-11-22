import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StackSpec } from '../../../services/hub/docker/agent-types.js'
import {
  type RenderStackInput,
  renderStackSpec,
  StackRenderError
} from '../../../services/hub/docker/render-spec.js'
import type { StackSettingsRow } from '../../../services/hub/docker/stack-settings.js'

// Every spec the Hub renderer emits must pass the Hub agent's OWN validator
// (packages/hub-agent/src/spec.ts validateStackSpec): sizes × edge modes × redis modes, plus the
// shapes that once slipped through (a TRUST_PROXY secret, a one-label base host, 10 names + the
// base host). Where the settings cannot make a valid spec the renderer throws StackRenderError —
// it never hands the agent something it refuses. The agent file is loaded by a computed path so
// the API's tsc (rootDir src) never compiles the agent package; a missing file fails the test.

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

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/hub-render-input.json'), 'utf8')
) as RenderStackInput

const cfg = (edge: 'traefik' | 'publish') => ({
  images: ['nodeworks/nivaro', 'registry.example.com/acme/tools-ext'],
  edge,
  hostSuffixes: ['.apps.example.com'],
  publishPorts: [31000, 31099] as const,
  redisImage: `redis@sha256:${'3'.repeat(64)}`
})

function inputFor(
  size: StackSettingsRow['size'],
  edge: 'traefik' | 'publish',
  redis: 'bundled' | 'external'
): RenderStackInput {
  const i = structuredClone(FIXTURE)
  i.edge = edge
  i.row.size = size
  i.row.redis = redis
  i.row.publish_port = edge === 'publish' ? 31000 : null
  if (redis === 'external') i.secrets.REDIS_URL = 'redis://:pw@redis.internal:6379'
  return i
}

/** The renderer's answer judged by the agent: either a valid spec or a coded refusal. */
function judge(input: RenderStackInput) {
  let spec: StackSpec
  try {
    spec = renderStackSpec(input)
  } catch (err) {
    if (err instanceof StackRenderError) return { refused: err.code }
    throw err
  }
  const r = agent.validateStackSpec(structuredClone(spec), cfg(input.edge))
  return r.ok ? { ok: true as const } : { agentRefused: r.fields }
}

describe('rendered specs pass the agent validator', () => {
  const cases: Array<[StackSettingsRow['size'], 'traefik' | 'publish', 'bundled' | 'external']> = []
  for (const size of ['small', 'medium', 'large'] as const)
    for (const edge of ['traefik', 'publish'] as const)
      for (const redis of ['bundled', 'external'] as const) cases.push([size, edge, redis])

  it.each(cases)('%s / %s / %s redis', (size, edge, redis) => {
    expect(judge(inputFor(size, edge, redis))).toEqual({ ok: true })
  })

  it('with HUB_URL, a TRUST_PROXY setting and extra hostnames', () => {
    const i = inputFor('large', 'traefik', 'external')
    i.hubPublicUrl = 'https://hub.example.com'
    i.row.settings.TRUST_PROXY = ''
    i.env.hostnames = Array.from({ length: 9 }, (_, n) => `n${n}.apps.example.com`)
    expect(judge(i)).toEqual({ ok: true })
  })

  it('a TRUST_PROXY secret: refused by the renderer, never sent', () => {
    const i = inputFor('small', 'traefik', 'bundled')
    i.secrets.TRUST_PROXY = '1'
    expect(judge(i)).toEqual({ refused: 'ENV_SECRET_CLASH' })
  })

  it('a localhost base host: refused on traefik, left out on publish', () => {
    const t = inputFor('small', 'traefik', 'bundled')
    t.env.base_url = 'http://localhost:3110'
    t.env.hostnames = []
    expect(judge(t)).toEqual({ refused: 'HOSTNAME_INVALID' })
    const p = inputFor('small', 'publish', 'bundled')
    p.env.base_url = 'http://localhost:3110'
    p.env.hostnames = []
    expect(judge(p)).toEqual({ ok: true })
  })

  it('10 environment hostnames + the base host: refused, never 11 sent', () => {
    const i = inputFor('medium', 'traefik', 'bundled')
    i.env.hostnames = Array.from({ length: 10 }, (_, n) => `n${n}.apps.example.com`)
    expect(judge(i)).toEqual({ refused: 'TOO_MANY_HOSTNAMES' })
  })
})

// P4-27: a `large` stack (web SOCKETS=off) routes every realtime path to the realtime role, the
// same paths as deploy/realtime and the API's REALTIME_PROXY_PATHS, so Nivaro's own `realtime`
// preflight (it reads PUBLIC_URL/api/events/stream and wants x-nivaro-role: realtime) passes.
type AgentRenderModule = {
  REALTIME_PATHS: readonly string[]
  renderServices: (
    stack: string,
    spec: StackSpec,
    cfg: Record<string, unknown>,
    ctx: Record<string, unknown>
  ) => Array<{
    Name: string
    Labels: Record<string, string>
    TaskTemplate: { ContainerSpec: { Env: string[] } }
  }>
}
const AGENT_RENDER = resolve(import.meta.dirname, '../../../../../packages/hub-agent/src/render.ts')
const agentRender = (await import(
  /* @vite-ignore */ pathToFileURL(AGENT_RENDER).href
)) as AgentRenderModule
const { REALTIME_PROXY_PATHS } = await import('../../../services/process-role.js')

/**
 * A Traefik v3 rule judged for one request: Host, Path, PathPrefix, PathRegexp, `&&`, `||` and
 * parentheses — the forms the agent writes, nothing more (anything else throws).
 */
function ruleMatches(rule: string, req: { host: string; path: string }): boolean {
  let i = 0
  const ws = () => {
    while (rule[i] === ' ') i++
  }
  const expr = (): boolean => {
    let v = term()
    for (ws(); rule.startsWith('||', i); ws()) {
      i += 2
      const r = term()
      v = v || r
    }
    return v
  }
  const term = (): boolean => {
    let v = atom()
    for (ws(); rule.startsWith('&&', i); ws()) {
      i += 2
      const r = atom()
      v = v && r
    }
    return v
  }
  const atom = (): boolean => {
    ws()
    if (rule[i] === '(') {
      i++
      const v = expr()
      ws()
      if (rule[i++] !== ')') throw new Error(`rule: ) expected at ${i}`)
      return v
    }
    const m = /^(Host|PathPrefix|PathRegexp|Path)\(`([^`]*)`\)/.exec(rule.slice(i))
    if (!m) throw new Error(`rule: unknown matcher at ${rule.slice(i, i + 20)}`)
    i += m[0].length
    const [, fn, arg] = m
    if (fn === 'Host') return req.host === arg
    if (fn === 'Path') return req.path === arg
    if (fn === 'PathPrefix') return req.path.startsWith(arg)
    return new RegExp(arg).test(req.path)
  }
  const v = expr()
  ws()
  if (i !== rule.length) throw new Error(`rule: trailing text at ${i}`)
  return v
}

describe('P4-27: a large stack routes every realtime path to the realtime role', () => {
  const i = inputFor('large', 'traefik', 'bundled')
  const spec = renderStackSpec(i)
  const host = new URL(i.env.base_url).hostname
  const svcs = agentRender.renderServices(
    'st',
    spec,
    {
      edge: 'traefik',
      edgeNetwork: 'edge',
      entrypoints: ['websecure'],
      certResolver: null,
      extensionsShared: false,
      extensionsHostRoot: '/var/lib/nivaro-hub-agent/extensions',
      volumeDriver: 'local',
      volumeOpts: null,
      redisImage: `redis@sha256:${'b'.repeat(64)}`
    },
    {
      hash: 'h'.repeat(64),
      secretIds: Object.fromEntries(
        Object.keys(spec.secrets).map((k) => [k, { id: `id_${k}`, name: `nvh_st_${k}` }])
      ),
      extensionPaths: Object.fromEntries(
        Object.keys(spec.extensions).map((id) => [id, `/var/lib/nivaro-hub-agent/extensions/${id}`])
      ),
      agentNodeId: 'node-1',
      network: 'nvh_st'
    }
  )
  const svc = (role: string) => {
    const s = svcs.find((x) => x.Name === `st_${role}`)
    if (!s) throw new Error(`no ${role}`)
    return s
  }
  const webRule = svc('web').Labels['traefik.http.routers.nvh_web_st.rule']
  const rtRule = svc('realtime').Labels['traefik.http.routers.nvh_rt_st.rule']
  /** Traefik's default priority is the rule's length: the longer matching rule wins. */
  const routedTo = (path: string) => {
    const req = { host, path }
    const hits = [
      ['web', webRule],
      ['realtime', rtRule]
    ].filter(([, r]) => ruleMatches(r, req))
    hits.sort((a, b) => b[1].length - a[1].length)
    return hits[0]?.[0] ?? null
  }

  it('the agent paths are the API’s REALTIME_PROXY_PATHS', () => {
    expect([...agentRender.REALTIME_PATHS]).toEqual([...REALTIME_PROXY_PATHS])
  })

  it('web runs SOCKETS=off; every realtime path (and the preflight probe) reaches realtime', () => {
    expect(svc('web').TaskTemplate.ContainerSpec.Env).toContain('SOCKETS=off')
    for (const p of REALTIME_PROXY_PATHS) {
      const path = p.replace(':id', 'v42')
      expect([path, routedTo(path)]).toEqual([path, 'realtime'])
    }
    expect(routedTo('/socket.io/?EIO=4&transport=polling'.split('?')[0])).toBe('realtime')
    // The `realtime` preflight check's probe (services/process-role.ts probeRealtimeRouting).
    expect(routedTo('/api/events/stream')).toBe('realtime')
  })

  it('everything else stays on web', () => {
    for (const p of [
      '/api/version',
      '/api/items/x',
      '/api/events/ticket',
      '/api/events/views/a/b/stream',
      '/'
    ])
      expect([p, routedTo(p)]).toEqual([p, 'web'])
  })
})

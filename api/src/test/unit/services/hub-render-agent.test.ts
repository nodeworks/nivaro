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

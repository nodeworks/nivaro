import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KNOWN_ENV_KEYS } from '../../../services/hub/docker/known-env.js'
import {
  agentAcceptsEnvKey,
  agentEnvPrefixes,
  allowedEnvKey,
  ENV_PREFIX_RE,
  RENDERER_DEFAULT_ENV_KEYS,
  RENDERER_ENV_KEYS
} from '../../../services/hub/docker/stack-env.js'

// Guard (Hub phase 4, ruling P4-23): a stack spec may set only the Nivaro app's known config keys
// plus keys under the agent's HUB_AGENT_ENV_PREFIXES. The known list is GENERATED from api/src by
// scripts/hub-known-env.mts into three copies (the fixture, the Hub's known-env.ts, the agent's
// known-env.ts). This test:
//   1. fails when a fresh run of the generator differs from any checked-in copy (a new env read
//      in api/src, or a hand edit) — run `node --import tsx ../scripts/hub-known-env.mts` from
//      api/ and commit the three files;
//   2. pins the agent's list and the Hub's list to each other;
//   3. runs the agent's own acceptedEnvKey against the Hub's agentAcceptsEnvKey;
//   4. checks that every key the Hub renderer sets is on the list (or its deploys would be
//      refused).
// The agent files and the generator are loaded by computed path; a missing file FAILS.

const ROOT = resolve(import.meta.dirname, '../../../../..')
const GENERATOR = resolve(ROOT, 'scripts/hub-known-env.mts')
const AGENT_KNOWN = resolve(ROOT, 'packages/hub-agent/src/known-env.ts')
const AGENT_SPEC = resolve(ROOT, 'packages/hub-agent/src/spec.ts')
const CONTRACT = resolve(ROOT, 'packages/hub-agent/contract/stack-spec.example.json')
const FIXTURE_PATH = resolve(import.meta.dirname, '../../fixtures/hub-known-env.json')

type Generator = {
  OUTPUTS: Record<'fixture' | 'hub' | 'agent', string>
  buildKnownEnv: () => {
    keys: string[]
    dynamic: Array<{ site: string; decision: string; keys?: string[] }>
  }
  renderOutputs: (k: unknown) => Record<'fixture' | 'hub' | 'agent', string>
  sameOutput: (kind: 'fixture' | 'hub' | 'agent', onDisk: string, fresh: string) => boolean
}
type AgentSpec = {
  acceptedEnvKey: (key: string, redis: unknown, prefixes?: readonly string[]) => boolean
  allowedEnvKey: (key: string, prefixes?: readonly string[]) => boolean
}

async function load<T>(path: string): Promise<T> {
  if (!existsSync(path)) throw new Error(`missing ${path}: the known-env guard cannot run`)
  return (await import(/* @vite-ignore */ pathToFileURL(path).href)) as T
}

function randomKeys(n: number, seed = 20261121): string[] {
  let x = seed
  const next = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return x
  }
  const first = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const rest = `${first}0123456789_`
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    let k = first[next() % first.length]
    const len = next() % 14
    for (let j = 0; j < len; j++) k += rest[next() % rest.length]
    out.push(k)
  }
  return out
}

describe('hub known env list (P4-23)', () => {
  it('every checked-in copy equals a fresh run of the generator', async () => {
    const gen = await load<Generator>(GENERATOR)
    const out = gen.renderOutputs(gen.buildKnownEnv())
    for (const k of ['fixture', 'hub', 'agent'] as const) {
      const onDisk = existsSync(gen.OUTPUTS[k]) ? readFileSync(gen.OUTPUTS[k], 'utf8') : ''
      expect([k, gen.sameOutput(k, onDisk, out[k])]).toEqual([k, true])
    }
  })

  it('the agent list, the Hub list and the fixture are identical', async () => {
    const agent = await load<{ KNOWN_ENV_KEYS: readonly string[] }>(AGENT_KNOWN)
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    expect([...agent.KNOWN_ENV_KEYS]).toEqual([...KNOWN_ENV_KEYS])
    expect(fixture.keys).toEqual([...KNOWN_ENV_KEYS])
    expect(KNOWN_ENV_KEYS.length).toBeGreaterThan(200)
  })

  it('every dynamic read is decided; extension env is left to an operator prefix', async () => {
    const gen = await load<Generator>(GENERATOR)
    const { dynamic } = gen.buildKnownEnv()
    const byDecision = (d: string) => dynamic.filter((x) => x.decision === d).map((x) => x.site)
    expect(byDecision('operator-prefix')).toEqual(['extensions/loader.ts: env[d.name]'])
    for (const x of dynamic) {
      expect(['allow-list', 'operator-prefix', 'not-a-read']).toContain(x.decision)
      if (x.decision === 'allow-list')
        expect([x.site, (x.keys ?? []).length > 0]).toEqual([x.site, true])
    }
  })

  it('every key the Hub renderer or the settings generate is on the list', () => {
    for (const k of [
      ...RENDERER_ENV_KEYS,
      ...RENDERER_DEFAULT_ENV_KEYS,
      // stack-settings GENERATED_SECRET_KEYS + the hub token the renderer adds as a secret
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
      'HUB_TOKEN',
      'DB_CLIENT',
      'DB_HOST',
      'DB_PORT',
      'DB_DATABASE',
      'DB_USER',
      'DB_PASSWORD',
      'REDIS_URL'
    ]) {
      expect([k, allowedEnvKey(k)]).toEqual([k, true])
    }
  })

  it('the contract example sets only known keys', () => {
    const ex = JSON.parse(readFileSync(CONTRACT, 'utf8'))
    for (const k of [...Object.keys(ex.env), ...Object.keys(ex.secrets)])
      expect([k, agentAcceptsEnvKey(k, ex.redis)]).toEqual([k, true])
  })

  it.each([
    [[] as string[]],
    [['EFP_']],
    [['EFP_', 'LD_', 'NODE_', 'MESA_']]
  ])("agentAcceptsEnvKey answers exactly the agent's acceptedEnvKey (prefixes %j)", async (prefixes) => {
    const agent = await load<AgentSpec>(AGENT_SPEC)
    const keys = new Set<string>([
      ...KNOWN_ENV_KEYS,
      ...randomKeys(400),
      'EFP_REGION',
      'EFP_',
      'EFP',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'NODE_ENV',
      'MESA_LOADER_DRIVER_OVERRIDE',
      'GCONV_PATH',
      'GREETING'
    ])
    for (const k of [...keys]) keys.add(`${k}_FILE`)
    for (const redis of ['bundled', 'external']) {
      const differ = [...keys].filter(
        (k) =>
          agent.acceptedEnvKey(k, redis, prefixes) !== agentAcceptsEnvKey(k, redis, prefixes) ||
          agent.allowedEnvKey(k, prefixes) !== allowedEnvKey(k, prefixes)
      )
      expect(differ).toEqual([])
    }
  })

  it('the prefix rule is the agent config rule; health prefixes are filtered, fail closed', async () => {
    const cfgSrc = readFileSync(resolve(ROOT, 'packages/hub-agent/src/config.ts'), 'utf8')
    expect(cfgSrc).toContain(`export const ENV_PREFIX_RE = ${ENV_PREFIX_RE.toString()}`)
    expect(agentEnvPrefixes(null)).toEqual([])
    expect(agentEnvPrefixes({})).toEqual([])
    expect(agentEnvPrefixes({ env_prefixes: 'EFP_' })).toEqual([])
    expect(agentEnvPrefixes({ env_prefixes: ['EFP_', 'efp_', '', 'X', 3, 'ACME2_'] })).toEqual([
      'EFP_',
      'ACME2_'
    ])
  })
})

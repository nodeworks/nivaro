import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGENT_ENV_RULES,
  agentRefusesEnvKey,
  ENV_KEY_RE,
  ONE_LINE_KEYS,
  reservedSettingKey
} from '../../../services/hub/docker/stack-env.js'

// Guard: the Hub's stack settings must refuse every env key the Hub agent refuses
// (packages/hub-agent/src/spec.ts forbiddenEnvKey), or a saved setting turns into a deploy the
// agent answers 400 SPEC_INVALID. The Hub keeps its own copy (stack-env.ts AGENT_ENV_RULES +
// agentRefusesEnvKey) and a fixture of the agent's lists. This test:
//   1. pins the Hub's lists to the fixture and the fixture to the agent's source;
//   2. runs the agent's own forbiddenEnvKey against the Hub's predicate over a generated corpus
//      (every fixture key, prefix+X, _FILE variants, random A–Z keys, both redis modes);
//   3. pins ENV_KEY_RE to the agent's.
// The agent files are loaded by computed path (the API's tsc, rootDir src, never compiles them);
// a missing agent file FAILS — it is never skipped. Change all three together.

const ROOT = resolve(import.meta.dirname, '../../../../..')
const AGENT_SPEC = resolve(ROOT, 'packages/hub-agent/src/spec.ts')
const AGENT_NAMES = resolve(ROOT, 'packages/hub-agent/src/names.ts')
const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/hub-agent-env-rules.json'), 'utf8')
)

type AgentSpec = { forbiddenEnvKey: (key: string, redis: unknown) => boolean }
type AgentNames = { ENV_KEY_RE: RegExp }

async function loadAgent(): Promise<{ spec: AgentSpec; names: AgentNames }> {
  if (!existsSync(AGENT_SPEC) || !existsSync(AGENT_NAMES)) {
    throw new Error(`hub agent sources missing (${AGENT_SPEC}): the env-rule guard cannot run`)
  }
  const spec = (await import(/* @vite-ignore */ pathToFileURL(AGENT_SPEC).href)) as AgentSpec
  const names = (await import(/* @vite-ignore */ pathToFileURL(AGENT_NAMES).href)) as AgentNames
  return { spec, names }
}

const strings = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1])

function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  if (i < 0) throw new Error(`agent spec.ts: "${start}" not found`)
  const j = src.indexOf(end, i + start.length)
  if (j < 0) throw new Error(`agent spec.ts: end of "${start}" not found`)
  return src.slice(i + start.length, j)
}

/** Deterministic pseudo-random A–Z / 0–9 / _ keys (seeded, so a failure reproduces). */
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

function corpus(): string[] {
  const base = new Set<string>([
    ...FIXTURE.runtime_keys,
    ...FIXTURE.node_allowed,
    ...FIXTURE.nivaro_allowed,
    ...FIXTURE.role_env_keys,
    ...FIXTURE.agent_set_env_keys,
    `${FIXTURE.node_prefix}X`,
    FIXTURE.node_prefix,
    `${FIXTURE.nivaro_prefix}X`,
    FIXTURE.nivaro_prefix,
    'NODE_OPTIONS',
    'NODE_PATH',
    'NIVARO_APP_UID',
    'DB_HOST',
    'DB_PASSWORD',
    'TRUST_PROXY',
    'PUBLIC_URL',
    'PATHS',
    'HOMEDIR',
    'LD',
    'SSL_CERT',
    'X_FILE',
    '_FILE',
    'FILE',
    ...randomKeys(400)
  ])
  for (const p of FIXTURE.runtime_prefixes) {
    base.add(`${p}X`)
    base.add(p)
    base.add(p.slice(0, -1))
  }
  const out = [...base]
  for (const k of [...out]) {
    out.push(`${k}${FIXTURE.file_suffix}`)
    out.push(`${k}${FIXTURE.file_suffix}${FIXTURE.file_suffix}`)
  }
  return out
}

describe('hub stack env rules mirror the agent', () => {
  it('the Hub mirror equals the copied fixture', () => {
    expect(AGENT_ENV_RULES.runtime_keys).toEqual(FIXTURE.runtime_keys)
    expect(AGENT_ENV_RULES.runtime_prefixes).toEqual(FIXTURE.runtime_prefixes)
    expect(AGENT_ENV_RULES.node_prefix).toBe(FIXTURE.node_prefix)
    expect(AGENT_ENV_RULES.node_allowed).toEqual(FIXTURE.node_allowed)
    expect(AGENT_ENV_RULES.nivaro_prefix).toBe(FIXTURE.nivaro_prefix)
    expect(AGENT_ENV_RULES.nivaro_allowed).toEqual(FIXTURE.nivaro_allowed)
    expect(AGENT_ENV_RULES.role_env_keys).toEqual(FIXTURE.role_env_keys)
    expect(AGENT_ENV_RULES.agent_set_env_keys).toEqual(FIXTURE.agent_set_env_keys)
    expect(AGENT_ENV_RULES.redis_url_allowed_when).toBe(FIXTURE.redis_url_allowed_when)
    expect(AGENT_ENV_RULES.file_suffix).toBe(FIXTURE.file_suffix)
    expect(AGENT_ENV_RULES.every_file_key_forbidden).toBe(FIXTURE.every_file_key_forbidden)
  })

  it('the fixture equals the agent source', () => {
    if (!existsSync(AGENT_SPEC)) throw new Error(`hub agent source missing: ${AGENT_SPEC}`)
    const src = readFileSync(AGENT_SPEC, 'utf8')
    expect(strings(block(src, 'const RUNTIME_KEYS = new Set([', '])'))).toEqual(
      FIXTURE.runtime_keys
    )
    expect(strings(block(src, 'const RUNTIME_PREFIXES = [', ']'))).toEqual(FIXTURE.runtime_prefixes)
    expect(strings(block(src, 'export const ROLE_ENV_KEYS: readonly string[] = [', ']'))).toEqual(
      FIXTURE.role_env_keys
    )
    expect(
      strings(block(src, 'export const NIVARO_ENV_ALLOWED: readonly string[] = [', ']'))
    ).toEqual(FIXTURE.nivaro_allowed)
    const agentSet = block(src, 'export const AGENT_SET_ENV_KEYS: readonly string[] = [', ']')
    expect([
      ...strings(agentSet),
      ...(agentSet.includes('...ROLE_ENV_KEYS') ? FIXTURE.role_env_keys : [])
    ]).toEqual(FIXTURE.agent_set_env_keys)
    // The one-line keys (smbclient auth file lines) are the same list on both sides.
    expect(strings(block(src, 'export const ONE_LINE_KEYS: readonly string[] = [', ']'))).toEqual([
      ...ONE_LINE_KEYS
    ])
    // Every <KEY>_FILE is refused before any other rule (ruling P4-20).
    expect(FIXTURE.every_file_key_forbidden).toBe(true)
    expect(src).toMatch(/if \(key\.endsWith\('_FILE'\)\) return true/)
  })

  it("ENV_KEY_RE is the agent's", async () => {
    const { names } = await loadAgent()
    expect(ENV_KEY_RE.source).toBe(names.ENV_KEY_RE.source)
    expect(ENV_KEY_RE.flags).toBe(names.ENV_KEY_RE.flags)
  })

  it.each([
    'bundled',
    'external',
    undefined
  ])("agentRefusesEnvKey answers exactly the agent's forbiddenEnvKey (redis %s)", async (redis) => {
    const { spec } = await loadAgent()
    const keys = corpus()
    expect(keys.length).toBeGreaterThan(800)
    const differ = keys.filter(
      (k) => spec.forbiddenEnvKey(k, redis) !== agentRefusesEnvKey(k, redis as string)
    )
    expect(differ).toEqual([])
    // and the settings rules refuse a superset of it
    const looser = keys.filter(
      (k) => spec.forbiddenEnvKey(k, redis) && !reservedSettingKey(k, redis as string)
    )
    expect(looser).toEqual([])
  })

  it.each(['bundled', 'external'] as const)('spot checks with redis %s', (redis) => {
    expect(agentRefusesEnvKey('NODE_ENV', redis)).toBe(false)
    expect(agentRefusesEnvKey('NIVARO_INSTANCE', redis)).toBe(false)
    expect(agentRefusesEnvKey('TMPDIR_FILE', redis)).toBe(true)
    expect(agentRefusesEnvKey('MAIL_FROM_FILE', redis)).toBe(true)
    expect(agentRefusesEnvKey('MAIL_FROM', redis)).toBe(false)
    expect(agentRefusesEnvKey('HELP_VIDEO_WHISPER_CMD', redis)).toBe(true)
    expect(agentRefusesEnvKey('PUPPETEER_EXECUTABLE_PATH', redis)).toBe(true)
    expect(agentRefusesEnvKey('FFREPORT', redis)).toBe(true)
    expect(agentRefusesEnvKey('REDIS_URL', redis)).toBe(redis === 'bundled')
    expect(reservedSettingKey('REDIS_URL', redis)).toBe(redis === 'bundled')
    expect(reservedSettingKey('DB_HOST', redis)).toBe(false)
  })
})

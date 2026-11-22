import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AGENT_ENV_RULES,
  agentRefusesEnvKey,
  reservedSettingKey
} from '../../../services/hub/docker/stack-env.js'

// Guard: the Hub's stack settings must refuse every env key the Hub agent refuses
// (packages/hub-agent/src/spec.ts forbiddenEnvKey), or a saved setting turns into a deploy the
// agent answers 400 SPEC_INVALID. The API never imports the agent package, so the agent's list is
// copied into a fixture; this test pins the Hub's mirror to the fixture, and the fixture to the
// agent's source text while that package sits in the same tree. Change all three together.

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const FIXTURE = readJson('../../fixtures/hub-agent-env-rules.json')
const AGENT_SPEC = new URL('../../../../../packages/hub-agent/src/spec.ts', import.meta.url)

const strings = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1])

function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  if (i < 0) throw new Error(`agent spec.ts: "${start}" not found`)
  const j = src.indexOf(end, i + start.length)
  if (j < 0) throw new Error(`agent spec.ts: end of "${start}" not found`)
  return src.slice(i + start.length, j)
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
  })

  it.skipIf(!existsSync(AGENT_SPEC))('the fixture equals the agent source', () => {
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
    // The predicate itself: shapes this test knows how to mirror.
    const base = block(src, 'function forbiddenBase(', '\n}\n')
    expect(base).toContain("k.startsWith('NODE_') && k !== 'NODE_ENV'")
    expect(base).toContain("k.startsWith('NIVARO_') && !NIVARO_ENV_ALLOWED.includes(k)")
    expect(base).toContain("return !(k === 'REDIS_URL' && redis === 'external')")
    const forbidden = block(src, 'export function forbiddenEnvKey(', '\n}\n')
    expect(forbidden).toContain("key.endsWith('_FILE') && forbiddenBase(key.slice(0, -5), redis)")
  })

  // Keys probing every family, both redis modes: the Hub refuses whatever the agent refuses.
  const PROBES = [
    ...FIXTURE.runtime_keys,
    ...FIXTURE.runtime_prefixes.map((p: string) => `${p}X`),
    'NODE_ENV',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NIVARO_APP_UID',
    'NIVARO_ROLE',
    ...FIXTURE.nivaro_allowed,
    ...FIXTURE.agent_set_env_keys,
    'DB_HOST',
    'DB_HOST_FILE',
    'TMPDIR_FILE',
    'REDIS_URL_FILE',
    'CACHE_WARM'
  ]
  it.each(['bundled', 'external'] as const)('Hub ⊇ agent with redis %s', (redis) => {
    for (const k of PROBES) {
      if (agentRefusesEnvKey(k, redis)) expect(reservedSettingKey(k, redis), k).toBe(true)
    }
    expect(agentRefusesEnvKey('NODE_ENV', redis)).toBe(false)
    expect(agentRefusesEnvKey('NIVARO_INSTANCE', redis)).toBe(false)
    expect(agentRefusesEnvKey('TMPDIR_FILE', redis)).toBe(true)
    expect(agentRefusesEnvKey('REDIS_URL', redis)).toBe(redis === 'bundled')
    expect(reservedSettingKey('REDIS_URL', redis)).toBe(redis === 'bundled')
    expect(reservedSettingKey('DB_HOST', redis)).toBe(false)
  })
})

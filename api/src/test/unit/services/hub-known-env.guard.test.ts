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
  operatorPrefixConflict,
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
  envReadsInSource: (fileName: string, text: string) => { keys: string[]; dynamic: unknown[] }
}
type AgentSpec = {
  operatorPrefixConflict: (prefix: string) => boolean
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

// The generator walks all of api/src: about 6 s on a CI runner, past vitest's 5 s default.
describe('hub known env list (P4-23)', { timeout: 60_000 }, () => {
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
    const none = { prefixes: [], known: false }
    expect(agentEnvPrefixes(null)).toEqual({ ...none, reason: 'unreachable' })
    // An agent from before P4-23 answers no env_prefixes at all.
    expect(agentEnvPrefixes({})).toEqual({ ...none, reason: 'old_agent' })
    expect(agentEnvPrefixes({ env_prefixes: 'EFP_' })).toEqual({ ...none, reason: 'old_agent' })
    expect(
      agentEnvPrefixes({
        env_prefixes: ['EFP_', 'efp_', '', 'X', 3, 'ACME2_', 'EFP_OPS_', 'GTK_', 'GST_PLUGIN_X_']
      })
    ).toEqual({ prefixes: ['EFP_', 'ACME2_', 'EFP_OPS_'], known: true })
  })

  it("operatorPrefixConflict answers exactly the agent's", async () => {
    const agent = await load<AgentSpec>(AGENT_SPEC)
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../fixtures/hub-agent-env-rules.json'), 'utf8')
    )
    const candidates = new Set<string>([
      'EFP_',
      'EFP_OPS_',
      'ACME_',
      'G_',
      'S_',
      'LIB_',
      'TEMPLATE_',
      'TEMPO_',
      'HOMEPAGE_',
      'PATHWAY_'
    ])
    for (const k of [...fixture.runtime_keys, ...fixture.agent_set_env_keys]) {
      for (let i = 1; i <= k.length; i++) candidates.add(`${k.slice(0, i)}_`)
      candidates.add(`${k}_X_`)
    }
    for (const p of fixture.runtime_prefixes) {
      candidates.add(p)
      candidates.add(`${p}X_`)
    }
    const differ = [...candidates].filter(
      (p) => agent.operatorPrefixConflict(p) !== operatorPrefixConflict(p)
    )
    expect(differ).toEqual([])
    for (const p of ['GIO_', 'GTK_', 'GST_', 'QT_', 'GLIBC_', 'GDK_', 'MESA_', 'DYLD_', 'XDG_'])
      expect([p, operatorPrefixConflict(p)]).toEqual([p, true])
    // Starting with an exact deny key (TEMP, HOME, PATH) opens nothing denied.
    for (const p of ['EFP_OPS_', 'TEMPLATE_', 'TEMPO_', 'HOMEPAGE_', 'PATHWAY_'])
      expect([p, operatorPrefixConflict(p)]).toEqual([p, false])
  })

  it('a comment or a string that mentions a key never adds it', async () => {
    const gen = await load<Generator>(GENERATOR)
    const src = [
      '// GIO_EXTRA_MODULES and GTK_MODULES are read by GLib, see process.env.GTK_MODULES',
      '/* process.env.IN_A_BLOCK_COMMENT */',
      "const a = 'process.env.IN_A_STRING'",
      'const b = `process.env.IN_A_TEMPLATE`',
      'lines.push("const u = process.env.BASE_URL ?? \'http://localhost\'")',
      'const c = someObj.env.NOT_AN_ENV',
      'const d = process.env.REAL_DOT',
      "const e = process.env['REAL_BRACKET']",
      'const { REAL_DESTRUCTURED, REAL_RENAMED: alias } = process.env',
      'function f(env: NodeJS.ProcessEnv) { return env.REAL_PARAM }',
      'function g(env = process.env) { return env?.REAL_DEFAULTED }',
      'function h(env: Record<string, string>) { return env.UNTYPED_PARAM }',
      'function t(env = `process.env.X`) { return env.TEMPLATE_DEFAULTED }',
      "const notEnv = 'see process.env'; const z = notEnv.FROM_A_STRING_BINDING",
      'process.env.READ_BY_NULLISH ??= "x"',
      'process.env.READ_BY_OR ||= "x"',
      "process.env['READ_BY_AND'] &&= 'x'",
      'process.env.WRITTEN_ONLY = "x"',
      'delete process.env.DELETED_ONLY'
    ].join('\n')
    const { keys } = gen.envReadsInSource('probe.ts', src)
    expect([...new Set(keys)].sort()).toEqual([
      'READ_BY_AND',
      'READ_BY_NULLISH',
      'READ_BY_OR',
      'REAL_BRACKET',
      'REAL_DEFAULTED',
      'REAL_DESTRUCTURED',
      'REAL_DOT',
      'REAL_PARAM',
      'REAL_RENAMED'
    ])
  })

  // A key on the list that looks like a loader or module path fails unless reviewed here: the
  // deny rules cannot list every loader variable, so a name like that needs a person's look.
  const LOADER_LIKE =
    /_PATH$|PATH$|_MODULES?$|_MODULE_DIR$|MODULE_FILE|_DIRS$|LIB$|DYLD_|PYTHONPATH|CLASSPATH|PERL5LIB|PLUGIN|LIBRARY|PRELOAD|_DIR$/
  const REVIEWED_DATA_PATHS: Record<string, string> = {
    EXPORT_WORK_DIR: 'export-files: scratch folder Nivaro writes export files into',
    FILES_FALLBACK_DIR: 'storage/fallback: read-only folder of another environment uploads',
    HUB_FILES_BACKUP_DIRS:
      'hub-data-app/files-backup: absolute folders a Hub files backup may write archives into',
    HELP_VIDEO_MUSIC_DIR: 'help-video-music: folder of audio files + music.json, decoded as media',
    UPLOAD_DIR: 'server: folder of stored uploads served as files',
    VIDEO_WORK_DIR: 'help-video-uploads / replay export: scratch folder for media files'
  }

  it('every loader-looking key on the list is a reviewed data path', () => {
    const unreviewed = KNOWN_ENV_KEYS.filter(
      (k) => LOADER_LIKE.test(k) && !(k in REVIEWED_DATA_PATHS)
    )
    expect(unreviewed).toEqual([])
    // and the reviewed set stays honest: each entry is still on the list and still loader-looking
    for (const k of Object.keys(REVIEWED_DATA_PATHS))
      expect([k, KNOWN_ENV_KEYS.includes(k) && LOADER_LIKE.test(k)]).toEqual([k, true])
  })
})

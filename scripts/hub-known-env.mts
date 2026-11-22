#!/usr/bin/env tsx
/**
 * Generates the Nivaro app's known config key list (Hub phase 4, ruling P4-23): the env keys a
 * Hub stack spec may set without an operator prefix (HUB_AGENT_ENV_PREFIXES on the agent).
 *
 * Source of truth: the API's own code under api/src (tests and host-run scripts left out):
 *   - every top-level key of the zod schema in api/src/config.ts;
 *   - every `env.X` / `env?.X` / `env['X']` read (process.env and env parameters alike);
 *   - every dynamic read `env[name]`, resolved to the literal names it reads (helper calls, literal
 *     arrays, `env: 'X'` definitions, const maps) or decided by hand in DECIDED below.
 * Keys the agent's deny rules refuse (with external Redis, so REDIS_URL stays) are left out.
 * A dynamic read the generator cannot resolve and DECIDED does not name FAILS the run: someone
 * must decide whether it joins the list or is left to an operator prefix.
 *
 * Writes three copies (the API never imports the agent package, nor the agent the API):
 *   api/src/test/fixtures/hub-known-env.json       the list plus every dynamic read's decision
 *   api/src/services/hub/docker/known-env.ts       the Hub's runtime copy
 *   packages/hub-agent/src/known-env.ts            the agent's runtime copy
 * hub-known-env.guard.test.ts fails when any copy differs from a fresh run.
 *
 * Run from api/:   node --import tsx ../scripts/hub-known-env.mts           (write)
 *                  node --import tsx ../scripts/hub-known-env.mts --check   (exit 1 when stale)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentRefusesEnvKey } from '../api/src/services/hub/docker/stack-env.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(ROOT, 'api/src')

export const OUTPUTS = {
  fixture: resolve(ROOT, 'api/src/test/fixtures/hub-known-env.json'),
  hub: resolve(ROOT, 'api/src/services/hub/docker/known-env.ts'),
  agent: resolve(ROOT, 'packages/hub-agent/src/known-env.ts')
}

export type Decision = 'allow-list' | 'operator-prefix' | 'not-a-read'

export interface DynamicRead {
  /** `<file under api/src>: <expression inside env[...]>` */
  site: string
  decision: Decision
  reason: string
  /** The names it reads, when they joined the list. */
  keys?: string[]
}

/**
 * Dynamic reads decided by hand: `<file>|<expression>`. Every other dynamic read must resolve to
 * literal names (and joins the list) or the run fails.
 */
const DECIDED: Record<string, { decision: Decision; reason: string }> = {
  'extensions/loader.ts|d.name': {
    decision: 'operator-prefix',
    reason:
      "Variables an extension declares in its manifest: not Nivaro's own. The operator allows the extension's prefix (EFP_ for efp-ops) with HUB_AGENT_ENV_PREFIXES."
  },
  'env-files.ts|name': {
    decision: 'not-a-read',
    reason:
      'Secrets from files (#1084): the X_FILE prefix scan and the /run/secrets folder. Every <KEY>_FILE is refused by the deny rules; a /run/secrets file is one of the spec\'s own secrets, which pass the same allow-list.'
  },
  'env-files.ts|key': {
    decision: 'not-a-read',
    reason: 'The X_FILE prefix scan (Object.keys(env)): every <KEY>_FILE is refused by the deny rules.'
  }
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      // Tests and host-run scripts are not the app a stack runs.
      if (name === 'test' || name === 'scripts' || name === 'node_modules') continue
      sourceFiles(p, out)
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Top-level keys of `const schema = z.object({ … })` in config.ts. */
export function schemaKeys(configText: string): string[] {
  const start = configText.indexOf('const schema = z.object({')
  if (start < 0) throw new Error('config.ts: `const schema = z.object({` not found')
  const end = configText.indexOf('\n})', start)
  if (end < 0) throw new Error('config.ts: end of the schema not found')
  const body = configText.slice(start, end)
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1])
}

const STATIC_DOT = /\benv(?:\?\.|\.)([A-Z][A-Z0-9_]*)\b/g
const BRACKET = /\benv(?:\?\.)?\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]/g
const QUOTED = /^\s*(['"`])([A-Z][A-Z0-9_]*)\1\s*$/

const literalArgs = (text: string, fn: string) =>
  [...text.matchAll(new RegExp(`\\b${fn}\\(\\s*['"]([A-Z][A-Z0-9_]*)['"]`, 'g'))].map((m) => m[1])

const quotedNames = (text: string) =>
  [...text.matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)].map((m) => m[1]).filter((k) => k.length > 1)

interface FileText {
  rel: string
  text: string
}

/** The names one dynamic read reads, or null when the generator cannot tell. */
function resolveDynamic(f: FileText, expr: string, at: number, all: FileText[]): string[] | null {
  const before = f.text.slice(0, at)
  const ident = /^[A-Za-z_$][\w$]*$/.test(expr) ? expr : null
  if (ident) {
    // A helper whose parameter is the name: `function H(ident…` / `const H = (ident…`.
    const helperRe = new RegExp(
      `(export\\s+)?(?:function\\s+(\\w+)\\s*\\(\\s*${ident}\\b|const\\s+(\\w+)\\s*=\\s*\\(\\s*${ident}\\b)`,
      'g'
    )
    const helpers = [...before.matchAll(helperRe)]
    const last = helpers.at(-1)
    if (last && at - (last.index ?? 0) < 800) {
      const name = last[2] ?? last[3]
      const keys = literalArgs(f.text, name)
      if (last[1]) {
        const mod = f.rel.replace(/\.ts$/, '.js').split('/').at(-1) as string
        const importRe = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'[^']*${mod}'`)
        for (const o of all) if (o !== f && importRe.test(o.text)) keys.push(...literalArgs(o.text, name))
      }
      return keys.length > 0 ? keys : null
    }
    // A loop over a literal array: `for (const ident of [ … ])`.
    const loops = [...before.matchAll(new RegExp(`for\\s*\\(\\s*const\\s+${ident}\\s+of\\s+\\[([^\\]]*)\\]`, 'g'))]
    const loop = loops.at(-1)
    if (loop && at - (loop.index ?? 0) < 800) {
      const keys = quotedNames(loop[1])
      return keys.length > 0 ? keys : null
    }
    return null
  }
  // `def.env`: the names are the `env: 'X'` definitions of the file.
  if (/^[A-Za-z_$][\w$]*\.env$/.test(expr)) {
    const keys = [...f.text.matchAll(/\benv:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)].map((m) => m[1])
    return keys.length > 0 ? keys : null
  }
  // `MAP[k]`: the string values of `const MAP … = { … }` in the file.
  const map = /^([A-Z][A-Z0-9_]*)\[[^\]]*\]$/.exec(expr)
  if (map) {
    const def = new RegExp(`const\\s+${map[1]}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`).exec(f.text)
    const keys = def ? quotedNames(def[1]) : []
    return keys.length > 0 ? keys : null
  }
  return null
}

export interface KnownEnv {
  keys: string[]
  dynamic: DynamicRead[]
}

/** The known config key list, from the sources as they are now. Throws on an undecided read. */
export function buildKnownEnv(): KnownEnv {
  const found = new Set<string>(schemaKeys(readFileSync(resolve(SRC, 'config.ts'), 'utf8')))
  const files: FileText[] = sourceFiles(SRC).map((p) => ({
    rel: relative(SRC, p).split('\\').join('/'),
    text: readFileSync(p, 'utf8')
  }))
  const dynamic = new Map<string, DynamicRead>()
  const undecided: string[] = []

  for (const f of files) {
    for (const m of f.text.matchAll(STATIC_DOT)) found.add(m[1])
    for (const m of f.text.matchAll(BRACKET)) {
      // A bracket after `env` inside a longer word (`someenv[`) never matches: \b. Writes skip.
      const inner = m[1]
      const quoted = QUOTED.exec(inner)
      if (quoted) {
        found.add(quoted[2])
        continue
      }
      const after = f.text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 6)
      if (/^\s*(?:=(?!=)|\|\|=|\?\?=|&&=)/.test(after)) continue
      const expr = inner.trim()
      const site = `${f.rel}: env[${expr}]`
      if (dynamic.has(site)) continue
      const decided = DECIDED[`${f.rel}|${expr}`]
      if (decided) {
        dynamic.set(site, { site, ...decided })
        continue
      }
      const keys = resolveDynamic(f, expr, m.index ?? 0, files)
      if (!keys) {
        undecided.push(site)
        continue
      }
      const uniq = [...new Set(keys)].sort()
      for (const k of uniq) found.add(k)
      dynamic.set(site, {
        site,
        decision: 'allow-list',
        reason: 'Resolved to the literal names it reads.',
        keys: uniq
      })
    }
  }
  if (undecided.length > 0) {
    throw new Error(
      `hub-known-env: dynamic env reads nobody decided (add each to DECIDED in scripts/hub-known-env.mts, or read the name literally):\n  ${undecided.join('\n  ')}`
    )
  }
  const keys = [...found]
    .filter((k) => ENV_NAME.test(k) && !agentRefusesEnvKey(k, 'external'))
    .sort()
  return { keys, dynamic: [...dynamic.values()].sort((a, b) => a.site.localeCompare(b.site)) }
}

const HEADER = (what: string) =>
  `// GENERATED by scripts/hub-known-env.mts — do not edit. Run from api/:
//   node --import tsx ../scripts/hub-known-env.mts
// ${what}
// The Nivaro app's known config keys (ruling P4-23): a Hub stack spec may set these, plus keys
// under the agent's HUB_AGENT_ENV_PREFIXES, and never a key the deny rules refuse.
`

function tsModule(keys: string[], what: string): string {
  const lines = keys.map((k) => `  '${k}'`).join(',\n')
  return `${HEADER(what)}export const KNOWN_ENV_KEYS: readonly string[] = [\n${lines}\n]\n`
}

/** The three files, exactly as the generator writes them. */
export function renderOutputs(known: KnownEnv): Record<keyof typeof OUTPUTS, string> {
  const fixture = {
    _comment:
      'GENERATED by scripts/hub-known-env.mts (run from api/: node --import tsx ../scripts/hub-known-env.mts) — do not edit. The Nivaro app\'s known config keys (ruling P4-23); copies in api/src/services/hub/docker/known-env.ts and packages/hub-agent/src/known-env.ts. hub-known-env.guard.test.ts fails when any copy is stale.',
    keys: known.keys,
    dynamic: known.dynamic
  }
  return {
    fixture: `${JSON.stringify(fixture, null, 2)}\n`,
    hub: tsModule(known.keys, "The Hub's copy (stack settings refuse a key outside it)."),
    agent: tsModule(known.keys, "The agent's copy (spec validation refuses a key outside it).")
  }
}

/**
 * A checked-in copy equals a fresh one: the TS modules byte for byte, the fixture by its JSON
 * (biome may lay the JSON out differently; the content is what counts).
 */
export function sameOutput(kind: keyof typeof OUTPUTS, onDisk: string, fresh: string): boolean {
  if (kind !== 'fixture') return onDisk === fresh
  try {
    return JSON.stringify(JSON.parse(onDisk)) === JSON.stringify(JSON.parse(fresh))
  } catch {
    return false
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const out = renderOutputs(buildKnownEnv())
  const check = process.argv.includes('--check')
  let stale = 0
  for (const [k, path] of Object.entries(OUTPUTS) as [keyof typeof OUTPUTS, string][]) {
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {}
    if (sameOutput(k, current, out[k])) continue
    stale++
    if (check) console.error(`stale: ${relative(ROOT, path)}`)
    else {
      writeFileSync(path, out[k])
      console.log(`wrote ${relative(ROOT, path)}`)
    }
  }
  if (check && stale > 0) process.exit(1)
  if (!check && stale === 0) console.log('hub-known-env: every copy is current')
}

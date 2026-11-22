#!/usr/bin/env tsx
/**
 * Generates the Nivaro app's known config key list (Hub phase 4, ruling P4-23): the env keys a
 * Hub stack spec may set without an operator prefix (HUB_AGENT_ENV_PREFIXES on the agent).
 *
 * Source of truth: the API's own code under api/src (tests and host-run scripts left out), read
 * with the TypeScript parser — comments and plain strings never count:
 *   - every top-level key of `const schema = z.object({ … })` in api/src/config.ts;
 *   - every real env read: `process.env.X`, `process.env['X']`, `env.X` / `env['X']` on an
 *     env-typed binding (a parameter or variable typed `…ProcessEnv` or initialised from
 *     `process.env`), and destructuring `const { X } = process.env`;
 *   - every dynamic read `env[name]`, resolved to the literal names it reads (helper calls,
 *     literal-array loops, `env: 'X'` definitions, const maps) or decided by hand in DECIDED.
 * Writes (`env[k] = v`, `||=`, `delete`) are not reads. Keys the agent's deny rules refuse (with
 * external Redis, so REDIS_URL stays) are left out. A dynamic read the generator cannot resolve
 * and DECIDED does not name FAILS the run: someone must decide whether it joins the list or is
 * left to an operator prefix.
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
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as TS from 'typescript'
import { agentRefusesEnvKey } from '../api/src/services/hub/docker/stack-env.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(ROOT, 'api/src')
// typescript is an api/ dependency (no root node_modules copy): resolve it from there.
const ts = createRequire(resolve(ROOT, 'api/package.json'))('typescript') as typeof TS

export const OUTPUTS = {
  fixture: resolve(ROOT, 'api/src/test/fixtures/hub-known-env.json'),
  hub: resolve(ROOT, 'api/src/services/hub/docker/known-env.ts'),
  agent: resolve(ROOT, 'packages/hub-agent/src/known-env.ts')
}

export type Decision = 'allow-list' | 'operator-prefix' | 'not-a-read'

export interface DynamicRead {
  /** `<file under api/src>: env[<expression>]` */
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
      "Secrets from files (#1084): the X_FILE prefix scan and the /run/secrets folder. Every <KEY>_FILE is refused by the deny rules; a /run/secrets file is one of the spec's own secrets, which pass the same allow-list."
  },
  'env-files.ts|key': {
    decision: 'not-a-read',
    reason:
      'The X_FILE prefix scan (Object.keys(env)): every <KEY>_FILE is refused by the deny rules.'
  }
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/** Plain code-unit order (never locale-dependent). */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort(byCodeUnit)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      // Tests and host-run scripts are not the app a stack runs.
      if (name === 'test' || name === 'scripts' || name === 'node_modules') continue
      sourceFiles(p, out)
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const parse = (fileName: string, text: string) =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const literalText = (n: TS.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null

/** Top-level keys of `const schema = z.object({ … })` in config.ts. */
export function schemaKeys(configText: string): string[] {
  const sf = parse('config.ts', configText)
  let keys: string[] | null = null
  const visit = (n: TS.Node) => {
    if (
      !keys &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'schema' &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'z.object'
    ) {
      const obj = n.initializer.arguments[0]
      if (obj && ts.isObjectLiteralExpression(obj)) {
        keys = obj.properties
          .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ''))
          .filter((k) => ENV_NAME.test(k))
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (!keys) throw new Error('config.ts: `const schema = z.object({ … })` not found')
  return keys
}

/** `process.env` itself. */
function isProcessEnv(n: TS.Node): boolean {
  return (
    ts.isPropertyAccessExpression(n) &&
    n.name.text === 'env' &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'process'
  )
}

/** A binding that holds an environment: typed `…ProcessEnv`, or initialised from process.env. */
function isEnvBinding(
  sf: TS.SourceFile,
  d: TS.ParameterDeclaration | TS.VariableDeclaration
): boolean {
  if (!ts.isIdentifier(d.name)) return false
  if (d.type && /\bProcessEnv\b/.test(d.type.getText(sf))) return true
  return !!d.initializer && /(^|[^\w.])process\.env\b/.test(d.initializer.getText(sf))
}

/** A read target, not a write: `x = …`, `x ||= …`, `delete x`, `x++` are not reads. */
function isWrite(n: TS.Node): boolean {
  const p = n.parent
  if (ts.isBinaryExpression(p) && p.left === n) {
    const k = p.operatorToken.kind
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment
  }
  return ts.isDeleteExpression(p)
}

export interface FileReads {
  /** Literal names read. */
  keys: string[]
  /** Dynamic element reads: the expression inside `env[…]` and the node. */
  dynamic: Array<{ expr: string; node: TS.ElementAccessExpression }>
  sf: TS.SourceFile
}

/** Every real env read in one source file. Comments and string contents never count. */
export function envReadsInSource(fileName: string, text: string): FileReads {
  const sf = parse(fileName, text)
  const keys: string[] = []
  const dynamic: FileReads['dynamic'] = []

  const visit = (n: TS.Node, envNames: ReadonlySet<string>) => {
    let names = envNames
    // Env-typed parameters of a function, and env-holding variables, scope over what follows.
    if (ts.isFunctionLike(n)) {
      const add = n.parameters.filter((p) => isEnvBinding(sf, p)).map((p) => (p.name as TS.Identifier).text)
      if (add.length > 0) names = new Set([...names, ...add])
    }
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) {
      const add: string[] = []
      for (const st of n.statements) {
        if (!ts.isVariableStatement(st)) continue
        for (const d of st.declarationList.declarations)
          if (isEnvBinding(sf, d)) add.push((d.name as TS.Identifier).text)
      }
      if (add.length > 0) names = new Set([...names, ...add])
    }
    const isEnvExpr = (e: TS.Expression): boolean =>
      isProcessEnv(e) || (ts.isIdentifier(e) && names.has(e.text))

    if (ts.isPropertyAccessExpression(n) && isEnvExpr(n.expression) && !isWrite(n)) {
      if (ENV_NAME.test(n.name.text)) keys.push(n.name.text)
    } else if (ts.isElementAccessExpression(n) && isEnvExpr(n.expression) && !isWrite(n)) {
      const lit = literalText(n.argumentExpression)
      if (lit !== null) {
        if (ENV_NAME.test(lit)) keys.push(lit)
      } else dynamic.push({ expr: n.argumentExpression.getText(sf), node: n })
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      isEnvExpr(n.initializer)
    ) {
      for (const el of n.name.elements) {
        const prop = el.propertyName ?? el.name
        const k = ts.isIdentifier(prop) ? prop.text : literalText(prop)
        if (k && ENV_NAME.test(k)) keys.push(k)
      }
    }
    ts.forEachChild(n, (c) => visit(c, names))
  }
  visit(sf, new Set())
  return { keys, dynamic, sf }
}

interface FileInfo {
  rel: string
  reads: FileReads
}

/** First-argument string literals of every call to `fn` in a file. */
function literalArgs(sf: TS.SourceFile, fn: string): string[] {
  const out: string[] = []
  const visit = (n: TS.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn) {
      const lit = literalText(n.arguments[0])
      if (lit && ENV_NAME.test(lit)) out.push(lit)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The function `ident` is a parameter of: its name and whether it is exported. */
function helperOf(node: TS.Node, ident: string, sf: TS.SourceFile) {
  for (let p: TS.Node | undefined = node.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p)) continue
    if (!p.parameters.some((x) => ts.isIdentifier(x.name) && x.name.text === ident)) continue
    let name: string | null = null
    let exported = false
    if (ts.isFunctionDeclaration(p) && p.name) {
      name = p.name.text
      exported = !!p.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    } else if (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
      name = p.parent.name.text
      const stmt = p.parent.parent?.parent
      exported =
        !!stmt &&
        ts.isVariableStatement(stmt) &&
        !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    }
    return name ? { name, exported } : null
  }
  void sf
  return null
}

/** The names one dynamic read reads, or null when the generator cannot tell. */
function resolveDynamic(
  f: FileInfo,
  d: FileReads['dynamic'][number],
  all: FileInfo[]
): string[] | null {
  const { sf } = f.reads
  const arg = d.node.argumentExpression
  if (ts.isIdentifier(arg)) {
    const ident = arg.text
    const helper = helperOf(d.node, ident, sf)
    if (helper) {
      const keys = literalArgs(sf, helper.name)
      if (helper.exported) {
        const mod = `/${f.rel.replace(/\.ts$/, '.js').split('/').at(-1)}`
        for (const o of all) {
          if (o === f) continue
          const imports = o.reads.sf.statements.some(
            (s) =>
              ts.isImportDeclaration(s) &&
              (literalText(s.moduleSpecifier) ?? '').endsWith(mod) &&
              !!s.importClause?.namedBindings &&
              ts.isNamedImports(s.importClause.namedBindings) &&
              s.importClause.namedBindings.elements.some((e) => e.name.text === helper.name)
          )
          if (imports) keys.push(...literalArgs(o.reads.sf, helper.name))
        }
      }
      return keys.length > 0 ? keys : null
    }
    // A loop over a literal array: `for (const ident of ['A', 'B'])`.
    for (let p: TS.Node | undefined = d.node.parent; p; p = p.parent) {
      if (!ts.isForOfStatement(p)) continue
      const init = p.initializer
      const bound =
        ts.isVariableDeclarationList(init) &&
        init.declarations.some((x) => ts.isIdentifier(x.name) && x.name.text === ident)
      if (!bound) continue
      if (!ts.isArrayLiteralExpression(p.expression)) return null
      const keys = p.expression.elements.map(literalText).filter((k): k is string => !!k && ENV_NAME.test(k))
      return keys.length > 0 ? keys : null
    }
    return null
  }
  // `def.env`: the names are the `env: 'X'` property definitions of the file.
  if (ts.isPropertyAccessExpression(arg) && arg.name.text === 'env') {
    const keys: string[] = []
    const visit = (n: TS.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'env') {
        const lit = literalText(n.initializer)
        if (lit && ENV_NAME.test(lit)) keys.push(lit)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return keys.length > 0 ? keys : null
  }
  // `MAP[k]`: the string values of `const MAP = { … }` in the file.
  if (ts.isElementAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
    const mapName = arg.expression.text
    let keys: string[] = []
    const visit = (n: TS.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === mapName &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        keys = n.initializer.properties
          .map((p) => (ts.isPropertyAssignment(p) ? literalText(p.initializer) : null))
          .filter((k): k is string => !!k && ENV_NAME.test(k))
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
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
  const files: FileInfo[] = sourceFiles(SRC).map((p) => {
    const rel = relative(SRC, p).split('\\').join('/')
    return { rel, reads: envReadsInSource(rel, readFileSync(p, 'utf8')) }
  })
  const dynamic = new Map<string, DynamicRead>()
  const undecided: string[] = []

  for (const f of files) {
    for (const k of f.reads.keys) found.add(k)
    for (const d of f.reads.dynamic) {
      const site = `${f.rel}: env[${d.expr}]`
      if (dynamic.has(site)) continue
      const decided = DECIDED[`${f.rel}|${d.expr}`]
      if (decided) {
        dynamic.set(site, { site, ...decided })
        continue
      }
      const keys = resolveDynamic(f, d, files)
      if (!keys) {
        undecided.push(site)
        continue
      }
      const uniq = [...new Set(keys)].sort(byCodeUnit)
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
    .sort(byCodeUnit)
  return {
    keys,
    dynamic: [...dynamic.values()].sort((a, b) => byCodeUnit(a.site, b.site))
  }
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

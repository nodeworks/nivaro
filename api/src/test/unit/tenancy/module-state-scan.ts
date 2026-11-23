import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { listSourceFiles } from '../cloud-flag-scan.js'

// The scanner behind module-state.guard.test.ts (Hub phase 6 Task 22). It lists every piece of
// module-level mutable state under the scanned folders of api/src (tests and migrations excluded):
//
//   let       a top-level `let` (one slot for the whole process)
//   Map, Set, WeakMap, WeakSet, <X>Cache …   a top-level `new X(…)` whose class name says it holds
//             entries (Map / Set / Cache / LRU / TTL), when the module writes to it, passes it on,
//             or exports it. One the module never writes is a fixed lookup table and is skipped.
//   literal   a top-level object / array literal the module writes to later (`x.a = …`,
//             `x[k] = …`, `x.push(…)`, `x.m.set(…)`, `delete x[k]`, `Object.assign(x, …)`)
//
//   create…Cache / create…Limiter / create…Budget   a top-level call of a factory that hands back
//             a cache, limiter or budget (short-cache.ts, socket-rate-limit.ts …)
//
// A top-level `const x = tenantState(…)` / `appMap()` / `appSet()` / `appBox(…)` is per app by
// construction and is never a finding.
//
// A Map / Set (or a `let` that only ever holds a fresh Map / Set) is DETECTED as keyed per app
// when the module writes it at least once and every write's key names the app: the key text calls
// a tenant helper (TENANT_HELPER), a function of this module whose body does, or uses a variable
// whose initialiser does (followed up to three hops). Every other finding must be listed.

export const SCAN_DIRS = [
  'auth/',
  'db/',
  'extensions/',
  'flows/',
  'functions/',
  'graphql/',
  'hooks/',
  'lib/',
  'middleware/',
  'plugins/',
  'routes/',
  'services/'
]

/** Helpers that put the app into a key (or hand out per-app state). */
export const TENANT_HELPER =
  /\b(?:currentTenantKey|getTenantId|tenantState|appKey|appKeyPart|dropAppEntries|tenantScopedRoom)\s*\(/

export interface StateFinding {
  /** `<file> :: <name>` */
  id: string
  file: string
  name: string
  kind: string
  /** Every write's key names the app (see above). */
  keyed: boolean
  line: number
  text: string
}

const COLLECTION_CLASS = /(?:Map|Set|Cache|LRU|Lru|TTL)$/
/** Initialisers that are per app by construction (services/ai-tenant-state.ts, app-state.ts). */
const PER_APP_FACTORY = /^(?:tenantState|appMap|appSet|appBox)$/
/** Factories that hand back a cache, limiter or budget holding entries (short-cache.ts …). */
const CACHE_FACTORY = /^create\w*(?:Cache|Limiter|Budget)$/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Functions (declarations and `const f = (…) => …`) anywhere in the file whose text names the
 *  app, iterated to a fixed point so a helper that calls such a helper counts too. */
function tenantFunctions(sf: ts.SourceFile): Set<string> {
  const bodies = new Map<string, string>()
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) bodies.set(n.name.text, n.getText(sf))
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      bodies.set(n.name.text, n.initializer.getText(sf))
    else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name))
      bodies.set(n.name.text, n.getText(sf))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const out = new Set<string>()
  for (let changed = true; changed; ) {
    changed = false
    const local =
      out.size > 0 ? new RegExp(`\\b(?:${[...out].map(escapeRe).join('|')})\\s*\\(`) : /(?!)/
    for (const [name, body] of bodies) {
      if (out.has(name)) continue
      if (TENANT_HELPER.test(body) || local.test(body)) {
        out.add(name)
        changed = true
      }
    }
  }
  return out
}

function isScope(n: ts.Node): boolean {
  return ts.isFunctionLike(n) || ts.isSourceFile(n)
}

function scopeOf(n: ts.Node): ts.Node {
  let p = n.parent
  while (p && !isScope(p)) p = p.parent
  return p
}

/** What the variable `id`, seen at `at`, may hold: the initialisers and plain assignments of the
 *  nearest scope (function or module) that declares it. A parameter holds whatever a caller
 *  passed, which this file cannot see: null. */
function valuesOf(id: string, at: ts.Node, sf: ts.SourceFile): string[] | null {
  for (
    let scope: ts.Node | undefined = scopeOf(at);
    scope;
    scope = scope.parent && scopeOf(scope)
  ) {
    if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === id)
          return p.initializer ? [p.initializer.getText(sf)] : null
        if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name))
          for (const el of p.name.elements)
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === id)
              return null
      }
    }
    const values: string[] = []
    let declared = false
    const visit = (n: ts.Node) => {
      if (n !== scope && isScope(n)) return
      if (ts.isVariableDeclaration(n)) {
        const hit =
          (ts.isIdentifier(n.name) && n.name.text === id) ||
          ((ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) &&
            n.name.elements.some(
              (el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === id
            ))
        if (hit) {
          declared = true
          if (n.initializer) values.push(n.initializer.getText(sf))
        }
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        n.left.text === id
      )
        values.push(n.right.getText(sf))
      if (
        (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
        ts.isVariableDeclarationList(n.initializer) &&
        n.initializer.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === id)
      ) {
        declared = true
        values.push(n.expression.getText(sf))
      }
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(scope, visit)
    if (declared) return values
    if (ts.isSourceFile(scope)) return null
  }
  return null
}

function namesApp(
  node: ts.Node,
  text: string,
  sf: ts.SourceFile,
  fns: Set<string>,
  depth = 0,
  seen = new Set<string>()
): boolean {
  if (TENANT_HELPER.test(text)) return true
  if (fns.size > 0 && new RegExp(`\\b(?:${[...fns].map(escapeRe).join('|')})\\s*\\(`).test(text))
    return true
  if (depth >= 3) return false
  for (const m of text.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*\b/g)) {
    const id = m[0]
    if (seen.has(id)) continue
    seen.add(id)
    for (const v of valuesOf(id, node, sf) ?? [])
      if (namesApp(node, v, sf, fns, depth + 1, seen)) return true
  }
  return false
}

/** The first argument of every write to `name` in the file: `name.set(k…)`, `name.add(k)`,
 *  `name[k] = …`; null when the name is reassigned to anything other than a fresh Map / Set. */
function writeKeys(sf: ts.SourceFile, name: string, decl: ts.Node): ts.Node[] | null {
  const keys: ts.Node[] = []
  let otherAssign = false
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === name &&
      /^(set|add)$/.test(n.expression.name.text)
    ) {
      keys.push(n.arguments[0] ?? n)
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name &&
      n !== decl
    ) {
      const r = n.right
      if (
        !(
          ts.isNewExpression(r) &&
          ts.isIdentifier(r.expression) &&
          /^(Map|Set)$/.test(r.expression.text) &&
          (r.arguments?.length ?? 0) === 0
        )
      )
        otherAssign = true
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === name
    )
      keys.push(n.left.argumentExpression)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return otherAssign ? null : keys
}

function isFreshCollection(init: ts.Expression | undefined): string | null {
  if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression)) return null
  return COLLECTION_CLASS.test(init.expression.text) ? init.expression.text : null
}

/** `Object.create(null)` — a bare dictionary, written by index like a literal. */
function isObjectCreate(init: ts.Expression): boolean {
  return (
    ts.isCallExpression(init) &&
    ts.isPropertyAccessExpression(init.expression) &&
    init.expression.getText() === 'Object.create'
  )
}

/** The literal named `n` is written after its declaration: assigned (`=`, `+=`, `??=` …),
 *  counted (`++` / `--`, either side), mutated by a method (`push`, `set` …), deleted from or
 *  Object.assign-ed — through any chain of `.prop` / `[index]` (review I-3). */
function literalWritten(n: string, after: string): boolean {
  const chain = `(?:\\s*(?:\\.[\\w$]+|\\[[^\\]]*\\]))*`
  const assign = `(?:=(?!=)|\\+\\+|--|[-+*/%&|^]=|\\*\\*=|<<=|>>>?=|\\?\\?=|\\|\\|=|&&=)`
  const method = `\\.(?:push|splice|unshift|pop|shift|set|add|delete|clear|fill|sort|reverse)\\s*\\(`
  return new RegExp(
    `\\b${n}${chain}\\s*(?:${assign}|${method})|(?:\\+\\+|--)\\s*${n}\\b${chain}|delete\\s+${n}\\b|Object\\.assign\\(\\s*${n}\\b`
  ).test(after)
}

/** Every module-level state of one file. */
export function scanStateFile(rel: string, src: string): StateFinding[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true)
  const fns = tenantFunctions(sf)
  const out: StateFinding[] = []
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    const isLet = (st.declarationList.flags & ts.NodeFlags.Let) !== 0
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      const name = d.name.text
      const init = d.initializer
      if (
        !isLet &&
        init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        PER_APP_FACTORY.test(init.expression.text)
      )
        continue
      const after = src.slice(st.end)
      const n = escapeRe(name)
      let kind = ''
      const coll = isFreshCollection(init)
      if (isLet) kind = 'let'
      else if (
        init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        CACHE_FACTORY.test(init.expression.text)
      )
        kind = init.expression.text
      else if (coll) {
        const written = new RegExp(`\\b${n}\\s*\\??\\.\\s*(?:set|add|delete|clear)\\s*\\(`).test(
          src
        )
        const passed = new RegExp(`[(,]\\s*${n}\\s*[,)]`).test(src)
        if (written || passed || exported) kind = coll
      } else if (
        init &&
        (ts.isObjectLiteralExpression(init) ||
          ts.isArrayLiteralExpression(init) ||
          isObjectCreate(init)) &&
        literalWritten(n, after)
      )
        kind = 'literal'
      if (!kind) continue
      let keyed = false
      // A Map handed to another function or aliased may be written there with any key: never
      // detected as keyed, it must be listed (review I-3). dropAppEntries() only removes. Also
      // handed on (R2-M1): object shorthand `{ m }`, an array element `[m]`, and `return m`
      // (a read through it — `return m.get(…)`, `m[k]`, `m?.size` — is not).
      const handedOn =
        new RegExp(`(?<!dropAppEntries)\\(\\s*${n}\\s*[,)]|,\\s*${n}\\s*[,)]`).test(src) ||
        new RegExp(`[=:]\\s*${n}\\s*(?:[,;)}\\n]|$)`, 'm').test(after) ||
        new RegExp(`[{,[]\\s*${n}\\s*[,}\\]]`).test(src) ||
        new RegExp(`\\breturn\\s+${n}\\b(?!\\s*(?:\\.|\\[|\\?\\.))`).test(src)
      if (coll && kind !== 'WeakMap' && kind !== 'WeakSet' && !handedOn) {
        const keys = writeKeys(sf, name, d)
        keyed = !!keys && keys.length > 0 && keys.every((k) => namesApp(k, k.getText(sf), sf, fns))
      }
      const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1
      out.push({
        id: `${rel} :: ${name}`,
        file: rel,
        name,
        kind,
        keyed,
        line,
        text: d.getText(sf).split('\n')[0]?.slice(0, 140) ?? ''
      })
    }
  }
  return out
}

/** Every module-level state under the scanned folders of `root` (api/src). */
export function scanModuleState(root: string): StateFinding[] {
  const out: StateFinding[] = []
  for (const rel of listSourceFiles(root)) {
    // The scanned folders, and the files at api/src itself (server.ts, realtime-server.ts …, M-6).
    if (rel.includes('/') && !SCAN_DIRS.some((d) => rel.startsWith(d))) continue
    out.push(...scanStateFile(rel, readFileSync(join(root, rel), 'utf8')))
  }
  return out
}

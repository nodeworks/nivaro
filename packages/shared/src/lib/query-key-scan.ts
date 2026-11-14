/**
 * Static inventory of TanStack Query keys and the SHAPE each reader stores under them.
 *
 * Node-only (reads files, parses with the TypeScript compiler). Used by the query-key guard
 * tests and by `scripts/query-key-inventory.ts`; never imported by app code.
 *
 * Why: two readers that put different shapes under one key crash whichever reads second
 * (prod 2026-11-13, "nn.find is not a function": ['collection-meta', c] held both a
 * relations ARRAY and the whole meta OBJECT). TypeScript can't see it — the key is a plain
 * array and the cache is untyped — so this scan compares readers statically.
 *
 * What counts as a site:
 *  - an object literal with `queryKey: ['<literal>', …]` (useQuery, useSuspenseQuery,
 *    useQueries entries, fetchQuery / ensureQueryData / prefetchQuery, queryOptions(), and the
 *    invalidate / remove / refetch / cancel filters), or `queryKey: <registry builder>(…)`;
 *  - `setQueryData([…], v)` / `getQueryData<T>([…])` / `setQueriesData({queryKey: […]}, …)`.
 *
 * Shape signature of a reader (best effort): `<METHOD> <path> <body path>[ →<derivation>]`,
 * e.g. `GET /collections/:p .data` for both `api.get(`/collections/${c}`).then(r => r.data.data)`
 * (axios: the response's `.data` is the body) and `client.request(get(`/collections/${c}`))
 * .then(r => r.data)` (the shared client returns the body). `?? []` / `|| {}` defaults and
 * optional chaining are ignored; `.map(…)` / `.filter(…)` and other calls on the result add a
 * derivation suffix (they change the stored shape); `select` is ignored (it never touches the
 * cache). A queryFn that calls a top-level helper (`fetchCollectionRelations(client, c)`) reads
 * as that helper's own shape when `functionIndex` resolved it, else `call <name>`. SDK request
 * builders (`readOnlinePresence()`) read as their endpoint (`commandEndpoints`). Anything else is
 * `?` + a compact text of the returned expression — reported, never treated as a known shape.
 *
 * Limits: keys built in a variable (`const key = […]; queryKey: key`), keys spread from another
 * array (`[...base, c]`), computed roots, URLs built from a variable (`get(path)`) and queryFns
 * with more than one top-level return or that branch between different sources are not
 * resolved (unknown — not compared). Object methods (`schemaApi.getTable`) stay `call <name>`.
 * A literal element vs a variable at the same position is treated as possibly equal (list real
 * exceptions in QUERY_KEY_DISJOINT). setQueryData values are not checked (the builders' DataTag
 * types cover those). Shapes come from the call site, not from TypeScript's types, so two
 * endpoints that happen to return the same JSON read as two shapes (a false alarm, fixed by
 * sharing a fetcher). Another repo's app (efp-new) is only checked when its src is passed to
 * scripts/query-key-inventory.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

export type QuerySiteKind = 'read' | 'filter' | 'set' | 'get'

export interface QuerySite {
  file: string
  line: number
  kind: QuerySiteKind
  /** First key element (the literal root). */
  root: string
  /** Key elements: string literal values as-is, everything else `*`. Null when spread/unknown. */
  pattern: string[] | null
  /** Reader shape signature (read sites only). */
  shape?: string
  /** Explicit type argument seen on the reader (useQuery<T>, request<T>, get<T>), compacted. */
  typeArg?: string
  /** Registry builder the key came from, when it did. */
  builder?: string
  /** ScanOptions.scope of the file. */
  scope?: string
}

export interface ScanOptions {
  /** Identifiers whose `.get/.post/.put/.patch/.delete/.request` return an axios RESPONSE. */
  responseClients?: string[]
  /** Registry builder names → root they produce (e.g. `collectionMeta` → 'collection-meta'). */
  builders?: Record<string, string>
  /** SDK request builders → endpoint signature (`readOnlinePresence` → `GET /presence/online`). */
  sdkEndpoints?: Record<string, string>
  /** Helper functions of other files → the shape they resolve to (see functionIndex). */
  functionShapes?: Map<string, string>
  /** Path prefix stripped from the file names reported. */
  base?: string
  /**
   * Which app the files belong to. Sites of two different apps never share a QueryClient, so
   * they never collide — except `shared` (packages/shared, packages/react), which every app hosts.
   */
  scope?: string
}

const BODY_CLIENT_METHODS = new Set(['request'])
const BODY_FUNCTIONS = new Set(['apiFetch', 'fetchJson', 'getJson'])
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'request'])
const DERIVATIONS = new Set([
  'map',
  'filter',
  'sort',
  'slice',
  'find',
  'reduce',
  'flatMap',
  'concat',
  'toSorted',
  'flat'
])
const FILTER_CALLS = new Set([
  'invalidateQueries',
  'removeQueries',
  'refetchQueries',
  'cancelQueries',
  'resetQueries',
  'getQueriesData',
  'setQueriesData',
  'isFetching',
  'useIsFetching',
  'getQueryCache'
])

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression
    else if (ts.isNonNullExpression(cur)) cur = cur.expression
    else if (ts.isAwaitExpression(cur)) cur = cur.expression
    else if (ts.isTypeAssertionExpression(cur)) cur = cur.expression
    else return cur
  }
}

function compact(text: string, max = 70): string {
  const t = text.replace(/\s+/g, ' ').replace(/\?\./g, '.').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** `a.b.c` property chain on a root identifier → { root, path: '.b.c' }. */
function chainOf(e: ts.Expression): { root: string; path: string } | null {
  const parts: string[] = []
  let cur = unwrap(e)
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(`.${cur.name.text}`)
      cur = unwrap(cur.expression)
    } else if (ts.isElementAccessExpression(cur) && ts.isStringLiteral(cur.argumentExpression)) {
      parts.unshift(`.${cur.argumentExpression.text}`)
      cur = unwrap(cur.expression)
    } else break
  }
  if (ts.isIdentifier(cur)) return { root: cur.text, path: parts.join('') }
  return null
}

/** `(<call>).a.b` → { call, path: '.a.b' } (at least one property). */
function callChainOf(e: ts.Expression): { call: ts.CallExpression; path: string } | null {
  const parts: string[] = []
  let cur = unwrap(e)
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(`.${cur.name.text}`)
    cur = unwrap(cur.expression)
  }
  if (!parts.length || !ts.isCallExpression(cur)) return null
  return { call: cur, path: parts.join('') }
}

/** Drop `?? x` / `|| x` defaults: they keep the shape. */
function stripDefault(e: ts.Expression): ts.Expression {
  let cur = unwrap(e)
  while (
    ts.isBinaryExpression(cur) &&
    (cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      cur.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    cur = unwrap(cur.left)
  return cur
}

function urlOf(arg: ts.Expression | undefined): string {
  if (!arg) return '<none>'
  const a = unwrap(arg)
  let raw: string
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) raw = a.text
  else if (ts.isTemplateExpression(a)) {
    raw = a.head.text
    for (const span of a.templateSpans) raw += `:p${span.literal.text}`
  } else if (
    ts.isBinaryExpression(a) &&
    a.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (ts.isStringLiteral(unwrap(a.left)) || ts.isNoSubstitutionTemplateLiteral(unwrap(a.left)))
  )
    raw = `${(unwrap(a.left) as ts.StringLiteral).text}:p`
  else return '<dynamic>'
  // `${apiBase}/my-work`: a leading interpolation is the API base, not a parameter.
  raw = raw
    .split('?')[0]
    .replace(/^:p(?=\/)/, '')
    .replace(/^\/api(?=\/)/, '')
  // A segment that is all parameters (`:p`, `:p-:p`) is one parameter.
  return raw
    .split('/')
    .map((s) => (/^(:p[-_.]?)+$/.test(s) ? ':p' : s))
    .join('/')
}

interface Source {
  sig: string
  /** True when the call returns an axios response (body is `.data`). */
  response: boolean
  typeArg?: string
}

/** `{ method: 'POST' }` in a fetch-style options argument; GET otherwise. */
function methodOption(arg: ts.Expression | undefined): string {
  const o = arg ? unwrap(arg) : undefined
  if (o && ts.isObjectLiteralExpression(o))
    for (const p of o.properties)
      if (
        ts.isPropertyAssignment(p) &&
        p.name.getText() === 'method' &&
        ts.isStringLiteral(unwrap(p.initializer))
      )
        return (unwrap(p.initializer) as ts.StringLiteral).text.toUpperCase()
  return 'GET'
}

function typeArgText(call: ts.CallExpression, sf: ts.SourceFile): string | undefined {
  const t = call.typeArguments?.[0]
  return t ? compact(t.getText(sf), 90) : undefined
}

/** A fetch call → endpoint signature. */
function sourceOf(call: ts.CallExpression, sf: ts.SourceFile, opts: ScanOptions): Source | null {
  const callee = unwrap(call.expression)
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text
    const recv = unwrap(callee.expression)
    const recvName = ts.isIdentifier(recv)
      ? recv.text
      : ts.isPropertyAccessExpression(recv)
        ? recv.name.text
        : ''
    if (BODY_CLIENT_METHODS.has(method) && /client|nivaro|sdk/i.test(recvName)) {
      // client.request(get(url)) / client.request(post(url, body))
      const inner = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
      if (inner && ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
        const fnName = inner.expression.text
        // An SDK request builder (readUser(id), readOnlinePresence()) names its own endpoint.
        if (!HTTP_VERBS.has(fnName))
          return {
            sig: opts.sdkEndpoints?.[fnName] ?? `sdk ${fnName}`,
            response: false,
            typeArg: typeArgText(call, sf)
          }
        const verb = fnName === 'del' ? 'DELETE' : fnName.toUpperCase()
        return {
          sig: `${verb} ${urlOf(inner.arguments[0])}`,
          response: false,
          typeArg: typeArgText(call, sf)
        }
      }
      return null
    }
    if (HTTP_VERBS.has(method) && (opts.responseClients ?? []).includes(recvName)) {
      return {
        sig: `${method === 'del' ? 'DELETE' : method.toUpperCase()} ${urlOf(call.arguments[0])}`,
        response: true,
        typeArg: typeArgText(call, sf)
      }
    }
    return {
      sig: `call ${method}`,
      response: false,
      typeArg: typeArgText(call, sf)
    }
  }
  if (ts.isIdentifier(callee)) {
    if (BODY_FUNCTIONS.has(callee.text))
      return {
        sig: `${methodOption(call.arguments[1])} ${urlOf(call.arguments[0])}`,
        response: false,
        typeArg: typeArgText(call, sf)
      }
    return { sig: `call ${callee.text}`, response: false, typeArg: typeArgText(call, sf) }
  }
  return null
}

/** Signature of a `.then(cb)` callback relative to its input: path + derivation. */
function callbackPath(cb: ts.Expression, sf: ts.SourceFile): string | null {
  const fn = unwrap(cb)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null
  const param = fn.parameters[0]
  if (!param) return null
  // ({ data }) => data.x  → '.data' + '.x'
  const names = new Map<string, string>()
  if (ts.isIdentifier(param.name)) names.set(param.name.text, '')
  else if (ts.isObjectBindingPattern(param.name))
    for (const el of param.name.elements)
      if (ts.isIdentifier(el.name)) {
        const prop =
          el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text
        names.set(el.name.text, `.${prop}`)
      }
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return pathOf(fn.body, names, sf)
  // { const d = r.data as X; return d?.relations ?? [] } — consts that are paths of known names,
  // then exactly one top-level return.
  const body = fn.body as ts.Block
  let ret: ts.Expression | undefined
  for (const st of body.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) return null
        const p = pathOf(d.initializer, names, sf)
        if (p === null) return null
        names.set(d.name.text, p)
      }
    } else if (ts.isReturnStatement(st) && st.expression && !ret) ret = st.expression
    else return null
  }
  return ret ? pathOf(ret, names, sf) : null
}

function isEmptyLiteral(e: ts.Expression): boolean {
  const u = unwrap(e)
  return (
    u.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(u) && u.text === 'undefined') ||
    (ts.isArrayLiteralExpression(u) && u.elements.length === 0) ||
    (ts.isObjectLiteralExpression(u) && u.properties.length === 0)
  )
}

/** Path of an expression in terms of known names; derivations add a suffix. */
function pathOf(e: ts.Expression, names: Map<string, string>, sf: ts.SourceFile): string | null {
  const x = stripDefault(e)
  const ch = chainOf(x)
  if (ch && names.has(ch.root)) return `${names.get(ch.root)}${ch.path}`
  // `Array.isArray(r.data) ? r.data : []` — an empty fallback keeps the other branch's shape.
  if (ts.isConditionalExpression(x)) {
    if (isEmptyLiteral(x.whenFalse)) return pathOf(x.whenTrue, names, sf)
    if (isEmptyLiteral(x.whenTrue)) return pathOf(x.whenFalse, names, sf)
    return null
  }
  // `({ display_template: r.data.x })` — a new object: its keys are the shape.
  if (ts.isObjectLiteralExpression(x)) {
    const keys = x.properties.map((p) => (p.name ? p.name.getText(sf) : '...'))
    return ` →{${keys.join(',')}}`
  }
  if (ts.isCallExpression(x)) {
    const callee = unwrap(x.expression)
    if (ts.isPropertyAccessExpression(callee)) {
      const inner = pathOf(callee.expression, names, sf)
      if (inner !== null) return `${inner} →${callee.name.text}`
    }
  }
  return null
}

function composePath(base: string, next: string): string {
  // `.then(r => r.data).then(d => d.x)` — `next` is relative to the previous result.
  return `${base}${next}`
}

/** Shape signature of the value a queryFn resolves to. */
function shapeOfQueryFn(
  fnExpr: ts.Expression,
  sf: ts.SourceFile,
  opts: ScanOptions
): {
  shape: string
  typeArg?: string
} {
  const fn = unwrap(fnExpr)
  if (ts.isIdentifier(fn)) return { shape: `call ${fn.text}` }
  if (ts.isPropertyAccessExpression(fn)) return { shape: `call ${fn.name.text}` }
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
    return { shape: `? ${compact(fn.getText(sf))}` }
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body))
    return resolveValue(fn.body, sf, opts, new Map(), new Map(), 0)
  return shapeOfBlock(fn.body as ts.Block, sf, opts)
}

function shapeOfBlock(
  body: ts.Block,
  sf: ts.SourceFile,
  opts: ScanOptions,
  depth = 0
): {
  shape: string
  typeArg?: string
} {
  const locals = new Map<string, ts.Expression>()
  const destructured = new Map<string, { from: ts.Expression; prop: string }>()
  const returns: ts.ReturnStatement[] = []
  for (const st of body.statements) {
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) {
        if (!d.initializer) continue
        if (ts.isIdentifier(d.name)) locals.set(d.name.text, d.initializer)
        else if (ts.isObjectBindingPattern(d.name))
          for (const el of d.name.elements)
            if (ts.isIdentifier(el.name))
              destructured.set(el.name.text, {
                from: d.initializer,
                prop:
                  el.propertyName && ts.isIdentifier(el.propertyName)
                    ? el.propertyName.text
                    : el.name.text
              })
      }
    if (ts.isReturnStatement(st) && st.expression) returns.push(st)
  }
  // Early `return []` guards (`if (!c) return []`) live inside if-blocks and are skipped:
  // only top-level returns count, and there must be exactly one.
  if (returns.length !== 1 || !returns[0].expression)
    return { shape: `? block(${returns.length} returns)` }
  return resolveValue(returns[0].expression, sf, opts, locals, destructured, depth)
}

function resolveValue(
  e: ts.Expression,
  sf: ts.SourceFile,
  opts: ScanOptions,
  locals: Map<string, ts.Expression>,
  destructured: Map<string, { from: ts.Expression; prop: string }>,
  depth: number
): { shape: string; typeArg?: string } {
  const unknown = { shape: `? ${compact(e.getText(sf))}` }
  if (depth > 6) return unknown
  const x = stripDefault(e)
  // <fetch>.then(cb)[.then(cb2)…]
  if (ts.isCallExpression(x)) {
    const callee = unwrap(x.expression)
    // .catch(() => fallback) / .finally(…) keep the shape of what they wrap.
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === 'catch' || callee.name.text === 'finally')
    )
      return resolveValue(callee.expression, sf, opts, locals, destructured, depth + 1)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'then') {
      const prev = resolveValue(callee.expression, sf, opts, locals, destructured, depth + 1)
      const p = x.arguments[0] ? callbackPath(x.arguments[0], sf) : null
      if (prev.shape.startsWith('?') || p === null) return { ...unknown, typeArg: prev.typeArg }
      return { shape: composeShape(prev.shape, p), typeArg: prev.typeArg }
    }
    // (await fetch(url)).json() / res.json() where `const res = await fetch(url)`: the body.
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'json') {
      let recv = unwrap(callee.expression)
      if (ts.isIdentifier(recv) && locals.has(recv.text))
        recv = unwrap(locals.get(recv.text) as ts.Expression)
      if (
        ts.isCallExpression(recv) &&
        ts.isIdentifier(recv.expression) &&
        recv.expression.text === 'fetch'
      ) {
        const url = urlOf(recv.arguments[0])
        if (url.includes('<dynamic>') || /[^/]:p/.test(url)) return unknown
        return { shape: `${methodOption(recv.arguments[1])} ${url} .` }
      }
      return unknown
    }
    // rows.filter(…) / data.map(…) — a derivation of a resolvable value, never a fetch.
    if (ts.isPropertyAccessExpression(callee) && DERIVATIONS.has(callee.name.text)) {
      const base = resolveValue(callee.expression, sf, opts, locals, destructured, depth + 1)
      if (base.shape.startsWith('?')) return unknown
      return { shape: composeShape(base.shape, ` →${callee.name.text}`), typeArg: base.typeArg }
    }
    // A helper defined in this file: resolve its own return.
    if (ts.isIdentifier(callee) && fileFunctions.has(callee.text) && depth < 4) {
      const fn = fileFunctions.get(callee.text) as ts.FunctionLikeDeclaration
      if (fn.body && ts.isBlock(fn.body)) {
        const r = shapeOfBlock(fn.body, sf, opts, depth + 1)
        return r.shape.startsWith('?') ? unknown : r
      }
      if (fn.body)
        return resolveValue(fn.body as ts.Expression, sf, opts, new Map(), new Map(), depth + 1)
    }
    const src = sourceOf(x, sf, opts)
    // A helper from another file whose shape the index resolved.
    const helper = src?.sig.startsWith('call ') ? opts.functionShapes?.get(src.sig.slice(5)) : null
    if (helper) return { shape: helper, typeArg: src?.typeArg }
    // A path built from a variable (`/command-center${path}`, `get(path)`) can't be compared.
    if (src && (src.sig.includes('<dynamic>') || /[^/]:p/.test(src.sig))) return unknown
    if (src)
      return {
        shape: `${src.sig} ${src.response ? '<response>' : ''}`.trim(),
        typeArg: src.typeArg
      }
    return unknown
  }
  // (await api.get(…)).data.data
  const tail = callChainOf(x)
  if (tail) {
    const base = resolveValue(tail.call, sf, opts, locals, destructured, depth + 1)
    if (base.shape.startsWith('?')) return unknown
    return { shape: composeShape(base.shape, tail.path), typeArg: base.typeArg }
  }
  // cond ? <fetch A> : <fetch B> — known only when both branches store the same shape.
  if (ts.isConditionalExpression(x)) {
    const a = resolveValue(x.whenTrue, sf, opts, locals, destructured, depth + 1)
    const b = resolveValue(x.whenFalse, sf, opts, locals, destructured, depth + 1)
    if (!a.shape.startsWith('?') && shapesCompatible(a.shape, b.shape)) return a
    if (isEmptyLiteral(x.whenFalse)) return a
    if (isEmptyLiteral(x.whenTrue)) return b
    return unknown
  }
  if (ts.isObjectLiteralExpression(x)) {
    const keys = x.properties.map((p) => (p.name ? p.name.getText(sf) : '...'))
    return { shape: `object {${keys.join(',')}}` }
  }
  // r.data.data where `const r = await <fetch>`
  const ch = chainOf(x)
  if (ch) {
    const init = locals.get(ch.root)
    if (init) {
      const base = resolveValue(init, sf, opts, locals, destructured, depth + 1)
      if (base.shape.startsWith('?')) return unknown
      return { shape: composeShape(base.shape, ch.path), typeArg: base.typeArg }
    }
    const d = destructured.get(ch.root)
    if (d) {
      const base = resolveValue(d.from, sf, opts, locals, destructured, depth + 1)
      if (base.shape.startsWith('?')) return unknown
      return { shape: composeShape(base.shape, `.${d.prop}${ch.path}`), typeArg: base.typeArg }
    }
  }
  return unknown
}

/**
 * Apply a path to a source signature. `<response>` marks an axios response: its `.data` is
 * the body, so `GET /x <response>` + `.data.data` → `GET /x .data`.
 */
function composeShape(shape: string, path: string): string {
  if (shape.endsWith(' <response>')) {
    const base = shape.slice(0, -' <response>'.length)
    if (path.startsWith('.data')) return `${base} ${path.slice('.data'.length) || '.'}`.trim()
    return `${base} <response>${path}`
  }
  // Body source: path is relative to the body; '' = the whole body.
  const m = shape.match(/^(.*?)( [.<].*)?$/)
  const head = m?.[1] ?? shape
  const tail = (m?.[2] ?? '').trim()
  const prev = tail === '.' ? '' : tail
  return `${head} ${composePath(prev, path) || '.'}`.trim()
}

function keyPattern(arr: ts.ArrayLiteralExpression): string[] | null {
  const out: string[] = []
  for (const el of arr.elements) {
    if (ts.isSpreadElement(el)) return null
    const u = unwrap(el)
    out.push(ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : '*')
  }
  return out
}

function keyFromExpr(
  e: ts.Expression,
  opts: ScanOptions
): { root: string; pattern: string[] | null; builder?: string } | null {
  const u = unwrap(e)
  if (ts.isArrayLiteralExpression(u)) {
    const first = u.elements[0] ? unwrap(u.elements[0] as ts.Expression) : undefined
    if (!first || !(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)))
      return null
    return { root: first.text, pattern: keyPattern(u) }
  }
  if (ts.isCallExpression(u) && opts.builders) {
    const callee = unwrap(u.expression)
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ''
    const root = opts.builders[name]
    if (root) return { root, pattern: [root, ...u.arguments.map(() => '*')], builder: name }
  }
  return null
}

/** Name of the call an object literal is the (first) argument of, through arrays/returns. */
function enclosingCallName(node: ts.Node): string | undefined {
  let cur: ts.Node | undefined = node.parent
  for (let i = 0; cur && i < 6; i++, cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const c = unwrap(cur.expression)
      return ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c)
          ? c.name.text
          : undefined
    }
    if (ts.isSourceFile(cur) || ts.isBlock(cur)) return undefined
  }
  return undefined
}

/** Top-level functions of the file being scanned (a queryFn that calls one is resolved). */
let fileFunctions = new Map<
  string,
  ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
>()

function collectFunctions(sf: ts.SourceFile) {
  const out = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>()
  for (const st of sf.statements) {
    const decl = ts.isExportDeclaration(st) ? undefined : st
    if (decl && ts.isFunctionDeclaration(decl) && decl.name && decl.body)
      out.set(decl.name.text, decl)
    if (decl && ts.isVariableStatement(decl))
      for (const d of decl.declarationList.declarations) {
        const init = d.initializer ? unwrap(d.initializer) : undefined
        if (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        )
          out.set(d.name.text, init)
      }
  }
  return out
}

export function scanSource(file: string, text: string, opts: ScanOptions = {}): QuerySite[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  fileFunctions = collectFunctions(sf)
  const name = opts.base ? relative(opts.base, file) : file
  const sites: QuerySite[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let keyProp: ts.PropertyAssignment | undefined
      let fnProp: ts.ObjectLiteralElementLike | undefined
      for (const p of node.properties) {
        const pn = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined
        if (pn === 'queryKey' && ts.isPropertyAssignment(p)) keyProp = p
        if (pn === 'queryFn') fnProp = p
      }
      if (keyProp) {
        const key = keyFromExpr(keyProp.initializer, opts)
        if (key) {
          const site: QuerySite = {
            file: name,
            line: lineOf(keyProp),
            kind: fnProp ? 'read' : 'filter',
            root: key.root,
            pattern: key.pattern,
            builder: key.builder,
            scope: opts.scope
          }
          if (fnProp) {
            let shape: { shape: string; typeArg?: string }
            if (ts.isPropertyAssignment(fnProp))
              shape = shapeOfQueryFn(fnProp.initializer, sf, opts)
            else if (ts.isMethodDeclaration(fnProp))
              // queryFn() { … }
              shape = fnProp.body ? shapeOfBlock(fnProp.body, sf, opts) : { shape: '? method' }
            else if (ts.isShorthandPropertyAssignment(fnProp))
              shape = { shape: `call ${fnProp.name.text}` }
            else shape = { shape: '? queryFn' }
            site.shape = shape.shape
            // useQuery<T>({…}) beats request<T>.
            const call = node.parent
            if (call && ts.isCallExpression(call) && call.typeArguments?.[0])
              site.typeArg = compact(call.typeArguments[0].getText(sf), 90)
            else if (shape.typeArg) site.typeArg = shape.typeArg
          } else {
            const callName = enclosingCallName(node)
            if (callName && !FILTER_CALLS.has(callName) && callName !== 'setQueriesData')
              site.kind = 'filter'
          }
          sites.push(site)
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const c = unwrap(node.expression)
      const method = ts.isPropertyAccessExpression(c) ? c.name.text : undefined
      if ((method === 'setQueryData' || method === 'getQueryData') && node.arguments[0]) {
        const key = keyFromExpr(node.arguments[0], opts)
        if (key)
          sites.push({
            file: name,
            line: lineOf(node),
            kind: method === 'setQueryData' ? 'set' : 'get',
            root: key.root,
            pattern: key.pattern,
            builder: key.builder,
            scope: opts.scope,
            typeArg: node.typeArguments?.[0]
              ? compact(node.typeArguments[0].getText(sf), 90)
              : undefined
          })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/**
 * Endpoints of SDK request builders: exported functions whose one statement returns
 * `cmd('GET', '/x')` or `get('/x', …)` (packages/sdk/src/commands, shared lib/commands.ts).
 */
export function commandEndpoints(files: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue
      const ret = st.body.statements.find(ts.isReturnStatement)?.expression
      const call = ret ? unwrap(ret) : undefined
      if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue
      const fn = call.expression.text
      if (fn === 'cmd') {
        const verb = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
        if (verb && ts.isStringLiteral(verb))
          out[st.name.text] = `${verb.text.toUpperCase()} ${urlOf(call.arguments[1])}`
      } else if (HTTP_VERBS.has(fn) && fn !== 'request')
        out[st.name.text] =
          `${fn === 'del' ? 'DELETE' : fn.toUpperCase()} ${urlOf(call.arguments[0])}`
    }
  }
  return out
}

export function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue
    const full = join(dir, n)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts'))
      out.push(full)
  }
  return out
}

export function scanDir(dir: string, opts: ScanOptions = {}): QuerySite[] {
  return sourceFiles(dir).flatMap((f) => scanSource(f, readFileSync(f, 'utf8'), opts))
}

/**
 * Top-level helpers across files (`fetchJourneyDays`, `queryWidgetRows`) → the shape they
 * resolve to, so a queryFn calling one compares by what it stores. Names defined more than once
 * with different shapes are left out (they stay `call <name>`).
 */
export function functionIndex(files: string[], opts: ScanOptions = {}): Map<string, string> {
  const found = new Map<string, Set<string>>()
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    fileFunctions = collectFunctions(sf)
    for (const [name, fn] of fileFunctions) {
      if (!fn.body) continue
      const r = ts.isBlock(fn.body)
        ? shapeOfBlock(fn.body, sf, opts)
        : resolveValue(fn.body, sf, opts, new Map(), new Map(), 0)
      const set = found.get(name) ?? new Set<string>()
      set.add(r.shape)
      found.set(name, set)
    }
  }
  const out = new Map<string, string>()
  for (const [name, shapes] of found) {
    const [only] = [...shapes]
    if (shapes.size === 1 && isKnownShape(only) && !only.startsWith('call ')) out.set(name, only)
  }
  return out
}

/** True when two key patterns can name the same cache entry. */
export function patternsOverlap(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === '*' || b[i] === '*' || x === b[i])
}

export function isKnownShape(shape: string | undefined): shape is string {
  return !!shape && !shape.startsWith('?')
}

/**
 * Same verb, same body path and the same URL up to parameters: `/pipelines/instance/:p/:p` and
 * `/pipelines/instance/nivaro_addendums/:p` store the same shape.
 */
export function shapesCompatible(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const [va, ua, ...ra] = a.split(' ')
  const [vb, ub, ...rb] = b.split(' ')
  if (va !== vb || ra.join(' ') !== rb.join(' ') || !ua || !ub) return false
  const sa = ua.split('/')
  const sb = ub.split('/')
  return sa.length === sb.length && sa.every((x, i) => x === sb[i] || x === ':p' || sb[i] === ':p')
}

export interface Collision {
  root: string
  shapes: Array<{ shape: string; sites: QuerySite[] }>
}

/** Two sites can meet in one QueryClient: same app, or either is in the shared library. */
export function sameClient(a: QuerySite, b: QuerySite): boolean {
  return !a.scope || !b.scope || a.scope === b.scope || a.scope === 'shared' || b.scope === 'shared'
}

/**
 * A literal key element that a wildcard at the same position can never equal — e.g.
 * ['erp-submissions', 'detail', id] beside ['erp-submissions', collection, item]: no collection
 * is called 'detail'. Each entry needs a reason.
 */
export interface DisjointLiteral {
  root: string
  literal: string
  why: string
}

/** Readers whose keys can name the same entry but whose known shapes differ. */
export function findCollisions(sites: QuerySite[], disjoint: DisjointLiteral[] = []): Collision[] {
  const apart = new Set(disjoint.map((d) => `${d.root}\u0000${d.literal}`))
  const overlap = (a: QuerySite, b: QuerySite) => {
    if (!patternsOverlap(a.pattern, b.pattern)) return false
    const pa = a.pattern as string[]
    const pb = b.pattern as string[]
    return !pa.some(
      (x, i) =>
        x !== pb[i] && (apart.has(`${a.root}\u0000${x}`) || apart.has(`${a.root}\u0000${pb[i]}`))
    )
  }
  const byRoot = new Map<string, QuerySite[]>()
  for (const s of sites) {
    if (s.kind !== 'read' || !isKnownShape(s.shape)) continue
    const list = byRoot.get(s.root) ?? []
    list.push(s)
    byRoot.set(s.root, list)
  }
  const out: Collision[] = []
  for (const [root, list] of byRoot) {
    const clashing = new Set<QuerySite>()
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (
          sameClient(list[i], list[j]) &&
          !shapesCompatible(list[i].shape, list[j].shape) &&
          overlap(list[i], list[j])
        ) {
          clashing.add(list[i])
          clashing.add(list[j])
        }
    if (!clashing.size) continue
    const groups = new Map<string, QuerySite[]>()
    for (const s of clashing) {
      const g = groups.get(s.shape as string) ?? []
      g.push(s)
      groups.set(s.shape as string, g)
    }
    out.push({ root, shapes: [...groups].map(([shape, ss]) => ({ shape, sites: ss })) })
  }
  return out.sort((a, b) => a.root.localeCompare(b.root))
}

/**
 * Readers of a registry key (lib/query-keys.ts QUERY_KEY_SPECS) whose shape is unknown or not
 * one the registry declares for that key length.
 */
export function registryMismatches(
  sites: QuerySite[],
  specs: Array<{ root: string; shapes: string[]; length?: number }>
): Array<{ site: QuerySite; declared: string[] }> {
  const out: Array<{ site: QuerySite; declared: string[] }> = []
  for (const site of sites) {
    if (site.kind !== 'read') continue
    const matching = specs.filter(
      (k) =>
        k.root === site.root &&
        (k.length === undefined || !site.pattern || k.length === site.pattern.length)
    )
    if (!matching.length) continue
    const declared = matching.flatMap((k) => k.shapes)
    if (!isKnownShape(site.shape) || !declared.some((d) => shapesCompatible(d, site.shape)))
      out.push({ site, declared })
  }
  return out
}

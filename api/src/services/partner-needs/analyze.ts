/**
 * Which values a partner payload NEEDS (idea 43, "Needed by <partner>" badges).
 *
 * Reads a payload template — a map spec (services/payload-templates/types.ts) or Liquid (a
 * code-mode template, or an action's inline `payload_template`) — and names the scope paths
 * whose value the partner always gets, so the record form can mark the fields behind them
 * before the move that sends the push.
 *
 * A path is NEEDED when it feeds a value the body carries with nothing standing in for it.
 * It is optional (no badge) when:
 *   - its output is `include: 'not_empty'` (dropped when empty) or its value has fallbacks;
 *   - it is guarded by a not-empty test on the SAME path (`include.when` or a `switch` case:
 *     "send the product number when there is one");
 *   - in Liquid: it has a `default:` filter, or sits inside an if / unless / case block.
 * A value guarded by some OTHER condition still counts: the partner gets it whenever that
 * condition holds, which cannot be judged before the values exist.
 *
 * Pure: no database. services/partner-needs/index.ts maps the paths to record fields and line
 * fields through the action's context definitions.
 */
import type { ConditionRule } from '../workflow-conditions.js'

/** One place the body reads, rooted the way the map evaluator resolves paths. */
export type NeedRef =
  /** `record.<field>` (or a bare field outside a list). */
  | { kind: 'record'; field: string }
  /** `context.<key>…` outside a list over that key: the rest after the row index. */
  | { kind: 'context'; key: string; rest: string[] }
  /** Inside a list whose source is `context.<key>`: `rest[0]` is the line's own column. */
  | { kind: 'line'; key: string; rest: string[]; where: ConditionRule[]; alias: string }

/** A list the body iterates over a context key (per-line inclusion is judged from it). */
export interface ListSource {
  key: string
  alias: string
  where: ConditionRule[]
}

export interface TemplateNeeds {
  needed: NeedRef[]
  lists: ListSource[]
}

/** Scope keys that are never a record field (evaluate.ts top-level scope + builtins). */
const SCOPE_KEYS = new Set([
  'record',
  'context',
  'state',
  'acting_user',
  'responses',
  'response',
  'today',
  'now',
  'list',
  'forloop'
])

const NOT_EMPTY_OPS = new Set(['nnull', 'not_null', 'nempty', 'not_empty'])

/** `a.b[0].c` / `a.b.0.c` / `a['b']` → ['a','b','0','c']. */
export function pathSegments(path: string): string[] {
  return String(path)
    .trim()
    .replace(/\[\s*'([^']*)'\s*\]/g, '.$1')
    .replace(/\[\s*"([^"]*)"\s*\]/g, '.$1')
    .replace(/\[\s*(\d+)\s*\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

const normPath = (p: string) => pathSegments(p).join('.')
const isIndex = (s: string | undefined) => s != null && /^\d+$/.test(s)

interface Frame {
  alias: string
  numberAs: string
  key: string | null
  where: ConditionRule[]
}

/** Resolve a path the way evaluate.ts does: list alias (innermost first), then scope, then record. */
export function resolveRef(path: string, frames: Frame[]): NeedRef | null {
  const segs = pathSegments(path)
  if (segs.length === 0) return null
  const [first, ...rest] = segs
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]
    if (first === f.numberAs) return null
    if (first === f.alias) {
      if (!f.key || rest.length === 0) return null
      return { kind: 'line', key: f.key, rest, where: f.where, alias: f.alias }
    }
  }
  if (first === 'record') return rest[0] ? { kind: 'record', field: rest[0] } : null
  if (first === 'context') {
    const key = rest[0]
    if (!key) return null
    const after = rest.slice(1)
    return { kind: 'context', key, rest: isIndex(after[0]) ? after.slice(1) : after }
  }
  if (SCOPE_KEYS.has(first)) return null
  // A bare name: inside a list it reads the item's column first (evaluate.ts lexical order).
  const inner = frames[frames.length - 1]
  if (inner?.key) return { kind: 'line', key: inner.key, rest: segs, where: inner.where, alias: '' }
  return { kind: 'record', field: first }
}

const selfGuarded = (path: string, guards: ConditionRule[]): boolean => {
  const want = normPath(path)
  return guards.some(
    (g) =>
      g &&
      typeof g.field === 'string' &&
      NOT_EMPTY_OPS.has(String(g.op ?? '').toLowerCase()) &&
      normPath(g.field) === want
  )
}

// ─── Map spec ────────────────────────────────────────────────────────────────

type AnyRec = Record<string, unknown>
const isObj = (v: unknown): v is AnyRec => v !== null && typeof v === 'object' && !Array.isArray(v)
const rulesOf = (v: unknown): ConditionRule[] =>
  Array.isArray(v) ? (v.filter((r) => isObj(r)) as unknown as ConditionRule[]) : []

function collectValue(
  v: unknown,
  frames: Frame[],
  guards: ConditionRule[],
  optional: boolean,
  out: NeedRef[]
): void {
  if (!isObj(v)) return
  const hasFallback = Array.isArray(v.fallbacks) && v.fallbacks.length > 0
  const opt = optional || hasFallback
  switch (v.source) {
    case 'path': {
      if (opt || typeof v.path !== 'string' || selfGuarded(v.path, guards)) return
      const ref = resolveRef(v.path, frames)
      if (ref) out.push(ref)
      return
    }
    case 'formula': {
      if (opt || typeof v.liquid !== 'string') return
      for (const hit of liquidRefs(v.liquid, frames).needed) {
        if (!selfGuarded(hit.path, guards)) out.push(hit.ref)
      }
      return
    }
    case 'switch': {
      for (const c of Array.isArray(v.cases) ? v.cases : []) {
        if (!isObj(c)) continue
        collectValue(c.value, frames, [...guards, ...rulesOf(c.when)], opt, out)
      }
      collectValue(v.else, frames, guards, opt, out)
      return
    }
    default:
      return
  }
}

function walkFields(fields: unknown, frames: Frame[], optional: boolean, out: TemplateNeeds): void {
  if (!Array.isArray(fields)) return
  for (const f of fields) {
    if (!isObj(f)) continue
    const include = f.include
    const opt = optional || include === 'not_empty'
    const guards = isObj(include) ? rulesOf(include.when) : []
    if (f.type === 'list' && isObj(f.list)) {
      const ls = f.list
      const alias = typeof ls.item === 'string' && ls.item ? ls.item : 'line'
      const numberAs = typeof ls.number_as === 'string' && ls.number_as ? ls.number_as : 'number'
      const src = typeof ls.source === 'string' ? resolveRef(ls.source, frames) : null
      const key = src?.kind === 'context' && src.rest.length === 0 ? src.key : null
      const where = rulesOf(ls.where)
      if (key) out.lists.push({ key, alias, where })
      walkFields(f.children, [...frames, { alias, numberAs, key, where }], opt, out)
      continue
    }
    if (f.type === 'object') {
      walkFields(f.children, frames, opt, out)
      continue
    }
    collectValue(f.value, frames, guards, opt, out.needed)
  }
}

export function analyzeMapSpec(spec: unknown): TemplateNeeds {
  const out: TemplateNeeds = { needed: [], lists: [] }
  if (!isObj(spec)) return out
  walkFields(spec.fields, [], false, out)
  return out
}

// ─── Liquid ──────────────────────────────────────────────────────────────────

const TOKEN_RE = /\{\{-?([\s\S]*?)-?\}\}|\{%-?([\s\S]*?)-?%\}/g
const PATH_RE =
  /^\s*([A-Za-z_][\w]*(?:\s*(?:\.\s*[A-Za-z_][\w]*|\[\s*\d+\s*\]|\[\s*'[^']*'\s*\]))*)/
const COND_OPEN = new Set(['if', 'unless', 'case', 'capture'])
const COND_CLOSE = new Set(['endif', 'endunless', 'endcase', 'endcapture'])

/** The paths a Liquid snippet OUTPUTS unconditionally and without a `default:`. */
export function liquidOutputPaths(src: string): string[] {
  return liquidRefs(src, []).needed.map((h) => h.path)
}

/** Liquid outputs (with the path as written) plus the context lists it loops over. */
function liquidRefs(
  src: string,
  outer: Frame[]
): { needed: Array<{ path: string; ref: NeedRef }>; lists: ListSource[] } {
  const out: { needed: Array<{ path: string; ref: NeedRef }>; lists: ListSource[] } = {
    needed: [],
    lists: []
  }
  const frames: Frame[] = [...outer]
  // Each open block: 'cond' (if/unless/case/capture), 'for', or 'skip' (comment/raw).
  const stack: Array<'cond' | 'for' | 'skip'> = []
  for (const m of String(src ?? '').matchAll(TOKEN_RE)) {
    const skipping = stack.includes('skip')
    if (m[2] !== undefined) {
      const tag = m[2].trim()
      const name = tag.split(/\s+/)[0]?.toLowerCase() ?? ''
      if (skipping) {
        if (name === 'endcomment' || name === 'endraw') stack.pop()
        continue
      }
      if (name === 'comment' || name === 'raw') stack.push('skip')
      else if (COND_OPEN.has(name)) stack.push('cond')
      else if (COND_CLOSE.has(name)) {
        const at = stack.lastIndexOf('cond')
        if (at >= 0) stack.splice(at, 1)
      } else if (name === 'for' || name === 'tablerow') {
        const fm = /^(?:for|tablerow)\s+([A-Za-z_]\w*)\s+in\s+(\S+)/.exec(tag)
        const alias = fm?.[1] ?? '__'
        const ref = fm ? resolveRef(fm[2].replace(/\)$/, ''), frames) : null
        const key = ref?.kind === 'context' && ref.rest.length === 0 ? ref.key : null
        if (key && !stack.includes('cond')) out.lists.push({ key, alias, where: [] })
        frames.push({ alias, numberAs: 'forloop', key, where: [] })
        stack.push('for')
      } else if (name === 'endfor' || name === 'endtablerow') {
        const at = stack.lastIndexOf('for')
        if (at >= 0) {
          stack.splice(at, 1)
          frames.pop()
        }
      }
      continue
    }
    if (skipping || m[1] === undefined) continue
    if (stack.includes('cond')) continue
    const expr = m[1]
    const parts = expr.split('|')
    if (parts.slice(1).some((p) => /^\s*default\b/.test(p))) continue
    const pm = PATH_RE.exec(parts[0] ?? '')
    if (!pm) continue
    const path = pm[1].replace(/\s+/g, '')
    if (/^(true|false|nil|null|empty|blank)$/.test(path)) continue
    const ref = resolveRef(path, frames)
    if (ref) out.needed.push({ path, ref })
  }
  return out
}

/** Liquid (a code-mode template or an inline payload_template). */
export function analyzeLiquid(src: string): TemplateNeeds {
  const r = liquidRefs(src, [])
  return { needed: r.needed.map((h) => h.ref), lists: r.lists }
}

/** One entry point: a published body in either mode. Unparseable map JSON reads as nothing. */
export function analyzeTemplate(mode: 'map' | 'code', body: string): TemplateNeeds {
  if (mode === 'map') {
    try {
      return analyzeMapSpec(JSON.parse(body))
    } catch {
      return { needed: [], lists: [] }
    }
  }
  return analyzeLiquid(body)
}

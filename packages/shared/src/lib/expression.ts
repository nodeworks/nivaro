/**
 * One expression language for the `{{token}}` formulas users author.
 *
 * Nivaro grew five separate arithmetic dialects — inline-grid client formulas,
 * QueryTable column formulas, match-agg column formulas, allocate-drawer
 * formulas and rollup value formulas — each with its own parser, its own token
 * regex and its own failure behaviour. A user cannot tell which box takes which
 * syntax, and every one of them shared the same two defects:
 *
 *   1. They SUBSTITUTED token values into the string and then parsed (or, in
 *      two cases, `eval`ed) the result. A value that is not a bare number —
 *      a negative, a date, a string, anything — corrupted the expression into
 *      something that either threw or, worse, silently computed a different
 *      sum than the author meant.
 *   2. A missing or non-numeric token became `0` with no signal, so a formula
 *      referencing a field that had been renamed quietly produced a plausible
 *      wrong number instead of an error.
 *
 * This module parses to an AST once and evaluates against a resolver, so a
 * token's VALUE is never able to change the SHAPE of the expression. It also
 * separates the two questions those dialects conflated: "is this expression
 * well-formed" (answerable at authoring time, which is what makes an editor
 * possible) from "what does it evaluate to for this row".
 *
 * `missing: 'zero'` is the DEFAULT and preserves the existing behaviour that
 * live formulas depend on — `{{amount}} - {{allocated_total}}` must keep
 * working when nothing has been allocated yet. `missing: 'null'` opts into
 * propagation for new call sites that would rather show nothing than a wrong
 * number.
 */

import { fiscalQuarterOf, fiscalYearOf } from './fiscal'

export type ExprValue = number | string | boolean | null

export type ExprNode =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'token'; path: string }
  | { kind: 'call'; name: string; args: ExprNode[] }
  | { kind: 'unary'; op: '-' | '!'; operand: ExprNode }
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }

export type BinaryOp = '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'

export interface ParseSuccess {
  ok: true
  ast: ExprNode
  /** Every distinct token path referenced, in first-appearance order. */
  tokens: string[]
}

export interface ParseFailure {
  ok: false
  error: string
  /** Zero-based index into the source where the problem is, for editor carets. */
  position: number
}

export type ParseResult = ParseSuccess | ParseFailure

// ── lexer ───────────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'tok'; v: string; at: number }
  | { t: 'word'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number }

/**
 * Token paths accept dotted segments and `[n]` indexing, matching what the
 * relation-path and repeater config elsewhere already lets people write. The
 * reserved `__agg__` / `__input__` / `__saved__` names used by the aggregate
 * and allocation call sites are ordinary identifiers to the lexer.
 */
const TOKEN_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*/

class LexError extends Error {
  constructor(
    message: string,
    readonly at: number
  ) {
    super(message)
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0

  while (i < src.length) {
    const c = src[i]

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }

    // {{ path }}
    if (c === '{' && src[i + 1] === '{') {
      const close = src.indexOf('}}', i + 2)
      if (close === -1) throw new LexError('Unclosed {{', i)
      const raw = src.slice(i + 2, close).trim()
      if (!raw) throw new LexError('Empty {{ }}', i)
      const m = TOKEN_PATH.exec(raw)
      if (!m || m[0] !== raw) throw new LexError(`Invalid field path: ${raw}`, i + 2)
      out.push({ t: 'tok', v: raw, at: i })
      i = close + 2
      continue
    }

    // 'string' or "string"
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, i + 1)
      if (close === -1) throw new LexError('Unclosed string', i)
      out.push({ t: 'str', v: src.slice(i + 1, close), at: i })
      i = close + 1
      continue
    }

    if (c >= '0' && c <= '9') {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))
      if (!m) throw new LexError('Bad number', i)
      out.push({ t: 'num', v: Number(m[0]), at: i })
      i += m[0].length
      continue
    }

    // Bare identifiers: the `item.field` legacy form, and the true/false/null
    // literals. `item.` is consumed here rather than rewritten, so the parser
    // sees exactly one kind of token node either way.
    if (/[A-Za-z_$]/.test(c)) {
      const m = TOKEN_PATH.exec(src.slice(i))
      if (!m) throw new LexError('Bad identifier', i)
      out.push({ t: 'word', v: m[0], at: i })
      i += m[0].length
      continue
    }

    const two = src.slice(i, i + 2)
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two, at: i })
      i += 2
      continue
    }
    if ('+-*/()<>!,'.includes(c)) {
      out.push({ t: 'op', v: c, at: i })
      i++
      continue
    }
    // A bare `=` is the single most likely typo for `==`, so it gets its own
    // message rather than "unexpected character".
    if (c === '=') throw new LexError('Use == for comparison', i)

    throw new LexError(`Unexpected character: ${c}`, i)
  }

  out.push({ t: 'end', at: src.length })
  return out
}

// ── parser ──────────────────────────────────────────────────────────────────

/** Binding power per operator, low to high. */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6
}

export function parseExpression(src: string): ParseResult {
  let toks: Tok[]
  try {
    toks = lex(src)
  } catch (err) {
    if (err instanceof LexError) return { ok: false, error: err.message, position: err.at }
    return { ok: false, error: 'Could not read the expression', position: 0 }
  }

  let p = 0
  const peek = () => toks[p]
  const tokens: string[] = []

  class ParseError extends Error {
    constructor(
      message: string,
      readonly at: number
    ) {
      super(message)
    }
  }

  function parseBinary(minBp: number): ExprNode {
    let left = parseUnary()
    for (;;) {
      const t = peek()
      if (t.t !== 'op') break
      const bp = PRECEDENCE[t.v]
      if (bp === undefined || bp < minBp) break
      p++
      const right = parseBinary(bp + 1)
      left = { kind: 'binary', op: t.v as BinaryOp, left, right }
    }
    return left
  }

  function parseUnary(): ExprNode {
    const t = peek()
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) {
      p++
      return { kind: 'unary', op: t.v, operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary(): ExprNode {
    const t = peek()
    if (t.t === 'num') {
      p++
      return { kind: 'number', value: t.v }
    }
    if (t.t === 'str') {
      p++
      return { kind: 'string', value: t.v }
    }
    if (t.t === 'tok') {
      p++
      if (!tokens.includes(t.v)) tokens.push(t.v)
      return { kind: 'token', path: t.v }
    }
    if (t.t === 'word') {
      // A function call. The SERVER-side evaluator (expr-eval, used for
      // write-computed fields) supports functions like concat(); this engine
      // does not evaluate them, but it must still recognise them as valid
      // syntax — reporting a real formula as a syntax error would be worse
      // than declining to preview it.
      const next = toks[p + 1]
      if (next && next.t === 'op' && next.v === '(') {
        p += 2
        const args: ExprNode[] = []
        if (!(peek().t === 'op' && (peek() as { v: string }).v === ')')) {
          for (;;) {
            args.push(parseBinary(0))
            const sep = peek()
            if (sep.t === 'op' && sep.v === ',') {
              p++
              continue
            }
            break
          }
        }
        const close = peek()
        if (close.t !== 'op' || close.v !== ')') throw new ParseError('Expected )', close.at)
        p++
        return { kind: 'call', name: t.v, args }
      }
      p++
      if (t.v === 'true' || t.v === 'false') {
        return { kind: 'boolean', value: t.v === 'true' }
      }
      if (t.v === 'null') return { kind: 'null' }
      // Legacy `item.field` — the prefix is part of the syntax, not the path.
      const path = t.v.startsWith('item.') ? t.v.slice(5) : t.v
      if (!path) throw new ParseError('Expected a field name after item.', t.at)
      if (!tokens.includes(path)) tokens.push(path)
      return { kind: 'token', path }
    }
    if (t.t === 'op' && t.v === '(') {
      p++
      const inner = parseBinary(0)
      const close = peek()
      if (close.t !== 'op' || close.v !== ')') {
        throw new ParseError('Expected )', close.at)
      }
      p++
      return inner
    }
    if (t.t === 'end') throw new ParseError('Expression ended unexpectedly', t.at)
    throw new ParseError(`Unexpected ${t.t === 'op' ? `"${t.v}"` : 'token'}`, t.at)
  }

  try {
    const ast = parseBinary(0)
    const rest = peek()
    if (rest.t !== 'end') {
      throw new ParseError(
        `Unexpected ${rest.t === 'op' ? `"${rest.v}"` : 'input'} after the expression`,
        rest.at
      )
    }
    return { ok: true, ast, tokens }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message, position: err.at }
    return { ok: false, error: 'Could not parse the expression', position: 0 }
  }
}

// ── evaluation ──────────────────────────────────────────────────────────────

export type TokenResolver = (path: string) => unknown

export interface EvaluateOptions {
  /**
   * What an unresolvable or non-numeric token means in arithmetic.
   * 'zero' (default) matches every existing dialect. 'null' propagates, so a
   * formula over a missing field shows nothing rather than a wrong number.
   */
  missing?: 'zero' | 'null'
}

/** Read a dotted/indexed path out of a plain object. */
export function readPath(source: unknown, path: string): unknown {
  // A literal key wins over traversal: resolve-paths stores its results flat
  // under the dotted path itself, and that must keep working.
  if (source && typeof source === 'object' && path in (source as Record<string, unknown>)) {
    return (source as Record<string, unknown>)[path]
  }
  let cur: unknown = source
  for (const seg of path.split('.')) {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(seg)
    const key = m ? m[1] : seg
    if (key) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[key]
    }
    for (const idx of m?.[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(idx)]
    }
  }
  return cur
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

/**
 * Evaluate a parsed expression. Returns null when the result is undefined
 * rather than throwing — a formula is display config, and a bad one must
 * degrade to "no value", never to a broken page.
 */
export function evaluateAst(
  ast: ExprNode,
  resolve: TokenResolver,
  opts: EvaluateOptions = {}
): ExprValue {
  const missing = opts.missing ?? 'zero'

  function num(node: ExprNode): number | null {
    const v = walk(node)
    const n = toNumber(v)
    if (n !== null) return n
    return missing === 'zero' ? 0 : null
  }

  function walk(node: ExprNode): ExprValue {
    switch (node.kind) {
      case 'number':
        return node.value
      case 'string':
        return node.value
      case 'boolean':
        return node.value
      case 'null':
        return null
      case 'token': {
        const raw = resolve(node.path)
        if (isEmpty(raw)) {
          // ALL_CAPS single-segment tokens fall through to the instance-wide
          // formula constants (#244) before reading as missing.
          if (/^[A-Z][A-Z0-9_]*$/.test(node.path)) {
            const c = formulaConstant(node.path)
            if (c !== null) return c
          }
          return null
        }
        if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') {
          return raw
        }
        // Objects and arrays have no scalar meaning in an expression; treating
        // them as 0 (as the old dialects did, via Number([]) === 0) invented
        // arithmetic out of a relation.
        return null
      }
      case 'call': {
        // A small set of BUILTINS evaluates natively (#344); anything else is
        // a server-side (expr-eval) function — null, not a throw, so a
        // preview simply shows "no value" instead of breaking the editor.
        const fn = node.name.toLowerCase()
        if (fn === 'networkdays' && node.args.length >= 2) {
          const a = toDateValue(walk(node.args[0]))
          const b = toDateValue(walk(node.args[1]))
          if (!a || !b) return null
          return networkdaysBetween(a, b)
        }
        if (fn === 'abs' && node.args.length === 1) {
          const n = num(node.args[0])
          return n === null ? null : Math.abs(n)
        }
        if ((fn === 'fiscal_year' || fn === 'fiscal_quarter') && node.args.length >= 1) {
          const d = toDateValue(walk(node.args[0]))
          if (!d) return null
          return fn === 'fiscal_year' ? fiscalYearOf(d) : fiscalQuarterOf(d)
        }
        if ((fn === 'round' || fn === 'floor' || fn === 'ceil') && node.args.length >= 1) {
          const n = num(node.args[0])
          if (n === null) return null
          if (fn === 'floor') return Math.floor(n)
          if (fn === 'ceil') return Math.ceil(n)
          const places = node.args[1] ? (num(node.args[1]) ?? 0) : 0
          const f = 10 ** places
          return Math.round(n * f) / f
        }
        return null
      }
      case 'unary': {
        if (node.op === '!') return !truthy(walk(node.operand))
        const n = num(node.operand)
        return n === null ? null : -n
      }
      case 'binary':
        return binary(node)
    }
  }

  function truthy(v: ExprValue): boolean {
    if (v === null) return false
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    return v !== ''
  }

  function binary(node: Extract<ExprNode, { kind: 'binary' }>): ExprValue {
    const { op } = node

    // Short-circuit, so `{{a}} != null && {{a}} > 5` does not evaluate the
    // right side when the guard already failed.
    if (op === '&&') return truthy(walk(node.left)) ? truthy(walk(node.right)) : false
    if (op === '||') return truthy(walk(node.left)) ? true : truthy(walk(node.right))

    if (op === '==' || op === '!=') {
      const l = walk(node.left)
      const r = walk(node.right)
      const eq = compareEqual(l, r)
      return op === '==' ? eq : !eq
    }

    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      const l = walk(node.left)
      const r = walk(node.right)
      const ln = toNumber(l)
      const rn = toNumber(r)
      // Comparing against a value that is not a number at all is not an
      // ordering question with a true answer — false, never a coerced 0.
      if (ln === null || rn === null) return false
      switch (op) {
        case '<':
          return ln < rn
        case '<=':
          return ln <= rn
        case '>':
          return ln > rn
        default:
          return ln >= rn
      }
    }

    const l = num(node.left)
    const r = num(node.right)
    if (l === null || r === null) return null
    switch (op) {
      case '+':
        return l + r
      case '-':
        return l - r
      case '*':
        return l * r
      default:
        // Division by zero yields null rather than Infinity, which formats as
        // nonsense in every one of our display paths.
        return r === 0 ? null : l / r
    }
  }

  function compareEqual(l: ExprValue, r: ExprValue): boolean {
    if (l === null || r === null) return l === r
    const ln = toNumber(l)
    const rn = toNumber(r)
    if (ln !== null && rn !== null) return ln === rn
    return String(l) === String(r)
  }

  return walk(ast)
}

/** Parse and evaluate in one call. Returns null on a parse error. */
export function evaluateExpression(
  src: string,
  resolve: TokenResolver | Record<string, unknown>,
  opts: EvaluateOptions = {}
): ExprValue {
  const parsed = parseExpression(src)
  if (!parsed.ok) return null
  const resolver: TokenResolver =
    typeof resolve === 'function' ? resolve : (path) => readPath(resolve, path)
  return evaluateAst(parsed.ast, resolver, opts)
}

/** Numeric convenience — the shape every existing call site wants. */
export function evaluateNumeric(
  src: string,
  row: TokenResolver | Record<string, unknown>,
  opts: EvaluateOptions = {}
): number | null {
  const v = evaluateExpression(src, row, opts)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  return null
}

/** Boolean convenience — for guards and conditions. */
export function evaluateBoolean(
  src: string,
  row: TokenResolver | Record<string, unknown>,
  opts: EvaluateOptions = {}
): boolean {
  const v = evaluateExpression(src, row, opts)
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return v !== ''
}

export interface ValidationResult {
  ok: boolean
  error?: string
  position?: number
  /** Every field the expression reads. */
  tokens: string[]
  /** Tokens not present in the supplied field list — probably typos or renames. */
  unknownTokens: string[]
}

/**
 * Authoring-time check. The point of separating this from evaluation is that
 * a formula can be told it is wrong while it is being written, instead of
 * silently producing nothing at render time months later.
 */
export function validateExpression(src: string, knownFields?: string[]): ValidationResult {
  if (!src.trim()) {
    return { ok: false, error: 'Expression is empty', position: 0, tokens: [], unknownTokens: [] }
  }
  const parsed = parseExpression(src)
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      position: parsed.position,
      tokens: [],
      unknownTokens: []
    }
  }
  const unknownTokens = knownFields
    ? parsed.tokens.filter(
        (t) => !knownFields.includes(t) && !knownFields.includes(t.split('.')[0])
      )
    : []
  return { ok: true, tokens: parsed.tokens, unknownTokens }
}

/** Field paths an expression reads, without evaluating it. */
export function extractExpressionTokens(src: string): string[] {
  const parsed = parseExpression(src)
  return parsed.ok ? parsed.tokens : []
}


// ─── networkdays (#344): business days between two dates, inclusive-exclusive
// (Mon–Fri; the fractional part of partial days is dropped). Order-agnostic —
// swapped arguments return a negative count.
function toDateValue(v: ExprValue): Date | null {
  if (typeof v !== 'string' || !v) return null
  const d = v.length === 10 ? new Date(`${v}T00:00:00`) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function networkdaysBetween(a: Date, b: Date): number {
  const sign = b.getTime() >= a.getTime() ? 1 : -1
  let [from, to] = sign === 1 ? [a, b] : [b, a]
  from = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  to = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  let days = 0
  const cur = new Date(from)
  while (cur.getTime() < to.getTime()) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) days++
    cur.setDate(cur.getDate() + 1)
  }
  return days * sign
}

// ─── Formula constants (#244): named instance values (TAX_RATE) resolvable in
// any expression. Hosts hydrate this from nivaro_settings.formula_constants;
// resolvers that miss a token can fall through to it.
let _formulaConstants: Record<string, number> = {}
export function setFormulaConstants(map: Record<string, number> | null | undefined): void {
  _formulaConstants = map && typeof map === 'object' ? map : {}
}
export function formulaConstant(name: string): number | null {
  const v = _formulaConstants[name]
  return Number.isFinite(v) ? v : null
}

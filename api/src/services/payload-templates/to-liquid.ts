import { payloadLiquid } from '../payload-filters.js'
import { MARKER } from '../secret-markers.js'
import type { ConditionRule } from '../workflow-conditions.js'
import {
  evaluateMap,
  neutralizeSecretMarkers,
  SECRET_PLACEHOLDER,
  validateSpec
} from './evaluate.js'
import type { Field, MapSpec, Transform, ValueSpec } from './types.js'

// ─── Field map → Liquid (one-way "Convert to Liquid", spec §5.3) ─────────────
// Generates a code-mode template that renders the same body as the field map,
// then proves it: convertIfEqual renders both against real records and only
// hands the Liquid back when every JSON.stringify output is byte-equal. The
// generator has to be exact, not pretty — so it never trusts Liquid's own
// coercions. Every value is handled as a JS value in `assign`ed variables and
// written with `jsonify`; JS type tests are spelled with jsonify too (a
// string is the only value whose `append: ''` round-trips through jsonify, an
// object/array is one whose JSON starts with `{`/`[`, a Date one whose JSON
// starts with `"` but is not a string). `to_integer` is the engine's
// `Number()`. Anything the generator cannot spell exactly (list sort,
// related-row rules, …) throws UnsupportedSpecError with the body path, and
// the convert refuses with that path.
//
// Path rules mirror evaluate.ts: the first segment is a list alias / number
// alias (innermost first), then a field of a list item (innermost first; the
// generator lists each item's keys once per iteration), then a top-level scope
// key, then a field of `record`. Aliases are the Liquid loop variables, so
// they shadow exactly as frames do. Every generated variable starts `nvr_`.

/** A construct the generator cannot express exactly; `path` is the body path. */
export class UnsupportedSpecError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message)
    this.name = 'UnsupportedSpecError'
  }
}

export type ToLiquidOptions = {
  /**
   * Top-level scope keys every render scope carries. A root in this list is
   * read straight from the scope; a root not in it never is (the map's
   * `Object.hasOwn(scope, root)` is then answered statically). Without it the
   * generator asks Liquid `root != nil`, which cannot tell a key holding null
   * from a missing one.
   */
  scopeKeys?: string[]
}

export type ConvertDiff = {
  /** Index of the record in `scopes`; -1 = refused before rendering. */
  index: number
  path: string
  map: unknown
  liquid: unknown
  message?: string
}

export type ConvertResult = { ok: true; liquid: string } | { ok: false; diffs: ConvertDiff[] }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const LIQUID_WORDS = new Set([
  'true',
  'false',
  'nil',
  'null',
  'empty',
  'blank',
  'and',
  'or',
  'not',
  'contains',
  'in',
  'forloop',
  'tablerowloop'
])
/** Names a list alias / number alias / formula variable must not take. */
const RESERVED = new Set(['record', 'secrets', 'acting_user', 'state'])
const RELATED_OPS = new Set([
  'related_some',
  'related_none',
  'children_in_state',
  'children_not_in_state'
])
/** Transforms that leave a secret placeholder as the map leaves its token. */
const SECRET_SAFE = new Set(['trim', 'prefix', 'suffix'])
const KEY_SEP = '\u0001'
/** A variable never assigned: reads as undefined (the `nil` literal is a drop, not null). */
const NIL = 'nvr_nil'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const joinPath = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key)

/** evaluate.ts `segments`, kept in step. */
function segments(path: string): string[] {
  return path
    .replace(/\[\s*(\d+)\s*\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
}

const isNumericish = (v: unknown): boolean =>
  !(v === null || v === undefined || v === '') && !Number.isNaN(Number(v))

/** A name Liquid can read bare and that no generated variable takes. */
const bareOk = (name: string): boolean =>
  IDENT.test(name) && !LIQUID_WORDS.has(name) && !name.startsWith('nvr_')

/** The fields of one sibling set the map evaluates (evaluate.ts checkKeys). */
function keptFields(fields: unknown): Field[] {
  if (!Array.isArray(fields)) return []
  const seen = new Set<string>()
  const out: Field[] = []
  for (const field of fields) {
    if (!isObj(field)) continue
    const key = typeof field.key === 'string' ? field.key : ''
    if (!key.trim() || seen.has(key)) continue
    seen.add(key)
    out.push(field as unknown as Field)
  }
  return out
}

type Frame = { alias: string; numberAs: string; num: string; keys: string; needKeys: boolean }

type Kind = 'string' | 'any' // 'string' = a string or nil

const FORMULA_REFUSED =
  /\{%-?\s*(break|continue|increment|decrement|include|render|layout|liquid|cycle)\b/

class Gen {
  private n = 0
  private consts: string[] = []
  private constNames = new Map<string, string>()
  private frames: Frame[] = []
  private readonly scopeKeys: Set<string> | null
  /** Names formulas assign, by formula text. */
  private formulaAssigns = new Map<string, Set<string>>()
  /** First-segment names used by paths, rule fields and list sources. */
  private roots = new Set<string>()
  /** Every list alias / number alias in the map. */
  private loopNames = new Set<string>()

  constructor(opts: ToLiquidOptions) {
    this.scopeKeys = Array.isArray(opts.scopeKeys)
      ? new Set(opts.scopeKeys.filter((k) => k !== 'secrets'))
      : null
  }

  private v(tag: string): string {
    this.n += 1
    return `nvr_${tag}${this.n}`
  }

  // ─── Constants (hoisted to the top of the template) ────────────────────────

  /** A variable holding the string `s` exactly. */
  str(s: string): string {
    const k = `s${s}`
    let name = this.constNames.get(k)
    if (name) return name
    name = this.v('k')
    // A tag ends at the first `%}` even inside quotes; base64 never has one.
    const expr = s.includes('%}')
      ? `'${Buffer.from(s, 'utf8').toString('base64')}' | base64_decode`
      : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    this.consts.push(`{% assign ${name} = ${expr} %}`)
    this.constNames.set(k, name)
    return name
  }

  /** A variable holding the number `n` exactly (Number() of its String()). */
  num(n: number): string {
    const k = `n${String(n)}`
    let name = this.constNames.get(k)
    if (name) return name
    name = this.v('k')
    this.consts.push(`{% assign ${name} = '${String(n)}' | to_integer %}`)
    this.constNames.set(k, name)
    return name
  }

  // ─── Pre-scan: names formulas assign must not collide ─────────────────────

  scan(fields: unknown): void {
    const walkValue = (v: unknown): void => {
      if (!isObj(v)) return
      if (v.source === 'path' && typeof v.path === 'string') this.addRoot(v.path)
      if (v.source === 'formula' && typeof v.liquid === 'string') {
        const names = new Set<string>()
        for (const m of v.liquid.matchAll(/\{%-?\s*(?:assign|capture)\s+([A-Za-z_][\w-]*)/g)) {
          names.add(m[1])
        }
        this.formulaAssigns.set(v.liquid, names)
      }
      if (v.source === 'switch' && Array.isArray(v.cases)) {
        for (const c of v.cases) {
          if (!isObj(c)) continue
          walkRules(c.when)
          walkValue(c.value)
        }
        walkValue(v.else)
      }
      if (Array.isArray(v.fallbacks)) for (const fb of v.fallbacks) walkValue(fb)
    }
    const walkRules = (rules: unknown): void => {
      if (!Array.isArray(rules)) return
      for (const r of rules) if (isObj(r) && typeof r.field === 'string') this.addRoot(r.field)
    }
    const walkFields = (list: unknown): void => {
      if (!Array.isArray(list)) return
      for (const fd of list) {
        if (!isObj(fd)) continue
        if (isObj(fd.include)) walkRules(fd.include.when)
        walkValue(fd.value)
        if (isObj(fd.list)) {
          if (typeof fd.list.source === 'string') this.addRoot(fd.list.source)
          walkRules(fd.list.where)
          const item = typeof fd.list.item === 'string' ? fd.list.item.trim() : ''
          const num = typeof fd.list.number_as === 'string' ? fd.list.number_as.trim() : ''
          this.loopNames.add(item || 'line')
          this.loopNames.add(num || 'number')
        }
        walkFields(fd.children)
      }
    }
    walkFields(fields)
  }

  private addRoot(path: string): void {
    const segs = segments(path)
    if (segs.length) this.roots.add(segs[0])
  }

  private checkFormula(liquid: string, path: string): void {
    const refuse = (why: string): never => {
      throw new UnsupportedSpecError(path, `This formula cannot be converted: ${why}`)
    }
    if (FORMULA_REFUSED.test(liquid)) refuse('it uses a tag the conversion cannot reproduce')
    if (/\bnvr_/.test(liquid)) refuse('nvr_ names are reserved for the generated template')
    const own = this.formulaAssigns.get(liquid) ?? new Set<string>()
    for (const name of own) {
      if (RESERVED.has(name) || this.roots.has(name) || this.loopNames.has(name)) {
        refuse(`it assigns '${name}', which the template also reads`)
      }
    }
    // In one template every assign is shared: another formula must not read a
    // name this one leaves behind.
    for (const [other, names] of this.formulaAssigns) {
      if (other === liquid) continue
      for (const name of names) {
        if (!own.has(name) && new RegExp(`\\b${name}\\b`).test(liquid)) {
          refuse(`it reads '${name}', which another formula assigns`)
        }
      }
    }
    if (this.frames.length) {
      if (/\bforloop\b/.test(liquid) && !/\{%-?\s*(for|tablerow)\b/.test(liquid)) {
        refuse('it reads forloop outside its own loop')
      }
      const names = this.frames.flatMap((fr) => [fr.alias, fr.numberAs])
      if (new Set(names).size !== names.length) {
        refuse('two enclosing lists share an alias or number name')
      }
    }
  }

  // ─── Paths ─────────────────────────────────────────────────────────────────

  /** Liquid property access for `segs` (after the base). */
  private access(segs: string[], path: string): string {
    let out = ''
    for (const seg of segs) {
      if (seg === 'size' || seg === 'first' || seg === 'last') {
        // Liquid answers these for any array/string/object that lacks the key.
        throw new UnsupportedSpecError(
          path,
          `The path segment '${seg}' cannot be converted (Liquid reads it as a count or an item)`
        )
      }
      if (IDENT.test(seg) && !LIQUID_WORDS.has(seg)) out += `.${seg}`
      else if (/^(0|[1-9]\d{0,8})$/.test(seg)) out += `[${seg}]`
      else out += `[${this.str(seg)}]`
    }
    return out
  }

  /** Code that assigns the value at `path` to `out`. */
  path(path: string, out: string, at: string): string {
    const segs = segments(path)
    if (segs.length === 0) return `{% assign ${out} = nvr_nil %}`
    const root = segs[0]
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const fr = this.frames[i]
      if (fr.alias === root)
        return `{% assign ${out} = ${fr.alias}${this.access(segs.slice(1), at)} %}`
      if (fr.numberAs === root) {
        return `{% assign ${out} = ${fr.num}${this.access(segs.slice(1), at)} %}`
      }
    }
    const branches: Array<{ cond: string | null; expr: string }> = []
    if (this.frames.length) {
      const needle = this.str(`${KEY_SEP}${root}${KEY_SEP}`)
      for (let i = this.frames.length - 1; i >= 0; i--) {
        const fr = this.frames[i]
        fr.needKeys = true
        branches.push({
          cond: `${fr.keys} contains ${needle}`,
          expr: `${fr.alias}${this.access(segs, at)}`
        })
      }
    }
    let scopeFinal = false
    if (root !== 'secrets') {
      const known = this.scopeKeys
      if (known === null || known.has(root)) {
        if (!bareOk(root)) {
          throw new UnsupportedSpecError(
            at,
            `The path '${path}' cannot be converted: '${root}' is not a Liquid name`
          )
        }
        const expr = `${root}${this.access(segs.slice(1), at)}`
        if (known === null) branches.push({ cond: `${root} != nil`, expr })
        else {
          branches.push({ cond: null, expr })
          scopeFinal = true
        }
      }
    }
    if (!scopeFinal) branches.push({ cond: null, expr: `record${this.access(segs, at)}` })
    if (branches.length === 1) return `{% assign ${out} = ${branches[0].expr} %}`
    let code = ''
    branches.forEach((b, i) => {
      const assign = `{% assign ${out} = ${b.expr} %}`
      if (i === 0) code += `{% if ${b.cond} %}${assign}`
      else if (b.cond) code += `{% elsif ${b.cond} %}${assign}`
      else code += `{% else %}${assign}`
    })
    return `${code}{% endif %}`
  }

  // ─── Shared value tests ────────────────────────────────────────────────────

  /** evaluate.ts `text(v)` of a non-nil `v` into `out`. */
  private text(v: string, out: string, kind: Kind): string {
    if (kind === 'string') return `{% assign ${out} = ${v} %}`
    const j = this.v('j')
    const s = this.v('s')
    const sj = this.v('sj')
    const c = this.v('c')
    const len = this.v('len')
    return (
      `{% assign ${j} = ${v} | jsonify %}{% assign ${s} = ${v} | append: '' %}` +
      `{% assign ${sj} = ${s} | jsonify %}` +
      `{% if ${sj} == ${j} %}{% assign ${out} = ${v} %}{% else %}` +
      `{% assign ${c} = ${j} | slice: 0 %}` +
      `{% if ${c} == '{' or ${c} == '[' %}{% assign ${out} = ${j} %}` +
      `{% elsif ${c} == '"' %}{% assign ${len} = ${j}.size | minus: 2 %}` +
      `{% assign ${out} = ${j} | slice: 1, ${len} %}` +
      `{% else %}{% assign ${out} = ${s} %}{% endif %}{% endif %}`
    )
  }

  /** Sets `out` to true when `v` is the map's empty (nil, '' or []). */
  private empty(v: string, out: string): string {
    const e = this.v('e')
    return (
      `{% assign ${e} = ${v} | jsonify %}{% assign ${out} = false %}` +
      `{% if ${e} == 'null' or ${e} == '""' or ${e} == '[]' %}{% assign ${out} = true %}{% endif %}`
    )
  }

  // ─── Conditions ────────────────────────────────────────────────────────────

  /** Code that sets `out` to whether every rule passes (AND; malformed = pass). */
  rules(rules: unknown, out: string, at: string): string {
    let code = `{% assign ${out} = true %}`
    if (!Array.isArray(rules)) return code
    for (const r of rules as ConditionRule[]) {
      if (!isObj(r) || typeof r.field !== 'string' || !r.field) continue
      if (r.field.includes(':') || RELATED_OPS.has(r.op)) {
        throw new UnsupportedSpecError(
          at,
          `The related-records condition on ${r.field} cannot be converted to Liquid`
        )
      }
      const one = this.v('r')
      code += `${this.rule(r, one, at)}{% unless ${one} %}{% assign ${out} = false %}{% endunless %}`
    }
    return code
  }

  private rule(r: ConditionRule, out: string, at: string): string {
    const x = this.v('x')
    let code = this.path(r.field, x, at)
    const c = r.value
    const set = (cond: string) =>
      `{% if ${cond} %}{% assign ${out} = true %}{% else %}{% assign ${out} = false %}{% endif %}`
    const sx = this.v('sx')
    const strOf = `{% assign ${sx} = ${x} | append: '' %}` // String(x ?? '')
    const nx = this.v('nx')
    const isn = this.v('isn')
    const numOf =
      `{% assign ${nx} = ${x} | to_integer %}{% assign ${isn} = false %}` +
      `{% unless ${x} == nil or ${x} == '' %}{% if ${nx} == ${nx} %}{% assign ${isn} = true %}{% endif %}{% endunless %}`
    switch (r.op) {
      case 'null':
        return code + set(`${x} == nil or ${x} == ''`)
      case 'nnull':
        return `${code}{% assign ${out} = true %}{% if ${x} == nil or ${x} == '' %}{% assign ${out} = false %}{% endif %}`
      case 'contains': {
        const needle = this.str(
          String(c ?? '')
            .toLowerCase()
            .trim()
        )
        const low = this.v('low')
        return (
          `${code}${strOf}{% assign ${low} = ${sx} | downcase %}{% assign ${out} = false %}` +
          `{% unless ${x} == nil %}{% if ${low} contains ${needle} %}{% assign ${out} = true %}{% endif %}{% endunless %}`
        )
      }
      case 'eq':
      case 'neq': {
        const [yes, no] = r.op === 'eq' ? ['true', 'false'] : ['false', 'true']
        const pick = (cond: string) =>
          `{% if ${cond} %}{% assign ${out} = ${yes} %}{% else %}{% assign ${out} = ${no} %}{% endif %}`
        const cs = this.str(String(c ?? ''))
        code += strOf
        if (!isNumericish(c)) return code + pick(`${sx} == ${cs}`)
        const cn = this.num(Number(c))
        return `${code}${numOf}{% if ${isn} %}${pick(`${nx} == ${cn}`)}{% else %}${pick(`${sx} == ${cs}`)}{% endif %}`
      }
      case 'in': {
        const list = String(c ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        code += `${strOf}${numOf}{% assign ${out} = false %}{% unless ${x} == nil or ${x} == '' %}`
        const hit = `{% assign ${out} = true %}`
        for (const item of list) {
          const is = this.str(item)
          if (isNumericish(item)) {
            const n = this.num(Number(item))
            code += `{% if ${isn} %}{% if ${nx} == ${n} %}${hit}{% endif %}{% else %}{% if ${sx} == ${is} %}${hit}{% endif %}{% endif %}`
          } else code += `{% if ${sx} == ${is} %}${hit}{% endif %}`
        }
        return `${code}{% endunless %}`
      }
      case 'within_days':
      case 'beyond_days': {
        if (!isNumericish(c)) return `${code}{% assign ${out} = false %}`
        // diff <= c ⟺ day <= today + floor(c) (days are whole); likewise >.
        const limit = this.v('lim')
        const day = this.v('day')
        const op = r.op === 'within_days' ? '<=' : '>'
        return (
          `${code}{% assign ${day} = ${x} | iso_date %}` +
          `{% assign ${limit} = nvr_nil | add_days: ${this.num(Math.floor(Number(c)))} %}` +
          `{% assign ${out} = false %}{% unless ${day} == '' %}{% if ${day} ${op} ${limit} %}{% assign ${out} = true %}{% endif %}{% endunless %}`
        )
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[r.op]
        const strCase =
          c == null
            ? `{% assign ${out} = false %}`
            : `{% if ${x} == nil %}{% assign ${out} = false %}{% else %}${set(`${sx} ${op} ${this.str(String(c))}`)}{% endif %}`
        code += strOf
        if (!isNumericish(c)) return code + strCase
        return `${code}${numOf}{% if ${isn} %}${set(`${nx} ${op} ${this.num(Number(c))}`)}{% else %}${strCase}{% endif %}`
      }
      default:
        return `${code}{% assign ${out} = false %}`
    }
  }

  // ─── Values ────────────────────────────────────────────────────────────────

  /** Whether `spec` (or a case / fallback inside it) can yield a secret. */
  private maySecret(spec: unknown): boolean {
    if (!isObj(spec)) return false
    if (spec.source === 'secret') return true
    if (spec.source === 'switch') {
      const cases = Array.isArray(spec.cases) ? spec.cases : []
      if (cases.some((c) => isObj(c) && this.maySecret(c.value))) return true
      if (this.maySecret(spec.else)) return true
    }
    return Array.isArray(spec.fallbacks) && spec.fallbacks.some((fb) => this.maySecret(fb))
  }

  /** Code that assigns the value of `spec` to `out` (+ formula flag to `flag`). */
  value(
    spec: ValueSpec,
    out: string,
    flag: string | null,
    at: string
  ): { code: string; kind: Kind } {
    const transforms = Array.isArray(spec.transforms) ? spec.transforms : []
    if (this.maySecret(spec)) {
      for (const t of transforms) {
        if (isObj(t) && !SECRET_SAFE.has(String(t.op))) {
          throw new UnsupportedSpecError(
            at,
            `The '${String(t.op)}' transform on a secret cannot be converted to Liquid`
          )
        }
      }
    }
    const raw = this.raw(spec, out, flag, at)
    let code = raw.code
    const tr = this.transforms(transforms, out, raw.kind, at)
    code += tr.code
    let kind = tr.kind
    if (Array.isArray(spec.fallbacks)) {
      for (const fb of spec.fallbacks) {
        if (!isObj(fb)) continue
        const isEmpty = this.v('em')
        const w = this.v('w')
        const wf = flag ? this.v('wf') : null
        const cand = this.value(fb as ValueSpec, w, wf, at)
        const ctr = this.transforms(transforms, w, cand.kind, at)
        const wEmpty = this.v('em')
        code +=
          `${this.empty(out, isEmpty)}{% if ${isEmpty} %}${cand.code}${ctr.code}` +
          `${this.empty(w, wEmpty)}{% unless ${wEmpty} %}{% assign ${out} = ${w} %}` +
          `${flag && wf ? `{% assign ${flag} = ${wf} %}` : ''}{% endunless %}{% endif %}`
        if (ctr.kind !== 'string') kind = 'any'
      }
    }
    return { code, kind }
  }

  private raw(
    spec: ValueSpec,
    out: string,
    flag: string | null,
    at: string
  ): { code: string; kind: Kind } {
    const setFlag = (on: boolean) => (flag ? `{% assign ${flag} = ${on} %}` : '')
    switch (spec.source) {
      case 'fixed': {
        const v = spec.value ?? null
        if (v === null)
          return { code: `{% assign ${out} = nvr_nil %}${setFlag(false)}`, kind: 'string' }
        if (typeof v === 'string') {
          if (v.includes(MARKER)) {
            throw new UnsupportedSpecError(
              at,
              'Fixed text that spells a secret placeholder cannot be converted'
            )
          }
          return { code: `{% assign ${out} = ${this.str(v)} %}${setFlag(false)}`, kind: 'string' }
        }
        if (typeof v === 'number') {
          return { code: `{% assign ${out} = ${this.num(v)} %}${setFlag(false)}`, kind: 'any' }
        }
        if (typeof v === 'boolean')
          return { code: `{% assign ${out} = ${v} %}${setFlag(false)}`, kind: 'any' }
        throw new UnsupportedSpecError(
          at,
          'A fixed value must be text, a number, true/false or empty'
        )
      }
      case 'path':
        return { code: this.path(String(spec.path ?? ''), out, at) + setFlag(false), kind: 'any' }
      case 'builtin':
        return { code: this.builtin(spec.name, out) + setFlag(false), kind: 'any' }
      case 'secret': {
        const name = String(spec.name ?? '').trim()
        if (!name) return { code: `{% assign ${out} = nvr_nil %}${setFlag(false)}`, kind: 'string' }
        return {
          code: `{% assign ${out} = secrets[${this.str(name)}] %}${setFlag(false)}`,
          kind: 'string'
        }
      }
      case 'switch': {
        let code = ''
        let close = ''
        let kind: Kind = 'string'
        for (const c of Array.isArray(spec.cases) ? spec.cases : []) {
          if (!isObj(c)) continue
          const pass = this.v('case')
          const v = isObj(c.value)
            ? this.value(c.value, out, flag, at)
            : { code: `{% assign ${out} = nvr_nil %}${setFlag(false)}`, kind: 'string' as Kind }
          if (v.kind !== 'string') kind = 'any'
          code += `${this.rules(c.when, pass, at)}{% if ${pass} %}${v.code}{% else %}`
          close += '{% endif %}'
        }
        const e = isObj(spec.else)
          ? this.value(spec.else, out, flag, at)
          : { code: `{% assign ${out} = nvr_nil %}${setFlag(false)}`, kind: 'string' as Kind }
        if (e.kind !== 'string') kind = 'any'
        return { code: code + e.code + close, kind }
      }
      case 'formula': {
        const liquid = String(spec.liquid ?? '')
        let parses = true
        try {
          payloadLiquid().parse(liquid)
        } catch {
          parses = false
        }
        // The map reports a formula that does not parse and leaves it empty.
        if (!parses)
          return { code: `{% assign ${out} = nvr_nil %}${setFlag(true)}`, kind: 'string' }
        this.checkFormula(liquid, at)
        // The map renders a formula with every list alias and number alias in
        // scope; the numbers are bound by one-step range loops.
        let open = ''
        let close = ''
        for (const fr of this.frames) {
          open += `{% for ${fr.numberAs} in (${fr.num}..${fr.num}) %}`
          close += '{% endfor %}'
        }
        return {
          code: `{% capture ${out} %}${open}${liquid}${close}{% endcapture %}${setFlag(true)}`,
          kind: 'string'
        }
      }
      default:
        return { code: `{% assign ${out} = nvr_nil %}${setFlag(false)}`, kind: 'string' }
    }
  }

  private builtin(name: string, out: string): string {
    switch (name) {
      case 'today':
        return `{% assign ${out} = nvr_nil | add_days: 0 %}`
      case 'now':
        return `{% capture ${out} %}{{ 'now' | date: '%Y-%m-%dT%H:%M:%S.%LZ', 'UTC' }}{% endcapture %}`
      case 'acting_user.email':
        return `{% assign ${out} = acting_user.email %}`
      case 'acting_user.employee_id':
        return `{% assign ${out} = acting_user.employee_id %}`
      case 'state.label':
        return `{% assign ${out} = state.label %}`
      case 'state.external_label':
        return `{% assign ${out} = state.external_label %}`
      case 'list.number': {
        const fr = this.frames[this.frames.length - 1]
        return `{% assign ${out} = ${fr ? fr.num : NIL} %}`
      }
      case 'acting_user.name': {
        const uc = this.v('uc')
        const fst = this.v('fst')
        const lst = this.v('lst')
        const okF = this.v('okf')
        const okL = this.v('okl')
        const has = (v: string, ok: string) =>
          `{% assign ${ok} = true %}{% if ${v} == nil or ${v} == '' %}{% assign ${ok} = false %}{% endif %}`
        return (
          `{% assign ${out} = nvr_nil %}{% assign ${uc} = acting_user | jsonify | slice: 0 %}` +
          `{% if ${uc} == '{' %}{% assign ${out} = acting_user.name %}` +
          `{% if ${out} == nil or ${out} == '' %}` +
          `{% assign ${fst} = acting_user.first_name %}{% assign ${lst} = acting_user.last_name %}` +
          `${has(fst, okF)}${has(lst, okL)}` +
          `{% capture ${out} %}{% if ${okF} %}{{ ${fst} }}{% endif %}{% if ${okF} and ${okL} %} {% endif %}{% if ${okL} %}{{ ${lst} }}{% endif %}{% endcapture %}` +
          `{% if ${out} == '' %}{% assign ${out} = nvr_nil %}{% endif %}{% endif %}{% endif %}`
        )
      }
      default:
        return `{% assign ${out} = nvr_nil %}`
    }
  }

  private transforms(
    list: Transform[],
    v: string,
    kindIn: Kind,
    at: string
  ): { code: string; kind: Kind } {
    let code = ''
    let kind = kindIn
    for (const t of list) {
      if (!isObj(t)) continue
      if (t.op === 'at_least_days_out') {
        code += `{% assign ${v} = ${v} | at_least_days_out: ${this.num(Number(t.n))} %}`
        kind = 'string'
        continue
      }
      const step = this.transform(t, v, kind, at)
      if (step === null) continue
      code += `{% unless ${v} == nil %}${step.code}{% endunless %}`
      kind = step.kind
    }
    return { code, kind }
  }

  /** One transform on a non-nil `v` (null = no-op). */
  private transform(
    t: Transform,
    v: string,
    kind: Kind,
    at: string
  ): { code: string; kind: Kind } | null {
    const t1 = this.v('t')
    const txt = (then: string): { code: string; kind: Kind } => ({
      code: `${this.text(v, t1, kind)}{% assign ${v} = ${t1}${then} %}`,
      kind: 'string'
    })
    switch (t.op) {
      case 'trim':
        return txt(' | strip')
      case 'upper':
        return txt(' | upcase')
      case 'lower':
        return txt(' | downcase')
      case 'next_open_day':
        return { code: `{% assign ${v} = ${v} | next_open_day %}`, kind: 'any' }
      case 'editor_text':
        return { code: `{% assign ${v} = ${v} | editorjs_text %}`, kind: 'string' }
      case 'truncate': {
        const n = Number(t.n)
        if (!Number.isFinite(n)) return null
        const k = Math.max(0, Math.trunc(n))
        return txt(` | slice: 0, ${this.num(k)}`)
      }
      case 'prefix':
        return txt(` | prepend: ${this.literalText(String(t.text ?? ''), at)}`)
      case 'suffix':
        return txt(` | append: ${this.literalText(String(t.text ?? ''), at)}`)
      case 'pad_start':
        return {
          code: `{% assign ${v} = ${v} | pad_start: ${this.num(Number(t.n))}, ${this.str(String(t.char ?? '0'))} %}`,
          kind: 'string'
        }
      case 'replace': {
        const from = String(t.from ?? '')
        if (!from) return null
        return txt(` | replace: ${this.str(from)}, ${this.literalText(String(t.to ?? ''), at)}`)
      }
      case 'date': {
        const x = this.v('dt')
        return {
          code:
            `{% capture ${x} %}{{ ${v} | date: ${this.str(String(t.format ?? ''))} }}{% endcapture %}` +
            `{% if ${x} == '' %}{% assign ${v} = nvr_nil %}{% else %}{% assign ${v} = ${x} %}{% endif %}`,
          kind: 'string'
        }
      }
      case 'add_days':
        return {
          code: `{% assign ${v} = ${v} | add_days: ${this.num(Number(t.n))} %}`,
          kind: 'any'
        }
      case 'join': {
        const c = this.v('c')
        const sep = this.str(String(t.sep ?? ''))
        return {
          code:
            `{% assign ${c} = ${v} | jsonify | slice: 0 %}{% if ${c} == '[' %}{% assign ${v} = ${v} | join: ${sep} %}` +
            `{% else %}${this.text(v, t1, kind)}{% assign ${v} = ${t1} %}{% endif %}`,
          kind: 'string'
        }
      }
      default:
        return null
    }
  }

  /** A text argument that may not spell a secret placeholder. */
  private literalText(s: string, at: string): string {
    if (s.includes(MARKER)) {
      throw new UnsupportedSpecError(
        at,
        'Text that spells a secret placeholder cannot be converted'
      )
    }
    return this.str(s)
  }

  // ─── Coercion (evaluate.ts `coerce`) → JSON text in `o` ────────────────────

  private coerce(type: string, v: string, kind: Kind, flag: string | null, o: string): string {
    const j = this.v('j')
    const s = this.v('s')
    const sj = this.v('sj')
    const c = this.v('c')
    const probe =
      `{% assign ${j} = ${v} | jsonify %}{% assign ${s} = ${v} | append: '' %}` +
      `{% assign ${sj} = ${s} | jsonify %}{% assign ${c} = ${j} | slice: 0 %}`
    const nil = `{% assign ${o} = 'null' %}`
    switch (type) {
      case 'text':
        if (kind === 'string') return `{% assign ${o} = ${v} | jsonify %}`
        return (
          `{% if ${v} == nil %}${nil}{% else %}${probe}` +
          `{% if ${sj} == ${j} or ${c} == '"' %}{% assign ${o} = ${j} %}` +
          `{% elsif ${c} == '{' or ${c} == '[' %}${nil}` +
          `{% else %}{% assign ${o} = ${s} | jsonify %}{% endif %}{% endif %}`
        )
      case 'number': {
        const st = this.v('st')
        const num = `{% assign ${o} = ${v} | to_integer | jsonify %}`
        return (
          `{% if ${v} == nil %}${nil}{% else %}${probe}` +
          `{% if ${sj} == ${j} %}{% assign ${st} = ${v} | strip %}{% if ${st} == '' %}${nil}{% else %}${num}{% endif %}` +
          `{% elsif ${c} == '{' or ${c} == '[' or ${c} == '"' %}${nil}` +
          `{% else %}${num}{% endif %}{% endif %}`
        )
      }
      case 'boolean': {
        const low = this.v('low')
        const yes = `{% assign ${o} = 'true' %}`
        const no = `{% assign ${o} = 'false' %}`
        return (
          `${nil}{% unless ${v} == nil or ${v} == '' %}${probe}` +
          `{% if ${sj} == ${j} %}{% assign ${low} = ${v} | strip | downcase %}` +
          `{% if ${low} == 'true' or ${low} == '1' %}${yes}{% elsif ${low} == 'false' or ${low} == '0' %}${no}{% endif %}` +
          `{% elsif ${j} == 'true' or ${j} == '1' %}${yes}{% elsif ${j} == 'false' or ${j} == '0' %}${no}{% endif %}` +
          '{% endunless %}'
        )
      }
      case 'date': {
        const day = this.v('day')
        return (
          `${nil}{% unless ${v} == nil or ${v} == '' %}${probe}` +
          `{% if ${sj} == ${j} or ${c} == '"' %}{% assign ${day} = ${v} | iso_date %}` +
          `{% unless ${day} == '' %}{% assign ${o} = ${day} | jsonify %}{% endunless %}{% endif %}` +
          '{% endunless %}'
        )
      }
      case 'json': {
        let code = `{% assign ${o} = ${v} | jsonify %}`
        if (flag) {
          // Formula output is JSON text: written as-is (trimmed), '' = null.
          const st = this.v('st')
          code +=
            `{% if ${flag} %}{% assign ${s} = ${v} | append: '' %}{% assign ${sj} = ${s} | jsonify %}` +
            `{% if ${sj} == ${o} %}{% assign ${st} = ${v} | strip %}` +
            `{% if ${st} == '' %}${nil}{% else %}{% assign ${o} = ${st} %}{% endif %}{% endif %}{% endif %}`
        }
        return code
      }
      default:
        return nil
    }
  }

  // ─── Fields ────────────────────────────────────────────────────────────────

  /** Code that sets `drop` (key left out) and `o` (the value as JSON text). */
  field(
    field: Field,
    at: string,
    itemDefault: string | null
  ): { code: string; drop: string; o: string } {
    const drop = this.v('d')
    const o = this.v('o')
    let body: string
    if (field.type === 'object') {
      body = this.object(keptFields(field.children), at, o)
    } else if (field.type === 'list') {
      body = this.list(field, at, o)
    } else if (['text', 'number', 'boolean', 'date', 'json'].includes(field.type)) {
      const v = this.v('v')
      const flag = field.type === 'json' ? this.v('f') : null
      let valueCode: string
      let kind: Kind
      if (isObj(field.value)) {
        const r = this.value(field.value, v, flag, at)
        valueCode = r.code
        kind = r.kind
      } else {
        valueCode = `{% assign ${v} = ${itemDefault ?? NIL} %}${flag ? `{% assign ${flag} = false %}` : ''}`
        kind = itemDefault ? 'any' : 'string'
      }
      body = valueCode + this.coerce(field.type, v, kind, flag, o)
    } else {
      body = `{% assign ${o} = 'null' %}`
    }
    if (field.include === 'not_empty') {
      body += `{% if ${o} == 'null' or ${o} == '""' or ${o} == '[]' %}{% assign ${drop} = true %}{% endif %}`
    }
    let code = `{% assign ${drop} = false %}`
    if (isObj(field.include)) {
      const pass = this.v('inc')
      code += `${this.rules(field.include.when, pass, at)}{% if ${pass} %}${body}{% else %}{% assign ${drop} = true %}{% endif %}`
    } else code += body
    return { code, drop, o }
  }

  /** Code that captures the object of `fields` as JSON text into `o`. */
  object(fields: Field[], prefix: string, o: string | null): string {
    const sep = this.v('sep')
    let inner = `{% assign ${sep} = false %}`
    for (const fd of fields) {
      const at = joinPath(prefix, fd.key)
      if (fd.key.includes(MARKER)) {
        throw new UnsupportedSpecError(
          at,
          'A key that spells a secret placeholder cannot be converted'
        )
      }
      const r = this.field(fd, at, null)
      const keyJson = JSON.stringify(fd.key)
      const key = /[{}%]/.test(keyJson) ? `{{ ${this.str(fd.key)} | jsonify }}` : keyJson
      inner +=
        `${r.code}{% unless ${r.drop} %}{% if ${sep} %},{% endif %}{% assign ${sep} = true %}` +
        `${key}:{{ ${r.o} }}{% endunless %}`
    }
    // '{ ' — a brace right before a tag would read as '{{'.
    const text = `{ ${inner}}`
    return o ? `{% capture ${o} %}${text}{% endcapture %}` : text
  }

  /** Code that captures the list as JSON text into `o`. */
  list(field: Field, at: string, o: string): string {
    const ls = field.list
    if (!isObj(ls) || typeof ls.source !== 'string' || !ls.source.trim()) {
      return `{% assign ${o} = '[]' %}`
    }
    if (typeof ls.sort === 'string' && ls.sort.trim()) {
      throw new UnsupportedSpecError(at, 'A sorted list cannot be converted to Liquid')
    }
    const alias = (typeof ls.item === 'string' && ls.item.trim()) || 'line'
    const numberAs = (typeof ls.number_as === 'string' && ls.number_as.trim()) || 'number'
    for (const name of [alias, numberAs]) {
      if (!bareOk(name) || RESERVED.has(name)) {
        throw new UnsupportedSpecError(at, `The list name '${name}' cannot be a Liquid variable`)
      }
    }
    const src = this.v('src')
    const srcCode = this.path(ls.source, src, at)
    const fr: Frame = {
      alias,
      numberAs,
      num: this.v('num'),
      keys: this.v('keys'),
      needKeys: false
    }
    const cnt = this.v('cnt')
    const lsep = this.v('lsep')
    const sc = this.v('sc')
    this.frames.push(fr)
    let item: string
    let where: string
    const pass = this.v('wh')
    try {
      where = this.rules(ls.where, pass, `${at}[]`)
      const children = keptFields(field.children)
      if (ls.scalar) {
        const child = children[0]
        if (!child) {
          item = `{% if ${lsep} %},{% endif %}{% assign ${lsep} = true %}{{ ${alias} | jsonify }}`
        } else {
          const r = this.field(child, `${at}[]`, alias)
          item = `${r.code}{% unless ${r.drop} %}{% if ${lsep} %},{% endif %}{% assign ${lsep} = true %}{{ ${r.o} }}{% endunless %}`
        }
      } else {
        const io = this.v('io')
        item = `${this.object(children, `${at}[]`, io)}{% if ${lsep} %},{% endif %}{% assign ${lsep} = true %}{{ ${io} }}`
      }
    } finally {
      this.frames.pop()
    }
    // The item's own keys, once per item, for bare-name lookups.
    const p = this.v('p')
    const kc = this.v('kc')
    const keys = fr.needKeys
      ? `{% assign ${kc} = ${alias} | jsonify | slice: 0 %}{% if ${kc} == '{' %}` +
        `{% capture ${fr.keys} %}${KEY_SEP}{% for ${p} in ${alias} %}{{ ${p}[0] }}${KEY_SEP}{% endfor %}{% endcapture %}` +
        `{% else %}{% assign ${fr.keys} = '' %}{% endif %}`
      : ''
    return (
      `${srcCode}{% assign ${sc} = ${src} | jsonify | slice: 0 %}` +
      `{% capture ${o} %}[{% if ${sc} == '[' %}{% assign ${cnt} = 0 %}{% assign ${lsep} = false %}` +
      `{% for ${alias} in ${src} %}${keys}{% assign ${fr.num} = 0 %}${where}` +
      `{% if ${pass} %}{% assign ${cnt} = ${cnt} | plus: 1 %}{% assign ${fr.num} = ${cnt} %}${item}{% endif %}` +
      `{% endfor %}{% endif %}]{% endcapture %}`
    )
  }

  template(spec: MapSpec): string {
    const fields = isObj(spec) && Array.isArray(spec.fields) ? spec.fields : []
    this.scan(fields)
    const body = this.object(keptFields(fields), '', null)
    return this.consts.join('') + body
  }
}

/**
 * Liquid that renders the same body as the field map (code mode: render →
 * JSON.parse). Throws UnsupportedSpecError (with the body path) for what it
 * cannot express exactly. Body secrets read `secrets.<name>`, which code mode
 * fills with the placeholders.
 */
export function specToLiquid(spec: MapSpec, opts: ToLiquidOptions = {}): string {
  return new Gen(opts).template(spec)
}

/** Every secret name the map uses (code mode must offer them as `secrets`). */
export function specSecretNames(spec: MapSpec): string[] {
  const names = new Set<string>()
  const walkValue = (v: unknown): void => {
    if (!isObj(v)) return
    if (v.source === 'secret' && typeof v.name === 'string' && v.name.trim())
      names.add(v.name.trim())
    if (Array.isArray(v.cases)) for (const c of v.cases) if (isObj(c)) walkValue(c.value)
    walkValue(v.else)
    if (Array.isArray(v.fallbacks)) for (const fb of v.fallbacks) walkValue(fb)
  }
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const fd of list) {
      if (!isObj(fd)) continue
      walkValue(fd.value)
      walk(fd.children)
    }
  }
  walk(isObj(spec) ? spec.fields : null)
  return [...names]
}

// ─── Equality gate ───────────────────────────────────────────────────────────

const MAX_DIFFS = 50

type Found = { path: string; map: unknown; liquid: unknown; message?: string }

function diffPaths(a: unknown, b: unknown, path: string, out: Found[]): void {
  if (out.length >= MAX_DIFFS) return
  if (JSON.stringify(a) === JSON.stringify(b)) return
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path, map: a, liquid: b, message: `${a.length} items vs ${b.length}` })
      return
    }
    for (let i = 0; i < a.length; i++) diffPaths(a[i], b[i], `${path}[${i}]`, out)
    return
  }
  if (isObj(a) && isObj(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    const before = out.length
    for (const k of [...new Set([...ak, ...bk])]) {
      const p = joinPath(path, k)
      if (!Object.hasOwn(b, k)) {
        out.push({
          path: p,
          map: a[k] ?? null,
          liquid: null,
          message: 'Missing from the Liquid output'
        })
      } else if (!Object.hasOwn(a, k)) {
        out.push({
          path: p,
          map: null,
          liquid: b[k] ?? null,
          message: 'Missing from the map output'
        })
      } else diffPaths(a[k], b[k], p, out)
    }
    if (out.length === before) {
      out.push({ path, map: ak, liquid: bk, message: 'Same keys in a different order' })
    }
    return
  }
  out.push({ path, map: a ?? null, liquid: b ?? null })
}

/** The top-level keys every scope has (the generator then reads them statically). */
function commonKeys(scopes: Record<string, unknown>[]): string[] {
  if (!scopes.length) return []
  const [first, ...rest] = scopes
  return Object.keys(isObj(first) ? first : {}).filter((k) =>
    rest.every((s) => isObj(s) && Object.hasOwn(s, k))
  )
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Generate the Liquid and render map vs Liquid against every scope; the
 * Liquid comes back only when every JSON.stringify output is byte-equal.
 * Otherwise `diffs` names each differing body path (index -1 = refused before
 * rendering, with a message).
 */
export async function convertIfEqual(
  spec: MapSpec,
  scopes: Record<string, unknown>[]
): Promise<ConvertResult> {
  let liquid: string
  try {
    liquid = specToLiquid(spec, { scopeKeys: commonKeys(scopes) })
  } catch (err) {
    if (err instanceof UnsupportedSpecError) {
      return {
        ok: false,
        diffs: [{ index: -1, path: err.path, map: null, liquid: null, message: err.message }]
      }
    }
    throw err
  }
  let tpl: ReturnType<ReturnType<typeof payloadLiquid>['parse']>
  try {
    tpl = payloadLiquid().parse(liquid)
  } catch (err) {
    return {
      ok: false,
      diffs: [
        {
          index: -1,
          path: '',
          map: null,
          liquid: null,
          message: `Generated Liquid: ${errText(err)}`
        }
      ]
    }
  }
  const secrets = Object.fromEntries(specSecretNames(spec).map((n) => [n, SECRET_PLACEHOLDER(n)]))
  const diffs: ConvertDiff[] = []
  for (let index = 0; index < scopes.length && diffs.length < MAX_DIFFS; index++) {
    const scope = isObj(scopes[index]) ? scopes[index] : {}
    const { body } = await evaluateMap(spec, scope)
    let out: unknown
    try {
      const text = await payloadLiquid().render(tpl, {
        ...(neutralizeSecretMarkers(scope) as Record<string, unknown>),
        secrets
      })
      out = JSON.parse(String(text))
    } catch (err) {
      diffs.push({ index, path: '', map: body, liquid: null, message: errText(err) })
      continue
    }
    if (JSON.stringify(out) === JSON.stringify(body)) continue
    const found: Found[] = []
    diffPaths(body, out, '', found)
    for (const d of found) diffs.push({ index, ...d })
  }
  return diffs.length ? { ok: false, diffs: diffs.slice(0, MAX_DIFFS) } : { ok: true, liquid }
}

/**
 * The `/convert` handler logic: schema-check the map, require at least one
 * record to prove it on, then convertIfEqual. (The route lives with the other
 * payload-template routes.)
 */
export async function convertTemplate(
  spec: MapSpec,
  scopes: Record<string, unknown>[]
): ReturnType<typeof convertIfEqual> {
  const valid = validateSpec(spec)
  if (!valid.ok) {
    return {
      ok: false,
      diffs: [{ index: -1, path: '', map: null, liquid: null, message: valid.errors.join('; ') }]
    }
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return {
      ok: false,
      diffs: [
        {
          index: -1,
          path: '',
          map: null,
          liquid: null,
          message: 'There is no record to check the conversion against'
        }
      ]
    }
  }
  return convertIfEqual(valid.spec, scopes)
}

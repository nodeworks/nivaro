import { payloadLiquid } from '../payload-filters.js'
import { makeSecretTokens, neutralizeSecretMarkers, SECRET_NAME_RE } from '../secret-markers.js'
import { evaluateMap } from './evaluate.js'
import type { Field, MapSpec, Problem, ProblemCode } from './types.js'

// ─── Render entry ────────────────────────────────────────────────────────────
// One call turns a stored template body (map spec JSON or Liquid) plus a scope
// into the request body, then runs the push-time checks (spec §5.4): locked
// keys present, and per-field rules. Never throws; everything wrong is a
// Problem. Output paths: dotted keys, `[i]` for list items (`lines[1].sku`).
// Locked keys are top-level or dotted object paths (`a.b`); a path through a
// list is not supported (list items are not addressed).

type Rules = NonNullable<Field['rules']>

export type RenderOpts = {
  lockedKeys?: string[]
  secretNames?: string[]
  /** Code mode only: rules by dotted output path (code has no field map to carry them). */
  rules?: Record<string, Rules>
}

export type RenderResult = {
  body: Record<string, unknown> | null
  problems: Problem[]
  values: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const err = (
  fieldId: string,
  path: string,
  message: string,
  code: ProblemCode,
  params?: Problem['params']
): Problem => ({
  field_id: fieldId,
  path,
  message,
  severity: 'error',
  code,
  ...(params ? { params } : {})
})

/** The problems that stop a send. */
export function blockingProblems(problems: Problem[]): Problem[] {
  return problems.filter((p) => p.severity === 'error')
}

// ─── Code mode: secrets ──────────────────────────────────────────────────────
// `secrets.<name>` and `'<name>' | secret` emit a per-render private token, never
// the real placeholder. After JSON.parse the tokens become placeholders
// and every other string is neutralized, so record text cannot forge one.

const TOKEN_VAR = '__secret_token'
const USED_VAR = '__secret_used'

// Registered once on the shared engine at first use. Safe: the filter is inert
// (returns '') unless the render scope carries this render's token factory, so
// other users of the shared engine never see a placeholder from it.
let filterRegistered = false
function ensureSecretFilter(): void {
  if (filterRegistered) return
  filterRegistered = true
  payloadLiquid().registerFilter('secret', function (this: any, v: unknown) {
    const name = String(v ?? '')
    const minter = this?.context?.getSync?.([TOKEN_VAR])
    if (typeof minter?.token !== 'function') return ''
    // Recorded even when invalid, so renderCode can report it instead of a silent ''.
    const used = this.context.getSync([USED_VAR])
    if (Array.isArray(used)) used.push(name)
    return SECRET_NAME_RE.test(name) ? minter.token(name) : ''
  })
}

function scanSecretNames(body: string): string[] {
  const names = new Set<string>()
  for (const m of body.matchAll(/\bsecrets\.([A-Za-z0-9_-]+)/g)) names.add(m[1])
  for (const m of body.matchAll(/\bsecrets\[\s*(['"])([A-Za-z0-9_.-]+)\1\s*\]/g)) names.add(m[2])
  return [...names]
}

/** Keys repeated inside one object of valid JSON text (JSON.parse keeps the last silently). */
function duplicateKeys(text: string): string[] {
  const dups: string[] = []
  type Frame = { keys: Set<string> | null; expectKey: boolean }
  const stack: Frame[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const top = stack[stack.length - 1]
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string
        if (top.keys.has(key)) dups.push(key)
        top.keys.add(key)
        top.expectKey = false
      }
      i = j + 1
      continue
    }
    if (c === '{') stack.push({ keys: new Set(), expectKey: true })
    else if (c === '[') stack.push({ keys: null, expectKey: false })
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') {
      const top = stack[stack.length - 1]
      if (top?.keys) top.expectKey = true
    }
    i++
  }
  return dups
}

/** Output tags whose filter chain does not end in jsonify (secrets are exempt). */
function unjsonifiedOutputs(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/\{\{-?([\s\S]*?)-?\}\}/g)) {
    const expr = m[1].trim()
    if (!expr) continue
    const parts = expr.split('|').map((x) => x.trim())
    const last = parts[parts.length - 1].split(':')[0].trim()
    if (parts.length > 1 && (last === 'jsonify' || last === 'secret')) continue
    if (parts.length === 1 && /^secrets(\.[\w-]+|\[\s*(['"])[\w.-]+\2\s*\])$/.test(expr)) continue
    out.push(expr)
  }
  return out
}

async function renderCode(
  body: string,
  scope: Record<string, unknown>,
  opts: RenderOpts
): Promise<RenderResult> {
  const problems: Problem[] = []
  const tokens = makeSecretTokens()
  const names = new Set([...(opts.secretNames ?? []), ...scanSecretNames(body)])
  const secrets: Record<string, string> = {}
  for (const n of names) secrets[n] = tokens.token(n)
  const used: string[] = []
  ensureSecretFilter()
  const renderScope = {
    ...(neutralizeSecretMarkers(isObj(scope) ? scope : {}) as Record<string, unknown>),
    secrets,
    [TOKEN_VAR]: { token: tokens.token },
    [USED_VAR]: used
  }
  for (const expr of unjsonifiedOutputs(body)) {
    problems.push({
      field_id: '',
      path: '',
      message: `Output '${expr}' is not passed through | jsonify — record text with quotes can break the payload`,
      severity: 'warning',
      code: 'unjsonified',
      params: { expr }
    })
  }
  let text: string
  try {
    text = String(await payloadLiquid().parseAndRender(body, renderScope))
  } catch (e) {
    problems.push(err('', '', `Liquid error: ${errMsg(e)}`, 'liquid_error', { detail: errMsg(e) }))
    return { body: null, problems, values: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    problems.push(err('', '', `Invalid JSON: ${errMsg(e)}`, 'invalid_json', { detail: errMsg(e) }))
    return { body: null, problems, values: {} }
  }
  if (!isObj(parsed)) {
    problems.push(err('', '', 'The template must render a JSON object', 'not_object'))
    return { body: null, problems, values: {} }
  }
  for (const k of new Set(duplicateKeys(text))) {
    problems.push(
      err(
        '',
        k,
        `Duplicate key '${k}' in rendered JSON (a record value may contain unescaped quotes — use | jsonify)`,
        'duplicate_output_key',
        { key: k }
      )
    )
  }
  const value = tokens.finish(parsed)
  const landed = tokens.used()
  const asked = new Set([...used, ...landed, ...scanSecretNames(body)])
  for (const n of asked) {
    if (!SECRET_NAME_RE.test(n)) {
      problems.push(
        err(
          '',
          '',
          `Secret name '${n}': Secret names use letters, digits, - and _`,
          'secret_bad_name',
          {
            name: n
          }
        )
      )
    }
  }
  if (opts.secretNames) {
    const have = new Set(opts.secretNames)
    for (const n of asked) {
      if (SECRET_NAME_RE.test(n) && !have.has(n))
        problems.push(
          err('', '', `This API has no \`${n}\` secret yet`, 'secret_unknown', { name: n })
        )
    }
  }
  return { body: value as Record<string, unknown>, problems, values: {} }
}

// ─── Checks ──────────────────────────────────────────────────────────────────

function getPath(body: Record<string, unknown>, path: string): unknown {
  let cur: unknown = body
  for (const seg of path.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === ''

type RuleFailure = { message: string; code: ProblemCode; params: NonNullable<Problem['params']> }

/** A value cut short for problem params. */
const brief = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

/** Rule failures for one present value. `required` is checked by the caller. */
function ruleFailures(path: string, value: unknown, r: Rules): RuleFailure[] {
  const out: RuleFailure[] = []
  if (empty(value)) return out
  const s = typeof value === 'string' ? value : String(value)
  if (r.max_length !== undefined && s.length > r.max_length) {
    out.push({
      message: `${path} is ${s.length} characters; the most allowed is ${r.max_length}`,
      code: 'rule_max_length',
      params: { length: s.length, max: r.max_length }
    })
  }
  if (r.allowed && !r.allowed.includes(s)) {
    out.push({
      message: `${path} is "${s}"; allowed values are ${r.allowed.join(', ')}`,
      code: 'rule_allowed',
      params: { got: brief(s), allowed: r.allowed.slice(0, 20) }
    })
  }
  if (r.pattern !== undefined) {
    try {
      if (r.pattern.length > 200) throw new Error('Pattern is too long')
      if (!new RegExp(r.pattern).test(s.slice(0, 10_000)))
        out.push({
          message: `${path} "${s}" does not match ${r.pattern}`,
          code: 'rule_pattern',
          params: { got: brief(s), pattern: r.pattern }
        })
    } catch {
      out.push({
        message:
          r.pattern.length > 200
            ? `${path}: Pattern is too long (200 characters at most)`
            : `${path} has a rule pattern that is not a valid expression: ${r.pattern}`,
        code: 'rule_pattern_invalid',
        params: { pattern: brief(r.pattern) }
      })
    }
  }
  if (r.min !== undefined || r.max !== undefined) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isNaN(n))
      out.push({
        message: `${path} is not a number`,
        code: 'rule_not_number',
        params: { got: brief(s) }
      })
    else {
      if (r.min !== undefined && n < r.min)
        out.push({
          message: `${path} is ${n}; the minimum is ${r.min}`,
          code: 'rule_min',
          params: { got: n, min: r.min }
        })
      if (r.max !== undefined && n > r.max)
        out.push({
          message: `${path} is ${n}; the maximum is ${r.max}`,
          code: 'rule_max',
          params: { got: n, max: r.max }
        })
    }
  }
  return out
}

/** Map mode: walk the spec beside the output. `required` is the evaluator's already. */
function checkMapRules(fields: Field[], node: unknown, prefix: string, out: Problem[]): void {
  if (!isObj(node)) return
  for (const field of fields) {
    if (!(field.key in node)) continue
    const path = prefix ? `${prefix}.${field.key}` : field.key
    const value = node[field.key]
    if ((field.type === 'object' || field.type === 'list') && field.rules) {
      out.push({
        field_id: field.id,
        path,
        message: 'Rules on a group or list are ignored',
        severity: 'warning',
        code: 'rules_ignored'
      })
    }
    if (field.type === 'object' && field.children) {
      checkMapRules(field.children, value, path, out)
    } else if (field.type === 'list' && field.children && Array.isArray(value)) {
      value.forEach((item, i) => {
        if (field.list?.scalar) {
          const child = field.children?.[0]
          if (child?.rules) {
            for (const m of ruleFailures(`${path}[${i}]`, item, child.rules)) {
              out.push(err(child.id, `${path}[${i}]`, m.message, m.code, m.params))
            }
          }
        } else checkMapRules(field.children ?? [], item, `${path}[${i}]`, out)
      })
    } else if (field.rules) {
      for (const m of ruleFailures(path, value, field.rules))
        out.push(err(field.id, path, m.message, m.code, m.params))
    }
  }
}

function findFieldId(fields: Field[], path: string): string {
  let cur = fields
  let id = ''
  for (const seg of path.split('.')) {
    const hit = cur.find((x) => x.key === seg)
    if (!hit) return ''
    id = hit.id
    cur = hit.children ?? []
  }
  return id
}

/** Map mode: locked = the spec still has a field at the path; the output may omit it (not_empty). */
function checkLockedSpec(fields: Field[], locked: string[] | undefined, out: Problem[]): void {
  for (const key of locked ?? []) {
    if (!findFieldId(fields, key)) {
      out.push(
        err('', key, `Locked key \`${key}\` is missing from the field map`, 'locked_missing', {
          key
        })
      )
    }
  }
}

/** Code mode: a locked key absent from the output is a warning (no field map to protect). */
function checkLockedOutput(
  body: Record<string, unknown>,
  locked: string[] | undefined,
  out: Problem[]
): void {
  for (const key of locked ?? []) {
    if (getPath(body, key) === undefined) {
      out.push({
        field_id: '',
        path: key,
        message: `Locked key \`${key}\` is missing from the output`,
        severity: 'warning',
        code: 'locked_missing_output',
        params: { key }
      })
    }
  }
}

function checkCodeRules(
  body: Record<string, unknown>,
  rules: Record<string, Rules> | undefined,
  out: Problem[]
): void {
  for (const [path, r] of Object.entries(rules ?? {})) {
    const value = getPath(body, path)
    if (r.required && empty(value)) out.push(err('', path, `${path} is required`, 'rule_required'))
    else
      for (const m of ruleFailures(path, value, r))
        out.push(err('', path, m.message, m.code, m.params))
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function renderBody(
  mode: 'map' | 'code',
  body: string,
  scope: Record<string, unknown>,
  opts: RenderOpts = {}
): Promise<RenderResult> {
  if (mode === 'code') {
    const r = await renderCode(body, scope, opts)
    if (r.body) {
      checkLockedOutput(r.body, opts.lockedKeys, r.problems)
      checkCodeRules(r.body, opts.rules, r.problems)
    }
    return r
  }
  let spec: MapSpec
  try {
    spec = JSON.parse(body) as MapSpec
  } catch (e) {
    return {
      body: null,
      problems: [
        err('', '', `Invalid field map JSON: ${errMsg(e)}`, 'invalid_spec', { detail: errMsg(e) })
      ],
      values: {}
    }
  }
  const r = await evaluateMap(spec, scope, { secretNames: opts.secretNames })
  const fields = Array.isArray(spec?.fields) ? spec.fields : []
  checkLockedSpec(fields, opts.lockedKeys, r.problems)
  checkMapRules(fields, r.body, '', r.problems)
  return r
}

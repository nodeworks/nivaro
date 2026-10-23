import { randomBytes } from 'node:crypto'
import { payloadLiquid } from '../payload-filters.js'
import { evaluateMap, neutralizeSecretMarkers, SECRET_PLACEHOLDER } from './evaluate.js'
import type { Field, MapSpec, Problem } from './types.js'

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
const err = (fieldId: string, path: string, message: string): Problem => ({
  field_id: fieldId,
  path,
  message,
  severity: 'error'
})

/** The problems that stop a send. */
export function blockingProblems(problems: Problem[]): Problem[] {
  return problems.filter((p) => p.severity === 'error')
}

// ─── Code mode: secrets ──────────────────────────────────────────────────────
// `secrets.<name>` and `'<name>' | secret` emit a per-render nonce token, never
// the real placeholder. After JSON.parse the nonce tokens become placeholders
// and every other string is neutralized, so record text cannot forge one.

const NONCE_VAR = '__secret_nonce'
const USED_VAR = '__secret_used'
const NAME_RE = /^[A-Za-z0-9_.-]+$/
const nonceToken = (nonce: string, name: string): string => `⟦nvr-nonce:${nonce}:${name}⟧`

let filterRegistered = false
function ensureSecretFilter(): void {
  if (filterRegistered) return
  filterRegistered = true
  payloadLiquid().registerFilter('secret', function (this: any, v: unknown) {
    const name = String(v ?? '')
    const nonce = this?.context?.getSync?.([NONCE_VAR])
    if (typeof nonce !== 'string' || !NAME_RE.test(name)) return ''
    const used = this.context.getSync([USED_VAR])
    if (Array.isArray(used)) used.push(name)
    return nonceToken(nonce, name)
  })
}

function scanSecretNames(body: string): string[] {
  const names = new Set<string>()
  for (const m of body.matchAll(/\bsecrets\.([A-Za-z0-9_-]+)/g)) names.add(m[1])
  for (const m of body.matchAll(/\bsecrets\[\s*(['"])([A-Za-z0-9_.-]+)\1\s*\]/g)) names.add(m[2])
  return [...names]
}

function resolveSecrets(node: unknown, nonce: string): { value: unknown; used: Set<string> } {
  const used = new Set<string>()
  const re = new RegExp(`⟦nvr-nonce:${nonce}:([A-Za-z0-9_.-]+)⟧`, 'g')
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const swapped = v.replace(/⟦nvr-secret:/g, '⟦nvr-secret​:')
      return swapped.replace(re, (_m, name: string) => {
        used.add(name)
        return SECRET_PLACEHOLDER(name)
      })
    }
    if (Array.isArray(v)) return v.map(walk)
    if (isObj(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v)) {
        const nk = k.replace(/⟦nvr-secret:/g, '⟦nvr-secret​:').replace(re, '')
        out[nk] = walk(v[k])
      }
      return out
    }
    return v
  }
  return { value: walk(node), used }
}

async function renderCode(
  body: string,
  scope: Record<string, unknown>,
  opts: RenderOpts
): Promise<RenderResult> {
  const problems: Problem[] = []
  const nonce = randomBytes(12).toString('hex')
  const names = new Set([...(opts.secretNames ?? []), ...scanSecretNames(body)])
  const secrets: Record<string, string> = {}
  for (const n of names) secrets[n] = nonceToken(nonce, n)
  const used: string[] = []
  ensureSecretFilter()
  const renderScope = {
    ...(neutralizeSecretMarkers(isObj(scope) ? scope : {}) as Record<string, unknown>),
    secrets,
    [NONCE_VAR]: nonce,
    [USED_VAR]: used
  }
  let text: string
  try {
    text = String(await payloadLiquid().parseAndRender(body, renderScope))
  } catch (e) {
    problems.push(err('', '', `Liquid error: ${errMsg(e)}`))
    return { body: null, problems, values: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    problems.push(err('', '', `Invalid JSON: ${errMsg(e)}`))
    return { body: null, problems, values: {} }
  }
  if (!isObj(parsed)) {
    problems.push(err('', '', 'The template must render a JSON object'))
    return { body: null, problems, values: {} }
  }
  const { value, used: tokens } = resolveSecrets(parsed, nonce)
  if (opts.secretNames) {
    const have = new Set(opts.secretNames)
    for (const n of new Set([...used, ...tokens, ...scanSecretNames(body)])) {
      if (!have.has(n)) problems.push(err('', '', `This API has no \`${n}\` secret yet`))
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

/** Rule failures for one present value. `required` is checked by the caller. */
function ruleMessages(path: string, value: unknown, r: Rules): string[] {
  const out: string[] = []
  if (empty(value)) return out
  const s = typeof value === 'string' ? value : String(value)
  if (r.max_length !== undefined && s.length > r.max_length) {
    out.push(`${path} is ${s.length} characters; the most allowed is ${r.max_length}`)
  }
  if (r.allowed && !r.allowed.includes(s)) {
    out.push(`${path} is "${s}"; allowed values are ${r.allowed.join(', ')}`)
  }
  if (r.pattern !== undefined) {
    try {
      if (!new RegExp(r.pattern).test(s)) out.push(`${path} "${s}" does not match ${r.pattern}`)
    } catch {
      out.push(`${path} has a rule pattern that is not a valid expression: ${r.pattern}`)
    }
  }
  if (r.min !== undefined || r.max !== undefined) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isNaN(n)) out.push(`${path} is not a number`)
    else {
      if (r.min !== undefined && n < r.min) out.push(`${path} is ${n}; the minimum is ${r.min}`)
      if (r.max !== undefined && n > r.max) out.push(`${path} is ${n}; the maximum is ${r.max}`)
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
    if (field.type === 'object' && field.children) {
      checkMapRules(field.children, value, path, out)
    } else if (field.type === 'list' && field.children && Array.isArray(value)) {
      value.forEach((item, i) => {
        if (field.list?.scalar) {
          const child = field.children?.[0]
          if (child?.rules) {
            for (const m of ruleMessages(`${path}[${i}]`, item, child.rules)) {
              out.push(err(child.id, `${path}[${i}]`, m))
            }
          }
        } else checkMapRules(field.children ?? [], item, `${path}[${i}]`, out)
      })
    } else if (field.rules) {
      for (const m of ruleMessages(path, value, field.rules)) out.push(err(field.id, path, m))
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

function checkLocked(
  body: Record<string, unknown>,
  locked: string[] | undefined,
  fields: Field[] | null,
  out: Problem[]
): void {
  for (const key of locked ?? []) {
    if (getPath(body, key) === undefined) {
      out.push(
        err(fields ? findFieldId(fields, key) : '', key, `Required key \`${key}\` is missing`)
      )
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
    if (r.required && empty(value)) out.push(err('', path, `${path} is required`))
    else for (const m of ruleMessages(path, value, r)) out.push(err('', path, m))
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
      checkLocked(r.body, opts.lockedKeys, null, r.problems)
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
      problems: [err('', '', `Invalid field map JSON: ${errMsg(e)}`)],
      values: {}
    }
  }
  const r = await evaluateMap(spec, scope, { secretNames: opts.secretNames })
  const fields = Array.isArray(spec?.fields) ? spec.fields : []
  checkLocked(r.body, opts.lockedKeys, fields, r.problems)
  checkMapRules(fields, r.body, '', r.problems)
  return r
}

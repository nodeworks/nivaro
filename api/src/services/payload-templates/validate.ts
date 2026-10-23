import type { MapSpec } from './types.js'

// Schema check for a stored field map (types.ts). The draft route refuses a
// save that fails it; the evaluator still tolerates anything (problems, never
// throws), so this only guards what gets stored.

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ─── Schema check (draft saves) ──────────────────────────────────────────────

const TYPES = new Set(['text', 'number', 'boolean', 'date', 'object', 'list', 'json'])
const BUILTINS = new Set([
  'today',
  'now',
  'acting_user.email',
  'acting_user.name',
  'acting_user.employee_id',
  'list.number',
  'state.label',
  'state.external_label'
])
const TRANSFORM_PARAMS: Record<string, Array<[string, 'number' | 'string']>> = {
  trim: [],
  upper: [],
  lower: [],
  next_open_day: [],
  editor_text: [],
  truncate: [['n', 'number']],
  prefix: [['text', 'string']],
  suffix: [['text', 'string']],
  pad_start: [
    ['n', 'number'],
    ['char', 'string']
  ],
  replace: [
    ['from', 'string'],
    ['to', 'string']
  ],
  date: [['format', 'string']],
  add_days: [['n', 'number']],
  at_least_days_out: [['n', 'number']],
  join: [['sep', 'string']]
}

function checkRuleList(rules: unknown, at: string, errors: string[]): void {
  if (!Array.isArray(rules)) {
    errors.push(`${at} must be a list of rules`)
    return
  }
  rules.forEach((r, i) => {
    if (!isObj(r) || typeof r.field !== 'string' || typeof r.op !== 'string') {
      errors.push(`${at}[${i}] must be a rule { field, op, value }`)
    }
  })
}

function checkValueSpec(v: unknown, at: string, errors: string[]): void {
  if (!isObj(v)) {
    errors.push(`${at} must be an object`)
    return
  }
  switch (v.source) {
    case 'fixed':
      if (v.value !== null && !['string', 'number', 'boolean'].includes(typeof v.value)) {
        errors.push(`${at}.value must be text, a number, true/false or null`)
      }
      break
    case 'path':
      if (typeof v.path !== 'string' || !v.path.trim()) errors.push(`${at}.path must be a path`)
      break
    case 'builtin':
      if (typeof v.name !== 'string' || !BUILTINS.has(v.name)) {
        errors.push(`${at}.name: unknown built-in '${String(v.name)}'`)
      }
      break
    case 'secret':
      if (typeof v.name !== 'string' || !v.name.trim()) errors.push(`${at}.name must name a secret`)
      break
    case 'switch':
      if (!Array.isArray(v.cases)) errors.push(`${at}.cases must be a list`)
      else {
        v.cases.forEach((c, i) => {
          if (!isObj(c)) {
            errors.push(`${at}.cases[${i}] must be an object`)
            return
          }
          checkRuleList(c.when, `${at}.cases[${i}].when`, errors)
          checkValueSpec(c.value, `${at}.cases[${i}].value`, errors)
        })
      }
      if (v.else !== undefined) checkValueSpec(v.else, `${at}.else`, errors)
      break
    case 'formula':
      if (typeof v.liquid !== 'string') errors.push(`${at}.liquid must be text`)
      break
    default:
      errors.push(`${at}.source: unknown source '${String(v.source)}'`)
  }
  if (v.transforms !== undefined) {
    if (!Array.isArray(v.transforms)) errors.push(`${at}.transforms must be a list`)
    else {
      v.transforms.forEach((t, i) => {
        const tAt = `${at}.transforms[${i}]`
        if (!isObj(t) || typeof t.op !== 'string' || !(t.op in TRANSFORM_PARAMS)) {
          errors.push(`${tAt}: unknown transform '${String(isObj(t) ? t.op : t)}'`)
          return
        }
        for (const [name, kind] of TRANSFORM_PARAMS[t.op]) {
          const ok = kind === 'number' ? Number.isFinite(t[name]) : typeof t[name] === 'string'
          if (!ok) errors.push(`${tAt}.${name} must be ${kind === 'number' ? 'a number' : 'text'}`)
        }
      })
    }
  }
  if (v.fallbacks !== undefined) {
    if (!Array.isArray(v.fallbacks)) errors.push(`${at}.fallbacks must be a list`)
    else {
      for (const [i, fb] of v.fallbacks.entries())
        checkValueSpec(fb, `${at}.fallbacks[${i}]`, errors)
    }
  }
}

function checkField(f: unknown, at: string, ids: Set<string>, errors: string[]): void {
  if (!isObj(f)) {
    errors.push(`${at} must be an object`)
    return
  }
  if (typeof f.id !== 'string' || !f.id.trim()) errors.push(`${at}.id must be a non-empty string`)
  else if (ids.has(f.id)) errors.push(`${at}.id: duplicate id '${f.id}'`)
  else ids.add(f.id)
  if (typeof f.key !== 'string') errors.push(`${at}.key must be text`)
  if (typeof f.type !== 'string' || !TYPES.has(f.type)) {
    errors.push(`${at}.type: unknown type '${String(f.type)}'`)
  }
  const inc = f.include
  if (isObj(inc) && Array.isArray(inc.when)) checkRuleList(inc.when, `${at}.include.when`, errors)
  else if (inc !== 'always' && inc !== 'not_empty') {
    errors.push(`${at}.include must be always, not_empty or { when: [...] }`)
  }
  if (f.value !== undefined) checkValueSpec(f.value, `${at}.value`, errors)
  if (f.children !== undefined) {
    if (!Array.isArray(f.children)) errors.push(`${at}.children must be a list`)
    else {
      for (const [i, c] of f.children.entries()) checkField(c, `${at}.children[${i}]`, ids, errors)
    }
  }
  if (f.type === 'list') {
    const l = f.list
    if (isObj(l) && l.scalar === true) {
      const n = Array.isArray(f.children) ? f.children.length : 0
      if (n !== 1) errors.push(`${at}.children: a scalar list needs exactly one child (has ${n})`)
    }
    if (!isObj(l) || typeof l.source !== 'string' || !l.source.trim()) {
      errors.push(`${at}.list: a list needs list.source`)
    } else {
      if (l.item !== undefined && typeof l.item !== 'string')
        errors.push(`${at}.list.item must be text`)
      if (l.where !== undefined) checkRuleList(l.where, `${at}.list.where`, errors)
      if (l.sort !== undefined && typeof l.sort !== 'string')
        errors.push(`${at}.list.sort must be text`)
      if (l.number_as !== undefined && typeof l.number_as !== 'string') {
        errors.push(`${at}.list.number_as must be text`)
      }
      if (l.scalar !== undefined && l.scalar !== true) errors.push(`${at}.list.scalar must be true`)
    }
  }
  if (f.rules !== undefined) {
    const r = f.rules
    if (!isObj(r)) errors.push(`${at}.rules must be an object`)
    else {
      if (r.required !== undefined && typeof r.required !== 'boolean') {
        errors.push(`${at}.rules.required must be true or false`)
      }
      for (const k of ['max_length', 'min', 'max']) {
        if (r[k] !== undefined && !Number.isFinite(r[k]))
          errors.push(`${at}.rules.${k} must be a number`)
      }
      if (
        r.allowed !== undefined &&
        (!Array.isArray(r.allowed) || r.allowed.some((x) => typeof x !== 'string'))
      ) {
        errors.push(`${at}.rules.allowed must be a list of text`)
      }
      if (r.pattern !== undefined) {
        if (typeof r.pattern !== 'string') errors.push(`${at}.rules.pattern must be text`)
        else {
          try {
            new RegExp(r.pattern)
          } catch (err) {
            errors.push(`${at}.rules.pattern: ${errMsg(err)}`)
          }
        }
      }
    }
  }
  if (f.locked !== undefined && f.locked !== true) errors.push(`${at}.locked must be true`)
  if (f.note !== undefined && typeof f.note !== 'string') errors.push(`${at}.note must be text`)
}

/** Schema check for a stored field map (the draft route refuses on errors). */
export function validateSpec(
  spec: unknown
): { ok: true; spec: MapSpec } | { ok: false; errors: string[] } {
  if (!isObj(spec)) return { ok: false, errors: ['spec must be an object'] }
  const errors: string[] = []
  if (spec.v !== 1) errors.push('v must be 1')
  if (!Array.isArray(spec.fields)) errors.push('fields must be a list')
  else {
    const ids = new Set<string>()
    for (const [i, f] of spec.fields.entries()) checkField(f, `fields[${i}]`, ids, errors)
  }
  return errors.length ? { ok: false, errors } : { ok: true, spec: spec as unknown as MapSpec }
}

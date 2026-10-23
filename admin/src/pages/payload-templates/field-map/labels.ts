import type { BuiltinName, ConditionRule, Field, ListSpec, Transform, ValueSpec } from '../api'

// Plain-language labels for the field map. Raw paths stay in Formula and the
// Code tab; everywhere else a path reads like "Shipping location → Inventory org".

export const TYPE_LABELS: Record<Field['type'], string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  date: 'Date',
  object: 'Group',
  list: 'List',
  json: 'JSON'
}

export const TYPE_HINTS: Record<Field['type'], string> = {
  text: 'Sent as a string',
  number: 'Sent as a number — anything else is a problem',
  boolean: 'Sent as true or false',
  date: 'Sent as YYYY-MM-DD',
  object: 'A nested object of fields',
  list: 'One entry per row of related data',
  json: 'Sent exactly as the value is (a formula’s output is read as JSON)'
}

export const BUILTINS: { name: BuiltinName; label: string; hint: string; inList?: true }[] = [
  { name: 'today', label: 'Today’s date', hint: 'In the instance time zone' },
  { name: 'now', label: 'Now', hint: 'Date and time of the push' },
  { name: 'acting_user.email', label: 'Acting person’s email', hint: 'Who made the change' },
  { name: 'acting_user.name', label: 'Acting person’s name', hint: 'Who made the change' },
  {
    name: 'acting_user.employee_id',
    label: 'Acting person’s employee id',
    hint: 'Who made the change'
  },
  {
    name: 'list.number',
    label: 'Line number',
    hint: '1, 2, 3… after the list’s filter',
    inList: true
  },
  { name: 'state.label', label: 'State', hint: 'The pipeline state the record moved to' },
  {
    name: 'state.external_label',
    label: 'State (partner label)',
    hint: 'The state’s external label'
  }
]

export function builtinLabel(name: string): string {
  return BUILTINS.find((b) => b.name === name)?.label ?? name
}

function humanizeSegment(seg: string): string {
  const clean = seg.replace(/\[\d*\]/g, '').replace(/_data$/, '')
  const words = clean
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
  if (!words) return seg
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

/** `record.shipping_location.inventory_org` → "Shipping location → Inventory org". */
export function humanizePath(path: string, itemAlias?: string | null): string {
  const parts = path.split('.').filter(Boolean)
  if (!parts.length) return ''
  const head = parts[0].replace(/\[\d*\]/g, '')
  let rest = parts
  let prefix = ''
  if (head === 'record') rest = parts.slice(1)
  else if (head === 'context') {
    rest = parts.slice(1)
    prefix = ''
  } else if (itemAlias && head === itemAlias) {
    rest = parts.slice(1)
    prefix = `Each ${humanizeSegment(itemAlias).toLowerCase()}`
    if (!rest.length) return `The ${humanizeSegment(itemAlias).toLowerCase()} itself`
  }
  const words = rest.map(humanizeSegment)
  if (prefix) words.unshift(prefix)
  return words.join(' → ') || humanizeSegment(head)
}

/** "materials" → "material" — good enough for a sentence header. */
export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y')
  if (/(ss|us)$/i.test(word)) return word
  if (/s$/i.test(word)) return word.slice(0, -1)
  return word
}

export const OPS: { op: string; label: string; symbol: string; noValue?: true }[] = [
  { op: 'eq', label: 'is', symbol: '=' },
  { op: 'neq', label: 'is not', symbol: '≠' },
  { op: 'gt', label: 'is more than', symbol: '>' },
  { op: 'gte', label: 'is at least', symbol: '≥' },
  { op: 'lt', label: 'is less than', symbol: '<' },
  { op: 'lte', label: 'is at most', symbol: '≤' },
  { op: 'contains', label: 'contains', symbol: 'contains' },
  { op: 'in', label: 'is one of', symbol: 'in' },
  { op: 'nnull', label: 'has a value', symbol: 'has a value', noValue: true },
  { op: 'null', label: 'is empty', symbol: 'is empty', noValue: true }
]

export function opInfo(op: string) {
  return OPS.find((o) => o.op === op)
}

function fieldWord(field: string, itemAlias?: string | null): string {
  if (!field) return '…'
  const alias = itemAlias ? `${itemAlias}.` : ''
  const bare = alias && field.startsWith(alias) ? field.slice(alias.length) : field
  return bare.replace(/^record\./, '').replace(/_/g, ' ')
}

/** One rule as a phrase: "quantity > 0". */
export function ruleText(r: ConditionRule, itemAlias?: string | null): string {
  const info = opInfo(r.op)
  const left = fieldWord(r.field, itemAlias)
  if (!info) return `${left} ${r.op} ${r.value ?? ''}`.trim()
  if (info.noValue) return `${left} ${info.symbol}`
  return `${left} ${info.symbol} ${r.value ?? '…'}`
}

export function rulesText(rules: ConditionRule[] | undefined, itemAlias?: string | null): string {
  return (rules ?? []).map((r) => ruleText(r, itemAlias)).join(' and ')
}

export function transformLabel(t: Transform): string {
  switch (t.op) {
    case 'trim':
      return 'Trim spaces'
    case 'upper':
      return 'UPPERCASE'
    case 'lower':
      return 'lowercase'
    case 'next_open_day':
      return 'Next open day'
    case 'editor_text':
      return 'Plain text from rich text'
    case 'truncate':
      return `First ${t.n} characters`
    case 'prefix':
      return `Add “${t.text}” before`
    case 'suffix':
      return `Add “${t.text}” after`
    case 'pad_start':
      return `Pad to ${t.n} with “${t.char}”`
    case 'replace':
      return `Replace “${t.from}” with “${t.to}”`
    case 'date':
      return `Date as ${t.format}`
    case 'add_days':
      return `${t.n >= 0 ? '+' : ''}${t.n} days`
    case 'at_least_days_out':
      return `At least ${t.n} days out`
    case 'join':
      return `Join with “${t.sep}”`
  }
}

/** The transform menu, with a sensible starting parameter for each. */
export const TRANSFORM_CHOICES: { label: string; hint: string; make: () => Transform }[] = [
  { label: 'Trim spaces', hint: 'Drop spaces at both ends', make: () => ({ op: 'trim' }) },
  { label: 'UPPERCASE', hint: 'All capitals', make: () => ({ op: 'upper' }) },
  { label: 'lowercase', hint: 'All small letters', make: () => ({ op: 'lower' }) },
  { label: 'First N characters', hint: 'Cut to a length', make: () => ({ op: 'truncate', n: 30 }) },
  { label: 'Add text before', hint: 'Prefix', make: () => ({ op: 'prefix', text: '' }) },
  { label: 'Add text after', hint: 'Suffix', make: () => ({ op: 'suffix', text: '' }) },
  {
    label: 'Pad to a length',
    hint: 'e.g. 9 digits with leading zeros',
    make: () => ({ op: 'pad_start', n: 9, char: '0' })
  },
  {
    label: 'Replace text',
    hint: 'Find and replace',
    make: () => ({ op: 'replace', from: '', to: '' })
  },
  {
    label: 'Format a date',
    hint: 'e.g. yyyy-MM-dd',
    make: () => ({ op: 'date', format: 'yyyy-MM-dd' })
  },
  { label: 'Add days', hint: 'Shift a date', make: () => ({ op: 'add_days', n: 1 }) },
  {
    label: 'At least N days out',
    hint: 'Never earlier than today + N',
    make: () => ({ op: 'at_least_days_out', n: 3 })
  },
  {
    label: 'Next open day',
    hint: 'Skip weekends and blackout dates',
    make: () => ({ op: 'next_open_day' })
  },
  {
    label: 'Plain text from rich text',
    hint: 'Editor blocks to text',
    make: () => ({ op: 'editor_text' })
  },
  { label: 'Join a list', hint: 'Into one text', make: () => ({ op: 'join', sep: ', ' }) }
]

function quote(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return v === '' ? '“”' : `“${v}”`
  return String(v)
}

/** What the value chip says (no transforms/fallbacks — those render as their own bits). */
export function valueSourceText(v: ValueSpec | undefined, itemAlias?: string | null): string {
  if (!v) return ''
  switch (v.source) {
    case 'fixed':
      return quote(v.value)
    case 'path':
      return v.path ? humanizePath(v.path, itemAlias) : 'Choose a field'
    case 'builtin':
      return builtinLabel(v.name)
    case 'secret':
      return v.name ? `Secret ${v.name}` : 'Choose a secret'
    case 'switch': {
      const n = v.cases?.length ?? 0
      return `If / then · ${n} ${n === 1 ? 'case' : 'cases'}`
    }
    case 'formula':
      return v.liquid?.trim() ? v.liquid.trim().replace(/\s+/g, ' ') : 'Empty formula'
  }
}

/** Is this value incomplete (nothing chosen yet)? */
export function valueIsBlank(v: ValueSpec | undefined): boolean {
  if (!v) return true
  if (v.source === 'path') return !v.path
  if (v.source === 'secret') return !v.name
  if (v.source === 'formula') return !v.liquid?.trim()
  if (v.source === 'switch') return !v.cases?.length && !v.else
  return false
}

/** Display text for a server-computed value. */
export function showValue(v: unknown): string {
  if (v === undefined) return ''
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** "One per material where quantity > 0, sorted by id, numbered from 1" as parts (bold = true). */
export function listSentence(list: ListSpec | undefined): { text: string; bold?: true }[] {
  const out: { text: string; bold?: true }[] = []
  if (!list?.source) return [{ text: 'Choose what this list comes from' }]
  const last = list.source.split('.').filter(Boolean).pop() ?? list.source
  const noun = singular(humanizeSegment(last).toLowerCase())
  out.push({ text: 'One per ' }, { text: noun, bold: true })
  if (list.where?.length)
    out.push({ text: ' where ' }, { text: rulesText(list.where, list.item), bold: true })
  if (list.sort) {
    const desc = list.sort.startsWith('-')
    out.push(
      { text: ', sorted by ' },
      { text: list.sort.replace(/^-/, '').replace(/_/g, ' '), bold: true }
    )
    if (desc) out.push({ text: ', highest first' })
  }
  out.push({ text: list.scalar ? ', as plain values' : ', numbered from 1' })
  return out
}

export function rulesSummary(rules: Field['rules']): string {
  if (!rules) return ''
  const bits: string[] = []
  if (rules.required) bits.push('Required')
  if (rules.max_length != null) bits.push(`≤ ${rules.max_length} chars`)
  if (rules.min != null && rules.max != null) bits.push(`${rules.min}–${rules.max}`)
  else if (rules.min != null) bits.push(`≥ ${rules.min}`)
  else if (rules.max != null) bits.push(`≤ ${rules.max}`)
  if (rules.allowed?.length) bits.push(`${rules.allowed.length} allowed`)
  if (rules.pattern) bits.push('Pattern')
  return bits.join(' · ')
}

export function includeSummary(inc: Field['include']): string {
  if (inc === 'always' || !inc) return 'Always sent'
  if (inc === 'not_empty') return 'Only if it has a value'
  const n = inc.when?.length ?? 0
  return n ? `Only when ${rulesText(inc.when)}` : 'Only when…'
}

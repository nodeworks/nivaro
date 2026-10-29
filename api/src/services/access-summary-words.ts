/**
 * #12 Permission summary in words — the PURE half.
 *
 * "Buyers can see and edit POs in their own Zones, can't delete, can't see
 * the Cost field." Takes facts services/access-summary.ts read through the
 * enforcement functions themselves (can(), getAllowedFields(), getRowFilter(),
 * routeScopeGates()) and phrases them. Nothing here decides access — a
 * sentence can only repeat what those functions answered.
 */
import { listPhrase } from './access-words.js'
import type { RowCondition } from './permissions.js'

/** role = "Buyers can …", third = "Beth can …" (an admin reading someone),
 *  self = "You can …" (a person reading their own access). */
export type SummaryVoice = 'role' | 'third' | 'self'

export interface SummaryScopeFact {
  /** Dimension label ("Zone"). */
  label: string
  /** Person voices: their OWN allowed values (labels). */
  values?: string[]
  /** Role voice: how many of the role's people this limits, out of `of`. */
  members?: number
  of?: number
}

export interface SummaryCollectionFacts {
  collection: string
  label: string
  /** Lower = more used; sentences are ordered by it. */
  rank: number
  read: boolean
  create: boolean
  update: boolean
  delete: boolean
  /** getAllowedFields — null = every field. */
  read_fields: string[] | null
  update_fields: string[] | null
  /** The collection's registered fields (the universe a field list narrows). */
  all_fields: string[]
  field_labels: Record<string, string>
  /** getRowFilter per action — null = no row rule. */
  row_filter: {
    read: RowCondition[] | null
    update: RowCondition[] | null
    delete: RowCondition[] | null
  }
  scopes: SummaryScopeFact[]
  /** A strict dimension that cannot reach the collection hides it entirely. */
  strict: string | null
  /** Subtree rules (nivaro_tree_permissions) exist for the role here. */
  tree_rules: boolean
}

export interface SummaryLine {
  /** Every collection the line speaks about, in rank order. */
  collections: string[]
  labels: string[]
  kind: 'full' | 'read_only' | 'limited' | 'hidden'
  sentence: string
}

export interface AccessSummaryInput {
  voice: SummaryVoice
  /** "Buyer" (role voice), "Beth" (third), ignored for self. */
  name: string
  role_name: string | null
  admin: boolean
  no_role?: boolean
  app_access: boolean
  collections: SummaryCollectionFacts[]
  /** Collections with no access at all (named only to administrators). */
  closed_count: number
  /** Disabled page paths (nivaro_roles.ui_permissions). */
  ui_disabled: string[]
  /** Role voice: people holding the role. */
  member_count?: number
  /** Self voice for a non-admin: never name a field the person cannot read. */
  conceal_hidden_fields?: boolean
}

export interface AccessSummaryWords {
  headline: string
  lines: SummaryLine[]
  ui_line: string | null
  closed_line: string | null
  sentences: string[]
  summary: string
}

// ── words ────────────────────────────────────────────────────────────────────

/** "Zone" → "Zones", "Business Unit" → "Business Units", "Entity" → "Entities". */
export function pluralLabel(label: string): string {
  const l = label.trim()
  if (!l) return l
  if (/[^aeiou]y$/i.test(l)) return `${l.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(l)) return `${l}es`
  return `${l}s`
}

/** A role name used as a subject: "Buyer" → "Buyers"; anything that does not
 *  read as a person noun → "People with the Finance role". */
export function roleSubject(roleName: string): string {
  const n = roleName.trim()
  if (!n) return 'People with this role'
  if (/(er|or|ist|ant|ent|ian|ee|ive|ager|ard|ect|ead)$/i.test(n)) return `${n}s`
  if (/(ers|ors|ists|ants|ents|ians|ees|ives|agers|ards|ects|eads)$/i.test(n)) return n
  return `People with the ${n} role`
}

interface Pron {
  subj: string
  they: string
  their: string
  them: string
  have: string
}

function pronouns(input: AccessSummaryInput): Pron {
  if (input.voice === 'self')
    return { subj: 'You', they: 'you', their: 'your', them: 'you', have: 'have' }
  if (input.voice === 'third')
    return { subj: input.name, they: 'they', their: 'their', them: 'them', have: 'has' }
  return {
    subj: roleSubject(input.role_name ?? input.name),
    they: 'they',
    their: 'their',
    them: 'them',
    have: 'have'
  }
}

const human = (f: string) => f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function labelOf(field: string, labels: Record<string, string>): string {
  const hit = labels[field]?.trim()
  return hit || human(field.split('.')[0])
}

const CREATOR_FIELDS = new Set(['user_created', 'created_by', 'creator', 'owner_created'])

function valueWords(v: unknown, p: Pron): string {
  if (v === '$CURRENT_USER') return p.them
  if (v === '$CURRENT_ROLE') return `${p.their} role`
  if (v === true || v === 'true') return 'yes'
  if (v === false || v === 'false') return 'no'
  if (v == null || v === '') return 'empty'
  return String(v)
}

/** One row-rule condition in words: "Status is Approved". */
export function conditionWords(
  c: RowCondition,
  labels: Record<string, string>,
  p: Pron = { subj: 'They', they: 'they', their: 'their', them: 'them', have: 'have' }
): string {
  const f = labelOf(c.field, labels)
  const v = valueWords(c.value, p)
  switch (c.op) {
    case 'eq':
      return `${f} is ${v}`
    case 'neq':
      return `${f} is not ${v}`
    case 'gt':
      return `${f} is over ${v}`
    case 'gte':
      return `${f} is at least ${v}`
    case 'lt':
      return `${f} is under ${v}`
    case 'lte':
      return `${f} is at most ${v}`
    case 'contains':
      return `${f} contains "${v}"`
    case 'in': {
      const list = Array.isArray(c.value)
        ? c.value
        : String(c.value ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
      return `${f} is ${listPhrase(
        list.map((x) => valueWords(x, p)),
        'or',
        5
      )}`
    }
    case 'null':
      return `${f} is empty`
    case 'nnull':
      return `${f} is filled in`
    default:
      return `${f} matches a rule`
  }
}

/** A whole row rule: "only ones they created", "only where Status is Approved". */
export function rowFilterWords(
  conds: RowCondition[],
  labels: Record<string, string>,
  p: Pron
): string {
  const created = conds.find(
    (c) => c.op === 'eq' && c.value === '$CURRENT_USER' && CREATOR_FIELDS.has(c.field)
  )
  const rest = conds.filter((c) => c !== created).map((c) => conditionWords(c, labels, p))
  if (created)
    return rest.length
      ? `only ones ${p.they} created where ${listPhrase(rest)}`
      : `only ones ${p.they} created`
  return `only where ${listPhrase(rest)}`
}

const sameConds = (a: RowCondition[] | null, b: RowCondition[] | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function fieldsReadable(conds: RowCondition[], f: SummaryCollectionFacts): boolean {
  return conds.every((c) => f.read_fields === null || f.read_fields.includes(c.field))
}

interface Parts {
  kind: SummaryLine['kind']
  /** Everything but the collection names — equal parts share one line. */
  key: string
  render: (labels: string) => string
}

function partsFor(f: SummaryCollectionFacts, input: AccessSummaryInput, p: Pron): Parts {
  const conceal = !!input.conceal_hidden_fields
  if (f.strict && f.read) {
    const s = (labels: string) =>
      `${p.subj} can't see any ${labels}: the ${f.strict} filter is strict and these records have no ${f.strict} link.`
    return { kind: 'hidden', key: `strict:${f.strict}`, render: s }
  }

  const scopeText = f.scopes.map((s) => {
    const own = `in ${p.their} own ${pluralLabel(s.label)}`
    if (input.voice === 'role') {
      if (s.members != null && s.of != null && s.members < s.of)
        return `${own} (for ${s.members} of ${s.of} people)`
      return own
    }
    const vals = listPhrase(s.values ?? [], 'or', 5)
    return vals ? `${own} (${vals})` : own
  })

  const rule = (conds: RowCondition[] | null): string | null => {
    if (!conds?.length) return null
    if (conceal && !fieldsReadable(conds, f)) return `only ones a rule on ${p.their} role allows`
    return rowFilterWords(conds, f.field_labels, p)
  }
  const readRule = f.read ? rule(f.row_filter.read) : null
  const editRule =
    f.update && !sameConds(f.row_filter.update, f.read ? f.row_filter.read : null)
      ? rule(f.row_filter.update)
      : null
  const deleteRule =
    f.delete && !sameConds(f.row_filter.delete, f.read ? f.row_filter.read : null)
      ? rule(f.row_filter.delete)
      : null

  // Field lists: what the role's list leaves out of the registered fields.
  const universe = f.all_fields.filter((x) => x !== 'id')
  const hiddenRead =
    f.read && f.read_fields !== null ? universe.filter((x) => !f.read_fields!.includes(x)) : []
  const shownRead =
    f.read && f.read_fields !== null ? universe.filter((x) => f.read_fields!.includes(x)) : []
  const lbl = (xs: string[]) => xs.map((x) => labelOf(x, f.field_labels))
  let readFields: string | null = null
  if (f.read && f.read_fields !== null) {
    if (universe.length === 0)
      readFields = f.read_fields.length ? null : `can't see any of their fields`
    else if (hiddenRead.length > 0) {
      if (conceal) readFields = `some fields are hidden from ${p.them}`
      else if (shownRead.length <= 3 && hiddenRead.length > shownRead.length * 2)
        readFields = shownRead.length
          ? `can see only the ${listPhrase(lbl(shownRead), 'and', 3)} ${shownRead.length === 1 ? 'field' : 'fields'}`
          : `can't see any of their fields`
      else
        readFields = `can't see the ${listPhrase(lbl(hiddenRead), 'and', 5)} ${hiddenRead.length === 1 ? 'field' : 'fields'}`
    }
  }
  let editFields: string | null = null
  if (f.update && f.update_fields !== null && universe.length > 0) {
    const readable = universe.filter((x) => !hiddenRead.includes(x))
    const noEdit = readable.filter((x) => !f.update_fields!.includes(x))
    const yesEdit = readable.filter((x) => f.update_fields!.includes(x))
    if (noEdit.length > 0)
      editFields =
        yesEdit.length === 0
          ? `can't change any field`
          : yesEdit.length <= 3 && noEdit.length > yesEdit.length * 2
            ? `can edit only the ${listPhrase(lbl(yesEdit), 'and', 3)} ${yesEdit.length === 1 ? 'field' : 'fields'}`
            : `can't edit the ${listPhrase(lbl(noEdit), 'and', 5)} ${noEdit.length === 1 ? 'field' : 'fields'}`
  }

  const can: string[] = []
  if (f.read) can.push('see')
  if (f.create) can.push('add')
  if (f.update) can.push('edit')
  if (f.delete) can.push('delete')
  const cannot = (['add', 'edit', 'delete'] as const).filter((v) => !can.includes(v))

  const limited =
    !!readRule ||
    !!editRule ||
    !!deleteRule ||
    !!readFields ||
    !!editFields ||
    scopeText.length > 0 ||
    f.tree_rules
  const key = JSON.stringify([
    can,
    readRule,
    editRule,
    deleteRule,
    readFields,
    editFields,
    scopeText,
    f.tree_rules
  ])

  if (!limited && can.length === 4)
    return {
      kind: 'full',
      key: 'full',
      render: (labels) => `${p.subj} ${p.have} full access to ${labels}: see, add, edit and delete.`
    }
  if (!limited && can.length === 1 && f.read)
    return {
      kind: 'read_only',
      key: 'read_only',
      render: (labels) => `${p.subj} can only see ${labels}, not change them.`
    }

  const render = (labels: string) => {
    const clauses: string[] = []
    let head: string
    if (f.read) {
      head = `${p.subj} can ${listPhrase(can)} ${labels}`
      if (readRule) head += `, ${readRule}`
      if (scopeText.length) head += ` ${listPhrase(scopeText)}`
    } else {
      head = `${p.subj} can ${listPhrase(can)} ${labels} but can't see them`
    }
    if (f.read && cannot.length) clauses.push(`can't ${listPhrase([...cannot], 'or')}`)
    if (editRule) clauses.push(`edits ${editRule}`)
    if (deleteRule) clauses.push(`deletes ${deleteRule}`)
    if (readFields) clauses.push(readFields)
    if (editFields) clauses.push(editFields)
    if (f.tree_rules) clauses.push('some branches are closed by subtree rules')
    return `${[head, ...clauses].join(', ')}.`
  }
  return { kind: 'limited', key, render }
}

function humanPath(path: string): string {
  const segs = path.split(/[/?#]/).filter(Boolean)
  if (!segs.length) return 'Home'
  return segs
    .map((s, i) => {
      const w = s.replace(/[-_]/g, ' ')
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

export function buildAccessSummary(input: AccessSummaryInput): AccessSummaryWords {
  const p = pronouns(input)
  const noun = input.voice === 'role' ? 'Everyone with this role' : p.subj
  const roleName = input.role_name ? `the ${input.role_name} role` : 'a role'

  if (input.admin) {
    const headline =
      input.voice === 'role'
        ? `${input.role_name ?? 'This role'} is an administrator role: ${noun.toLowerCase()} can see and change every record, every page is open, and no row rules, field limits or scopes apply.`
        : `${p.subj} ${p.have} an administrator role — ${p.they} can see and change every record, and every page is open.`
    return {
      headline,
      lines: [],
      ui_line: null,
      closed_line: null,
      sentences: [],
      summary: headline
    }
  }
  if (input.no_role) {
    const headline = `${p.subj} ${p.have} no role, so ${p.they} can't see any records.`
    return {
      headline,
      lines: [],
      ui_line: null,
      closed_line: null,
      sentences: [],
      summary: headline
    }
  }

  const groups = new Map<string, { parts: Parts; facts: SummaryCollectionFacts[] }>()
  const ordered = [...input.collections].sort(
    (a, z) => a.rank - z.rank || a.label.localeCompare(z.label)
  )
  for (const f of ordered) {
    if (!f.read && !f.create && !f.update && !f.delete) continue
    const parts = partsFor(f, input, p)
    const g = groups.get(parts.key)
    if (g) g.facts.push(f)
    else groups.set(parts.key, { parts, facts: [f] })
  }
  const lines: SummaryLine[] = [...groups.values()].map(({ parts, facts }) => {
    const labels = facts.map((f) => f.label)
    return {
      collections: facts.map((f) => f.collection),
      labels,
      kind: parts.kind,
      sentence: parts.render(listPhrase(labels, 'and', 8))
    }
  })

  const uiLine = input.ui_disabled.length
    ? `Pages turned off${input.voice === 'self' ? ' for you' : ''}: ${listPhrase(
        input.ui_disabled.map(humanPath),
        'and',
        8
      )}.`
    : null
  const closedLine =
    input.closed_count > 0
      ? input.voice === 'self'
        ? 'Everything else is closed to you.'
        : `${p.subj} can't open the other ${input.closed_count.toLocaleString('en-US')} ${
            input.closed_count === 1 ? 'collection' : 'collections'
          }.`
      : null
  const appLine = input.app_access
    ? null
    : input.voice === 'role'
      ? `${noun} can't sign in to the app (the role has no app access).`
      : `${p.subj} can't sign in to the app (${p.their} role has no app access).`

  const headline =
    input.voice === 'role'
      ? lines.length
        ? `What ${input.role_name ?? 'this role'} can do${
            input.member_count != null
              ? ` (${input.member_count} ${input.member_count === 1 ? 'person' : 'people'})`
              : ''
          }:`
        : `${input.role_name ?? 'This role'} can't open any collection.`
      : lines.length
        ? `${p.subj} ${p.have} ${roleName}.`
        : `${p.subj} ${p.have} ${roleName}, which can't open any collection.`

  const sentences = [
    ...lines.map((l) => l.sentence),
    ...(closedLine && lines.length ? [closedLine] : []),
    ...(uiLine ? [uiLine] : []),
    ...(appLine ? [appLine] : [])
  ]
  return {
    headline,
    lines,
    ui_line: uiLine,
    closed_line: closedLine,
    sentences,
    summary: [headline, ...sentences.slice(0, 3)].join(' ')
  }
}

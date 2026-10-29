import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can } from './permissions.js'

/**
 * Schema change proposals (#3209): a connected assistant (the MCP `propose_schema_change` tool)
 * or any signed-in API caller drafts a field or collection change — add a field, change a
 * field's label, note, choices or required flag, add a collection with its fields — and it
 * waits for an administrator. NOTHING changes here: an administrator reads the proposal in
 * plain words on the Data Model page and applies it (the same Data Model routes a person uses,
 * re-entered in-process as that administrator — routes/schema-proposals.ts) or rejects it.
 *
 * Stored as rows of nivaro_ai_proposals with action_type 'schema_change' (no table of its own,
 * the layout-proposal precedent): payload {changes, note, via, client}, preview {sentences}.
 * executeProposal (services/ai-actions.ts) refuses this type — only an administrator applies it.
 *
 * Out of scope on purpose: renames, type changes, drops and relations. A proposal can only add
 * or relabel; anything destructive stays a person's job in the Data Model.
 */

export const SCHEMA_PROPOSAL_TYPE = 'schema_change'
export const MAX_CHANGES = 50
export const MAX_NEW_FIELDS = 50
export const MAX_CHOICES = 200
/** Unresolved proposals older than this are shown as expired and cannot be applied. */
export const SCHEMA_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Open proposals one person may have waiting at once. */
export const MAX_OPEN_PER_PERSON = 20

export const FIELD_TYPES = [
  'string',
  'text',
  'integer',
  'bigInteger',
  'boolean',
  'decimal',
  'float',
  'date',
  'datetime',
  'uuid'
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_FIELDS = new Set(['id'])
const CHOICE_TYPES = new Set<FieldType>(['string', 'integer', 'bigInteger'])

export interface Choice {
  value: string | number
  text: string
}

export interface FieldSpec {
  field: string
  type: FieldType
  label?: string
  note?: string
  choices?: Choice[]
  required?: boolean
  max_length?: number
}

export type SchemaChange =
  | ({ kind: 'add_field'; collection: string } & FieldSpec)
  | {
      kind: 'update_field'
      collection: string
      field: string
      label?: string
      note?: string
      choices?: Choice[]
      required?: boolean
    }
  | {
      kind: 'add_collection'
      collection: string
      display_name?: string
      singular?: string
      plural?: string
      icon?: string
      note?: string
      fields: FieldSpec[]
    }

export class SchemaProposalError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public change_index?: number
  ) {
    super(message)
  }
}

type Obj = Record<string, unknown>

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = [...v]
    .filter((c) => {
      const code = c.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? s.slice(0, max) : undefined
}

const tableName = (v: unknown, where: string): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || s.length > 64 || !NAME_RE.test(s))
    throw new SchemaProposalError(
      `${where}: a collection name is letters, digits and underscores, starting with a letter (at most 64)`
    )
  if (/^(nivaro_|directus_)/i.test(s))
    throw new SchemaProposalError(`${where}: system collections cannot be changed by a proposal`)
  return s
}

const fieldName = (v: unknown, where: string): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || s.length > 64 || !NAME_RE.test(s))
    throw new SchemaProposalError(
      `${where}: a field name is letters, digits and underscores, starting with a letter (at most 64)`
    )
  if (RESERVED_FIELDS.has(s.toLowerCase()))
    throw new SchemaProposalError(`${where}: “${s}” is reserved`)
  return s
}

function choicesOf(v: unknown, where: string): Choice[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new SchemaProposalError(`${where}: choices must be a list`)
  if (v.length > MAX_CHOICES)
    throw new SchemaProposalError(`${where}: at most ${MAX_CHOICES} choices`)
  const out: Choice[] = []
  const seen = new Set<string>()
  for (const c of v) {
    const o: Obj =
      c && typeof c === 'object' ? (c as Obj) : { value: c as unknown, text: String(c ?? '') }
    const raw = o.value ?? o.text
    const value =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : text(raw == null ? '' : String(raw), 255)
    if (value === undefined || value === '')
      throw new SchemaProposalError(`${where}: every choice needs a value`)
    const key = String(value).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ value, text: text(o.text, 255) ?? String(value) })
  }
  return out
}

function fieldSpecOf(v: unknown, where: string): FieldSpec {
  const o = (v && typeof v === 'object' ? v : {}) as Obj
  const field = fieldName(o.field, where)
  const type = (typeof o.type === 'string' ? o.type : 'string') as FieldType
  if (!FIELD_TYPES.includes(type))
    throw new SchemaProposalError(`${where}: type must be one of ${FIELD_TYPES.join(', ')}`)
  const choices = choicesOf(o.choices, where)
  if (choices?.length && !CHOICE_TYPES.has(type))
    throw new SchemaProposalError(`${where}: choices need a string or integer field`)
  if (
    choices?.length &&
    type !== 'string' &&
    choices.some((c) => !Number.isInteger(Number(c.value)))
  )
    throw new SchemaProposalError(`${where}: an integer field's choices must be whole numbers`)
  const spec: FieldSpec = { field, type }
  const label = text(o.label, 120)
  if (label) spec.label = label
  const note = text(o.note, 500)
  if (note) spec.note = note
  if (choices?.length) spec.choices = choices
  if (typeof o.required === 'boolean') spec.required = o.required
  if (type === 'string' && o.max_length !== undefined) {
    const n = Number(o.max_length)
    if (!Number.isInteger(n) || n < 1 || n > 4000)
      throw new SchemaProposalError(`${where}: max_length must be 1 to 4000`)
    spec.max_length = n
  }
  return spec
}

/** Normalize a caller's change list (shape, names, types, choices); throws on the first bad one. */
export function normalizeChanges(raw: unknown): SchemaChange[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new SchemaProposalError('changes must be a non-empty list')
  if (raw.length > MAX_CHANGES) throw new SchemaProposalError(`At most ${MAX_CHANGES} changes`)
  return raw.map((c, i) => {
    const where = `Change ${i + 1}`
    try {
      const o = (c && typeof c === 'object' ? c : {}) as Obj
      const kind = o.kind
      if (kind === 'add_field') {
        return { kind, collection: tableName(o.collection, where), ...fieldSpecOf(o, where) }
      }
      if (kind === 'update_field') {
        const out: SchemaChange = {
          kind,
          collection: tableName(o.collection, where),
          field: fieldName(o.field, where)
        }
        const label = text(o.label, 120)
        if (label) out.label = label
        if (o.note !== undefined) out.note = text(o.note, 500) ?? ''
        const choices = choicesOf(o.choices, where)
        if (choices) out.choices = choices
        if (typeof o.required === 'boolean') out.required = o.required
        if (!out.label && out.note === undefined && !out.choices && out.required === undefined)
          throw new SchemaProposalError(
            `${where}: say what changes (label, note, choices or required)`
          )
        return out
      }
      if (kind === 'add_collection') {
        const fields = Array.isArray(o.fields) ? o.fields : []
        if (fields.length > MAX_NEW_FIELDS)
          throw new SchemaProposalError(`${where}: at most ${MAX_NEW_FIELDS} fields`)
        const specs = fields.map((f, j) => fieldSpecOf(f, `${where}, field ${j + 1}`))
        const names = new Set<string>()
        for (const s of specs) {
          if (names.has(s.field.toLowerCase()))
            throw new SchemaProposalError(`${where}: field “${s.field}” is listed twice`)
          names.add(s.field.toLowerCase())
        }
        const out: SchemaChange = {
          kind,
          collection: tableName(o.collection, where),
          fields: specs
        }
        for (const [k, max] of [
          ['display_name', 120],
          ['singular', 120],
          ['plural', 120],
          ['icon', 60],
          ['note', 500]
        ] as const) {
          const v = text(o[k], max)
          if (v) out[k] = v
        }
        return out
      }
      throw new SchemaProposalError(
        `${where}: kind must be add_field, update_field or add_collection (renames, type changes and deletions are done by a person in the Data Model)`
      )
    } catch (err) {
      if (err instanceof SchemaProposalError) {
        err.change_index = i
        throw err
      }
      throw err
    }
  })
}

// ─── Facts: what the database has now ────────────────────────────────────────

export interface SchemaFacts {
  /** Collection (lower-cased) → its registered name + display name, or null when only a table. */
  collections: Map<string, { name: string; display: string | null; registered: boolean }>
  /** `collection.field` (lower-cased) for every registered field and every column. */
  fields: Set<string>
  /** `collection.field` (lower-cased) → its stored options + interface (registered fields). */
  meta: Map<string, { label: string | null; interface: string | null; options: string | null }>
}

/** The live facts for the collections the changes name. */
export async function loadSchemaFacts(collections: string[]): Promise<SchemaFacts> {
  const names = [...new Set(collections.map((c) => c.toLowerCase()))]
  const facts: SchemaFacts = { collections: new Map(), fields: new Set(), meta: new Map() }
  if (!names.length) return facts
  const registered = (await db('nivaro_collections')
    .whereIn('collection', names)
    .select('collection', 'display_name')) as Array<{
    collection: string
    display_name: string | null
  }>
  for (const r of registered)
    facts.collections.set(String(r.collection).toLowerCase(), {
      name: String(r.collection),
      display: r.display_name ?? null,
      registered: true
    })
  for (const n of names) {
    if (facts.collections.has(n)) continue
    if (await db.schema.hasTable(n).catch(() => false))
      facts.collections.set(n, { name: n, display: null, registered: false })
  }
  const present = [...facts.collections.values()].map((c) => c.name)
  if (!present.length) return facts
  const cols = (await db('INFORMATION_SCHEMA.COLUMNS')
    .whereIn('TABLE_NAME', present)
    .select('TABLE_NAME as t', 'COLUMN_NAME as c')
    .catch(() => [])) as Array<{ t: string; c: string }>
  for (const c of cols) facts.fields.add(`${c.t}.${c.c}`.toLowerCase())
  const meta = (await db('nivaro_fields')
    .whereIn('collection', present)
    .select('collection', 'field', 'label', 'interface', 'options')) as Array<{
    collection: string
    field: string
    label: string | null
    interface: string | null
    options: string | null
  }>
  for (const m of meta) {
    const key = `${m.collection}.${m.field}`.toLowerCase()
    facts.fields.add(key)
    facts.meta.set(key, {
      label: m.label ?? null,
      interface: m.interface ?? null,
      options:
        typeof m.options === 'string' ? m.options : m.options ? JSON.stringify(m.options) : null
    })
  }
  return facts
}

const changeCollections = (changes: SchemaChange[]) => changes.map((c) => c.collection)

/**
 * Judge the changes against the database as it is (pure over `facts`): a field to add must not
 * exist, a field to change must be registered, a collection to add must not exist. Collections
 * the same proposal adds count as existing for the changes after it. Throws on the first one
 * that does not hold; `visible` says which collections the proposer may name (non-admins: the
 * ones they can read — anything else reads as "not found").
 */
export function checkChanges(
  changes: SchemaChange[],
  facts: SchemaFacts,
  visible: (collection: string) => boolean = () => true
): void {
  const added = new Set<string>()
  const addedFields = new Set<string>()
  changes.forEach((c, i) => {
    const where = `Change ${i + 1}`
    const key = c.collection.toLowerCase()
    const exists = facts.collections.has(key) && visible(c.collection)
    const fail = (msg: string) => {
      throw new SchemaProposalError(`${where}: ${msg}`, 400, i)
    }
    if (c.kind === 'add_collection') {
      if (facts.collections.has(key) || added.has(key))
        fail(`${c.collection} already exists — propose add_field changes to it instead`)
      added.add(key)
      for (const f of c.fields) addedFields.add(`${key}.${f.field.toLowerCase()}`)
      return
    }
    if (!exists && !added.has(key)) fail(`collection ${c.collection} was not found`)
    const fkey = `${key}.${c.field.toLowerCase()}`
    if (c.kind === 'add_field') {
      if (facts.fields.has(fkey) || addedFields.has(fkey))
        fail(`${c.collection} already has a field ${c.field}`)
      addedFields.add(fkey)
      return
    }
    if (!facts.meta.has(fkey))
      fail(
        addedFields.has(fkey)
          ? `${c.field} is added by this proposal — put its label and choices on the add_field change`
          : `${c.collection} has no registered field ${c.field}`
      )
  })
}

// ─── Plain words ──────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function fieldWords(f: FieldSpec): string {
  const bits: string[] = [f.type]
  if (f.choices?.length) bits.push(plural(f.choices.length, 'choice'))
  if (f.required) bits.push('required')
  return `“${f.label ?? f.field}” (${f.field}, ${bits.join(', ')})`
}

/** One sentence per change, for the reviewing administrator (pure). */
export function describeChanges(changes: SchemaChange[], facts?: SchemaFacts): string[] {
  const display = (c: string) => facts?.collections.get(c.toLowerCase())?.display || c
  return changes.map((c) => {
    if (c.kind === 'add_collection') {
      const head = `Add collection “${c.display_name ?? c.collection}” (${c.collection})`
      return c.fields.length
        ? `${head} with ${plural(c.fields.length, 'field')}: ${c.fields.map(fieldWords).join('; ')}`
        : head
    }
    if (c.kind === 'add_field') return `Add field ${fieldWords(c)} to ${display(c.collection)}`
    const parts: string[] = []
    const was = facts?.meta.get(`${c.collection}.${c.field}`.toLowerCase())?.label
    if (c.label) parts.push(was ? `label “${was}” → “${c.label}”` : `label “${c.label}”`)
    if (c.note !== undefined) parts.push(c.note ? 'a new help note' : 'no help note')
    if (c.choices) parts.push(`${plural(c.choices.length, 'choice')}`)
    if (c.required !== undefined) parts.push(c.required ? 'required' : 'optional')
    return `Change ${display(c.collection)}.${c.field}: ${parts.join(', ')}`
  })
}

// ─── Store ────────────────────────────────────────────────────────────────────

export interface ProposerRef {
  user_id: string
  via: 'oauth' | 'api_key' | 'session' | 'token' | 'other'
  client: string | null
}

const parse = (v: unknown): Obj => {
  if (v && typeof v === 'object') return v as Obj
  try {
    const p = JSON.parse(String(v ?? ''))
    return p && typeof p === 'object' ? (p as Obj) : {}
  } catch {
    return {}
  }
}

/** Collections a non-admin may name: the ones they can read. */
async function visibilityFor(user: User, isAdmin: boolean, collections: string[]) {
  if (isAdmin) return () => true
  const ok = new Set<string>()
  for (const c of [...new Set(collections)])
    if (await can(user, 'read', c).catch(() => false)) ok.add(c.toLowerCase())
  return (c: string) => ok.has(c.toLowerCase())
}

export async function createSchemaProposal(opts: {
  user: User
  isAdmin: boolean
  changes: unknown
  note: unknown
  proposer: ProposerRef
}): Promise<{ id: string; sentences: string[] }> {
  const changes = normalizeChanges(opts.changes)
  const open = (await db('nivaro_ai_proposals')
    .where({ user: opts.user.id, action_type: SCHEMA_PROPOSAL_TYPE, status: 'proposed' })
    .where('created_at', '>=', new Date(Date.now() - SCHEMA_PROPOSAL_TTL_MS))
    .count({ n: '*' })
    .first()) as { n?: number | string } | undefined
  if (Number(open?.n ?? 0) >= MAX_OPEN_PER_PERSON)
    throw new SchemaProposalError(
      `You already have ${MAX_OPEN_PER_PERSON} schema proposals waiting for review. Wait for an administrator to apply or reject some first.`,
      409
    )
  const facts = await loadSchemaFacts(changeCollections(changes))
  checkChanges(
    changes,
    facts,
    await visibilityFor(opts.user, opts.isAdmin, changeCollections(changes))
  )
  const sentences = describeChanges(changes, facts)
  const id = randomUUID()
  await db('nivaro_ai_proposals').insert({
    id,
    user: opts.user.id,
    action_type: SCHEMA_PROPOSAL_TYPE,
    collection: changes[0].collection,
    payload: JSON.stringify({
      changes,
      note: text(opts.note, 500) ?? null,
      via: opts.proposer.via,
      client: opts.proposer.client
    }),
    preview: JSON.stringify({ sentences }),
    status: 'proposed',
    created_at: new Date()
  })
  return { id, sentences }
}

export interface SchemaProposalView {
  id: string
  status: 'proposed' | 'applied' | 'rejected' | 'expired'
  collections: string[]
  changes: SchemaChange[]
  sentences: string[]
  note: string | null
  proposed_by: { id: string; name: string }
  via: string
  client: string | null
  created_at: string
  resolved_at: string | null
  result: Obj | null
}

function viewOf(r: Obj, names: Map<string, string>): SchemaProposalView {
  const p = parse(r.payload)
  const preview = parse(r.preview)
  const changes = (Array.isArray(p.changes) ? p.changes : []) as SchemaChange[]
  const created = new Date(r.created_at as string)
  const stored = String(r.status)
  const status: SchemaProposalView['status'] =
    stored === 'executed'
      ? 'applied'
      : stored === 'rejected'
        ? 'rejected'
        : stored === 'expired' || Date.now() - created.getTime() > SCHEMA_PROPOSAL_TTL_MS
          ? 'expired'
          : 'proposed'
  const uid = String(r.user)
  return {
    id: String(r.id).toLowerCase(),
    status,
    collections: [...new Set(changes.map((c) => c.collection))],
    changes,
    sentences: Array.isArray(preview.sentences) ? (preview.sentences as string[]) : [],
    note: typeof p.note === 'string' ? p.note : null,
    proposed_by: { id: uid, name: names.get(uid.toLowerCase()) ?? 'Someone' },
    via: typeof p.via === 'string' ? p.via : 'other',
    client: typeof p.client === 'string' ? p.client : null,
    created_at: created.toISOString(),
    resolved_at: r.executed_at ? new Date(r.executed_at as string).toISOString() : null,
    result: r.result ? parse(r.result) : null
  }
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)]
  if (!uniq.length) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', uniq)
    .select('id', 'first_name', 'last_name', 'email')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return new Map(
    rows.map((u) => [
      String(u.id).toLowerCase(),
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ||
        (u.email ?? '').split('@')[0] ||
        'Someone'
    ])
  )
}

export async function listSchemaProposals(
  opts: { status?: 'open' | 'all'; collection?: string | null; limit?: number } = {}
): Promise<SchemaProposalView[]> {
  const q = db('nivaro_ai_proposals')
    .where({ action_type: SCHEMA_PROPOSAL_TYPE })
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 200))
    .select('id', 'user', 'payload', 'preview', 'status', 'result', 'created_at', 'executed_at')
  if (opts.status !== 'all') {
    q.where({ status: 'proposed' }).where(
      'created_at',
      '>=',
      new Date(Date.now() - SCHEMA_PROPOSAL_TTL_MS)
    )
  }
  const rows = (await q) as Obj[]
  const names = await namesOf(rows.map((r) => String(r.user)))
  const views = rows.map((r) => viewOf(r, names))
  return opts.collection
    ? views.filter((v) =>
        v.collections.some((c) => c.toLowerCase() === opts.collection?.toLowerCase())
      )
    : views
}

export async function readSchemaProposal(id: string): Promise<SchemaProposalView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const r = (await db('nivaro_ai_proposals')
    .where({ id, action_type: SCHEMA_PROPOSAL_TYPE })
    .first('id', 'user', 'payload', 'preview', 'status', 'result', 'created_at', 'executed_at')) as
    | Obj
    | undefined
  if (!r) return null
  return viewOf(r, await namesOf([String(r.user)]))
}

/** Close an open proposal (applied → executed, rejected); false when it was no longer open. */
export async function closeSchemaProposal(
  id: string,
  outcome: 'executed' | 'rejected',
  result: Obj
): Promise<boolean> {
  const n = await db('nivaro_ai_proposals')
    .where({ id, action_type: SCHEMA_PROPOSAL_TYPE, status: 'proposed' })
    .update({ status: outcome, result: JSON.stringify(result), executed_at: new Date() })
  return Number(n) > 0
}

/** Keep a partial apply's progress on the still-open proposal. */
export async function noteSchemaProposalProgress(id: string, result: Obj): Promise<void> {
  await db('nivaro_ai_proposals')
    .where({ id, action_type: SCHEMA_PROPOSAL_TYPE, status: 'proposed' })
    .update({ result: JSON.stringify(result) })
}

// ─── Apply plan (pure) ───────────────────────────────────────────────────────

export interface ApplyStep {
  change_index: number
  /** What a person reads. */
  label: string
  method: 'POST' | 'PATCH'
  path: string
  body: Obj
  /** Skip when this already holds (`collection.field` present, table present). */
  skip_if?: { table?: string; field?: string }
}

const enc = encodeURIComponent

function choiceOptions(existing: string | null, choices: Choice[]): string {
  const base = parse(existing)
  return JSON.stringify({
    ...base,
    choices: choices.map((c) => ({ text: c.text, value: c.value }))
  })
}

function fieldSteps(collection: string, f: FieldSpec, i: number): ApplyStep[] {
  const steps: ApplyStep[] = [
    {
      change_index: i,
      label: `Create column ${collection}.${f.field}`,
      method: 'POST',
      path: `/api/data-model/tables/${enc(collection)}/columns`,
      body: {
        name: f.field,
        type: f.type,
        nullable: true,
        ...(f.max_length ? { max_length: f.max_length } : {})
      },
      skip_if: { table: collection, field: f.field }
    },
    {
      change_index: i,
      label: `Register field ${collection}.${f.field}`,
      method: 'POST',
      path: `/api/data-model/tables/${enc(collection)}/fields`,
      body: {
        field: f.field,
        type: f.type,
        ...(f.choices?.length
          ? { interface: 'select-dropdown', options: choiceOptions(null, f.choices) }
          : {}),
        ...(f.required !== undefined ? { required: f.required } : {}),
        ...(f.note ? { note: f.note } : {})
      }
    }
  ]
  if (f.label)
    steps.push({
      change_index: i,
      label: `Label ${collection}.${f.field} “${f.label}”`,
      method: 'PATCH',
      path: `/api/field-config/${enc(collection)}/${enc(f.field)}`,
      body: { label: f.label }
    })
  return steps
}

/**
 * The Data Model calls that carry out the changes, in order (pure over `facts`): each one is
 * the same route a person's click makes, so its checks and logging apply.
 */
export function planApply(changes: SchemaChange[], facts: SchemaFacts): ApplyStep[] {
  const steps: ApplyStep[] = []
  changes.forEach((c, i) => {
    if (c.kind === 'add_collection') {
      steps.push({
        change_index: i,
        label: `Create table ${c.collection}`,
        method: 'POST',
        path: '/api/data-model/tables',
        body: { name: c.collection },
        skip_if: { table: c.collection }
      })
      steps.push({
        change_index: i,
        label: `Register collection ${c.collection}`,
        method: 'POST',
        path: `/api/data-model/tables/${enc(c.collection)}/register`,
        body: {
          ...(c.display_name ? { display_name: c.display_name } : {}),
          ...(c.singular ? { singular: c.singular } : {}),
          ...(c.plural ? { plural: c.plural } : {}),
          ...(c.icon ? { icon: c.icon } : {}),
          ...(c.note ? { note: c.note } : {})
        }
      })
      for (const f of c.fields) steps.push(...fieldSteps(c.collection, f, i))
      return
    }
    if (c.kind === 'add_field') {
      steps.push(...fieldSteps(c.collection, c, i))
      return
    }
    const meta = facts.meta.get(`${c.collection}.${c.field}`.toLowerCase())
    const body: Obj = {}
    if (c.label) body.label = c.label
    if (c.note !== undefined) body.note = c.note || null
    if (c.required !== undefined) body.required = c.required
    if (c.choices) {
      body.options = choiceOptions(meta?.options ?? null, c.choices)
      const iface = meta?.interface ?? ''
      if (iface !== 'select-dropdown' && iface !== 'radio-buttons')
        body.interface = 'select-dropdown'
    }
    steps.push({
      change_index: i,
      label: `Change ${c.collection}.${c.field}`,
      method: 'PATCH',
      path: `/api/field-config/${enc(c.collection)}/${enc(c.field)}`,
      body
    })
  })
  return steps
}

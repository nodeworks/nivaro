import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { safeRecordLabel } from './record-label-fallback.js'

/**
 * Search commands (search program item 19): a query that reads like an
 * instruction — `hold 372779`, `remove hold 372779`, `approve 372779`,
 * `assign 372779 to sam`, `new ir for project 1234` — comes back with
 * confirmable commands. Search NEVER runs one: every command carries the
 * request the client sends to the EXISTING route after the person confirms,
 * and that route judges it again in full.
 *
 * A command is offered only when the caller could run it now:
 * - the record is found AS THE CALLER (search hits, or readItems with the
 *   caller's readable fields);
 * - hold / remove hold: an active registry bulk action the caller's access
 *   allows (listAvailable), canUpdateItem on the record, and the action's
 *   guard passing on the record as the caller reads it;
 * - transition: assertInstanceAccess (update) + the shared manual-transition
 *   gate chain (from-state, roles, owner-only, requirements, conditions);
 *   transitions kept off list-row menus (in_row_menu = false, form-only) are
 *   not offered outside the record form;
 * - assign: the record readable, an open current step, and the add-owner rule
 *   (an administrator or an owner of the current step);
 * - create: can(create) on the collection.
 */

export type CommandKind = 'transition' | 'hold' | 'create' | 'assign'

export interface SearchCommand {
  id: string
  label: string
  kind: CommandKind
  collection?: string
  item?: string
  confirm: string
  payload: CommandPayload
}

/** What the client sends after the confirm. `path` is relative to the API
 *  root (both apps' clients prefix `/api`). */
export type CommandPayload =
  | {
      method: 'POST'
      path: string
      body: Record<string, unknown>
      /** hold: the action wants a reason (send it as body.reason). */
      require_reason?: boolean
      /** transition: comment_mode 'required' — ask for a note (body.comment). */
      needs_comment?: boolean
      /** transition: the move has data-entry requirements still open; the
       *  route answers 422 TRANSITION_REQUIREMENTS — open the record instead. */
      has_requirements?: boolean
    }
  | {
      navigate: { href: string; admin_href: string }
      prefill: Record<string, unknown> | null
    }

export type ParsedCommand =
  | { kind: 'hold'; on: boolean; ref: string }
  | { kind: 'assign'; ref: string; person: string }
  | { kind: 'create'; thing: string; forField: string | null; forValue: string | null }
  | { kind: 'transition'; verb: string; ref: string }

// A record reference holds at least one digit: 372779, CR26-76773, #4512.
const REF = String.raw`#?([A-Za-z0-9][A-Za-z0-9_\-./]*\d[A-Za-z0-9_\-./]*|\d)`
const re = (s: string) => new RegExp(`^${s}$`, 'i')

const OFF_HOLD = [
  re(
    String.raw`(?:remove|release|lift|clear|end|cancel)\s+(?:the\s+)?hold\s+(?:on\s+|from\s+|for\s+)?${REF}`
  ),
  re(String.raw`(?:unhold|un-hold)\s+${REF}`),
  re(String.raw`(?:take|put)\s+${REF}\s+off\s+(?:of\s+)?hold`),
  re(String.raw`${REF}\s+off\s+hold`)
]
const ON_HOLD = [
  re(String.raw`(?:hold|put\s+on\s+hold|place\s+on\s+hold|on\s+hold)\s+${REF}`),
  re(String.raw`(?:put|place)\s+${REF}\s+on\s+hold`),
  re(String.raw`${REF}\s+on\s+hold`)
]
const ASSIGN = re(String.raw`(?:assign|reassign|give|hand)\s+${REF}\s+to\s+(.{2,60})`)
const CREATE = re(String.raw`(?:new|create|add|start)\s+(?:an?\s+)?(.+?)(?:\s+for\s+(.+))?`)
const TRANSITION = re(String.raw`([A-Za-z][A-Za-z'&/-]*(?:\s+[A-Za-z][A-Za-z'&/-]*){0,4})\s+${REF}`)
const NOT_VERBS = new Set(['new', 'create', 'add', 'start', 'assign', 'reassign', 'give', 'hand'])

/** Read an instruction out of a search query; null = an ordinary search.
 *  Pure — exported for tests. */
export function parseCommand(q: string): ParsedCommand | null {
  const s = String(q ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (s.length < 3 || s.length > 120) return null
  for (const r of OFF_HOLD) {
    const m = r.exec(s)
    if (m) return { kind: 'hold', on: false, ref: m[1] }
  }
  for (const r of ON_HOLD) {
    const m = r.exec(s)
    if (m) return { kind: 'hold', on: true, ref: m[1] }
  }
  const a = ASSIGN.exec(s)
  if (a) return { kind: 'assign', ref: a[1], person: a[2].trim() }
  const c = CREATE.exec(s)
  if (c) {
    const thing = c[1].trim()
    // "new 372779" is not a thing to create.
    if (thing && !/^\d/.test(thing) && thing.split(' ').length <= 4) {
      const forPart = c[2]?.trim() ?? ''
      const words = forPart ? forPart.split(' ') : []
      return {
        kind: 'create',
        thing,
        forField: words.length >= 2 ? words[0] : null,
        forValue: words.length >= 2 ? words.slice(1).join(' ') : words[0] || null
      }
    }
  }
  const t = TRANSITION.exec(s)
  if (t) {
    const verb = t[1].trim()
    if (!NOT_VERBS.has(verb.split(' ')[0].toLowerCase()))
      return { kind: 'transition', verb, ref: t[2] }
  }
  return null
}

const norm = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Does a transition's button label answer the typed verb? Exact, or the
 *  label starting with the verb's words ("send back" → "Send back to planner"),
 *  never a fragment under three letters. Pure — exported for tests. */
export function labelMatchesVerb(label: string, verb: string): boolean {
  const l = norm(label)
  const v = norm(verb)
  if (!l || v.length < 3) return false
  return l === v || l.startsWith(`${v} `)
}

/** Is this bulk action a hold (on: true) or a remove-hold (on: false)?
 *  Pure — exported for tests. */
export function holdActionMatches(action: { key: string; label: string }, on: boolean): boolean {
  const text = `${norm(action.key)} ${norm(action.label)}`
  if (!/\bhold\b/.test(text)) return false
  const off = /\b(remove|release|lift|clear|off|unhold|resume|end)\b/.test(text)
  return on ? !off : off
}

/** Collection names a typed thing may mean: the key, the display name and its
 *  singular, the words with underscores as spaces. Pure — exported for tests. */
export function collectionAliases(collection: string, displayName: string | null): string[] {
  const out = new Set<string>()
  const add = (s: string | null | undefined) => {
    const n = norm(s ?? '')
    if (!n) return
    out.add(n)
    if (n.endsWith('ies')) out.add(`${n.slice(0, -3)}y`)
    else if (n.endsWith('s') && !n.endsWith('ss')) out.add(n.slice(0, -1))
  }
  add(collection.replace(/_/g, ' '))
  add(displayName)
  return [...out]
}

/** `?prefill=` as both apps decode it: base64 of the UTF-8 JSON, URI-encoded. */
export function encodePrefill(values: Record<string, unknown>): string {
  return encodeURIComponent(Buffer.from(JSON.stringify(values), 'utf8').toString('base64'))
}

// ─── Dependencies (injectable for tests) ─────────────────────────────────────

export interface Target {
  collection: string
  id: string
  label: string
}

export interface OfferedTransition {
  id: string
  label: string
  to_label: string | null
  needs_comment: boolean
  has_requirements: boolean
}

export interface CommandDeps {
  /** Every manual transition label (any template) — a cheap pre-check so an
   *  ordinary "word 123" search never goes looking for a record. */
  transitionLabels(): Promise<string[]>
  /** Records `ref` names that the caller can read (hits first). */
  findTargets(user: User, ref: string, hits: HitLike[]): Promise<Target[]>
  bulkActions(
    collection: string,
    req: FastifyRequest
  ): Promise<
    Array<{
      key: string
      label: string
      source: string
      kind: string
      require_reason: boolean
      confirm_text: string | null
      guard: Array<{ field: string; op: string; value?: unknown }> | null
    }>
  >
  canUpdate(user: User, collection: string, id: string, req: FastifyRequest): Promise<boolean>
  /** The record as the caller reads it (null = not readable). */
  readRecord(
    user: User,
    collection: string,
    id: string,
    fields: string[],
    req: FastifyRequest
  ): Promise<Record<string, unknown> | null>
  transitions(
    user: User,
    isAdmin: boolean,
    collection: string,
    id: string,
    match: (label: string) => boolean
  ): Promise<OfferedTransition[]>
  /** The current step the caller may hand off, or null. */
  ownerStep(
    user: User,
    isAdmin: boolean,
    collection: string,
    id: string
  ): Promise<{ state: string; state_label: string | null } | null>
  findPeople(text: string, isAdmin: boolean): Promise<Array<{ id: string; name: string }>>
  creatable(
    user: User,
    isAdmin: boolean,
    thing: string
  ): Promise<Array<{ collection: string; display_name: string }>>
  prefillFor(
    user: User,
    collection: string,
    fieldWord: string | null,
    value: string
  ): Promise<{ field: string; id: string; label: string } | null>
}

export type HitLike = {
  collection: string
  id: unknown
  label?: string
  snippet?: string
  display_name?: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TARGET_COLLECTIONS = 10
const MAX_COMMANDS = 5

async function findTargets(user: User, ref: string, hits: HitLike[]): Promise<Target[]> {
  const want = ref.toLowerCase()
  const fromHits = hits.filter(
    (h) =>
      String(h.id).toLowerCase() === want ||
      String(h.label ?? '').toLowerCase() === want ||
      String(h.snippet ?? '').toLowerCase() === want
  )
  if (fromHits.length > 0)
    return fromHits.slice(0, 3).map((h) => ({
      collection: h.collection,
      id: String(h.id),
      // Command labels and confirm text never show the pk (record-label-fallback.ts).
      label: safeRecordLabel(h.label, {
        collection: h.collection,
        id: h.id,
        display_name: h.display_name
      })
    }))

  // Collections that carry a pipeline or a registry action — where commands live.
  const [bound, withActions] = await Promise.all([
    db('nivaro_workflow_bindings').distinct('collection') as Promise<Array<{ collection: string }>>,
    (
      db('nivaro_bulk_actions').where({ is_active: true }).distinct('collection') as Promise<
        Array<{ collection: string | null }>
      >
    ).catch(() => [])
  ])
  const candidates = [...new Set([...bound, ...withActions].map((r) => String(r.collection ?? '')))]
    .filter((c) => IDENT.test(c) && !/^(nivaro_|directus_)/i.test(c))
    .slice(0, MAX_TARGET_COLLECTIONS)
  if (candidates.length === 0) return []
  const [fieldRows, colRows] = await Promise.all([
    db('nivaro_fields')
      .whereIn('collection', candidates)
      .select('collection', 'field', 'type') as Promise<
      Array<{ collection: string; field: string; type: string | null }>
    >,
    db('nivaro_collections')
      .whereIn('collection', candidates)
      .select('collection', 'display_template', 'display_name') as Promise<
      Array<{ collection: string; display_template: string | null; display_name: string | null }>
    >
  ])
  const { readItems } = await import('./items.js')
  const { getAllowedFields } = await import('./permissions.js')
  const { linkLabelsAsUser } = await import('./ai-link-labels.js')
  const found: Target[] = []
  await Promise.all(
    candidates.map(async (collection) => {
      try {
        const fields = fieldRows.filter((f) => f.collection === collection)
        const template = colRows.find((c) => c.collection === collection)?.display_template ?? ''
        const templ = [...template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1])
        const allowed = await getAllowedFields(user, 'read', collection).catch((): string[] => [])
        const may = (f: string) => allowed == null || allowed.includes('*') || allowed.includes(f)
        const idType = String(fields.find((f) => f.field === 'id')?.type ?? '').toLowerCase()
        const clauses: Array<Record<string, unknown>> = []
        const intId = /int|number/.test(idType)
        if (
          (intId && /^\d+$/.test(ref)) ||
          (idType === 'uuid' && UUID.test(ref)) ||
          idType === 'string'
        )
          clauses.push({ id: { _eq: intId ? Number(ref) : ref } })
        // Human ids: string fields the label shows, and string *_id business ids.
        for (const f of fields) {
          if (!['string', 'text'].includes(String(f.type)) || !IDENT.test(f.field)) continue
          if (!(templ.includes(f.field) || (f.field.endsWith('_id') && f.field !== 'id'))) continue
          if (may(f.field)) clauses.push({ [f.field]: { _eq: ref } })
        }
        if (clauses.length === 0) return
        const res = (await readItems(user, collection, {
          filter: { _or: clauses.slice(0, 6) },
          fields: ['id'],
          limit: 2,
          count: false
        })) as { data?: Array<Record<string, unknown>> }
        for (const row of res.data ?? []) found.push({ collection, id: String(row.id), label: ref })
      } catch {
        /* unreadable for the caller or a stale field — no target there */
      }
    })
  )
  if (found.length === 0) return []
  const byCollection = new Map<string, Set<string>>()
  for (const t of found) {
    const set = byCollection.get(t.collection) ?? new Set<string>()
    set.add(t.id)
    byCollection.set(t.collection, set)
  }
  const labels = await linkLabelsAsUser(user, byCollection).catch(
    () => ({}) as Record<string, string>
  )
  return found.slice(0, 3).map((t) => ({
    ...t,
    // Typed a business id: it is the label until the record's own label is known.
    // Typed the pk: never shown — the collection's name stands in.
    label: safeRecordLabel(labels[`${t.collection}:${t.id}`] ?? t.label, {
      collection: t.collection,
      id: t.id,
      display_name: colRows.find((c) => c.collection === t.collection)?.display_name
    })
  }))
}

async function offeredTransitions(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string,
  match: (label: string) => boolean
): Promise<OfferedTransition[]> {
  const { assertInstanceAccess } = await import('./instance-guard.js')
  try {
    await assertInstanceAccess(user, isAdmin, collection, id)
  } catch {
    return []
  }
  const { findRecordInstance } = await import('./branch-instances.js')
  const inst = (await findRecordInstance(collection, id)) as
    | { id: string; template: string; current_state: string | null; completed_at: Date | null }
    | undefined
  if (!inst) return []
  const rows = (await db('nivaro_workflow_transitions')
    .where({ template: inst.template })
    .orderBy('sort')
    .select('*')) as Array<Record<string, unknown>>
  const on = (v: unknown) => v === true || v === 1 || v === '1'
  const candidates = rows.filter(
    (t) =>
      match(String(t.label ?? '')) &&
      !on(t.auto_trigger) &&
      // Form-only moves (in_row_menu = 0) are not offered outside the record form.
      !(t.in_row_menu === false || t.in_row_menu === 0) &&
      (t.from_state == null || String(t.from_state) === String(inst.current_state ?? ''))
  )
  if (candidates.length === 0) return []
  const { commentMissing, manualTransitionRefusal } = await import('./manual-transition-gate.js')
  const states = (await db('nivaro_workflow_states')
    .where({ template: inst.template })
    .select('id', 'label')) as Array<{ id: string; label: string }>
  const out: OfferedTransition[] = []
  for (const t of candidates.slice(0, 3)) {
    // The comment gate is asked separately (the confirm collects the note), so
    // the chain runs with a stand-in note to judge everything else.
    const refusal = await manualTransitionRefusal({
      user,
      isAdmin,
      collection,
      item: id,
      instance: inst,
      transition: t as never,
      comment: '(search)',
      reviewed: false
    }).catch(() => ({ status: 500, body: {} as Record<string, unknown> }))
    const requirements = refusal?.status === 422 && refusal.body.error === 'TRANSITION_REQUIREMENTS'
    if (refusal && !requirements) continue
    out.push({
      id: String(t.id),
      label: String(t.label ?? ''),
      to_label:
        states.find((s) => String(s.id).toUpperCase() === String(t.to_state ?? '').toUpperCase())
          ?.label ?? null,
      needs_comment: commentMissing(t as { comment_mode?: string | null }, null),
      has_requirements: requirements
    })
  }
  return out
}

async function ownerStep(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string
): Promise<{ state: string; state_label: string | null } | null> {
  const { assertInstanceAccess } = await import('./instance-guard.js')
  try {
    await assertInstanceAccess(user, isAdmin, collection, id, undefined, 'read')
  } catch {
    return null
  }
  const { findRecordInstance } = await import('./branch-instances.js')
  const inst = (await findRecordInstance(collection, id)) as
    | { id: string; current_state: string | null; completed_at: Date | null }
    | undefined
  if (!inst?.current_state || inst.completed_at) return null
  if (!isAdmin) {
    const { checkTransitionOwner } = await import('./record-access.js')
    const owner = await checkTransitionOwner({
      user,
      isAdmin: false,
      collection,
      item: id,
      instanceId: String(inst.id)
    })
    if (!owner.allowed) return null
  }
  const state = (await db('nivaro_workflow_states')
    .where({ id: inst.current_state })
    .first('label')) as { label?: string } | undefined
  return { state: String(inst.current_state), state_label: state?.label ?? null }
}

async function findPeople(text: string, _isAdmin: boolean) {
  const { applyDirectoryListingRules } = await import('./user-directory-cols.js')
  const terms = text.split(/\s+/).filter(Boolean).slice(0, 3)
  if (terms.length === 0) return []
  // Only people can own a step: the directory rules apply to everyone here.
  const qb = db('nivaro_users').select('id', 'first_name', 'last_name', 'email').limit(3)
  applyDirectoryListingRules(qb)
  for (const t of terms) {
    const like = `%${t.replace(/[\\%_[]/g, (m) => `\\${m}`)}%`
    qb.where((w) => {
      for (const c of ['first_name', 'last_name', 'email'])
        w.orWhereRaw(`[${c}] LIKE ? ESCAPE '\\'`, [like])
    })
  }
  const rows = (await qb) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return rows.map((r) => ({
    id: String(r.id),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || String(r.email ?? r.id)
  }))
}

async function creatable(user: User, isAdmin: boolean, thing: string) {
  const want = norm(thing)
  const rows = (await db('nivaro_collections')
    .whereNot('collection', 'like', 'nivaro\\_%')
    .whereNot('collection', 'like', 'directus\\_%')
    .where((qb) => void qb.where('is_virtual', 0).orWhereNull('is_virtual'))
    .select('collection', 'display_name')) as Array<{
    collection: string
    display_name: string | null
  }>
  // Search scope prefixes (`ir` → inventory_request) name collections too —
  // the same map the query parser reads (services/search-scopes.ts).
  const { loadSearchScopes } = await import('./search-scopes.js')
  const scopes: Record<string, string> = await loadSearchScopes().catch(() => ({}))
  const scoped = Object.entries(scopes)
    .filter(([k]) => norm(k) === want)
    .map(([, c]) => c)
  const matches = rows.filter(
    (r) =>
      scoped.includes(r.collection) ||
      collectionAliases(r.collection, r.display_name).includes(want)
  )
  const { can } = await import('./permissions.js')
  const out: Array<{ collection: string; display_name: string }> = []
  for (const r of matches.slice(0, 3)) {
    if (isAdmin || (await can(user, 'create', r.collection).catch(() => false)))
      out.push({ collection: r.collection, display_name: r.display_name || r.collection })
  }
  return out
}

async function prefillFor(
  user: User,
  collection: string,
  fieldWord: string | null,
  value: string
): Promise<{ field: string; id: string; label: string } | null> {
  if (!fieldWord) return null
  const w = norm(fieldWord).replace(/ /g, '_')
  const rels = (await db('nivaro_relations')
    .where({ many_collection: collection })
    .whereNotNull('one_collection')
    .whereNull('junction_field')
    .select('many_field', 'one_collection')) as Array<{
    many_field: string
    one_collection: string
  }>
  const rel = rels.find(
    (r) =>
      IDENT.test(r.many_field) &&
      IDENT.test(r.one_collection) &&
      [
        r.many_field,
        r.many_field.replace(/_id$/, ''),
        r.one_collection,
        r.one_collection.replace(/s$/, '')
      ]
        .map((x) => x.toLowerCase())
        .includes(w)
  )
  if (!rel || /^(nivaro_|directus_)/i.test(rel.one_collection)) return null
  const { getAllowedFields } = await import('./permissions.js')
  const { readItems } = await import('./items.js')
  const fields = (await db('nivaro_fields')
    .where({ collection: rel.one_collection })
    .whereIn('type', ['string', 'text'])
    .select('field')) as Array<{ field: string }>
  const allowed = await getAllowedFields(user, 'read', rel.one_collection).catch((): string[] => [])
  const may = (f: string) => allowed == null || allowed.includes('*') || allowed.includes(f)
  const cols = fields
    .map((f) => f.field)
    .filter(
      (f) => IDENT.test(f) && may(f) && (/(^|_)(name|title|label)$/.test(f) || f.endsWith('_id'))
    )
    .slice(0, 4)
  const clauses: Array<Record<string, unknown>> = cols.map((c) => ({ [c]: { _eq: value } }))
  if (/^\d+$/.test(value)) clauses.push({ id: { _eq: Number(value) } })
  if (clauses.length === 0) return null
  try {
    const res = (await readItems(user, rel.one_collection, {
      filter: { _or: clauses },
      fields: ['id', ...cols],
      limit: 2,
      count: false
    })) as { data?: Array<Record<string, unknown>> }
    const rows = res.data ?? []
    // Exactly one: anything else is a guess the form should not make.
    if (rows.length !== 1) return null
    const label = cols.map((c) => rows[0][c]).find((v) => v != null && String(v).trim()) ?? value
    return { field: rel.many_field, id: String(rows[0].id), label: String(label) }
  } catch {
    return null
  }
}

const LABEL_TTL_MS = 60_000
const labelCache = new Map<string, { at: number; labels: string[] }>()

async function transitionLabels(): Promise<string[]> {
  const { currentTenantKey } = await import('./tenant-rooms.js')
  const key = currentTenantKey()
  const hit = labelCache.get(key)
  if (hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.labels
  const rows = (await db('nivaro_workflow_transitions')
    .where((w) => {
      w.where('auto_trigger', false).orWhereNull('auto_trigger')
    })
    .distinct('label')) as Array<{ label: string | null }>
  const labels = rows.map((r) => String(r.label ?? '')).filter(Boolean)
  labelCache.set(key, { at: Date.now(), labels })
  return labels
}

export const defaultCommandDeps: CommandDeps = {
  transitionLabels,
  findTargets,
  async bulkActions(collection, req) {
    const { listAvailable } = await import('./bulk-actions.js')
    return listAvailable(collection, req)
  },
  async canUpdate(user, collection, id, req) {
    if (req.isAdmin) return true
    const { canUpdateItem } = await import('./items.js')
    return canUpdateItem(user, collection, id, req.workspaceId ?? undefined).catch(() => false)
  },
  async readRecord(user, collection, id, fields, req) {
    const { readOne } = await import('./items.js')
    const row = await readOne(user, collection, id, req.workspaceId ?? undefined, [
      'id',
      ...fields
    ]).catch(() => null)
    return (row as Record<string, unknown> | null) ?? null
  },
  transitions: offeredTransitions,
  ownerStep,
  findPeople,
  creatable,
  prefillFor
}

// ─── The commands for one query ─────────────────────────────────────────────

/** The commands a query asks for that the caller may run now. Never throws. */
export async function searchCommands(
  user: User,
  q: string,
  hits: HitLike[],
  opts: { isAdmin: boolean; req: FastifyRequest; deps?: CommandDeps }
): Promise<SearchCommand[]> {
  const parsed = parseCommand(q)
  if (!parsed) return []
  const deps = opts.deps ?? defaultCommandDeps
  try {
    return (await commandsFor(user, parsed, hits, opts.isAdmin, opts.req, deps)).slice(
      0,
      MAX_COMMANDS
    )
  } catch {
    return []
  }
}

async function commandsFor(
  user: User,
  parsed: ParsedCommand,
  hits: HitLike[],
  isAdmin: boolean,
  req: FastifyRequest,
  deps: CommandDeps
): Promise<SearchCommand[]> {
  const out: SearchCommand[] = []

  if (parsed.kind === 'create') {
    for (const c of await deps.creatable(user, isAdmin, parsed.thing)) {
      const pre = parsed.forValue
        ? await deps
            .prefillFor(user, c.collection, parsed.forField, parsed.forValue)
            .catch(() => null)
        : null
      const prefill = pre ? { [pre.field]: pre.id } : null
      const qs = prefill ? `?prefill=${encodePrefill(prefill)}` : ''
      out.push({
        id: `create:${c.collection}${pre ? `:${pre.field}:${pre.id}` : ''}`,
        label: `New ${c.display_name}${pre ? ` for ${pre.label}` : ''}`,
        kind: 'create',
        collection: c.collection,
        confirm: `Open a new ${c.display_name} form${pre ? ` for ${pre.label}` : ''}?`,
        payload: {
          navigate: {
            href: `/records/${encodeURIComponent(c.collection)}/new${qs}`,
            admin_href: `/collections/${encodeURIComponent(c.collection)}/new${qs}`
          },
          prefill
        }
      })
    }
    return out
  }

  if (parsed.kind === 'transition') {
    const labels = await deps.transitionLabels().catch(() => [] as string[])
    if (!labels.some((l) => labelMatchesVerb(l, parsed.verb))) return out
  }
  const targets = await deps.findTargets(user, parsed.ref, hits)
  for (const t of targets) {
    const base = { collection: t.collection, item: t.id }
    const instancePath = `/pipelines/instance/${encodeURIComponent(t.collection)}/${encodeURIComponent(t.id)}`

    if (parsed.kind === 'hold') {
      const actions = (await deps.bulkActions(t.collection, req).catch(() => [])).filter(
        (a) =>
          a.source === 'db' &&
          a.kind !== 'builtin' &&
          a.kind !== 'extension' &&
          holdActionMatches(a, parsed.on)
      )
      if (actions.length === 0) continue
      if (!(await deps.canUpdate(user, t.collection, t.id, req))) continue
      for (const a of actions.slice(0, 1)) {
        if (a.guard?.length) {
          const fields = [...new Set(a.guard.map((g) => g.field).filter((f) => IDENT.test(f)))]
          const row = await deps.readRecord(user, t.collection, t.id, fields, req)
          if (!row) continue
          const { guardPasses } = await import('./action-guards.js')
          // Already on hold (or not on hold, for a remove): nothing to offer.
          if (!guardPasses(a.guard, row)) continue
        }
        out.push({
          id: `hold:${t.collection}:${t.id}:${a.key}`,
          label: `${a.label} — ${t.label}`,
          kind: 'hold',
          ...base,
          confirm: `${a.label}: ${t.label}?${a.confirm_text ? ` ${a.confirm_text}` : ''}`,
          payload: {
            method: 'POST',
            path: '/bulk-actions/run',
            body: { collection: t.collection, key: a.key, ids: [t.id] },
            require_reason: a.require_reason
          }
        })
      }
      continue
    }

    if (parsed.kind === 'transition') {
      const offered = await deps.transitions(user, isAdmin, t.collection, t.id, (label) =>
        labelMatchesVerb(label, parsed.verb)
      )
      for (const tr of offered) {
        out.push({
          id: `transition:${t.collection}:${t.id}:${tr.id}`,
          label: `${tr.label} — ${t.label}`,
          kind: 'transition',
          ...base,
          confirm: `${tr.label} ${t.label}${tr.to_label ? ` (moves it to ${tr.to_label})` : ''}?`,
          payload: {
            method: 'POST',
            path: `${instancePath}/transition`,
            body: { transition_id: tr.id },
            needs_comment: tr.needs_comment,
            has_requirements: tr.has_requirements
          }
        })
      }
      continue
    }

    if (parsed.kind === 'assign') {
      const step = await deps.ownerStep(user, isAdmin, t.collection, t.id)
      if (!step) continue
      for (const p of await deps.findPeople(parsed.person, isAdmin)) {
        out.push({
          id: `assign:${t.collection}:${t.id}:${p.id}`,
          label: `Assign ${t.label} to ${p.name}`,
          kind: 'assign',
          ...base,
          confirm: `Add ${p.name} as an owner of ${t.label}${step.state_label ? ` for “${step.state_label}”` : ''}?`,
          payload: {
            method: 'POST',
            path: `${instancePath}/owners`,
            body: { user: p.id, state: step.state }
          }
        })
      }
    }
  }
  return out
}

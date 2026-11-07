/**
 * Edit lock while a record waits on someone (army 2026-10-24, Rob: "editing a
 * workflow while it is in approval: creator, current step owners, admins —
 * everyone else read-only").
 *
 * Config: `nivaro_collections.summary_mode_rules.edit_lock` on the bound
 * collection —
 *
 *   { states: ['waiting_on_manager_approval', …],   // pipeline state keys
 *     children: ['workflow_line_items'] }           // child rows that count
 *
 * While the record's open pipeline instance sits in one of `states`, only the
 * record's creator, the people who own the current step (owner groups,
 * instance owners, delegation, the binding's owner fallback) and admins may
 * change it — or create, change or delete one of the record's OWN rows
 * pointing at it (army v3, Rob: "the lock covers lines, zones, funding years,
 * file links"). Its own rows: a listed child collection, the junction rows of
 * its many-to-many and file fields, and the rows of an inline-grid field.
 * Other one-to-many children (notes, forecasts, queue rows) stay open unless
 * listed: approvers and finance write those while the record waits.
 *
 * The same own rows ride the record's person-held edit lock (item-lock-guard):
 * a line or a zone link of a record someone else is editing is refused 409
 * RECORD_LOCKED like the record itself.
 *
 * Admin-only tier (2026-11-04, Rob: changing a record after its approvals
 * defeats the purpose of the approvals) —
 *
 *   admin_only: { states: ['approved', 'closed'],       // pipeline state keys
 *                 transitions: ['<transition id>', …],  // moves only admins run there
 *                 open_fields: ['is_on_hold'],          // record fields still open
 *                 open_children: ['<link junction>'] }  // own rows still open
 *
 * While the record's LATEST pipeline run sits in one of those states — open or
 * finished, so a completed record stays locked — only admins may change the
 * record or its own rows: the creator and the step owners lose their
 * exemption. What stays open is named, never inferred: an update that writes
 * nothing but `open_fields`, and the rows of `open_children`. A delete never
 * passes. A record whose latest run is in neither tier is judged as before.
 * Item actions and outbound pushes (a record's Push button) skip this tier
 * (`adminOnlyTier: false`): they move the record forward, which is how it
 * leaves these states — the approval tier still judges them. A person-held
 * edit lock stays usable when the tier leaves open fields (the save itself is
 * judged per payload). In either tier, the values a move's own requirements
 * dialog saves pass for whoever may run that move (requirement-writes.ts).
 *
 * Judged on REQUEST writes only (the items service is handed the request):
 * the engine's own writes — flows, transition actions, addendum apply, crons,
 * imports — carry no request and are never locked out by it. A question that
 * cannot be answered refuses (403 EDIT_LOCKED), like the owner-only gate.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { excludeBranchChildren } from './branch-instances.js'
import { pickInstance } from './record-state.js'
import { currentTenantKey } from './tenant-rooms.js'

export const EDIT_LOCKED = 'EDIT_LOCKED'

export class EditLockedError extends Error {
  statusCode = 403
  code = EDIT_LOCKED
}

export interface EditLockAdminOnly {
  /** pipeline state keys in which only admins may change the record */
  states: string[]
  /** transition ids only admins may run from those states */
  transitions: string[]
  /** record fields a non-admin may still write there */
  open_fields: string[]
  /** own-row collections that stay open there */
  open_children: string[]
}

export interface EditLockConfig {
  /** approval states (creator, step owners, admins); may be [] with admin_only */
  states: string[]
  children: string[]
  admin_only?: EditLockAdminOnly
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const STATE_KEY_RE = /^[A-Za-z0-9_\-:.]{1,100}$/
const TRANSITION_ID_RE = /^[0-9A-Fa-f-]{36}$/
const MAX_LIST = 50

const ADMIN_ONLY_LISTS = [
  ['states', STATE_KEY_RE, 'state keys'],
  ['transitions', TRANSITION_ID_RE, 'transition ids'],
  ['open_fields', IDENT, 'field names'],
  ['open_children', IDENT, 'collection names']
] as const

const list = (v: unknown, re: RegExp) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && re.test(x)))].slice(
        0,
        MAX_LIST
      )
    : []

function parseAdminOnly(raw: unknown): EditLockAdminOnly | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const out: EditLockAdminOnly = {
    states: list(o.states, STATE_KEY_RE),
    transitions: list(o.transitions, TRANSITION_ID_RE),
    open_fields: list(o.open_fields, IDENT),
    open_children: list(o.open_children, IDENT)
  }
  return out.states.length > 0 ? out : null
}

/** Lenient read of the `edit_lock` key; null = no lock configured. */
export function parseEditLock(raw: unknown): EditLockConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as { states?: unknown; children?: unknown; admin_only?: unknown }
  const states = list(o.states, STATE_KEY_RE)
  const adminOnly = parseAdminOnly(o.admin_only)
  if (states.length === 0 && !adminOnly) return null
  return {
    states,
    children: list(o.children, IDENT),
    ...(adminOnly ? { admin_only: adminOnly } : {})
  }
}

/** Strict write of the `edit_lock` key: normalized value or an error. */
export function validateEditLock(
  raw: unknown
): { value: EditLockConfig | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw == null) return { value: null }
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'summary_mode_rules.edit_lock must be an object' }
  const o = raw as { states?: unknown; children?: unknown; admin_only?: unknown }
  const checkList = (path: string, v: unknown, re: RegExp, what: string) => {
    if (v === undefined) return null
    if (!Array.isArray(v) || v.length > MAX_LIST)
      return `summary_mode_rules.edit_lock.${path} must be a list of at most ${MAX_LIST}`
    if (!v.every((x) => typeof x === 'string' && re.test(x)))
      return `summary_mode_rules.edit_lock.${path} entries must be ${what}`
    return null
  }
  for (const [key, re, what] of [
    ['states', STATE_KEY_RE, 'state keys'],
    ['children', IDENT, 'collection names']
  ] as const) {
    const error = checkList(key, o[key], re, what)
    if (error) return { error }
  }
  if (o.admin_only != null) {
    if (typeof o.admin_only !== 'object' || Array.isArray(o.admin_only))
      return { error: 'summary_mode_rules.edit_lock.admin_only must be an object' }
    const a = o.admin_only as Record<string, unknown>
    for (const [key, re, what] of ADMIN_ONLY_LISTS) {
      const error = checkList(`admin_only.${key}`, a[key], re, what)
      if (error) return { error }
    }
  }
  return { value: parseEditLock(raw) }
}

interface ChildLink {
  parent: string
  field: string
}

interface LockPlan {
  /** bound collection → its lock */
  locks: Map<string, EditLockConfig>
  /** own-row collection → the FK columns that point at a parent with an approval lock */
  childLinks: Map<string, ChildLink[]>
  /** own-row collection → the FK columns that point at any parent (person-held locks) */
  heldLinks: Map<string, ChildLink[]>
}

const PLAN_TTL_MS = 30_000
const planCache = new Map<string, { at: number; plan: Promise<LockPlan> }>()
const SYSTEM_TABLE = /^(nivaro_|directus_)/i

interface RelationRow {
  many_collection: string
  many_field: string
  one_collection: string
  one_field: string | null
  junction_field: string | null
}

/**
 * Which relations make the many side one of the parent's OWN rows: a listed
 * child, a junction leg of a many-to-many / files field, or the rows of an
 * inline-grid field. Exported for the tests.
 */
export function ownRowLinks(
  locks: Map<string, EditLockConfig>,
  rels: RelationRow[],
  inlineGrids: Set<string>
): Pick<LockPlan, 'childLinks' | 'heldLinks'> {
  const childLinks = new Map<string, ChildLink[]>()
  const heldLinks = new Map<string, ChildLink[]>()
  const add = (map: Map<string, ChildLink[]>, child: string, link: ChildLink) => {
    const list = map.get(child) ?? []
    if (!list.some((l) => l.parent === link.parent && l.field === link.field)) list.push(link)
    map.set(child, list)
  }
  for (const r of rels) {
    const child = String(r.many_collection ?? '')
    const parent = String(r.one_collection ?? '')
    const field = String(r.many_field ?? '')
    if (!IDENT.test(child) || !IDENT.test(parent) || !IDENT.test(field)) continue
    if (child === parent || SYSTEM_TABLE.test(parent) || SYSTEM_TABLE.test(child)) continue
    const lock = locks.get(parent)
    const listed = !!lock?.children.includes(child)
    const grid = !!r.one_field && inlineGrids.has(`${parent}.${r.one_field}`)
    // The far leg of a junction (divisions_id → divisions) is not the
    // record's row: only the leg the parent shows as a field, or a leg of a
    // locked parent, counts.
    const junction = !!r.junction_field && (!!r.one_field || !!lock)
    if (!listed && !grid && !junction) continue
    add(heldLinks, child, { parent, field })
    if (lock) add(childLinks, child, { parent, field })
  }
  return { childLinks, heldLinks }
}

async function readPlan(): Promise<LockPlan> {
  const rows = (await db('nivaro_collections')
    .where('summary_mode_rules', 'like', '%edit_lock%')
    .select('collection', 'summary_mode_rules')
    .catch(() => [])) as Array<{ collection: string; summary_mode_rules: string | null }>
  const locks = new Map<string, EditLockConfig>()
  for (const r of rows) {
    let obj: unknown = null
    try {
      obj = r.summary_mode_rules ? JSON.parse(r.summary_mode_rules) : null
    } catch {
      continue
    }
    const lock = parseEditLock((obj as { edit_lock?: unknown } | null)?.edit_lock)
    if (lock) locks.set(r.collection, lock)
  }
  const rels = (await db('nivaro_relations')
    .whereNotNull('one_collection')
    .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')
    .catch(() => [])) as RelationRow[]
  const grids = (await db('nivaro_fields')
    .where('interface', 'inline-grid')
    .select('collection', 'field')
    .catch(() => [])) as Array<{ collection: string; field: string }>
  const inlineGrids = new Set(grids.map((g) => `${g.collection}.${g.field}`))
  return { locks, ...ownRowLinks(locks, rels, inlineGrids) }
}

function lockPlan(): Promise<LockPlan> {
  const key = currentTenantKey()
  const hit = planCache.get(key)
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan
  const plan = readPlan()
  planCache.set(key, { at: Date.now(), plan })
  plan.catch(() => planCache.delete(key))
  return plan
}

/** Forget the cached plan (a collection's Form UX settings were saved). */
export function forgetEditLockPlan(): void {
  planCache.delete(currentTenantKey())
}

export interface EditLockVerdict {
  locked: boolean
  allowed: boolean
  message: string
  /** which tier locked it (absent when open) */
  tier?: 'approval' | 'admin_only'
  /** the fields a non-admin may still write (tier 'admin_only' only) */
  open_fields?: string[]
}

const OPEN: EditLockVerdict = { locked: false, allowed: true, message: '' }

interface InstanceRow {
  id: string
  current_state: string
  key: string
  label: string | null
  completed_at?: unknown
}

/**
 * The record's run for the admin-only tier, open or finished — THE record's
 * run as the rest of the app reads it (findRecordInstance): never a parallel
 * branch child; among the rest the open one, else the newest by start. The
 * same start falls to the higher id (the read's own order, kept by the sort).
 */
async function latestInstance(collection: string, item: string): Promise<InstanceRow | undefined> {
  const rows = (await db('nivaro_workflow_instances as i')
    .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
    .where({ 'i.collection': collection, 'i.item': String(item) })
    .orderBy([
      { column: 'i.started_at', order: 'desc' },
      { column: 'i.id', order: 'desc' }
    ])
    .select(
      'i.id',
      'i.collection',
      'i.item',
      'i.template',
      'i.current_state',
      'i.started_at',
      'i.completed_at',
      's.key',
      's.label'
    )) as Array<
    InstanceRow & {
      collection: string
      item: string
      template: string
      started_at: Date | null
      completed_at: Date | null
    }
  >
  if (rows.length <= 1) return rows[0]
  const kept = await excludeBranchChildren(rows)
  return pickInstance(kept.length ? kept : rows)
}

/**
 * The admin-only state `item` of `collection` sits in (its latest run), or
 * null — for the gates that judge moves out of it and the form.
 */
export async function adminOnlyStateOf(
  collection: string,
  item: string
): Promise<{ key: string; label: string } | null> {
  const adminOnly = (await lockPlan()).locks.get(collection)?.admin_only
  if (!adminOnly) return null
  const inst = await latestInstance(collection, item)
  if (!inst || !adminOnly.states.includes(inst.key)) return null
  return { key: inst.key, label: inst.label ?? inst.key }
}

/** Transition ids (upper-cased) only admins may run from an admin-only state. */
export async function adminOnlyTransitionsFor(collection: string): Promise<Set<string>> {
  const adminOnly = (await lockPlan()).locks.get(collection)?.admin_only
  return new Set((adminOnly?.transitions ?? []).map((id) => String(id).toUpperCase()))
}

/** The pipeline state keys that are admin-only for `collection` (list pages judge by state). */
export async function adminOnlyStatesFor(collection: string): Promise<Set<string>> {
  return new Set((await lockPlan()).locks.get(collection)?.admin_only?.states ?? [])
}

/**
 * Is `parentId` of `parent` locked right now, and may `user` change it?
 * Exported for the instance read (the form shows read-only from it).
 */
/**
 * The admin-only tier's sentence (a15-6). It is about FIELDS: a record at a
 * post-approval step may still offer this person a move (the record panel's
 * actions, which the tier does not lock) — then the sentence says so instead
 * of sending them to Request help for something they can do themselves.
 */
export function adminOnlyLockMessage(step: string, hasMove: boolean): string {
  return hasMove
    ? `This record is at ${step} — only administrators can change its fields. You can still use the actions above; use Request help to ask for any other change.`
    : `This record is at ${step} — only administrators can change its fields. Use Request help to ask for a change.`
}

/**
 * Whether the record's run offers `user` (never an admin here) at least one
 * manual move from where it stands — judged by the same gate a move is run
 * through (manual-transition-gate.ts: from-state, automatic, admin-only list,
 * extension vetoes, roles, step owner, conditions). Requirements and the note
 * are what the move's own dialog asks for, so they do not take a move off
 * offer. Any doubt = false (the plain Request help sentence).
 */
async function offersAMove(
  user: User,
  collection: string,
  item: string,
  inst: InstanceRow
): Promise<boolean> {
  try {
    const template = (inst as InstanceRow & { template?: string | null }).template
    if (!template) return false
    const transitions = (await db('nivaro_workflow_transitions')
      .where({ template })
      .where((q) => q.where('from_state', inst.current_state).orWhereNull('from_state'))
      // Every column: some (allow_creator, …) are newer than some databases.
      .select('*')) as Array<import('./manual-transition-gate.js').GateTransition>
    if (transitions.length === 0) return false
    const { manualTransitionRefusal } = await import('./manual-transition-gate.js')
    for (const t of transitions) {
      const refused = await manualTransitionRefusal({
        user,
        isAdmin: false,
        collection,
        item,
        instance: {
          id: String(inst.id),
          current_state: inst.current_state,
          completed_at: (inst.completed_at as Date | string | null | undefined) ?? null
        },
        transition: t,
        skipRequirements: true,
        skipComment: true
      })
      if (!refused) return true
    }
    return false
  } catch {
    return false
  }
}

export async function editLockVerdictFor(
  user: User,
  parent: string,
  parentId: string,
  lock?: EditLockConfig
): Promise<EditLockVerdict> {
  const cfg = lock ?? (await lockPlan()).locks.get(parent)
  if (!cfg) return OPEN
  // Admins never get here (the callers let them through first).
  let latest: InstanceRow | undefined
  if (cfg.admin_only) {
    latest = await latestInstance(parent, String(parentId))
    if (latest && cfg.admin_only.states.includes(latest.key))
      return {
        locked: true,
        allowed: false,
        message: adminOnlyLockMessage(
          latest.label ?? latest.key,
          await offersAMove(user, parent, String(parentId), latest)
        ),
        tier: 'admin_only',
        // A FINISHED run (Completed, Canceled) leaves nothing open: putting a finished
        // record on hold means nothing (army 8 b14: Put On Hold was offered to a creator
        // on a Completed, admin-locked workflow). Open fields apply while the run waits.
        open_fields: latest.completed_at == null ? cfg.admin_only.open_fields : []
      }
  }
  if (cfg.states.length === 0) return OPEN
  // The approval tier reads only an OPEN run (the latest one when it is open).
  const inst =
    latest && latest.completed_at == null
      ? latest
      : ((await db('nivaro_workflow_instances as i')
          .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
          .where({ 'i.collection': parent, 'i.item': String(parentId) })
          .whereNull('i.completed_at')
          .first('i.id', 'i.current_state', 's.key', 's.label')) as InstanceRow | undefined)
  if (!inst || !cfg.states.includes(inst.key)) return OPEN
  const { recordCreators, sameUser, ownsStep } = await import('./record-access.js')
  const creator = (await recordCreators(parent, [String(parentId)])).get(String(parentId))
  if (sameUser(creator, user.id))
    return { locked: true, allowed: true, message: '', tier: 'approval' }
  const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
  const owners = await resolveStateOwnersBatch([
    {
      key: 'x',
      stateId: inst.current_state,
      instanceId: inst.id,
      collection: parent,
      itemId: String(parentId)
    }
  ])
  if (ownsStep(owners.get('x') ?? [], String(user.id)))
    return { locked: true, allowed: true, message: '', tier: 'approval' }
  const step = inst.label ?? inst.key
  return {
    locked: true,
    allowed: false,
    message: `This record is at ${step} — only the person who created it, the owners of that step and administrators can change it.`,
    tier: 'approval'
  }
}

/**
 * The approval-lock verdict for a person HOLDING (or asking for) the
 * record's person-held edit lock: admins and records without a lock are
 * open. A lock its holder may no longer use (the record moved into a step
 * they do not own) is void — the lock routes drop it and the save guard
 * ignores it, so the creator and the step owners are not locked out.
 * A question that cannot be answered keeps the lock (never voids it).
 */
export async function lockHolderVerdict(
  holder: { id: string; role?: string | null } | string,
  collection: string,
  item: string
): Promise<EditLockVerdict> {
  const plan = await lockPlan().catch(() => null)
  const cfg = plan?.locks.get(collection)
  if (!cfg) return OPEN
  try {
    const user =
      typeof holder === 'string'
        ? ((await db('nivaro_users').where({ id: holder }).first('id', 'role')) as User | undefined)
        : (holder as User)
    if (!user) return OPEN
    const { isAdminRole } = await import('./permissions.js')
    if (await isAdminRole(user)) return OPEN
    const verdict = await editLockVerdictFor(user, collection, String(item), cfg)
    // A form with open fields is still worth holding: each save is judged.
    if (verdict.tier === 'admin_only' && (verdict.open_fields?.length ?? 0) > 0)
      return { ...verdict, allowed: true, message: '' }
    return verdict
  } catch {
    return OPEN
  }
}

function fkOf(value: unknown): string | null {
  const fk = value && typeof value === 'object' ? (value as { id?: unknown }).id : value
  return fk != null && fk !== '' ? String(fk) : null
}

/**
 * The gate the items service runs on a request write. `ids` = the rows being
 * changed or deleted; `payload` = the values being written (a child row's FK
 * to its parent may be among them). Judges, for a record's own rows (a
 * listed child, a junction row of a many-to-many / files field, an inline-grid
 * row) the parent's person-held edit lock (409 RECORD_LOCKED, admins
 * included, as on the record) and, for a record and its own rows, the
 * approval edit lock (403 EDIT_LOCKED, admins pass). Throws on a refusal.
 * In an admin-only state, an update writing only the lock's open fields and
 * a row of one of its open children still pass; `adminOnlyTier: false` (item
 * actions, outbound pushes) skips that tier altogether. In either tier, an
 * update of values a move's requirements dialog asks for passes for whoever
 * may run that move (requirement-writes.ts).
 */
export async function assertNotEditLocked(
  user: User | null | undefined,
  collection: string,
  opts: { ids?: Array<string | number>; payload?: Record<string, unknown> | null },
  req?: FastifyRequest,
  tiers: { adminOnlyTier?: boolean } = {}
): Promise<void> {
  if (!req || !user) return
  const plan = await lockPlan()
  const own = plan.locks.get(collection)
  const links = plan.childLinks.get(collection)
  const held = plan.heldLinks.get(collection)
  if (!own && !links && !held) return

  // The rows' current parents, read once for both locks. A row moved OUT of a
  // locked parent counts as much as one moved in (the payload's FK).
  const ids = (opts.ids ?? []).map(String)
  const fields = [...new Set([...(links ?? []), ...(held ?? [])].map((l) => l.field))]
  let current: Array<Record<string, unknown>> = []
  let currentFailed = false
  if (ids.length > 0 && fields.length > 0) {
    try {
      current = (await db(collection).whereIn('id', ids).select(fields)) as Array<
        Record<string, unknown>
      >
    } catch {
      currentFailed = true
    }
  }
  const parentsOf = (ls: ChildLink[]) => {
    const out: Array<{ parent: string; id: string }> = []
    const seen = new Set<string>()
    const push = (parent: string, id: string | null) => {
      if (id == null) return
      const k = `${parent}:${id.toLowerCase()}`
      if (seen.has(k)) return
      seen.add(k)
      out.push({ parent, id })
    }
    for (const link of ls) {
      push(link.parent, fkOf(opts.payload?.[link.field]))
      for (const r of current) push(link.parent, fkOf(r[link.field]))
    }
    return out
  }

  if (held) {
    const { editLockRefusal, RecordLockedError } = await import('./item-lock-guard.js')
    for (const t of parentsOf(held)) {
      const refused = await editLockRefusal(req, t.parent, t.id)
      if (refused) throw new RecordLockedError(refused.body)
    }
  }
  if (!own && !links) return
  const { isAdminRole } = await import('./permissions.js')
  if (req.isAdmin || (await isAdminRole(user))) return
  if (links && currentFailed)
    throw new EditLockedError('Could not confirm you may change this record while it waits.')

  // Admin-only tier: an update of the record that writes nothing but open
  // fields (a delete has no payload; `id` and `_` keys are not fields).
  const written = Object.keys(opts.payload ?? {}).filter((k) => k !== 'id' && !k.startsWith('_'))
  const onlyOpenFields = (open: string[] | undefined) =>
    !!opts.payload && written.length > 0 && written.every((k) => !!open?.includes(k))

  // A value the move's own requirements dialog saves (requirement-writes.ts):
  // the request names the move, and every row written is one the server
  // finds that move asks for, on the very record judged here. Asked only
  // when a lock would refuse, once per call.
  let moveRecords: Promise<Array<{ collection: string; item: string } | null>> | null = null
  const forTheMove = async (parent: string, id: string) => {
    if (ids.length === 0 || written.length === 0) return false
    const { REQUIREMENTS_FOR_HEADER, requirementWriteTarget } = await import(
      './requirement-writes.js'
    )
    if (!req.headers?.[REQUIREMENTS_FOR_HEADER]) return false
    moveRecords ??= Promise.all(
      ids.map((rowId) => requirementWriteTarget(req, collection, rowId, written))
    )
    const found = await moveRecords
    return found.every(
      (m) => !!m && m.collection === parent && m.item.toLowerCase() === id.toLowerCase()
    )
  }

  const targets: Array<{ parent: string; id: string; child: boolean }> = []
  if (own) for (const id of ids) targets.push({ parent: collection, id, child: false })
  if (links) for (const p of parentsOf(links)) targets.push({ ...p, child: true })
  const seen = new Set<string>()
  for (const t of targets) {
    const k = `${t.parent}:${t.id.toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    const planned = plan.locks.get(t.parent)
    const lock =
      planned && tiers.adminOnlyTier === false
        ? { states: planned.states, children: planned.children }
        : planned
    let verdict: EditLockVerdict
    try {
      verdict = await editLockVerdictFor(user, t.parent, t.id, lock)
    } catch {
      throw new EditLockedError('Could not confirm you may change this record while it waits.')
    }
    if (verdict.allowed) continue
    if (verdict.tier === 'admin_only') {
      if (t.child && lock?.admin_only?.open_children.includes(collection)) continue
      if (!t.child && onlyOpenFields(verdict.open_fields)) continue
    }
    if (await forTheMove(t.parent, t.id)) continue
    throw new EditLockedError(verdict.message)
  }
}

/** Whether a batch fast path must leave `collection` to the items service. */
export async function editLockTouches(collection: string): Promise<boolean> {
  const plan = await lockPlan().catch(() => null)
  if (!plan) return true
  return plan.locks.has(collection) || plan.heldLinks.has(collection)
}

export interface RecordWriteRefusal {
  status: 403 | 404 | 409
  body: { error: string; code?: string; locked_by?: string; locked_by_name?: string | null }
}

/**
 * Everything a person's write to ONE record must pass, for the routes that
 * change a record (or rows hanging off it) outside updateOne — the same
 * sequence as the single-record item action (item-actions.ts): the caller
 * reads it as themselves (row filter, User Scopes; invisible = 404), may
 * update it (update row filter, tree permission), nobody else holds its
 * person-held edit lock (409 RECORD_LOCKED, admins included) and its
 * approval lock lets them (403 EDIT_LOCKED). null = go ahead. `heldLock:
 * false` skips the person-held lock (an outbound push, like the record's own
 * Push button, does not write the form someone has open). `fields` = the
 * record fields the caller writes, when it knows them: an admin-only lock
 * lets a write of nothing but its open fields through. `adminOnlyTier:
 * false` skips the admin-only tier (outbound pushes).
 */
export async function recordWriteRefusal(
  req: FastifyRequest,
  collection: string,
  id: string | number,
  opts: { heldLock?: boolean; fields?: string[]; adminOnlyTier?: boolean } = {}
): Promise<RecordWriteRefusal | null> {
  const user = req.user
  if (!user) return { status: 403, body: { error: 'Forbidden' } }
  if (opts.heldLock !== false) {
    const { editLockRefusal } = await import('./item-lock-guard.js')
    const held = await editLockRefusal(req, collection, id)
    if (held) return held
  }
  if (req.isAdmin) return null
  const items = await import('./items.js')
  let row: unknown = null
  try {
    row = await items.readOne(user, collection, id, req.workspaceId ?? undefined, ['id'])
  } catch (err) {
    if (err instanceof items.ForbiddenError) return { status: 403, body: { error: 'Forbidden' } }
    if (
      err instanceof items.CollectionNotFoundError ||
      err instanceof items.ItemNotFoundError ||
      (err as { statusCode?: number })?.statusCode === 400
    )
      return { status: 404, body: { error: 'Not found' } }
    throw err
  }
  if (row == null) return { status: 404, body: { error: 'Not found' } }
  if (!(await items.canUpdateItem(user, collection, id, req.workspaceId ?? undefined)))
    return { status: 403, body: { error: 'You do not have permission to change this record' } }
  try {
    const payload = opts.fields ? Object.fromEntries(opts.fields.map((f) => [f, null])) : undefined
    await assertNotEditLocked(user, collection, { ids: [id], payload }, req, {
      adminOnlyTier: opts.adminOnlyTier
    })
  } catch (err) {
    if (err instanceof EditLockedError)
      return { status: 403, body: { error: err.message, code: EDIT_LOCKED } }
    throw err
  }
  return null
}

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
 * change it — or create, change or delete a row of a listed child collection
 * pointing at it. Children are named, never inferred: notes, forecasts and
 * queue rows are children too, and approvers and finance write those.
 *
 * Judged on REQUEST writes only (the items service is handed the request):
 * the engine's own writes — flows, transition actions, addendum apply, crons,
 * imports — carry no request and are never locked out by it. A question that
 * cannot be answered refuses (403 EDIT_LOCKED), like the owner-only gate.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { currentTenantKey } from './tenant-rooms.js'

export const EDIT_LOCKED = 'EDIT_LOCKED'

export class EditLockedError extends Error {
  statusCode = 403
  code = EDIT_LOCKED
}

export interface EditLockConfig {
  states: string[]
  children: string[]
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const STATE_KEY_RE = /^[A-Za-z0-9_\-:.]{1,100}$/
const MAX_LIST = 50

/** Lenient read of the `edit_lock` key; null = no lock configured. */
export function parseEditLock(raw: unknown): EditLockConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as { states?: unknown; children?: unknown }
  const list = (v: unknown, re: RegExp) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string' && re.test(x)))].slice(
          0,
          MAX_LIST
        )
      : []
  const states = list(o.states, STATE_KEY_RE)
  if (states.length === 0) return null
  return { states, children: list(o.children, IDENT) }
}

/** Strict write of the `edit_lock` key: normalized value or an error. */
export function validateEditLock(
  raw: unknown
): { value: EditLockConfig | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw == null) return { value: null }
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'summary_mode_rules.edit_lock must be an object' }
  const o = raw as { states?: unknown; children?: unknown }
  for (const [key, re] of [
    ['states', STATE_KEY_RE],
    ['children', IDENT]
  ] as const) {
    const v = o[key]
    if (v === undefined) continue
    if (!Array.isArray(v) || v.length > MAX_LIST)
      return { error: `summary_mode_rules.edit_lock.${key} must be a list of at most ${MAX_LIST}` }
    if (!v.every((x) => typeof x === 'string' && re.test(x)))
      return {
        error: `summary_mode_rules.edit_lock.${key} entries must be ${key === 'states' ? 'state keys' : 'collection names'}`
      }
  }
  return { value: parseEditLock(raw) }
}

interface LockPlan {
  /** bound collection → its lock */
  locks: Map<string, EditLockConfig>
  /** child collection → the FK columns that point at a locked parent */
  childLinks: Map<string, Array<{ parent: string; field: string }>>
}

const PLAN_TTL_MS = 30_000
const planCache = new Map<string, { at: number; plan: Promise<LockPlan> }>()

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
  const childLinks = new Map<string, Array<{ parent: string; field: string }>>()
  const wanted = [...locks.entries()].flatMap(([parent, l]) =>
    l.children.map((child) => ({ parent, child }))
  )
  if (wanted.length > 0) {
    const rels = (await db('nivaro_relations')
      .whereIn(
        'many_collection',
        wanted.map((w) => w.child)
      )
      .whereIn(
        'one_collection',
        wanted.map((w) => w.parent)
      )
      .select('many_collection', 'many_field', 'one_collection')) as Array<{
      many_collection: string
      many_field: string
      one_collection: string
    }>
    for (const w of wanted) {
      for (const r of rels) {
        if (r.many_collection !== w.child || r.one_collection !== w.parent) continue
        if (!IDENT.test(String(r.many_field))) continue
        const list = childLinks.get(w.child) ?? []
        list.push({ parent: w.parent, field: r.many_field })
        childLinks.set(w.child, list)
      }
    }
  }
  return { locks, childLinks }
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
}

const OPEN: EditLockVerdict = { locked: false, allowed: true, message: '' }

/**
 * Is `parentId` of `parent` locked right now, and may `user` change it?
 * Exported for the instance read (the form shows read-only from it).
 */
export async function editLockVerdictFor(
  user: User,
  parent: string,
  parentId: string,
  lock?: EditLockConfig
): Promise<EditLockVerdict> {
  const cfg = lock ?? (await lockPlan()).locks.get(parent)
  if (!cfg) return OPEN
  const inst = (await db('nivaro_workflow_instances as i')
    .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
    .where({ 'i.collection': parent, 'i.item': String(parentId) })
    .whereNull('i.completed_at')
    .first('i.id', 'i.current_state', 's.key', 's.label')) as
    | { id: string; current_state: string; key: string; label: string | null }
    | undefined
  if (!inst || !cfg.states.includes(inst.key)) return OPEN
  const { recordCreators, sameUser, ownsStep } = await import('./record-access.js')
  const creator = (await recordCreators(parent, [String(parentId)])).get(String(parentId))
  if (sameUser(creator, user.id)) return { locked: true, allowed: true, message: '' }
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
    return { locked: true, allowed: true, message: '' }
  const step = inst.label ?? inst.key
  return {
    locked: true,
    allowed: false,
    message: `This record is at ${step} — only the person who created it, the owners of that step and administrators can change it.`
  }
}

/**
 * The gate the items service runs on a request write. `ids` = the rows being
 * changed or deleted; `payload` = the values being written (a child row's FK
 * to its parent may be among them). Throws EditLockedError on a refusal.
 */
export async function assertNotEditLocked(
  user: User | null | undefined,
  collection: string,
  opts: { ids?: Array<string | number>; payload?: Record<string, unknown> | null },
  req?: FastifyRequest
): Promise<void> {
  if (!req || !user) return
  const plan = await lockPlan()
  if (plan.locks.size === 0) return
  const own = plan.locks.get(collection)
  const links = plan.childLinks.get(collection)
  if (!own && !links) return
  const { isAdminRole } = await import('./permissions.js')
  if (req.isAdmin || (await isAdminRole(user))) return

  const targets: Array<{ parent: string; id: string }> = []
  if (own) for (const id of opts.ids ?? []) targets.push({ parent: collection, id: String(id) })
  if (links) {
    const ids = (opts.ids ?? []).map(String)
    for (const link of links) {
      const fromPayload = opts.payload?.[link.field]
      const fk =
        fromPayload && typeof fromPayload === 'object'
          ? (fromPayload as { id?: unknown }).id
          : fromPayload
      if (fk != null && fk !== '') targets.push({ parent: link.parent, id: String(fk) })
      if (ids.length > 0) {
        const rows = (await db(collection)
          .whereIn('id', ids)
          .select(`${link.field} as fk`)) as Array<{ fk: unknown }>
        for (const r of rows)
          if (r.fk != null && r.fk !== '') targets.push({ parent: link.parent, id: String(r.fk) })
      }
    }
  }
  const seen = new Set<string>()
  for (const t of targets) {
    const k = `${t.parent}:${t.id.toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    let verdict: EditLockVerdict
    try {
      verdict = await editLockVerdictFor(user, t.parent, t.id, plan.locks.get(t.parent))
    } catch {
      throw new EditLockedError('Could not confirm you may change this record while it waits.')
    }
    if (!verdict.allowed) throw new EditLockedError(verdict.message)
  }
}

/** Whether a batch fast path must leave `collection` to the items service. */
export async function editLockTouches(collection: string): Promise<boolean> {
  const plan = await lockPlan().catch(() => null)
  if (!plan) return true
  return plan.locks.has(collection) || plan.childLinks.has(collection)
}

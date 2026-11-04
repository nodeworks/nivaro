/**
 * Move-requirement writes (2026-11-04, Rob: the values a forward move asks for
 * in its own requirements dialog still save for whoever may run that move).
 *
 * A move with `requirements` opens the requirements dialog, which saves what
 * it collects — a Req ID per line, the record's project id and name — with
 * plain item PATCHes as the person running the move, BEFORE the move itself
 * is posted. In a locked state (edit-lock.ts, either tier) those PATCHes
 * would be refused like any other edit, and the move could never be made.
 *
 * The dialog names the move it is saving for in the `x-nivaro-requirements-for`
 * header (the transition id). That header is only a question, never a pass:
 * the write goes through only when the server finds, on its own reads, that
 *  - the move declares a requirement entry covering every field written —
 *    `record_fields` on the record itself, or `child_fields` on a row of the
 *    entry's collection whose CURRENT `fk_field` (read here, never taken from
 *    the payload; a write of `fk_field` itself never passes) names the record;
 *  - that record's open-or-latest run is of the move's pipeline;
 *  - the caller may run the move on it right now — record access plus the
 *    manual-transition gate (admin-only moves, roles, owner-only included),
 *    asked without the requirements (what is being filled in) and the note
 *    (which rides the move itself).
 * Anything that cannot be answered refuses. Junction writes (many-to-many
 * requirement fields) are not covered. One answer per request.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { findRecordInstance } from './branch-instances.js'
import { instanceAccessAllowed } from './instance-guard.js'
import {
  type GateInstance,
  type GateTransition,
  manualTransitionRefusal
} from './manual-transition-gate.js'

export const REQUIREMENTS_FOR_HEADER = 'x-nivaro-requirements-for'

/** The record whose move a requirement write belongs to. */
export interface RequirementWriteTarget {
  collection: string
  item: string
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const TRANSITION_ID = /^[A-Za-z0-9-]{1,64}$/

const memo = new WeakMap<FastifyRequest, Map<string, Promise<RequirementWriteTarget | null>>>()

type MoveTransition = GateTransition & { template: string }
type MoveInstance = GateInstance & { template: string; collection: string; item: string }

interface Entry {
  type?: unknown
  collection?: unknown
  fk_field?: unknown
  fields?: unknown
}

const same = (a: unknown, b: unknown) => String(a).toUpperCase() === String(b).toUpperCase()

function headerOf(req: FastifyRequest): string | null {
  const raw = req.headers?.[REQUIREMENTS_FOR_HEADER]
  return typeof raw === 'string' && TRANSITION_ID.test(raw) ? raw : null
}

function entriesOf(raw: unknown): Entry[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? (v.filter((e) => e && typeof e === 'object') as Entry[]) : []
  } catch {
    return []
  }
}

/** Every written key is one of the entry's declared fields. */
function covers(entry: Entry, keys: string[]): boolean {
  const fields = Array.isArray(entry.fields) ? entry.fields : []
  return keys.every((k) => fields.includes(k))
}

function fkOf(value: unknown): string | null {
  const fk = value && typeof value === 'object' ? (value as { id?: unknown }).id : value
  return fk != null && fk !== '' ? String(fk) : null
}

async function mayRunMove(
  req: FastifyRequest,
  transition: MoveTransition,
  target: RequirementWriteTarget
): Promise<boolean> {
  const isAdmin = req.isAdmin === true
  if (!(await instanceAccessAllowed(req.user, isAdmin, target.collection, target.item)))
    return false
  const instance = await findRecordInstance<MoveInstance>(target.collection, target.item)
  if (!instance || !same(instance.template, transition.template)) return false
  const refusal = await manualTransitionRefusal({
    user: req.user,
    isAdmin,
    collection: target.collection,
    item: target.item,
    instance,
    transition,
    skipRequirements: true,
    skipComment: true,
    log: req.log
  })
  return refusal == null
}

async function judge(
  req: FastifyRequest,
  transitionId: string,
  collection: string,
  id: string,
  keys: string[]
): Promise<RequirementWriteTarget | null> {
  const transition = (await db('nivaro_workflow_transitions')
    .where({ id: transitionId })
    .first()) as MoveTransition | undefined
  if (!transition?.requirements || !transition.template) return null

  const candidates: RequirementWriteTarget[] = []
  for (const entry of entriesOf(transition.requirements)) {
    if (!covers(entry, keys)) continue
    if (entry.type === 'record_fields') {
      // The record itself — its run must be of the move's pipeline (below).
      candidates.push({ collection, item: id })
      continue
    }
    if (entry.type !== 'child_fields' || entry.collection !== collection) continue
    const fk = entry.fk_field
    if (typeof fk !== 'string' || !IDENT.test(fk) || keys.includes(fk)) continue
    const row = (await db(collection).where({ id }).first(fk)) as
      | Record<string, unknown>
      | undefined
    const parent = fkOf(row?.[fk])
    if (!parent) continue
    // The entry names no parent collection: the records holding a run of the
    // move's pipeline under that id are the ones the requirement reads rows for.
    const runs = (await db('nivaro_workflow_instances')
      .where({ template: transition.template, item: parent })
      .select('collection')) as Array<{ collection: string }>
    for (const c of new Set(runs.map((r) => r.collection)))
      candidates.push({ collection: c, item: parent })
  }

  const asked = new Set<string>()
  for (const c of candidates) {
    const k = `${c.collection}:${c.item.toLowerCase()}`
    if (asked.has(k)) continue
    asked.add(k)
    if (await mayRunMove(req, transition, c)) return c
  }
  return null
}

/**
 * The record whose move lets this write of `keys` to `collection`/`id`
 * through, or null (see the header comment). Memoized per request.
 */
export function requirementWriteTarget(
  req: FastifyRequest,
  collection: string,
  id: string | number,
  keys: string[]
): Promise<RequirementWriteTarget | null> {
  const transitionId = headerOf(req)
  if (!transitionId || !req.user || keys.length === 0 || !IDENT.test(collection))
    return Promise.resolve(null)
  const key = JSON.stringify([transitionId, collection, String(id), [...keys].sort()])
  let byReq = memo.get(req)
  if (!byReq) {
    byReq = new Map()
    memo.set(req, byReq)
  }
  const hit = byReq.get(key)
  if (hit) return hit
  const answer = judge(req, transitionId, collection, String(id), keys).catch(() => null)
  byReq.set(key, answer)
  return answer
}

/** True when writing `keys` to `collection`/`id` is a value the named move asks for. */
export async function requirementWriteAllowed(
  req: FastifyRequest,
  collection: string,
  id: string | number,
  keys: string[]
): Promise<boolean> {
  return (await requirementWriteTarget(req, collection, id, keys)) != null
}

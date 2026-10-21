import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import {
  applyLayoutOps,
  CANVAS_SLOT_KEYS,
  GROUP_PATCH_KEYS,
  LAYOUT_PATCH_KEYS,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError,
  PLACEMENT_PATCH_KEYS
} from '../layout-ops-apply.js'
import { describeLayoutOps, type LayoutFacts, loadLayoutFacts } from './layout-facts.js'
import { cleanText } from './model.js'

/**
 * Layout proposals (#2694): layout ops a connected assistant (claude.ai,
 * ChatGPT, Claude Code over /api/mcp) or any admin API caller suggests for a
 * layout. A proposal is NEVER applied here: the editor lists it ("Proposals
 * (N)"), an admin reads it in plain words, applies it to the draft with
 * draft.apply (one undo step, saved with Save like any edit) or rejects it.
 *
 * Stored as rows of nivaro_ai_proposals with action_type 'layout_ops' (no
 * table of its own, the 'plan' precedent): payload {layout_id, ops, note,
 * base_rev, via, client}, preview {sentences, dropped}. executeProposal
 * refuses this type — only the editor resolves it.
 */

export const LAYOUT_PROPOSAL_TYPE = 'layout_ops'
export const MAX_PROPOSAL_OPS = 200
/** Unresolved proposals older than this are shown as expired and not offered. */
export const PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

type Obj = Record<string, unknown>

const OP_KINDS = new Set([
  'place',
  'move',
  'update_placement',
  'remove',
  'group_create',
  'group_update',
  'group_move',
  'group_remove',
  'layout_update'
])

function keepKeys(v: unknown, allowed: readonly string[], dropped: string[], where: string): Obj {
  const out: Obj = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, x] of Object.entries(v as Obj)) {
    if (allowed.includes(k)) out[k] = x
    else dropped.push(`${where}: unknown setting “${k}” left out`)
  }
  return out
}

const pkey = (v: unknown): { field: string; group_key: string | null } | null => {
  const o = (v ?? {}) as Obj
  if (typeof o.field !== 'string' || !o.field) return null
  return { field: o.field, group_key: typeof o.group_key === 'string' ? o.group_key : null }
}
const idx = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0)

export interface CheckedOps {
  ops: LayoutOp[]
  /** Plain words for what was left out, and why. */
  dropped: string[]
  /** Why the remaining ops do not apply to the layout as it is, or null. */
  error: string | null
  op_index?: number
  sentences: string[]
}

/**
 * Model or caller ops checked against the layout: unknown op kinds, fields
 * that are not on the collection and unknown settings keys are dropped (and
 * named); what is left must apply to the layout with the ops twin, the same
 * check the editor and POST /:id/ops make.
 */
export function checkLayoutOps(
  facts: Pick<LayoutFacts, 'labels' | 'roleNames' | 'ctx'>,
  bundle: LayoutBundle,
  raw: unknown
): CheckedOps {
  const dropped: string[] = []
  const fields = new Set(facts.ctx.fields.map((f) => f.field))
  // Collection fields, slot cards (__comments__, __ext_<key>__, …) and widgets.
  const isPlaceable = (f: string) =>
    fields.has(f) ||
    (CANVAS_SLOT_KEYS as readonly string[]).includes(f) ||
    (/^__[a-z][a-z0-9_-]{1,70}__$/.test(f) && f !== '__ungrouped_pos__')
  const list = Array.isArray(raw) ? raw : []
  if (list.length > MAX_PROPOSAL_OPS)
    dropped.push(`Only the first ${MAX_PROPOSAL_OPS} of ${list.length} changes were kept`)
  const ops: LayoutOp[] = []
  list.slice(0, MAX_PROPOSAL_OPS).forEach((r, i) => {
    const o = (r ?? {}) as Obj
    const n = `Change ${i + 1}`
    if (!OP_KINDS.has(String(o.op))) {
      dropped.push(`${n}: “${String(o.op ?? '?')}” is not a layout change`)
      return
    }
    switch (o.op) {
      case 'place': {
        const field = typeof o.field === 'string' ? o.field : ''
        if (!isPlaceable(field)) {
          dropped.push(`${n}: no field “${field}” on this collection`)
          return
        }
        const patch = keepKeys(o.patch, PLACEMENT_PATCH_KEYS, dropped, n)
        ops.push({
          op: 'place',
          field,
          group_key: typeof o.group_key === 'string' ? o.group_key : null,
          index: idx(o.index),
          ...(Object.keys(patch).length ? { patch } : {})
        } as LayoutOp)
        return
      }
      case 'move': {
        const from = pkey(o.from)
        if (!from) {
          dropped.push(`${n}: a move needs from.field`)
          return
        }
        ops.push({
          op: 'move',
          from,
          to_group_key: typeof o.to_group_key === 'string' ? o.to_group_key : null,
          index: idx(o.index)
        })
        return
      }
      case 'update_placement': {
        const at = pkey(o.at)
        if (!at) {
          dropped.push(`${n}: an update needs at.field`)
          return
        }
        const patch = keepKeys(o.patch, PLACEMENT_PATCH_KEYS, dropped, n)
        if (!Object.keys(patch).length) {
          dropped.push(`${n}: nothing to change`)
          return
        }
        ops.push({ op: 'update_placement', at, patch } as LayoutOp)
        return
      }
      case 'remove': {
        const at = pkey(o.at)
        if (!at) {
          dropped.push(`${n}: a removal needs at.field`)
          return
        }
        ops.push({ op: 'remove', at })
        return
      }
      case 'group_create': {
        const label = cleanText(o.label, 80)
        const key = typeof o.key === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(o.key) ? o.key : null
        if (!label || !key) {
          dropped.push(`${n}: a new section needs a key and a label`)
          return
        }
        const patch = keepKeys(o.patch, GROUP_PATCH_KEYS, dropped, n)
        ops.push({
          op: 'group_create',
          key,
          label,
          group_type: typeof o.group_type === 'string' ? o.group_type : 'section',
          parent_key: typeof o.parent_key === 'string' ? o.parent_key : null,
          index: idx(o.index),
          ...(Object.keys(patch).length ? { patch } : {})
        } as LayoutOp)
        return
      }
      case 'group_update': {
        if (typeof o.key !== 'string') {
          dropped.push(`${n}: which section?`)
          return
        }
        const patch = keepKeys(o.patch, GROUP_PATCH_KEYS, dropped, n)
        if (!Object.keys(patch).length) {
          dropped.push(`${n}: nothing to change`)
          return
        }
        ops.push({ op: 'group_update', key: o.key, patch } as LayoutOp)
        return
      }
      case 'group_move': {
        if (typeof o.key !== 'string') {
          dropped.push(`${n}: which section?`)
          return
        }
        ops.push({
          op: 'group_move',
          key: o.key,
          parent_key: typeof o.parent_key === 'string' ? o.parent_key : null,
          index: idx(o.index)
        })
        return
      }
      case 'group_remove': {
        if (typeof o.key !== 'string') {
          dropped.push(`${n}: which section?`)
          return
        }
        ops.push({
          op: 'group_remove',
          key: o.key,
          placements: o.placements === 'delete' ? 'delete' : 'ungroup'
        })
        return
      }
      case 'layout_update': {
        const patch = keepKeys(o.patch, LAYOUT_PATCH_KEYS, dropped, n)
        if (!Object.keys(patch).length) {
          dropped.push(`${n}: nothing to change`)
          return
        }
        ops.push({ op: 'layout_update', patch } as LayoutOp)
        return
      }
    }
  })
  let error: string | null = null
  let op_index: number | undefined
  if (ops.length === 0) error = 'No change is left to propose'
  else
    try {
      applyLayoutOps(bundle, ops)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      if (err instanceof LayoutOpError) op_index = err.op_index
    }
  return {
    ops,
    dropped,
    error,
    ...(op_index !== undefined ? { op_index } : {}),
    sentences: describeLayoutOps(facts, bundle, ops)
  }
}

export interface ProposerRef {
  user_id: string
  via: 'oauth' | 'api_key' | 'session' | 'token' | 'other'
  client: string | null
}

export interface LayoutProposalView {
  id: string
  layout_id: number
  note: string | null
  status: 'proposed' | 'applied' | 'rejected' | 'expired'
  created_at: string
  proposer: { name: string; via: string }
  ops: LayoutOp[]
  sentences: string[]
  dropped: string[]
  /** Why it would not apply to the layout as it is NOW, or null. */
  conflict: string | null
}

const VIA_WORDS: Record<string, string> = {
  oauth: 'connected app',
  api_key: 'API key',
  session: 'signed in',
  token: 'token',
  other: 'API'
}

/** Store a checked proposal. Refuses when nothing applicable is left. */
export async function createLayoutProposal(opts: {
  layoutId: number
  ops: unknown
  note?: unknown
  proposer: ProposerRef
}): Promise<
  | { ok: true; id: string; sentences: string[]; dropped: string[] }
  | { ok: false; status: number; error: string; dropped?: string[]; op_index?: number }
> {
  const facts = await loadLayoutFacts(opts.layoutId)
  if (!facts) return { ok: false, status: 404, error: 'Layout not found' }
  const checked = checkLayoutOps(facts, facts.bundle, opts.ops)
  if (checked.error)
    return {
      ok: false,
      status: 400,
      error: checked.error,
      dropped: checked.dropped,
      ...(checked.op_index !== undefined ? { op_index: checked.op_index } : {})
    }
  const id = randomUUID()
  await db('nivaro_ai_proposals').insert({
    id,
    user: opts.proposer.user_id,
    action_type: LAYOUT_PROPOSAL_TYPE,
    collection: String(facts.bundle.layout.collection),
    payload: JSON.stringify({
      layout_id: opts.layoutId,
      ops: checked.ops,
      note: cleanText(opts.note, 500),
      base_rev: facts.bundle.rev,
      via: opts.proposer.via,
      client: opts.proposer.client
    }),
    preview: JSON.stringify({ sentences: checked.sentences, dropped: checked.dropped }),
    status: 'proposed',
    created_at: new Date()
  })
  return { ok: true, id, sentences: checked.sentences, dropped: checked.dropped }
}

function parseObj(v: unknown): Obj {
  if (v && typeof v === 'object') return v as Obj
  try {
    const x = JSON.parse(String(v ?? ''))
    return x && typeof x === 'object' ? (x as Obj) : {}
  } catch {
    return {}
  }
}

const STATUS_OUT: Record<string, LayoutProposalView['status']> = {
  proposed: 'proposed',
  executed: 'applied',
  rejected: 'rejected',
  expired: 'expired'
}

/**
 * Open proposals for a layout (newest first), each re-read against the layout
 * as it is now: sentences in today's labels and whether it still applies. The
 * editor passes its draft so "still applies" means "applies to what I see".
 */
export async function listLayoutProposals(
  layoutId: number,
  opts: { draft?: unknown; status?: 'open' | 'all' } = {}
): Promise<LayoutProposalView[] | null> {
  const facts = await loadLayoutFacts(layoutId, { draft: opts.draft })
  if (!facts) return null
  const rows = (await db('nivaro_ai_proposals')
    .where({
      action_type: LAYOUT_PROPOSAL_TYPE,
      collection: String(facts.bundle.layout.collection)
    })
    .modify((q) => {
      if (opts.status !== 'all') q.where({ status: 'proposed' })
    })
    .orderBy('created_at', 'desc')
    .limit(200)
    .select('id', 'user', 'payload', 'preview', 'status', 'created_at')) as Obj[]
  const mine = rows
    .map((r) => ({ r, p: parseObj(r.payload) }))
    .filter(({ p }) => Number(p.layout_id) === layoutId)
    .slice(0, 50)
  const userIds = [...new Set(mine.map(({ r }) => String(r.user)))]
  const users = new Map(
    (userIds.length
      ? ((await db('nivaro_users')
          .whereIn('id', userIds)
          .select('id', 'first_name', 'last_name', 'email')) as Obj[])
      : []
    ).map((u) => [
      String(u.id).toUpperCase(),
      [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || String(u.email ?? 'Someone')
    ])
  )
  const now = Date.now()
  const out: LayoutProposalView[] = []
  for (const { r, p } of mine) {
    const created = new Date(String(r.created_at))
    let status = STATUS_OUT[String(r.status)] ?? 'expired'
    if (status === 'proposed' && now - created.getTime() > PROPOSAL_TTL_MS) status = 'expired'
    if (opts.status !== 'all' && status !== 'proposed') continue
    const checked = checkLayoutOps(facts, facts.bundle, p.ops)
    const preview = parseObj(r.preview)
    const via = String(p.via ?? 'other')
    const who = users.get(String(r.user).toUpperCase()) ?? 'Someone'
    out.push({
      id: String(r.id),
      layout_id: layoutId,
      note: typeof p.note === 'string' ? p.note : null,
      status,
      created_at: created.toISOString(),
      proposer: {
        name: who,
        via: p.client ? `${String(p.client)} (${VIA_WORDS[via] ?? via})` : (VIA_WORDS[via] ?? via)
      },
      ops: checked.ops,
      sentences: checked.sentences,
      dropped: Array.isArray(preview.dropped) ? (preview.dropped as string[]) : [],
      conflict: checked.error
    })
  }
  return out
}

/** The admin applied it to the draft, or rejected it. Only an open proposal moves. */
export async function resolveLayoutProposal(opts: {
  layoutId: number
  id: string
  outcome: 'applied' | 'rejected'
  by: string | null
}): Promise<'ok' | 'not_found' | 'not_open'> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.id)) return 'not_found'
  const row = (await db('nivaro_ai_proposals')
    .where({ id: opts.id, action_type: LAYOUT_PROPOSAL_TYPE })
    .first('id', 'payload', 'status')) as Obj | undefined
  if (!row || Number(parseObj(row.payload).layout_id) !== opts.layoutId) return 'not_found'
  const n = await db('nivaro_ai_proposals')
    .where({ id: opts.id, status: 'proposed' })
    .update({
      status: opts.outcome === 'applied' ? 'executed' : 'rejected',
      result: JSON.stringify({ outcome: opts.outcome, by: opts.by }),
      executed_at: new Date()
    })
  return Number(n) === 1 ? 'ok' : 'not_open'
}

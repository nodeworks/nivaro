import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { createOne, readItems, updateOne } from './items.js'
import { can } from './permissions.js'

/**
 * AI action proposals — propose/approve/execute split.
 *
 * proposeAction() runs AS THE REQUESTING USER: affected records resolve
 * through readItems (RBAC + RLS), fields validate against the registry, and
 * the result is a STORED proposal + human-readable preview. Nothing mutates.
 *
 * executeProposal() — only the proposer, only while 'proposed', only within
 * EXPIRY — applies each row through updateOne/createOne so hooks, validation,
 * row security, computed fields and activity logging all run per record.
 */

const MAX_AFFECTED = 200
const EXPIRY_MS = 60 * 60 * 1000

export interface ProposalPreview {
  proposal_id: string
  action_type: 'bulk_update' | 'create_record'
  collection: string
  count: number
  changes: Record<string, unknown> | null
  sample: Array<{ id: string; label: string }>
  expires_note: string
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function rowLabel(row: Record<string, unknown>): string {
  return String(row.title ?? row.name ?? row.label ?? row.subject ?? `#${String(row.id)}`)
}

export async function proposeAction(
  user: User,
  input: {
    action_type?: string
    collection?: string
    filter?: unknown
    changes?: Record<string, unknown>
    data?: Record<string, unknown>
  }
): Promise<ProposalPreview> {
  const collection = String(input.collection ?? '')
  if (!/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
    throw new Error('Invalid collection')
  }
  const actionType = input.action_type === 'create_record' ? 'create_record' : 'bulk_update'

  const requiredAction = actionType === 'create_record' ? 'create' : 'update'
  if (!(await can(user, requiredAction, collection))) {
    throw new Error(`You do not have ${requiredAction} permission on ${collection}`)
  }

  const validFields = new Set(
    ((await db('nivaro_fields').where({ collection }).select('field')) as Array<{ field: string }>).map(
      (r) => r.field
    )
  )

  let payload: Record<string, unknown>
  let preview: Omit<ProposalPreview, 'proposal_id' | 'expires_note'>

  if (actionType === 'create_record') {
    const data = Object.fromEntries(
      Object.entries(input.data ?? {}).filter(([k]) => validFields.has(k) && k !== 'id')
    )
    if (Object.keys(data).length === 0) throw new Error('data must set at least one valid field')
    payload = { data }
    preview = {
      action_type: 'create_record',
      collection,
      count: 1,
      changes: data,
      sample: []
    }
  } else {
    const changes = Object.fromEntries(
      Object.entries(input.changes ?? {}).filter(([k]) => validFields.has(k) && k !== 'id')
    )
    if (Object.keys(changes).length === 0) {
      throw new Error('changes must set at least one valid field')
    }
    // Resolve affected ids through the permission-checked read path (RLS applies)
    const res = await readItems(user, collection, {
      filter: (input.filter as Record<string, unknown>) ?? {},
      limit: MAX_AFFECTED + 1
    })
    const rows = ((res as { data?: Array<Record<string, unknown>> }).data ?? []) as Array<
      Record<string, unknown>
    >
    if (rows.length === 0) throw new Error('The filter matches no records you can read')
    if (rows.length > MAX_AFFECTED) {
      throw new Error(
        `The filter matches more than ${MAX_AFFECTED} records — narrow it before proposing`
      )
    }
    payload = { ids: rows.map((r) => String(r.id)), changes }
    preview = {
      action_type: 'bulk_update',
      collection,
      count: rows.length,
      changes,
      sample: rows.slice(0, 8).map((r) => ({ id: String(r.id), label: rowLabel(r) }))
    }
  }

  const id = randomUUID()
  await db('nivaro_ai_proposals').insert({
    id,
    user: user.id,
    action_type: actionType,
    collection,
    payload: JSON.stringify(payload),
    preview: JSON.stringify(preview),
    status: 'proposed',
    created_at: new Date()
  })

  return {
    proposal_id: id,
    ...preview,
    expires_note: 'The user must approve this proposal in the UI within 1 hour; it does NOT execute automatically.'
  }
}

export async function executeProposal(
  user: User,
  proposalId: string
): Promise<{ status: string; result: Record<string, unknown> }> {
  const row = await db('nivaro_ai_proposals').where({ id: proposalId }).first()
  if (!row) throw Object.assign(new Error('Proposal not found'), { statusCode: 404 })
  if (row.user !== user.id) {
    throw Object.assign(new Error('Only the proposer can approve this'), { statusCode: 403 })
  }
  if (row.status !== 'proposed') {
    throw Object.assign(new Error(`Proposal is already ${String(row.status)}`), { statusCode: 409 })
  }
  if (Date.now() - new Date(row.created_at).getTime() > EXPIRY_MS) {
    await db('nivaro_ai_proposals').where({ id: proposalId }).update({ status: 'expired' })
    throw Object.assign(new Error('Proposal expired — ask again'), { statusCode: 410 })
  }

  const payload = parseJson<Record<string, unknown>>(row.payload) ?? {}
  const collection = String(row.collection)
  let result: Record<string, unknown>

  if (row.action_type === 'create_record') {
    const created = (await createOne(
      user,
      collection,
      (payload.data as Record<string, unknown>) ?? {}
    )) as Record<string, unknown>
    result = { id: created?.id ?? null }
  } else {
    const ids = (payload.ids as string[]) ?? []
    const changes = (payload.changes as Record<string, unknown>) ?? {}
    let updated = 0
    const errors: string[] = []
    for (const id of ids) {
      try {
        await updateOne(user, collection, id, { ...changes })
        updated++
      } catch (err) {
        if (errors.length < 10) {
          errors.push(`${id}: ${err instanceof Error ? err.message.slice(0, 120) : 'failed'}`)
        }
      }
    }
    result = { updated, failed: ids.length - updated, errors }
  }

  await db('nivaro_ai_proposals').where({ id: proposalId }).update({
    status: 'executed',
    result: JSON.stringify(result),
    executed_at: new Date()
  })
  return { status: 'executed', result }
}

export async function rejectProposal(user: User, proposalId: string): Promise<void> {
  const row = await db('nivaro_ai_proposals').where({ id: proposalId }).first()
  if (!row) throw Object.assign(new Error('Proposal not found'), { statusCode: 404 })
  if (row.user !== user.id) {
    throw Object.assign(new Error('Only the proposer can reject this'), { statusCode: 403 })
  }
  if (row.status !== 'proposed') return
  await db('nivaro_ai_proposals').where({ id: proposalId }).update({ status: 'rejected' })
}

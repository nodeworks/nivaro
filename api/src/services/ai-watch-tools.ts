import type { FastifyRequest } from 'fastify'
import type { User } from '../types.js'
import {
  fieldChanges,
  type PastRevision,
  parseAsOf,
  snapshotAsOf,
  stateStays,
  totalsByState
} from './ai-past.js'
import { listWatchSummaries } from './ai-watches.js'
import { getAllowedFields } from './permissions.js'
import { listRevisions } from './revisions.js'
import { isAdminRole } from './user-scopes.js'

/**
 * Ask AI tools for watched numbers (#1948) and the past (#1843). Kept apart
 * from ai-chat.ts, which spreads WATCH_TOOLS into its tool list and routes the
 * two names here. Both run as the asker: the past reader opens the record the
 * way the revision API does (recordVisibleTo — readOne as the caller, 404 for
 * what they cannot see) and narrows every value to the fields their role may
 * read, because a snapshot carries columns the role never saw.
 */

const MAX_FIELDS = 60
const MAX_CHANGES = 20

function clip(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v
  if (v != null && typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 300 ? `${s.slice(0, 300)}…` : v
  }
  return v
}

function narrow(
  data: Record<string, unknown>,
  allowed: string[] | null
): { values: Record<string, unknown>; cut: boolean } {
  const keys = Object.keys(data).filter(
    (k) => !k.startsWith('_') && (!allowed || allowed.includes(k))
  )
  const values: Record<string, unknown> = {}
  for (const k of keys.slice(0, MAX_FIELDS)) values[k] = clip(data[k])
  return { values, cut: keys.length > MAX_FIELDS }
}

export async function executeWatchTool(
  user: User,
  name: string,
  input: Record<string, unknown>
): Promise<{ result: unknown; summary: string }> {
  if (name === 'my_watches') {
    const watches = await listWatchSummaries(user.id)
    return {
      result: { watches },
      summary: watches.length ? `${watches.length} watched number(s)` : 'No watched numbers'
    }
  }

  const collection = String(input.collection ?? '')
  const id = String(input.id ?? '').trim()
  if (!/^[a-zA-Z0-9_]+$/.test(collection) || /^(nivaro_|directus_)/.test(collection))
    throw new Error('Invalid collection name')
  if (!id) throw new Error('id is required')
  const mode = String(input.mode ?? '')
  if (!['as_of', 'changes', 'time_in_state'].includes(mode)) throw new Error('Invalid mode')

  // Same gate as GET /revisions: the record must be one the asker can open.
  const { recordVisibleTo } = await import('./revision-access.js')
  const req = {
    user,
    isAdmin: await isAdminRole(user.role),
    workspaceId: null
  } as unknown as FastifyRequest
  if (!(await recordVisibleTo(req, collection, id))) throw new Error('Record not found')

  const allowed = await getAllowedFields(user, 'read', collection)
  const revs = (await listRevisions(collection, id)) as unknown as PastRevision[]
  const limited = revs.length >= 100
  const base = { record: `${collection}/${id}`, history_limited: limited }
  if (!revs.length) {
    return {
      result: { ...base, note: 'No history is recorded for this record.' },
      summary: 'No history'
    }
  }

  if (mode === 'as_of') {
    const asOf = parseAsOf(input.as_of)
    if (!asOf) throw new Error('as_of must be a date like 2026-03-01')
    const snap = snapshotAsOf(revs, asOf)
    if (!snap) {
      const oldest = [...revs]
        .map((r) => (r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN))
        .filter((t) => !Number.isNaN(t))
        .sort((a, b) => a - b)[0]
      return {
        result: {
          ...base,
          note: `No history from that early${oldest ? `; the earliest recorded change is ${new Date(oldest).toISOString()}` : ''}${limited ? ' (older history was not read)' : ''}.`
        },
        summary: 'Nothing recorded that early'
      }
    }
    const stays = stateStays(revs, new Date())
    const state = [...stays].reverse().find((s) => new Date(s.entered_at) <= asOf)
    const { values, cut } = narrow(snap.data, allowed)
    return {
      result: {
        ...base,
        as_of: asOf.toISOString(),
        snapshot_taken_at: snap.at,
        last_changed_by: snap.by,
        pipeline_state: state?.state ?? null,
        values,
        ...(cut ? { note: `Only the first ${MAX_FIELDS} fields are shown.` } : {})
      },
      summary: `${collection}/${id} as of ${asOf.toISOString().slice(0, 10)}`
    }
  }

  if (mode === 'changes') {
    const field = typeof input.field === 'string' ? input.field.trim() : ''
    if (field) {
      if (allowed && !allowed.includes(field)) throw new Error('You may not read that field')
      const changes = fieldChanges(revs, field).slice(0, MAX_CHANGES)
      return {
        result: {
          ...base,
          field,
          changes: changes.map((c) => ({ ...c, from: clip(c.from), to: clip(c.to) }))
        },
        summary: `${changes.length} change(s) to ${field}`
      }
    }
    // No field: which fields changed, newest first.
    const seen: Array<{ at: string; by: string; fields: string[] }> = []
    for (const r of revs) {
      if (r.event || !r.delta || !r.timestamp) continue
      const fields = Object.keys(r.delta).filter(
        (k) => !k.startsWith('_') && (!allowed || allowed.includes(k))
      )
      if (!fields.length) continue
      seen.push({
        at: new Date(r.timestamp).toISOString(),
        by: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.user_email || 'the system',
        fields: fields.slice(0, 15)
      })
      if (seen.length >= MAX_CHANGES) break
    }
    return { result: { ...base, changes: seen }, summary: `${seen.length} edit(s)` }
  }

  const stays = stateStays(revs, new Date())
  if (!stays.length) {
    return {
      result: { ...base, note: 'This record has no recorded pipeline moves.' },
      summary: 'No pipeline history'
    }
  }
  return {
    result: { ...base, stays, totals: totalsByState(stays) },
    summary: `${stays.length} stay(s) across ${new Set(stays.map((s) => s.state)).size} state(s)`
  }
}

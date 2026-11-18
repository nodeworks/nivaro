import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import { currentTenantKey } from '../tenant-rooms.js'

export const TRACKER_EMAIL = 'gitlab-sync@nivaro.local'

type Row = Record<string, unknown>

const firstRow = async (): Promise<Row | undefined> =>
  (await db('nivaro_users').where({ email: TRACKER_EMAIL }).orderBy('id').first('id')) as
    | Row
    | undefined

/** One lookup-or-create at a time per tenant in this process (final review: create race). */
const inflight = new Map<string, Promise<string>>()

/**
 * The machine identity that authors comments imported from the tracker.
 * Suspended by design (hidden from pickers, presence, mail); created on first use.
 * Concurrent first uses share one create in this process; across processes a lost insert (unique
 * email) reads the winner, and every reader takes the same row (lowest id) if two were made.
 */
export function trackerUserId(): Promise<string> {
  const key = currentTenantKey()
  const running = inflight.get(key)
  if (running) return running
  const p = resolveTrackerUser().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function resolveTrackerUser(): Promise<string> {
  const existing = await firstRow()
  if (existing) return String(existing.id)
  const id = randomUUID().toUpperCase()
  try {
    await db('nivaro_users').insert({
      id,
      email: TRACKER_EMAIL,
      first_name: 'GitLab',
      status: 'suspended',
      account_kind: 'integration'
    })
  } catch (err) {
    const raced = await firstRow()
    if (raced) return String(raced.id)
    throw err
  }
  const winner = await firstRow()
  return winner ? String(winner.id) : id
}

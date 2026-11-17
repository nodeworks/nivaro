import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'

export const TRACKER_EMAIL = 'gitlab-sync@nivaro.local'

/**
 * The machine identity that authors comments imported from the tracker.
 * Suspended by design (hidden from pickers, presence, mail); created on first use.
 */
export async function trackerUserId(): Promise<string> {
  const existing = await db('nivaro_users').where({ email: TRACKER_EMAIL }).first('id')
  if (existing) return String(existing.id)
  const id = randomUUID().toUpperCase()
  await db('nivaro_users').insert({
    id,
    email: TRACKER_EMAIL,
    first_name: 'GitLab',
    status: 'suspended',
    account_kind: 'integration'
  })
  return id
}

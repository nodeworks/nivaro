import { db } from '../../db/index.js'
import { getTeamsBotConfig } from './config.js'

/**
 * The caller's own Teams facts for Profile → Notification rules: whether the bot is on for this
 * instance, and their working link (status + when). A link is personal, so this is only ever
 * called for the person's own profile.
 */
export async function ownTeamsFacts(userId: string): Promise<{
  teams_available: boolean
  teams_link: { status: string; linked_at: string | null } | null
}> {
  let available = false
  try {
    available = (await getTeamsBotConfig()).enabled === true
  } catch {
    available = false
  }
  if (!available) return { teams_available: false, teams_link: null }
  let row: { status: string; linked_at: Date | string | null } | undefined
  try {
    row = (await db('nivaro_teams_links')
      .where({ user_id: userId, status: 'active' })
      .orderBy('linked_at', 'desc')
      .first('status', 'linked_at')) as typeof row
  } catch {
    row = undefined
  }
  return {
    teams_available: true,
    teams_link: row
      ? {
          status: row.status,
          linked_at: row.linked_at ? new Date(row.linked_at as string | Date).toISOString() : null
        }
      : null
  }
}

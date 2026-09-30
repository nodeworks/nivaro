import type { DigestSection } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { listRooms } from './chat.js'
import { registerDigestSection } from './daily-digest.js'

/**
 * Mention digest (#931): chat messages that named you in the last three days
 * and that you have not read yet — a section of the daily summary, one line
 * per room with who and what.
 */
let registered = false
export function registerChatMentionDigest(): void {
  if (registered) return
  registered = true
  registerDigestSection(async (userId): Promise<DigestSection | null> => {
    const user = (await db('nivaro_users').where({ id: userId }).first()) as User | undefined
    if (!user) return null
    const rooms = (await listRooms(user)).filter((r) => r.mentions > 0)
    if (rooms.length === 0) return null
    const since = new Date(Date.now() - 3 * 86_400_000)
    const lines = []
    for (const r of rooms.slice(0, 10)) {
      const last = r.last_message
      if (last && new Date(last.date_created) < since) continue
      lines.push({
        text: `${r.label ?? r.room} — ${r.mentions} unread ${r.mentions === 1 ? 'mention' : 'mentions'}`,
        sub: last
          ? `${last.sender_name ?? 'Someone'}: ${String(last.message).replace(/\s+/g, ' ').slice(0, 120)}`
          : undefined,
        url: `/chat?room=${encodeURIComponent(r.room)}`
      })
    }
    if (lines.length === 0) return null
    return { title: `Chat mentions you have not read (${lines.length})`, lines }
  })
}

import { db } from '../db/index.js'

/** Post a card to Teams via the configured incoming webhook. Fire-and-forget (no throw). */
export async function sendTeamsNotification(opts: {
  title: string
  text: string
  color?: string // hex like '#00ceff'
}): Promise<void> {
  try {
    const settings = await db('nivaro_settings').where({ id: 1 }).first()
    const url = settings?.teams_webhook_url as string | null
    if (!url) return

    const body = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: (opts.color ?? '#00ceff').replace('#', ''),
      summary: opts.title,
      sections: [{ activityTitle: opts.title, activityText: opts.text }]
    }

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch {
    // Teams notifications are non-critical — never throw
  }
}

/** Resolve Azure AD groups from OIDC token claims to a Nivaro role ID. */
export async function resolveRoleFromAdGroups(groups: string[]): Promise<string | null> {
  if (!groups || groups.length === 0) return null
  try {
    const settings = await db('nivaro_settings').where({ id: 1 }).first()
    const raw = settings?.ad_group_role_map as string | null
    if (!raw) return null
    const map = JSON.parse(raw) as Array<{ ad_group_id: string; role_id: string }>
    for (const g of groups) {
      const match = map.find((m) => m.ad_group_id === g)
      if (match) return match.role_id
    }
    return null
  } catch {
    return null
  }
}

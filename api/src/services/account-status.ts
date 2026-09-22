import { db } from '../db/index.js'

/**
 * Why an account cannot sign in (#512).
 *
 * Redaction, directory sync, offboarding and a plain admin edit all write
 * the reason somewhere — an activity row, a revision delta, a column — but
 * the person who hits "we couldn't sign you in" never sees it and neither
 * does the admin they ask. This reads every place a suspension leaves a
 * mark and answers with the newest, in one sentence.
 */

export interface SuspensionReason {
  /** Which mechanism suspended the account. */
  source:
    | 'directory'
    | 'retention'
    | 'offboarding'
    | 'merge'
    | 'admin'
    | 'legacy-redaction'
    | 'unknown'
  text: string
  at: string | null
  by: { id: string; name: string } | null
}

const ACTION_SOURCE: Record<string, SuspensionReason['source']> = {
  'directory-suspend': 'directory',
  'user-retention-suspend': 'retention',
  'user-offboard': 'offboarding',
  'user-merge': 'merge',
  'legacy-users-sync': 'legacy-redaction'
}

export async function suspensionReason(userId: string): Promise<SuspensionReason | null> {
  const user = (await db('nivaro_users')
    .where({ id: userId })
    .first(
      'id',
      'status',
      'is_redacted',
      'redacted_at',
      'directory_status',
      'directory_checked_at',
      'first_name',
      'email'
    )) as Record<string, unknown> | undefined
  if (!user) return null
  const suspended = user.status === 'suspended' || !!user.is_redacted
  if (!suspended) return null

  // The newest activity row that names a suspension mechanism on this user.
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where('a.collection', 'nivaro_users')
    .where('a.item', String(userId))
    .whereIn('a.action', [...Object.keys(ACTION_SOURCE), 'update'])
    .orderBy('a.id', 'desc')
    .limit(40)
    .select(
      'a.id',
      'a.action',
      'a.comment',
      'a.timestamp',
      'a.user',
      'u.first_name',
      'u.last_name'
    )) as Array<Record<string, unknown>>
  const actor = (r: Record<string, unknown>) =>
    r.user
      ? {
          id: String(r.user),
          name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || String(r.user)
        }
      : null
  const when = (r: Record<string, unknown>) =>
    r.timestamp instanceof Date ? r.timestamp.toISOString() : null

  for (const r of rows) {
    const action = String(r.action)
    if (ACTION_SOURCE[action]) {
      return {
        source: ACTION_SOURCE[action],
        text: String(r.comment ?? '').trim() || describe(ACTION_SOURCE[action]),
        at: when(r),
        by: actor(r)
      }
    }
    // A plain edit: only counts when its revision delta flipped status.
    if (action === 'update') {
      const rev = (await db('nivaro_revisions').where({ activity: r.id }).first('delta')) as
        | { delta: string | null }
        | undefined
      if (rev?.delta) {
        try {
          const delta = JSON.parse(rev.delta) as Record<string, unknown>
          if (delta.status === 'suspended' || delta.is_redacted === true) {
            const who = actor(r)
            return {
              source: 'admin',
              text: `Suspended by ${who?.name ?? 'an administrator'}${r.comment ? ` — ${String(r.comment)}` : ''}`,
              at: when(r),
              by: who
            }
          }
        } catch {
          /* unreadable delta — keep looking */
        }
      }
    }
  }

  // No row: fall back to what the columns say.
  if (user.is_redacted) {
    return {
      source: 'retention',
      text: 'Redacted by a retention policy (no per-user record was kept at the time)',
      at: user.redacted_at instanceof Date ? user.redacted_at.toISOString() : null,
      by: null
    }
  }
  if (user.directory_status === 'missing' || user.directory_status === 'disabled') {
    return {
      source: 'directory',
      text:
        user.directory_status === 'missing'
          ? 'Not found in the company directory on the last sync'
          : 'Disabled in the company directory on the last sync',
      at:
        user.directory_checked_at instanceof Date ? user.directory_checked_at.toISOString() : null,
      by: null
    }
  }
  if (
    String(user.first_name ?? '') === 'Redacted' ||
    /^Redacted_/i.test(String(user.email ?? ''))
  ) {
    return {
      source: 'legacy-redaction',
      text: 'Redacted by the legacy nightly retention job (36 months without activity) and carried over by the user sync',
      at: null,
      by: null
    }
  }
  return { source: 'unknown', text: 'Suspended — no record says by what', at: null, by: null }
}

function describe(source: SuspensionReason['source']): string {
  switch (source) {
    case 'directory':
      return 'Suspended by directory sync — the account is gone from or disabled in the company directory'
    case 'retention':
      return 'Suspended by a retention policy'
    case 'offboarding':
      return 'Suspended by offboarding'
    case 'merge':
      return 'Merged into another account'
    case 'legacy-redaction':
      return 'Redacted by the legacy retention job'
    default:
      return 'Suspended'
  }
}

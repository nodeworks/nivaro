import { db } from '../../../db/index.js'
import { getApp } from '../../io-holder.js'

/**
 * Tells an app's owners (and anyone else named, e.g. who started a train) about a release
 * operation the Hub did on its own: an automatic rollback, a train that stopped or needs a
 * person, a scheduled promotion that could not start. Through notifyUser (the whole channel
 * stack and each person's notification rules); best effort, never throws.
 */
export async function notifyAppPeople(
  appId: number,
  note: { subject: string; message: string; urgent?: boolean },
  also: Array<string | null | undefined> = []
): Promise<number> {
  try {
    const app = getApp()
    if (!app) return 0
    const owners = (await db('nivaro_hub_app_owners')
      .where({ app_id: appId })
      .select('user_id')) as Array<{ user_id: string }>
    const ids = [
      ...new Set(
        [...owners.map((o) => String(o.user_id)), ...also]
          .filter((x): x is string => typeof x === 'string' && !!x)
          .map((x) => x.toLowerCase())
      )
    ]
    const { notifyUser } = await import('../../notification-channels.js')
    let n = 0
    for (const id of ids) {
      try {
        await notifyUser(app, id, {
          subject: note.subject.slice(0, 200),
          message: note.message.slice(0, 1000),
          always_inbox: true,
          ...(note.urgent ? { urgent: true } : {}),
          target: { kind: 'external', url: '/hub/releases' },
          source: { kind: 'hub-releases', label: 'Hub release operations' }
        })
        n++
      } catch {
        /* one person's delivery never stops the others */
      }
    }
    return n
  } catch {
    return 0
  }
}

/** Active administrators (an unattended run whose person can no longer act tells them). */
export async function hubAdminIds(): Promise<string[]> {
  try {
    const rows = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .limit(50)
      .select('u.id')) as Array<{ id: string }>
    return rows.map((r) => String(r.id))
  } catch {
    return []
  }
}

/** An app's owners plus every active administrator. */
export async function notifyAppPeopleAndAdmins(
  appId: number,
  note: { subject: string; message: string; urgent?: boolean }
): Promise<number> {
  return notifyAppPeople(appId, note, await hubAdminIds())
}

/**
 * The ONE place an automatic rollback (or a watch that ended without one) is announced — a single
 * helper so it can be routed through another notifier with a one-line change.
 */
export function notifyAutoRollback(
  appId: number,
  note: { subject: string; message: string; urgent?: boolean }
): Promise<number> {
  return notifyAppPeople(appId, note)
}

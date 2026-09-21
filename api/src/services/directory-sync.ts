import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import {
  DirectoryError,
  type DirectoryUser,
  directoryStatus,
  fetchDirectoryManager,
  fetchDirectoryPhoto,
  lookupDirectoryUser,
  walkDirectoryUsers
} from './graph-directory.js'
import { isMachineAccount } from './machine-accounts.js'
import { notifyUser } from './notification-channels.js'
import { queueOfficeGeocode } from './office-geocode.js'

// ─── Directory sync ──────────────────────────────────────────────────────────
// "Is this person still with the company?" answered from the tenant directory
// and written onto nivaro_users: `directory_status` active | disabled |
// missing, `directory_checked_at`, `directory_id`. A person the directory no
// longer has (missing, or found but disabled) is SUSPENDED when the
// directory_sync_suspend setting is on — suspension takes them out of every
// picker and lets Coverage Gaps flag what they still own. Redaction is a
// separate, deliberate admin action and is never touched here; neither is a
// suspension lifted — admins suspend on purpose too.
//
// Whole-table checks walk the tenant once (999 users per Graph call) instead
// of one call per person; a handful of ids are looked up directly.

export type DirectoryVerdict = 'active' | 'disabled' | 'missing'

export interface DirectoryChange {
  id: string
  email: string
  name: string
  status: DirectoryVerdict
  previous: DirectoryVerdict | null
  suspended: boolean
}

export interface DirectoryCheckSummary {
  ran_at: string
  mode: 'all' | 'subset'
  checked: number
  active: number
  disabled: number
  missing: number
  suspended: number
  skipped: number
  changes: DirectoryChange[]
  profile_updated?: number
}

type UserRow = {
  id: string
  email: string
  account_kind: string | null
  first_name: string | null
  last_name: string | null
  status: string | null
  directory_status: DirectoryVerdict | null
  directory_id: string | null
  manager_id: string | null
  title: string | null
  company: string | null
  department: string | null
  phone: string | null
  office_location: string | null
  city: string | null
  state: string | null
  country: string | null
  employee_id: string | null
  preferred_language: string | null
}

/** Integration / placeholder identities have no directory entry by design. */

const LOOKUP_THRESHOLD = 25

async function suspendSetting(): Promise<boolean> {
  const row = (await db('nivaro_settings').first('directory_sync_suspend')) as
    | { directory_sync_suspend?: boolean | number | null }
    | undefined
  const v = row?.directory_sync_suspend
  return v === undefined || v === null ? true : Boolean(v)
}

function displayName(u: { first_name: string | null; last_name: string | null; email: string }) {
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
}

/** Directory wins for every field it has a value for; a blank never clears. */
function profileUpdates(user: UserRow, entry: DirectoryUser): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const consider = (col: keyof UserRow, next: string | null) => {
    if (next && user[col] !== next) out[col] = next
  }
  consider('first_name', entry.first_name)
  consider('last_name', entry.last_name)
  consider('title', entry.title)
  consider('company', entry.company)
  consider('department', entry.department)
  consider('phone', entry.phone)
  consider('office_location', entry.office_location)
  consider('city', entry.city)
  consider('state', entry.state)
  consider('country', entry.country)
  consider('employee_id', entry.employee_id)
  consider('preferred_language', entry.preferred_language)
  return out
}

/** The Nivaro account behind a directory entry, by email then UPN. */
export async function nivaroUserForEntry(
  entry: DirectoryUser
): Promise<{ id: string; status: string | null } | null> {
  const candidates = [entry.email, entry.upn].filter((v): v is string => Boolean(v))
  if (candidates.length === 0) return null
  const row = (await db('nivaro_users')
    .whereRaw(
      `LOWER(email) IN (${candidates.map(() => '?').join(',')})`,
      candidates.map((c) => c.toLowerCase())
    )
    .first('id', 'status')) as { id: string; status: string | null } | undefined
  return row ?? null
}

export interface CheckOptions {
  /** Nivaro user ids to check; null/undefined = every checkable user. */
  userIds?: string[] | null
  /** Who ran it (activity attribution); null for the cron. */
  actorId?: string | null
  /** Also pull profile fields / manager / photo for users the directory has. */
  pullProfile?: boolean
  /** Send admins one notification naming newly departed people. */
  notifyAdmins?: boolean
  /** Override the settings switch (the cron passes the setting; a manual run may too). */
  suspend?: boolean
}

export async function checkDirectory(
  app: FastifyInstance | null,
  opts: CheckOptions = {}
): Promise<DirectoryCheckSummary> {
  const status = await directoryStatus()
  if (!status.granted) {
    throw new DirectoryError(
      status.reason ?? 'Directory access is not granted',
      503,
      status.configured ? 'directory_not_granted' : 'directory_not_configured'
    )
  }
  const suspend = opts.suspend ?? (await suspendSetting())
  const ranAt = new Date()

  let q = db('nivaro_users')
    .whereNotNull('email')
    .where((b) => b.where('is_redacted', false).orWhereNull('is_redacted'))
    .select(
      'id',
      'email',
      'account_kind',
      'first_name',
      'last_name',
      'status',
      'directory_status',
      'directory_id',
      'manager_id',
      'title',
      'company',
      'department',
      'phone',
      'office_location',
      'city',
      'state',
      'country',
      'employee_id',
      'preferred_language'
    )
  if (opts.userIds && opts.userIds.length > 0) q = q.whereIn('id', opts.userIds)
  // A machine identity has no directory entry by design — reading its absence
  // as "left the company" would suspend the integration it belongs to.
  const users = ((await q) as UserRow[]).filter((u) => !isMachineAccount(u))
  const subset = Boolean(opts.userIds && opts.userIds.length > 0)

  // Resolve directory entries: a few ids → direct lookups, otherwise one walk.
  const entries = new Map<string, DirectoryUser | null>()
  if (subset && users.length <= LOOKUP_THRESHOLD) {
    for (const u of users) {
      const byId = u.directory_id
        ? await lookupDirectoryUser(u.directory_id).catch(() => null)
        : null
      entries.set(u.id, byId ?? (await lookupDirectoryUser(u.email)))
    }
  } else {
    const all = await walkDirectoryUsers()
    const byKey = new Map<string, DirectoryUser>()
    for (const e of all) {
      byKey.set(`id:${e.id}`, e)
      if (e.email) byKey.set(`mail:${e.email.toLowerCase()}`, e)
      if (e.upn) byKey.set(`mail:${e.upn.toLowerCase()}`, e)
    }
    for (const u of users) {
      entries.set(
        u.id,
        (u.directory_id ? byKey.get(`id:${u.directory_id}`) : undefined) ??
          byKey.get(`mail:${u.email.toLowerCase()}`) ??
          null
      )
    }
  }

  const summary: DirectoryCheckSummary = {
    ran_at: ranAt.toISOString(),
    mode: subset ? 'subset' : 'all',
    checked: users.length,
    active: 0,
    disabled: 0,
    missing: 0,
    suspended: 0,
    skipped: 0,
    changes: [],
    profile_updated: 0
  }

  const byVerdict: Record<DirectoryVerdict, string[]> = { active: [], disabled: [], missing: [] }
  const perUser: Array<{ id: string; updates: Record<string, unknown> }> = []

  for (const u of users) {
    const entry = entries.get(u.id) ?? null
    const verdict: DirectoryVerdict = !entry
      ? 'missing'
      : entry.account_enabled === false
        ? 'disabled'
        : 'active'
    summary[verdict] += 1
    byVerdict[verdict].push(u.id)

    const updates: Record<string, unknown> = {}
    if (entry && entry.id !== u.directory_id) updates.directory_id = entry.id

    let suspendedNow = false
    if (verdict !== 'active' && suspend && (u.status ?? 'active') === 'active') {
      updates.status = 'suspended'
      updates.is_out_of_office = false
      suspendedNow = true
      summary.suspended += 1
    }

    if (opts.pullProfile && entry) {
      const prof = profileUpdates(u, entry)
      const [manager, avatar] = await Promise.all([
        fetchDirectoryManager(entry.id).catch(() => null),
        fetchDirectoryPhoto(entry.id).catch(() => null)
      ])
      if (manager) {
        const m = await nivaroUserForEntry(manager)
        if (m && m.id !== u.id && m.id !== u.manager_id) prof.manager_id = m.id
      }
      if (avatar) {
        prof.avatar = avatar
        prof.avatar_updated_at = ranAt
      }
      if (Object.keys(prof).length > 0) {
        Object.assign(updates, prof)
        summary.profile_updated = (summary.profile_updated ?? 0) + 1
        if (prof.office_location) queueOfficeGeocode(u.id)
      }
    }

    if (Object.keys(updates).length > 0) perUser.push({ id: u.id, updates })

    if (verdict !== u.directory_status || suspendedNow) {
      summary.changes.push({
        id: u.id,
        email: u.email,
        name: displayName(u),
        status: verdict,
        previous: u.directory_status,
        suspended: suspendedNow
      })
    }
  }

  // Verdict + timestamp in three batched updates; per-user rows only where
  // something else moved (directory id, suspension, profile).
  for (const verdict of Object.keys(byVerdict) as DirectoryVerdict[]) {
    const ids = byVerdict[verdict]
    for (let i = 0; i < ids.length; i += 500) {
      await db('nivaro_users')
        .whereIn('id', ids.slice(i, i + 500))
        .update({ directory_status: verdict, directory_checked_at: ranAt })
    }
  }
  for (const { id, updates } of perUser) {
    await db('nivaro_users')
      .where({ id })
      .update({ ...updates, updated_at: ranAt })
  }

  for (const c of summary.changes) {
    if (c.suspended) {
      await logActivity({
        action: 'directory-suspend',
        collection: 'nivaro_users',
        item: c.id,
        user: opts.actorId ?? null,
        comment:
          c.status === 'missing'
            ? 'Suspended: no longer in the Microsoft directory'
            : 'Suspended: account disabled in the Microsoft directory'
      })
    }
  }
  if (opts.actorId || !subset) {
    await logActivity({
      action: 'directory-check',
      collection: 'nivaro_users',
      user: opts.actorId ?? null,
      comment: `${summary.checked} checked · ${summary.active} active · ${summary.disabled} disabled · ${summary.missing} missing · ${summary.suspended} suspended`
    })
  }

  if (!subset) {
    await db('nivaro_settings')
      .update({
        directory_sync_last_run: ranAt,
        directory_sync_last_summary: JSON.stringify({
          ...summary,
          changes: summary.changes.slice(0, 200)
        })
      })
      .catch(() => {})
  }

  const departed = summary.changes.filter((c) => c.status !== 'active')
  if (opts.notifyAdmins && app && departed.length > 0) {
    const admins = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .limit(20)
      .select('u.id')) as Array<{ id: string }>
    const names = departed
      .slice(0, 10)
      .map((c) => `${c.name} (${c.status === 'missing' ? 'not in directory' : 'disabled'})`)
      .join(', ')
    const more = departed.length > 10 ? ` and ${departed.length - 10} more` : ''
    for (const a of admins) {
      await notifyUser(app, a.id, {
        subject: `Directory check: ${departed.length} ${departed.length === 1 ? 'person is' : 'people are'} no longer with the company`,
        message: `${names}${more}. ${suspend ? 'They have been suspended.' : 'Review them on the Users page.'} Hand off what they own from their user page.`,
        category: 'system',
        target: { kind: 'external', url: '/users?directory=departed' }
      }).catch(() => {})
    }
  }

  return summary
}

/** The cron body: honours the Settings switch and the token's real permission. */
export async function runDirectorySyncCron(app: FastifyInstance): Promise<string> {
  const row = (await db('nivaro_settings').first('directory_sync_enabled')) as
    | { directory_sync_enabled?: boolean | number | null }
    | undefined
  if (!row?.directory_sync_enabled) return 'skipped — directory sync is off in Settings'
  const status = await directoryStatus()
  if (!status.granted) return `skipped — ${status.reason ?? 'directory access not granted'}`
  const s = await checkDirectory(app, { pullProfile: false, notifyAdmins: true })
  return `${s.checked} checked · ${s.disabled} disabled · ${s.missing} missing · ${s.suspended} suspended`
}

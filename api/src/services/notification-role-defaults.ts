import { db } from '../db/index.js'
import { type NotifyRules, sanitizeNotifyRules } from './notification-layers.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Default notification rules by role (#3077, migration 513). One row per role, rules in the
 * same shape as a person's own. Read at DECIDE time (never copied onto people) through a short
 * tenant-keyed cache; a save busts this process and other replicas catch up within the TTL.
 */

export const ROLE_DEFAULTS_TABLE = 'nivaro_role_notification_defaults'
const TTL_MS = 30_000

export interface RoleDefaultsRow {
  role_id: string
  rules: NotifyRules
  updated_at: string | null
  updated_by: string | null
}

type CacheEntry = { at: number; rows: Map<string, RoleDefaultsRow> | null }
const cache = new Map<string, CacheEntry>()

function parseRules(raw: unknown): NotifyRules {
  try {
    return sanitizeNotifyRules(typeof raw === 'string' ? JSON.parse(raw) : raw, {
      allowTeamsMute: false
    })
  } catch {
    return {}
  }
}

const iso = (v: unknown) =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v as string)

/** Every role's defaults (a small CONFIG table), cached per tenant. Null = table missing. */
async function allRoleDefaults(): Promise<Map<string, RoleDefaultsRow> | null> {
  const key = currentTenantKey()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows
  let rows: Map<string, RoleDefaultsRow> | null = null
  try {
    const list = (await db(ROLE_DEFAULTS_TABLE).select(
      'role_id',
      'rules',
      'updated_at',
      'updated_by'
    )) as Array<Record<string, unknown>>
    rows = new Map()
    for (const r of list)
      rows.set(String(r.role_id).toUpperCase(), {
        role_id: String(r.role_id),
        rules: parseRules(r.rules),
        updated_at: iso(r.updated_at),
        updated_by: r.updated_by != null ? String(r.updated_by) : null
      })
  } catch {
    // table not there yet (a tenant behind migration 513) — no role layer
    rows = null
  }
  cache.set(key, { at: Date.now(), rows })
  return rows
}

export async function getRoleDefaults(roleId: string | null | undefined) {
  if (!roleId) return null
  const all = await allRoleDefaults()
  return all?.get(String(roleId).toUpperCase()) ?? null
}

/** Role ids whose defaults carry an escalation step (the escalation cron's pre-filter). */
export async function rolesWithEscalation(): Promise<string[]> {
  const all = await allRoleDefaults()
  if (!all) return []
  return [...all.values()]
    .filter((r) =>
      Object.values(r.rules.escalation ?? {}).some((e) => e?.push_after_min || e?.email_after_min)
    )
    .map((r) => r.role_id)
}

/** Role ids whose defaults put any category's email in the daily summary. */
export async function rolesWithDailyEmail(): Promise<Set<string>> {
  const all = await allRoleDefaults()
  const out = new Set<string>()
  for (const r of all?.values() ?? [])
    if (Object.values(r.rules.matrix ?? {}).some((m) => m?.email === 'daily'))
      out.add(r.role_id.toUpperCase())
  return out
}

export function bustRoleDefaultsCache(): void {
  cache.delete(currentTenantKey())
}

/** Upsert one role's defaults. `rules` is sanitized here — the one writer. */
export async function saveRoleDefaults(
  roleId: string,
  raw: unknown,
  updatedBy: string | null
): Promise<RoleDefaultsRow> {
  const rules = sanitizeNotifyRules(raw, { allowTeamsMute: false })
  const now = new Date()
  const existing = await db(ROLE_DEFAULTS_TABLE).where({ role_id: roleId }).first('id')
  const values = { rules: JSON.stringify(rules), updated_at: now, updated_by: updatedBy }
  if (existing) await db(ROLE_DEFAULTS_TABLE).where({ role_id: roleId }).update(values)
  else await db(ROLE_DEFAULTS_TABLE).insert({ role_id: roleId, ...values })
  bustRoleDefaultsCache()
  return { role_id: roleId, rules, updated_at: now.toISOString(), updated_by: updatedBy }
}

/** The role delete route lets go first — the FK is NO ACTION. */
export async function forgetRoleNotificationDefaults(roleId: string): Promise<void> {
  try {
    await db(ROLE_DEFAULTS_TABLE).where({ role_id: roleId }).del()
  } catch {
    // table missing — nothing to forget
  }
  bustRoleDefaultsCache()
}

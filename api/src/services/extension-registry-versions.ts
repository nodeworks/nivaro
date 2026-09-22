/**
 * Versioned extension registry (#530) — see migration 338.
 *
 * The ledger is the STABLE part of describeExtensionRegistry: hooks
 * (timing/collection/action), crons (id + expression), registrations by kind,
 * settings keys. Volatile fields (next_run, paused, observed capabilities,
 * staged builds, logs) are left out so a fingerprint only moves when the
 * BUILD changed what it registers. Sorted before hashing so registration
 * order at boot cannot mint a phantom version.
 */
import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'

export interface RegistryLedger {
  hooks: string[]
  crons: string[]
  registrations: Record<string, string[]>
  settings: string[]
}

export function ledgerFrom(desc: Record<string, unknown>): RegistryLedger {
  const hooks = (
    (desc.hooks as Array<{ timing: string; collection: string; action: string }>) ?? []
  )
    .map((h) => `${h.timing} ${h.collection}.${h.action}`)
    .sort()
  const crons = ((desc.crons as Array<{ id: string; expression: string }>) ?? [])
    .map((c) => `${c.id} @ ${c.expression}`)
    .sort()
  const regs: Record<string, string[]> = {}
  for (const [kind, list] of Object.entries((desc.registrations as Record<string, string[]>) ?? {}))
    regs[kind] = [...list].sort()
  const settings = ((desc.settings as Array<{ key: string }>) ?? []).map((s) => s.key).sort()
  return { hooks, crons, registrations: Object.fromEntries(Object.entries(regs).sort()), settings }
}

export function fingerprint(ledger: RegistryLedger): string {
  return createHash('sha256').update(JSON.stringify(ledger)).digest('hex')
}

export interface RegistryVersionRow {
  id: number
  extension: string
  version: number
  fingerprint: string
  app_version: string | null
  first_seen_at: string
  last_seen_at: string
  boots: number
  ledger: RegistryLedger
}

/** Record this boot's ledger: a new version when it changed, a touch when not. Never throws. */
export async function recordRegistryVersion(
  extension: string,
  desc: Record<string, unknown>
): Promise<{ version: number; changed: boolean } | null> {
  try {
    const ledger = ledgerFrom(desc)
    const fp = fingerprint(ledger)
    const latest = (await db('nivaro_extension_registry_versions')
      .where({ extension })
      .orderBy('version', 'desc')
      .first('id', 'version', 'fingerprint')) as
      | { id: number; version: number; fingerprint: string }
      | undefined
    const now = new Date()
    if (latest && latest.fingerprint === fp) {
      await db('nivaro_extension_registry_versions')
        .where({ id: latest.id })
        .update({ last_seen_at: now, app_version: NIVARO_VERSION })
        .increment('boots', 1)
      return { version: latest.version, changed: false }
    }
    const version = (latest?.version ?? 0) + 1
    await db('nivaro_extension_registry_versions').insert({
      extension,
      version,
      fingerprint: fp,
      ledger: JSON.stringify(ledger),
      app_version: NIVARO_VERSION,
      first_seen_at: now,
      last_seen_at: now,
      boots: 1
    })
    return { version, changed: true }
  } catch (err) {
    console.warn(
      `[extension-registry] version record failed for ${extension}:`,
      (err as Error).message
    )
    return null
  }
}

export interface RegistryVersionDiff {
  added: Record<string, string[]>
  removed: Record<string, string[]>
  total: number
}

export function diffLedgers(
  before: RegistryLedger | null,
  after: RegistryLedger
): RegistryVersionDiff {
  const added: Record<string, string[]> = {}
  const removed: Record<string, string[]> = {}
  const kinds = new Set<string>([
    'hooks',
    'crons',
    'settings',
    ...Object.keys(after.registrations),
    ...Object.keys(before?.registrations ?? {})
  ])
  let total = 0
  for (const k of kinds) {
    const a =
      k === 'hooks' || k === 'crons' || k === 'settings' ? after[k] : (after.registrations[k] ?? [])
    const b = before
      ? k === 'hooks' || k === 'crons' || k === 'settings'
        ? before[k]
        : (before.registrations[k] ?? [])
      : []
    const bs = new Set(b)
    const as = new Set(a)
    const plus = a.filter((x) => !bs.has(x))
    const minus = b.filter((x) => !as.has(x))
    if (plus.length) added[k] = plus
    if (minus.length) removed[k] = minus
    total += plus.length + minus.length
  }
  return { added, removed, total }
}

export async function registryHistory(
  extension: string
): Promise<Array<RegistryVersionRow & { diff: RegistryVersionDiff }>> {
  const rows = (await db('nivaro_extension_registry_versions')
    .where({ extension })
    .orderBy('version', 'asc')) as Array<
    Omit<RegistryVersionRow, 'ledger' | 'first_seen_at' | 'last_seen_at'> & {
      ledger: string
      first_seen_at: Date
      last_seen_at: Date
    }
  >
  const out: Array<RegistryVersionRow & { diff: RegistryVersionDiff }> = []
  let prev: RegistryLedger | null = null
  for (const r of rows) {
    const ledger = JSON.parse(r.ledger) as RegistryLedger
    out.push({
      ...r,
      ledger,
      first_seen_at: new Date(r.first_seen_at).toISOString(),
      last_seen_at: new Date(r.last_seen_at).toISOString(),
      diff: diffLedgers(prev, ledger)
    })
    prev = ledger
  }
  return out.reverse()
}

import { adminBaseUrl } from '../../../admin-base.js'
import { db } from '../../../db/index.js'
import { NIVARO_VERSION } from '../../../version.js'
import { type DriftFacts, type DriftFinding, evaluateDrift, newestVersion } from './rules.js'
import { type FleetSettings, loadFleetSettings } from './settings.js'
import { ALERTS, lastDeploys, listProbeTargets, readFleetStatus } from './store.js'

/**
 * Version drift alerts (cron hub-fleet-alerts, every 15 minutes, Hub only). Evaluates the rules in
 * the fleet settings (rules.ts) over the status snapshot the probe job keeps, then:
 *
 *  - a finding with no open alert (same rule + subject) opens one and is told ONCE to the app's
 *    owners and every Hub administrator — one notification per person per tick, however many
 *    alerts opened (a burst after a release never floods anyone);
 *  - a finding with an open alert refreshes it (last_seen_at, message);
 *  - an open alert whose finding is gone is resolved (resolved_at) — nobody is told; the chip on
 *    the fleet page simply goes.
 *
 * Only environments the probe job has a version for take part: an unknown version never fires.
 */

export interface AlertDeps {
  now?: Date
  settings?: FleetSettings
  /** Active Hub administrators (people). */
  admins?: () => Promise<string[]>
  notify?: (
    userId: string,
    note: { subject: string; message: string; url: string }
  ) => Promise<void>
}

export interface AlertTickResult {
  findings: number
  opened: number
  resolved: number
  notified: number
}

async function gatherFacts(): Promise<{ facts: DriftFacts[]; newest: string | null }> {
  const targets = await listProbeTargets()
  const status = await readFleetStatus()
  const newest = newestVersion([NIVARO_VERSION, ...[...status.values()].map((s) => s.version)])
  const { lastSuccess } = await lastDeploys(targets.map((t) => t.id))
  const facts: DriftFacts[] = []
  for (const t of targets) {
    const st = status.get(t.id)
    if (!st?.version) continue
    const success = lastSuccess.get(t.id)?.finished_at ?? null
    const since = st.version_since
    const deployedAt =
      success && since
        ? new Date(success).getTime() >= new Date(since).getTime()
          ? success
          : since
        : (success ?? since)
    facts.push({
      app_id: t.app_id,
      app_key: t.app_key,
      environment_id: t.id,
      env_key: t.key,
      version: st.version,
      deployed_at: deployedAt
    })
  }
  return { facts, newest }
}

async function defaultAdmins(): Promise<string[]> {
  const { activeAdminIds } = await import('../../infra-drift/store.js')
  return activeAdminIds()
}

async function defaultNotify(
  userId: string,
  note: { subject: string; message: string; url: string }
): Promise<void> {
  const { getApp } = await import('../../io-holder.js')
  const app = getApp()
  if (!app) return
  const { notifyUser } = await import('../../notification-channels.js')
  await notifyUser(app, userId, {
    subject: note.subject,
    message: note.message,
    category: 'system',
    target: { kind: 'external', url: note.url, action: 'review' },
    source: { kind: 'hub_fleet', label: 'Hub fleet' },
    why: 'You own one of these apps or administer this Hub; the fleet alert rules (Apps → Fleet) said so.'
  })
}

const key = (rule: string, subject: string) => `${rule}\u0001${subject}`

/** Owners per app id. */
async function ownersOf(appIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (!appIds.length) return out
  const rows = (await db('nivaro_hub_app_owners')
    .whereIn('app_id', appIds)
    .select('app_id', 'user_id')) as Array<{ app_id: number; user_id: string }>
  for (const r of rows)
    out.set(Number(r.app_id), [...(out.get(Number(r.app_id)) ?? []), String(r.user_id)])
  return out
}

export async function runFleetAlertTick(deps: AlertDeps = {}): Promise<AlertTickResult> {
  const now = deps.now ?? new Date()
  const settings = deps.settings ?? (await loadFleetSettings())
  const { facts, newest } = await gatherFacts()
  const findings = evaluateDrift(settings.rules, facts, newest, now)

  const open = (await db(ALERTS).whereNull('resolved_at').select('*')) as Array<
    Record<string, unknown>
  >
  const openByKey = new Map(open.map((a) => [key(String(a.rule_id), String(a.subject_key)), a]))
  const seen = new Set<string>()
  const opened: DriftFinding[] = []

  for (const f of findings) {
    const k = key(f.rule_id, f.subject_key)
    if (seen.has(k)) continue
    seen.add(k)
    const existing = openByKey.get(k)
    if (existing) {
      await db(ALERTS)
        .where({ id: existing.id as number })
        .update({
          last_seen_at: now,
          message: f.message.slice(0, 1000),
          environment_id: f.environment_id,
          app_id: f.app_id
        })
    } else {
      await db(ALERTS).insert({
        rule_id: f.rule_id,
        kind: f.kind,
        subject_key: f.subject_key.slice(0, 200),
        app_id: f.app_id,
        environment_id: f.environment_id,
        message: f.message.slice(0, 1000),
        opened_at: now,
        last_seen_at: now
      })
      opened.push(f)
    }
  }

  const gone = open.filter((a) => !seen.has(key(String(a.rule_id), String(a.subject_key))))
  for (const a of gone)
    await db(ALERTS)
      .where({ id: a.id as number })
      .update({ resolved_at: now })

  let notified = 0
  if (opened.length) {
    const admins = await (deps.admins ?? defaultAdmins)().catch(() => [] as string[])
    const owners = await ownersOf([...new Set(opened.map((f) => f.app_id))])
    // Person → the alerts they hear about (owners: their apps; admins: all).
    const perPerson = new Map<string, DriftFinding[]>()
    const add = (uid: string, f: DriftFinding) => {
      const id = uid.toLowerCase()
      const list = perPerson.get(id) ?? []
      if (!list.includes(f)) list.push(f)
      perPerson.set(id, list)
    }
    for (const f of opened) {
      for (const uid of owners.get(f.app_id) ?? []) add(uid, f)
      for (const uid of admins) add(uid, f)
    }
    const url = `${adminBaseUrl() ?? ''}/hub/fleet`
    const notify = deps.notify ?? defaultNotify
    for (const [uid, list] of perPerson) {
      const subject =
        list.length === 1
          ? `Version drift: ${list[0].message.split(' ')[0].replace(/[:,]$/, '')}`
          : `Version drift: ${list.length} new fleet alerts`
      const lines = list.slice(0, 6).map((f) => f.message)
      if (list.length > lines.length) lines.push(`…and ${list.length - lines.length} more`)
      try {
        await notify(uid, {
          subject: subject.slice(0, 255),
          message: lines.join(' ').slice(0, 1000),
          url
        })
        notified++
      } catch {
        /* one person's delivery never stops the rest */
      }
    }
    await db(ALERTS).whereNull('resolved_at').whereNull('notified_at').update({ notified_at: now })
  }

  return { findings: findings.length, opened: opened.length, resolved: gone.length, notified }
}

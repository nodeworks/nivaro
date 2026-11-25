import { db } from '../../../db/index.js'
import { type FleetNotifier, fleetNotify, fleetUrl, hubAdminIds } from './notify.js'
import { loadKnownReleases, refreshRegistryCache } from './releases.js'
import { type DriftFacts, evaluateDrift } from './rules.js'
import {
  type FleetSettings,
  type FleetState,
  loadFleetSettings,
  loadFleetState,
  saveFleetState
} from './settings.js'
import {
  ALERTS,
  busyEnvironments,
  lastDeploys,
  listProbeTargets,
  readFleetStatus
} from './store.js'

/**
 * Version drift alerts (cron hub-fleet-alerts every 15 minutes, or Check now; Hub only; one pass at
 * a time through the nvr:hub:fleet-alerts lock). Evaluates the enabled rules (all ship off) over
 * the status snapshot the probe job keeps and the releases the Hub knows (releases.ts):
 *
 *  - one open alert per rule + environment: a finding with none opens one, a finding with one
 *    refreshes it;
 *  - an open alert is resolved only when its environment was evaluated and the finding is gone, or
 *    its rule was turned off. An environment a Hub run is busy with (a promotion, an open move) or
 *    that is not active is left as it is, so a move never resolves and re-opens its alerts;
 *  - every open alert not yet told (notified_at empty) is told to the app's owners and every Hub
 *    administrator: one notification per person per pass. A rule's FIRST pass after it was turned
 *    on sends one summary line for that rule instead of a line per environment. If the
 *    administrators cannot be read, nothing is stamped and the next pass tries again.
 */

export interface AlertDeps {
  now?: Date
  settings?: FleetSettings
  admins?: () => Promise<string[]>
  notify?: FleetNotifier
  known?: () => Promise<string[]>
  busy?: () => Promise<Set<number>>
  /** Refresh the cached registry tags (default: the hourly refresh); tests pass a no-op. */
  refreshRegistry?: (now: Date) => Promise<FleetState | null>
}

export interface AlertTickResult {
  findings: number
  opened: number
  resolved: number
  notified: number
}

const RULE_LABEL: Record<string, string> = {
  behind_newest: 'Releases behind the newest',
  pair_apart: 'Two environments apart',
  stale_deploy: 'Not deployed for days'
}

async function gatherFacts(): Promise<DriftFacts[]> {
  const targets = await listProbeTargets()
  const status = await readFleetStatus(targets.map((t) => t.id))
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
  return facts
}

const key = (rule: string, subject: string) => `${rule}\u0001${subject}`

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

interface OpenAlert {
  id: number
  rule_id: string
  kind: string
  subject_key: string
  app_id: number
  environment_id: number | null
  message: string
  notified: boolean
}

export async function runFleetAlertTick(deps: AlertDeps = {}): Promise<AlertTickResult> {
  const now = deps.now ?? new Date()
  const settings = deps.settings ?? (await loadFleetSettings())
  if (deps.refreshRegistry) await deps.refreshRegistry(now)
  else await refreshRegistryCache(now).catch(() => null)
  const state = await loadFleetState()
  const known = await (deps.known ?? (() => loadKnownReleases(state)))()
  const busy = await (deps.busy ?? busyEnvironments)()
  const facts = (await gatherFacts()).filter((f) => !busy.has(f.environment_id))
  const evaluated = new Set(facts.map((f) => f.environment_id))
  const enabled = new Set(settings.rules.filter((r) => r.enabled).map((r) => r.id))
  const findings = evaluateDrift(settings.rules, facts, known, now)

  const open = (
    (await db(ALERTS).whereNull('resolved_at').select('*')) as Array<Record<string, unknown>>
  ).map(
    (a): OpenAlert => ({
      id: Number(a.id),
      rule_id: String(a.rule_id),
      kind: String(a.kind),
      subject_key: String(a.subject_key),
      app_id: Number(a.app_id),
      environment_id: a.environment_id == null ? null : Number(a.environment_id),
      message: String(a.message),
      notified: a.notified_at != null
    })
  )
  const openByKey = new Map(open.map((a) => [key(a.rule_id, a.subject_key), a]))
  const seen = new Set<string>()
  let opened = 0

  for (const f of findings) {
    const k = key(f.rule_id, f.subject_key)
    if (seen.has(k)) continue
    seen.add(k)
    const existing = openByKey.get(k)
    if (existing) {
      await db(ALERTS)
        .where({ id: existing.id })
        .update({ last_seen_at: now, message: f.message.slice(0, 1000) })
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
      opened++
    }
  }

  // Resolve only what was really looked at (or whose rule is off now).
  const gone = open.filter((a) => {
    if (seen.has(key(a.rule_id, a.subject_key))) return false
    if (!enabled.has(a.rule_id)) return true
    return a.environment_id != null && evaluated.has(a.environment_id)
  })
  for (const a of gone) await db(ALERTS).where({ id: a.id }).update({ resolved_at: now })

  const notified = await tellUntold(now, state, enabled, deps)
  return { findings: findings.length, opened, resolved: gone.length, notified }
}

/** Every open alert nobody was told about yet: one notification per person. */
async function tellUntold(
  now: Date,
  state: FleetState,
  enabled: Set<string>,
  deps: AlertDeps
): Promise<number> {
  const untold = (await db(ALERTS)
    .whereNull('resolved_at')
    .whereNull('notified_at')
    .limit(500)
    .select('id', 'rule_id', 'kind', 'app_id', 'message')) as Array<{
    id: number
    rule_id: string
    kind: string
    app_id: number
    message: string
  }>
  const armedBefore = new Set(state.armed_rules)
  const nextArmed = [...enabled]
  const saveArmed = async () => {
    if (nextArmed.join('\u0001') !== state.armed_rules.join('\u0001'))
      await saveFleetState({ ...state, armed_rules: nextArmed }).catch(() => {})
  }
  if (!untold.length) {
    await saveArmed()
    return 0
  }
  let admins: string[]
  try {
    admins = await (deps.admins ?? hubAdminIds)()
  } catch {
    // Untold rows stay untold: the next pass tries again (rules not marked armed either).
    return 0
  }
  const owners = await ownersOf([...new Set(untold.map((a) => Number(a.app_id)))])
  const perPerson = new Map<string, typeof untold>()
  const add = (uid: string, a: (typeof untold)[number]) => {
    const id = uid.toLowerCase()
    const list = perPerson.get(id) ?? []
    if (!list.includes(a)) list.push(a)
    perPerson.set(id, list)
  }
  for (const a of untold) {
    for (const uid of owners.get(Number(a.app_id)) ?? []) add(uid, a)
    for (const uid of admins) add(uid, a)
  }
  const url = await fleetUrl()
  const notify = deps.notify ?? fleetNotify
  let sent = 0
  for (const [uid, list] of perPerson) {
    // First pass of a newly armed rule: one summary line for that rule.
    const lines: string[] = []
    const byRule = new Map<string, typeof list>()
    for (const a of list) byRule.set(a.rule_id, [...(byRule.get(a.rule_id) ?? []), a])
    for (const [ruleId, items] of byRule) {
      if (!armedBefore.has(ruleId) && items.length > 1)
        lines.push(
          `${RULE_LABEL[items[0].kind] ?? ruleId} (just turned on): ${items.length} environments match.`
        )
      else lines.push(...items.map((a) => a.message))
    }
    const shown = lines.slice(0, 6)
    if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`)
    const subject =
      list.length === 1
        ? 'Version drift: 1 new fleet alert'
        : `Version drift: ${list.length} new fleet alerts`
    try {
      await notify(uid, { kind: 'drift', subject, message: shown.join(' '), url })
      sent++
    } catch {
      /* one person's delivery never stops the rest */
    }
  }
  await db(ALERTS)
    .whereIn(
      'id',
      untold.map((a) => a.id)
    )
    .update({ notified_at: now })
  await saveArmed()
  return sent
}

import { adminBaseUrl } from '../../../admin-base.js'
import { db } from '../../../db/index.js'
import { type FleetSettings, loadFleetSettings, targetFor } from './settings.js'
import { REPORTS, uptimeCounts } from './store.js'
import { monthBounds, previousMonth, sloFigures, toBp } from './uptime.js'

/**
 * The monthly SLO report (cron hub-slo-report, 07:00 on the 1st, Hub only). For the month just
 * ended (UTC), every environment with samples gets one nivaro_hub_slo_reports row (uptime and the
 * target it was held to, basis points — the row is the month's record even after the samples are
 * pruned). Then, unless the report is switched off in the fleet settings:
 *
 *  - each app's owners get ONE message for their app (in-app + email): every environment's
 *    uptime against its target;
 *  - every Hub administrator gets ONE summary of the whole fleet (how many met, which missed).
 *
 * Idempotent: a month already reported (sent_at set) is never sent again, so a re-run or a
 * second leader only fills in what is missing.
 */

export interface ReportDeps {
  now?: Date
  month?: string
  settings?: FleetSettings
  admins?: () => Promise<string[]>
  notify?: (
    userId: string,
    note: { subject: string; message: string; url: string }
  ) => Promise<void>
}

export interface ReportResult {
  month: string
  environments: number
  missed: number
  notified: number
}

interface EnvLine {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  uptime: number | null
  target: number
  met: boolean | null
  samples: number
}

const pct = (v: number | null) =>
  v === null ? 'no samples' : `${v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} %`

function lineOf(l: EnvLine): string {
  const verdict = l.met === null ? '' : l.met ? ' — met' : ' — missed'
  return `${l.env_key}: ${pct(l.uptime)} (target ${l.target} %)${verdict}`
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
    category: 'reports',
    channels: { inapp: true, email: true },
    target: { kind: 'external', url: note.url },
    source: { kind: 'hub_slo_report', label: 'Monthly SLO report' },
    why: 'You own this app (or administer this Hub); the Hub sends its uptime report on the 1st of every month.'
  })
}

export async function runSloReport(deps: ReportDeps = {}): Promise<ReportResult> {
  const now = deps.now ?? new Date()
  const month = deps.month ?? previousMonth(now)
  const bounds = monthBounds(month)
  if (!bounds) throw new Error(`Bad month ${month}`)
  const settings = deps.settings ?? (await loadFleetSettings())

  const envs = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .orderBy('a.key', 'asc')
    .orderBy('e.position', 'asc')
    .select('e.id', 'e.app_id', 'e.key', 'a.key as app_key', 'a.name as app_name')) as Array<
    Record<string, unknown>
  >
  const counts = await uptimeCounts(
    envs.map((e) => Number(e.id)),
    bounds.from,
    bounds.to
  )
  const existing = (await db(REPORTS)
    .where({ month })
    .select('environment_id', 'sent_at')) as Array<{
    environment_id: number
    sent_at: unknown
  }>
  const known = new Map(existing.map((r) => [Number(r.environment_id), r.sent_at != null]))

  const lines: EnvLine[] = []
  for (const e of envs) {
    const id = Number(e.id)
    const c = counts.get(id)
    if (!c?.samples) continue
    const target = targetFor(settings, id)
    const f = sloFigures(c, target)
    const line: EnvLine = {
      app_id: Number(e.app_id),
      app_key: String(e.app_key),
      app_name: String(e.app_name),
      environment_id: id,
      env_key: String(e.key),
      uptime: f.uptime,
      target,
      met: f.met,
      samples: c.samples
    }
    if (!known.has(id)) {
      await db(REPORTS).insert({
        month,
        app_id: line.app_id,
        environment_id: id,
        samples: c.samples,
        up_samples: c.up,
        uptime_bp: f.uptime === null ? null : toBp(f.uptime),
        target_bp: toBp(target),
        met: f.met,
        created_at: now
      })
    }
    // Already told about this environment's month: left out of the messages.
    if (known.get(id)) continue
    lines.push(line)
  }

  let notified = 0
  const missed = lines.filter((l) => l.met === false)
  if (settings.report_enabled && lines.length) {
    const notify = deps.notify ?? defaultNotify
    const url = `${adminBaseUrl() ?? ''}/hub/fleet`
    const byApp = new Map<number, EnvLine[]>()
    for (const l of lines) byApp.set(l.app_id, [...(byApp.get(l.app_id) ?? []), l])
    const owners = (await db('nivaro_hub_app_owners')
      .whereIn('app_id', [...byApp.keys()])
      .select('app_id', 'user_id')) as Array<{ app_id: number; user_id: string }>
    for (const [appId, list] of byApp) {
      const miss = list.filter((l) => l.met === false).length
      const subject = `${list[0].app_name}: uptime for ${month}${miss ? ` — ${miss} missed the target` : ''}`
      const message = list.map(lineOf).join('; ')
      for (const o of owners.filter((x) => Number(x.app_id) === appId)) {
        try {
          await notify(String(o.user_id), { subject: subject.slice(0, 255), message, url })
          notified++
        } catch {
          /* next person */
        }
      }
    }
    const admins = await (deps.admins ?? defaultAdmins)().catch(() => [] as string[])
    if (admins.length) {
      const met = lines.filter((l) => l.met === true).length
      const subject = `Hub uptime for ${month}: ${met} of ${lines.length} environments met their target`
      const message = missed.length
        ? `Missed: ${missed
            .slice(0, 10)
            .map((l) => `${l.app_key}/${lineOf(l)}`)
            .join('; ')}${missed.length > 10 ? `; …and ${missed.length - 10} more` : ''}`
        : 'Every environment met its target.'
      for (const uid of admins) {
        try {
          await notify(uid, {
            subject: subject.slice(0, 255),
            message: message.slice(0, 1000),
            url
          })
          notified++
        } catch {
          /* next person */
        }
      }
    }
  }
  if (lines.length)
    await db(REPORTS)
      .where({ month })
      .whereIn(
        'environment_id',
        lines.map((l) => l.environment_id)
      )
      .update({ sent_at: now })

  return { month, environments: lines.length, missed: missed.length, notified }
}

/** Stored monthly rows (newest month first), optionally for some environments only. */
export async function listSloReports(envIds: number[] | null, limit = 500) {
  const q = db(REPORTS).orderBy('month', 'desc').orderBy('environment_id', 'asc').limit(limit)
  if (envIds) {
    if (!envIds.length) return []
    q.whereIn('environment_id', envIds.slice(0, 1000))
  }
  const rows = (await q.select('*')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    month: String(r.month),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    samples: Number(r.samples),
    up_samples: Number(r.up_samples),
    uptime: r.uptime_bp == null ? null : Number(r.uptime_bp) / 100,
    target: Number(r.target_bp) / 100,
    met: r.met == null ? null : r.met === true || r.met === 1 || r.met === '1',
    sent: r.sent_at != null
  }))
}

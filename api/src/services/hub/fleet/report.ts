import { db } from '../../../db/index.js'
import { type FleetNotifier, fleetNotify, fleetUrl, hubAdminIds } from './notify.js'
import {
  type FleetSettings,
  loadFleetSettings,
  loadFleetState,
  saveFleetState,
  targetFor
} from './settings.js'
import { HOURS, REPORTS, uptimeCounts } from './store.js'
import { monthBounds, monthOf, previousMonth, sloFigures, toBp } from './uptime.js'

/**
 * The monthly SLO report (cron hub-slo-report, 07:00 UTC on the 1st with 72 hours of catch-up;
 * Hub only). Every ended month that has uptime hours and is not reported yet (up to
 * MAX_CATCH_UP_MONTHS back) is reported: each environment with samples gets one
 * nivaro_hub_slo_reports row (uptime and the target it was held to, basis points — the month's
 * record for good). Then, unless the report is switched off in the fleet settings:
 *
 *  - each app's owners get ONE message for their app (in-app + email);
 *  - every Hub administrator gets ONE summary of the whole fleet for the month.
 *
 * At most once: an app's rows are stamped sent BEFORE its owners are told, and a month is marked
 * summarised in the fleet state before the administrators are told — a crash part-way never tells
 * anyone twice (it may leave someone untold, which is the cheaper mistake).
 */

export const MAX_CATCH_UP_MONTHS = 12

export interface ReportDeps {
  now?: Date
  /** Report this one month only (tests, a manual re-run). */
  month?: string
  settings?: FleetSettings
  admins?: () => Promise<string[]>
  notify?: FleetNotifier
}

export interface ReportResult {
  month: string
  months: string[]
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
}

const pct = (v: number | null) =>
  v === null ? 'no samples' : `${Number(v.toFixed(v >= 99.9 ? 3 : 2))} %`

function lineOf(l: EnvLine): string {
  const verdict = l.met === null ? '' : l.met ? ' — met' : ' — missed'
  return `${l.env_key}: ${pct(l.uptime)} (target ${l.target} %)${verdict}`
}

/** Ended months with hours stored, oldest first, at most MAX_CATCH_UP_MONTHS back. */
async function monthsToReport(now: Date): Promise<string[]> {
  const last = previousMonth(now)
  const earliest = (await db(HOURS).min({ at: 'hour' }).first()) as { at: unknown } | undefined
  if (!earliest?.at) return [last]
  const first = monthOf(
    new Date(String(earliest.at instanceof Date ? earliest.at.toISOString() : earliest.at))
  )
  const out: string[] = []
  let d = new Date(`${last}-01T00:00:00.000Z`)
  for (let i = 0; i < MAX_CATCH_UP_MONTHS; i++) {
    const m = monthOf(d)
    if (m < first) break
    out.unshift(m)
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
  }
  return out.length ? out : [last]
}

export async function runSloReport(deps: ReportDeps = {}): Promise<ReportResult> {
  const now = deps.now ?? new Date()
  const settings = deps.settings ?? (await loadFleetSettings())
  const months = deps.month ? [deps.month] : await monthsToReport(now)
  let environments = 0
  let missed = 0
  let notified = 0
  for (const month of months) {
    const r = await reportMonth(month, now, settings, deps)
    environments += r.environments
    missed += r.missed
    notified += r.notified
  }
  return { month: months[months.length - 1], months, environments, missed, notified }
}

async function reportMonth(
  month: string,
  now: Date,
  settings: FleetSettings,
  deps: ReportDeps
): Promise<{ environments: number; missed: number; notified: number }> {
  const bounds = monthBounds(month)
  if (!bounds) throw new Error(`Bad month ${month}`)
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
    .select('environment_id', 'sent_at')) as Array<{ environment_id: number; sent_at: unknown }>
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
      met: f.met
    }
    if (!known.has(id)) {
      try {
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
      } catch {
        // Another leader stored it first: its sent_at decides below.
        continue
      }
    }
    if (known.get(id)) continue
    lines.push(line)
  }

  const missed = lines.filter((l) => l.met === false)
  let notified = 0
  if (!lines.length) return { environments: 0, missed: 0, notified }
  if (!settings.report_enabled) {
    await stampSent(
      month,
      lines.map((l) => l.environment_id),
      now
    )
    return { environments: lines.length, missed: missed.length, notified }
  }
  const notify = deps.notify ?? fleetNotify
  const url = await fleetUrl()
  const byApp = new Map<number, EnvLine[]>()
  for (const l of lines) byApp.set(l.app_id, [...(byApp.get(l.app_id) ?? []), l])
  const owners = (await db('nivaro_hub_app_owners')
    .whereIn('app_id', [...byApp.keys()])
    .select('app_id', 'user_id')) as Array<{ app_id: number; user_id: string }>
  for (const [appId, list] of byApp) {
    // Stamped first: a crash below never tells these owners twice.
    await stampSent(
      month,
      list.map((l) => l.environment_id),
      now
    )
    const miss = list.filter((l) => l.met === false).length
    const subject = `${list[0].app_name}: uptime for ${month}${miss ? ` — ${miss} missed the target` : ''}`
    const message = list.map(lineOf).join('; ')
    for (const o of owners.filter((x) => Number(x.app_id) === appId)) {
      try {
        await notify(String(o.user_id), { kind: 'slo_report', subject, message, url })
        notified++
      } catch {
        /* next person */
      }
    }
  }

  const state = await loadFleetState()
  if (!state.summarised_months.includes(month)) {
    let admins: string[] | null = null
    try {
      admins = await (deps.admins ?? hubAdminIds)()
    } catch {
      admins = null // not marked: the next run (catch-up) sends the summary
    }
    if (admins) {
      await saveFleetState({
        ...state,
        summarised_months: [...state.summarised_months, month].slice(-36)
      })
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
          await notify(uid, { kind: 'slo_report', subject, message, url })
          notified++
        } catch {
          /* next person */
        }
      }
    }
  }
  return { environments: lines.length, missed: missed.length, notified }
}

async function stampSent(month: string, envIds: number[], now: Date): Promise<void> {
  for (let i = 0; i < envIds.length; i += 500)
    await db(REPORTS)
      .where({ month })
      .whereIn('environment_id', envIds.slice(i, i + 500))
      .update({ sent_at: now })
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

import { db } from '../../../db/index.js'
import { deliverHubNotice, type NotifyDeps } from '../notify-events.js'
import { activeWindow, listFreezes, nextWindow } from '../releases/freeze.js'
import { listSchedules } from '../releases/schedules.js'
import { bandOf, currentHealth, type EnvHealth } from './health.js'
import { loadInsightSettings } from './settings.js'

/**
 * Weekly Hub digest (enhancement 39): one email per app OWNER (nivaro_hub_app_owners) about their
 * apps — last week's deploys, incidents, open drift alerts, the health score against a week ago —
 * and what is coming: scheduled promotes and freeze windows of the next 14 days.
 *
 *  - cron hub-insight-digest, Mondays 12:00 UTC (≈ 7–8 AM Eastern), 48 h catch-up;
 *  - the whole digest can be switched off in the insight settings; each person turns their own
 *    off in Apps → Health (nivaro_hub_digest_prefs); a person never gets one for a week twice:
 *    the (user, week) row in nivaro_hub_digest_sends is CLAIMED before the send (unique index),
 *    so two leaders or a catch-up run can never both send it;
 *  - the email is the `hub_weekly_digest` template, which wears the Hub mail layout on a
 *    standalone Hub (services/mail.ts mailChrome) and is sent under the person's notification
 *    rules (category reports); an in-app notice goes through deliverHubNotice.
 *
 * Only owners get it: administrators already get every alert, and the digest names only the
 * apps the person owns, so it never shows them anything their Hub pages would not.
 */

const DAY_MS = 86_400_000

/** Monday (UTC) of the ISO week `now` falls in: the digest's key. Pure. */
export function digestWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - dow * DAY_MS).toISOString().slice(0, 10)
}

export interface DigestApp {
  app_id: number
  name: string
  url: string
  deploys: Array<{ env: string; kind: string; version: string; status: string; at: string | null }>
  incidents: Array<{ title: string; severity: string; status: string; at: string | null }>
  drift: Array<{ env: string; message: string }>
  health: Array<{
    env: string
    score: number | null
    band: string | null
    was: number | null
    change: number | null
  }>
  upcoming: Array<{ what: string; when: string }>
}

export interface Digest {
  user_id: string
  week: string
  apps: DigestApp[]
  /** Nothing happened and nothing is coming: the email says so in one line. */
  quiet: boolean
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

async function ownedApps(
  userId: string
): Promise<Array<{ id: number; name: string; key: string }>> {
  return (
    (await db('nivaro_hub_app_owners as o')
      .join('nivaro_hub_apps as a', 'a.id', 'o.app_id')
      .where('o.user_id', userId)
      .orderBy('a.key', 'asc')
      .select('a.id', 'a.name', 'a.key')) as Array<{ id: number; name: string; key: string }>
  ).map((a) => ({ id: Number(a.id), name: String(a.name || a.key), key: String(a.key) }))
}

async function incidentsOf(
  appIds: number[],
  since: Date
): Promise<Map<number, DigestApp['incidents']>> {
  const out = new Map<number, DigestApp['incidents']>()
  // The incident tables arrive with the incident enhancement; a Hub without them has none.
  if (!appIds.length || !(await db.schema.hasTable('nivaro_hub_incidents'))) return out
  const rows = (await db('nivaro_hub_incidents')
    .whereIn('app_id', appIds)
    .where((w) => {
      w.where('opened_at', '>=', since).orWhereNot('status', 'resolved')
    })
    .orderBy('opened_at', 'desc')
    .limit(200)
    .select('app_id', 'title', 'severity', 'status', 'opened_at')) as Array<Record<string, unknown>>
  for (const r of rows) {
    const list = out.get(Number(r.app_id)) ?? []
    if (list.length < 10)
      list.push({
        title: String(r.title ?? '').slice(0, 200),
        severity: String(r.severity ?? ''),
        status: String(r.status ?? ''),
        at: iso(r.opened_at)
      })
    out.set(Number(r.app_id), list)
  }
  return out
}

export interface DigestDeps {
  health?: (who: { userId: string; isAdmin: boolean }) => Promise<EnvHealth[]>
  adminBase?: () => string
}

/** One person's digest for the week ending `now` (null = they own no apps). */
export async function buildDigest(
  userId: string,
  now = new Date(),
  deps: DigestDeps = {}
): Promise<Digest | null> {
  const apps = await ownedApps(userId)
  if (!apps.length) return null
  const appIds = apps.map((a) => a.id)
  const since = new Date(now.getTime() - 7 * DAY_MS)
  const horizon = now.getTime() + 14 * DAY_MS
  const base = (deps.adminBase?.() ?? '').replace(/\/+$/, '')

  const envKeys = new Map(
    (
      (await db('nivaro_hub_environments').whereIn('app_id', appIds).select('id', 'key')) as Array<{
        id: number
        key: string
      }>
    ).map((e) => [Number(e.id), String(e.key)])
  )
  const deploys = (await db('nivaro_hub_deploys')
    .whereIn('app_id', appIds)
    .where('started_at', '>=', since)
    .orderBy('id', 'desc')
    .limit(300)
    .select(
      'app_id',
      'environment_id',
      'kind',
      'version',
      'status',
      'started_at',
      'finished_at'
    )) as Array<Record<string, unknown>>
  const drift = (await db('nivaro_hub_fleet_alerts')
    .whereIn('app_id', appIds)
    .whereNull('resolved_at')
    .select('app_id', 'environment_id', 'message')) as Array<Record<string, unknown>>
  const incidents = await incidentsOf(appIds, since)
  const health = await (deps.health ?? ((w) => currentHealth(w)))({ userId, isAdmin: false })
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10)

  const freezes = await listFreezes()
  const schedules = await listSchedules({ appIds, limit: 200 })

  const out: DigestApp[] = []
  for (const a of apps) {
    const upcoming: DigestApp['upcoming'] = []
    for (const s of schedules) {
      if (s.app_id !== a.id || !['scheduled', 'waiting'].includes(s.status)) continue
      const t = Date.parse(s.run_at)
      if (!Number.isFinite(t) || t < now.getTime() || t > horizon) continue
      const env = s.environment_id != null ? envKeys.get(s.environment_id) : null
      upcoming.push({
        what:
          s.kind === 'train'
            ? `Release train ${s.version}`
            : `Promote ${s.version}${env ? ` to ${env}` : ''}`,
        when: new Date(t).toISOString()
      })
    }
    for (const f of freezes) {
      if (f.app_id != null && f.app_id !== a.id) continue
      const w = activeWindow(f, now.getTime()) ?? nextWindow(f, now.getTime())
      if (!w || w.start > horizon) continue
      upcoming.push({
        what: `Freeze: ${f.name}${w.start <= now.getTime() ? ' (in force now)' : ''}`,
        when: new Date(Math.max(w.start, now.getTime())).toISOString()
      })
    }
    upcoming.sort((x, y) => x.when.localeCompare(y.when))
    out.push({
      app_id: a.id,
      name: a.name,
      url: `${base}/hub?app=${a.id}`,
      deploys: deploys
        .filter((d) => Number(d.app_id) === a.id)
        .slice(0, 15)
        .map((d) => ({
          env: envKeys.get(Number(d.environment_id)) ?? '',
          kind: String(d.kind),
          version: String(d.version),
          status: String(d.status),
          at: iso(d.finished_at ?? d.started_at)
        })),
      incidents: incidents.get(a.id) ?? [],
      drift: drift
        .filter((d) => Number(d.app_id) === a.id)
        .slice(0, 10)
        .map((d) => ({
          env: d.environment_id == null ? '' : (envKeys.get(Number(d.environment_id)) ?? ''),
          message: String(d.message ?? '').slice(0, 300)
        })),
      health: health
        .filter((h) => h.app_id === a.id)
        .map((h) => {
          const was = [...h.trend].reverse().find((t) => t.day <= weekAgo)?.score ?? null
          return {
            env: h.env_key,
            score: h.score,
            band: bandOf(h.score),
            was,
            change: h.score != null && was != null ? h.score - was : null
          }
        }),
      upcoming: upcoming.slice(0, 10)
    })
  }
  const quiet = out.every(
    (a) => !a.deploys.length && !a.incidents.length && !a.drift.length && !a.upcoming.length
  )
  return { user_id: userId, week: digestWeek(now), apps: out, quiet }
}

/** The person's own switch (default on). */
export async function digestEnabledFor(userId: string): Promise<boolean> {
  const row = (await db('nivaro_hub_digest_prefs').where({ user_id: userId }).first('enabled')) as
    | { enabled: unknown }
    | undefined
  if (!row) return true
  return row.enabled === true || Number(row.enabled) === 1
}

export async function setDigestEnabled(userId: string, enabled: boolean): Promise<void> {
  const hit = (await db('nivaro_hub_digest_prefs').where({ user_id: userId }).first('id')) as
    | { id: number }
    | undefined
  if (hit)
    await db('nivaro_hub_digest_prefs')
      .where({ id: hit.id })
      .update({ enabled, updated_at: new Date() })
  else
    await db('nivaro_hub_digest_prefs').insert({ user_id: userId, enabled, updated_at: new Date() })
}

/** Plain words for one digest (the in-app notice and the email's text part). Pure. */
export function digestSummary(d: Digest): string {
  const deploys = d.apps.reduce((n, a) => n + a.deploys.length, 0)
  const incidents = d.apps.reduce((n, a) => n + a.incidents.length, 0)
  const drift = d.apps.reduce((n, a) => n + a.drift.length, 0)
  if (d.quiet)
    return `A quiet week for your ${d.apps.length === 1 ? 'app' : `${d.apps.length} apps`}: no deploys, incidents or drift.`
  const bits = [
    `${deploys} deploy${deploys === 1 ? '' : 's'}`,
    incidents ? `${incidents} incident${incidents === 1 ? '' : 's'}` : null,
    drift ? `${drift} open drift alert${drift === 1 ? '' : 's'}` : null
  ].filter(Boolean)
  return `Last week on your ${d.apps.length === 1 ? 'app' : `${d.apps.length} apps`}: ${bits.join(', ')}.`
}

export interface SendDeps extends DigestDeps, NotifyDeps {
  sendMail?: (opts: Record<string, unknown>) => Promise<unknown>
  now?: () => Date
}

export interface DigestRunSummary {
  week: string
  owners: number
  sent: number
  skipped: number
  failed: number
}

async function claim(userId: string, week: string, apps: number): Promise<boolean> {
  try {
    await db('nivaro_hub_digest_sends').insert({
      user_id: userId,
      week,
      apps,
      status: 'sending',
      sent_at: new Date()
    })
    return true
  } catch {
    // The unique (user, week) row exists: someone already sends or sent it.
    return false
  }
}

/** The weekly run: every active owner who did not turn theirs off, once per week. */
export async function runWeeklyDigest(deps: SendDeps = {}): Promise<DigestRunSummary> {
  const now = deps.now ? deps.now() : new Date()
  const week = digestWeek(now)
  const summary: DigestRunSummary = { week, owners: 0, sent: 0, skipped: 0, failed: 0 }
  if (!(await loadInsightSettings()).digest.enabled) return summary
  const owners = (await db('nivaro_hub_app_owners as o')
    .join('nivaro_users as u', 'u.id', 'o.user_id')
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .distinct('u.id', 'u.email', 'u.first_name')) as Array<{
    id: unknown
    email: unknown
    first_name: unknown
  }>
  let base = ''
  try {
    base = deps.adminBase
      ? deps.adminBase()
      : ((await import('../../../admin-base.js')).adminBaseUrl() ?? '')
  } catch {
    base = ''
  }
  const send =
    deps.sendMail ??
    (async (opts: Record<string, unknown>) => {
      const { sendMail } = await import('../../mail.js')
      return sendMail(opts as never)
    })
  const seen = new Set<string>()
  for (const o of owners) {
    const userId = String(o.id)
    if (seen.has(userId.toUpperCase())) continue
    seen.add(userId.toUpperCase())
    summary.owners++
    if (!(await digestEnabledFor(userId))) {
      summary.skipped++
      continue
    }
    const already = await db('nivaro_hub_digest_sends').where({ user_id: userId, week }).first('id')
    if (already) {
      summary.skipped++
      continue
    }
    let digest: Digest | null
    try {
      digest = await buildDigest(userId, now, { ...deps, adminBase: () => base })
    } catch {
      summary.failed++
      continue
    }
    if (!digest) {
      summary.skipped++
      continue
    }
    if (!(await claim(userId, week, digest.apps.length))) {
      summary.skipped++
      continue
    }
    let ok = true
    const email = typeof o.email === 'string' ? o.email.trim() : ''
    const text = digestSummary(digest)
    if (email) {
      try {
        await send({
          to: email,
          subject: 'Your apps this week',
          template: 'hub_weekly_digest',
          category: 'reports',
          cadence: 'sender',
          skipDigest: true,
          why: 'you own apps in the Hub. Turn the weekly digest off in Apps → Health.',
          text,
          data: {
            first_name: typeof o.first_name === 'string' ? o.first_name : '',
            week: digest.week,
            quiet: digest.quiet,
            summary: text,
            apps: digest.apps.map((a) => ({
              ...a,
              deploys: a.deploys.map((d) => ({ ...d, when: d.at ? d.at.slice(0, 10) : '' })),
              incidents: a.incidents.map((i) => ({ ...i, when: i.at ? i.at.slice(0, 10) : '' })),
              upcoming: a.upcoming.map((u) => ({
                ...u,
                when: `${u.when.slice(0, 16).replace('T', ' ')} UTC`
              })),
              health: a.health.map((h) => ({
                ...h,
                change_text:
                  h.change == null
                    ? ''
                    : h.change === 0
                      ? 'no change'
                      : `${h.change > 0 ? '+' : ''}${h.change} since last week`
              }))
            })),
            home_url: `${base.replace(/\/+$/, '')}/hub/health`
          }
        })
      } catch {
        ok = false
      }
    }
    await deliverHubNotice(
      [userId],
      {
        subject: 'Your apps this week',
        message: text,
        path: '/hub/health',
        source: { kind: 'hub', label: 'weekly_digest', id: digest.week },
        why: 'You own apps in the Hub. Turn the weekly digest off in Apps → Health.',
        category: 'reports'
      },
      deps
    )
    await db('nivaro_hub_digest_sends')
      .where({ user_id: userId, week })
      .update({ status: ok ? 'sent' : 'failed', sent_at: new Date() })
    if (ok) summary.sent++
    else summary.failed++
  }
  return summary
}

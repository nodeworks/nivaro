import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { plainBannerText } from '../../hub-link/status-banner.js'
import { deliverHubNotice } from '../notify-events.js'
import { hubNotify } from '../providers/notify-hook.js'
import { FREEZES } from '../releases/freeze.js'
import { type BannerCallDeps, type BannerState, pushBanner } from './banner.js'
import { closeIncidentPages, openPage, type PageDeps, pagedUserIds, readPage } from './paging.js'
import {
  activeAdminIds,
  activeOwnerIds,
  addEvent,
  type BannerEnvState,
  type EnvRow,
  envRows,
  type Incident,
  insertIncident,
  patchIncident,
  productionEnvIds,
  readIncident,
  SEVERITIES,
  type Severity
} from './store.js'

/**
 * Incident mode (Hub enhancement 32). Opening an incident for an app (optionally one
 * environment):
 *
 *   1. freezes deploys for the app — one nivaro_hub_freezes row tagged `incident:<id>`, so
 *      EVERY promote / apply / upgrade / move path the freeze engine already guards refuses with
 *      409 FROZEN (a rollback to an older version stays allowed). Lifted when the incident is
 *      resolved, or earlier by an administrator ("Lift freeze") for a fix that must ship;
 *   2. shows a status banner in the app — plain text, over the hub link (banner.ts), to every
 *      signed-in person; on the incident's environment, else on the app's production ones;
 *      refreshed every BANNER_REFRESH_MS while open (the app keeps it 2 h), retried every
 *      BANNER_RETRY_MS while a push fails, cleared on resolve;
 *   3. starts the incident timeline (nivaro_hub_incident_events);
 *   4. pages on-call (paging.ts); an app without a rota tells its owners and the administrators.
 */

export const FREEZE_FOR_MS = 30 * 86_400_000
export const BANNER_REFRESH_MS = 30 * 60_000
export const BANNER_RETRY_MS = 2 * 60_000
export const MAX_BANNER_TRIES = 30

export const SEV_LABEL: Record<Severity, string> = { sev1: 'SEV 1', sev2: 'SEV 2', sev3: 'SEV 3' }

export class IncidentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface IncidentDeps extends PageDeps {
  banner?: BannerCallDeps
  push?: typeof pushBanner
  production?: (appId: number) => Promise<number[]>
}

export interface OpenInput {
  app_id: number
  environment_id: number | null
  title: string
  severity: Severity
  summary: string | null
  banner_text: string | null
  freeze: boolean
  page: boolean
}

export function validateOpen(
  b: Record<string, unknown>
): Omit<OpenInput, 'app_id'> | { error: string } {
  const title = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ') : ''
  if (!title || title.length > 200) return { error: 'title is required (at most 200 characters)' }
  const sev = b.severity == null ? 'sev2' : String(b.severity)
  if (!(SEVERITIES as readonly string[]).includes(sev))
    return { error: 'severity is sev1, sev2 or sev3' }
  let env: number | null = null
  if (b.environment_id != null && b.environment_id !== '') {
    env = Number(b.environment_id)
    if (!Number.isSafeInteger(env) || env <= 0)
      return { error: 'environment_id is an environment of this app' }
  }
  const summary =
    typeof b.summary === 'string' && b.summary.trim() ? b.summary.trim().slice(0, 8000) : null
  let banner: string | null = null
  if (b.banner_text != null && b.banner_text !== '') {
    banner = plainBannerText(b.banner_text)
    if (!banner) return { error: 'banner_text is plain text' }
  }
  return {
    environment_id: env,
    title,
    severity: sev as Severity,
    summary,
    banner_text: banner,
    freeze: b.freeze !== false,
    page: b.page !== false
  }
}

export const toneFor = (s: Severity) => (s === 'sev3' ? 'warn' : 'critical')

/** The environments an incident's banner goes to. */
export async function bannerTargets(
  i: Pick<Incident, 'app_id' | 'environment_id'>,
  deps: IncidentDeps = {}
): Promise<EnvRow[]> {
  const envs = (await envRows(i.app_id)).filter((e) => e.status.toLowerCase() !== 'archived')
  if (i.environment_id != null) return envs.filter((e) => e.id === i.environment_id)
  const prod = new Set(await (deps.production ?? productionEnvIds)(i.app_id))
  return envs.filter((e) => prod.has(e.id))
}

/** Pushes (or clears) the banner on every target; answers the new per-environment state. */
export async function syncBanner(
  i: Incident,
  mode: 'show' | 'clear',
  deps: IncidentDeps = {},
  now = new Date()
): Promise<{ state: Record<string, BannerEnvState>; allDone: boolean }> {
  const push = deps.push ?? pushBanner
  const targets = await bannerTargets(i, deps)
  const prev = i.banner_state ?? {}
  const state: Record<string, BannerEnvState> = {}
  // An environment that showed the banner before (and is no target now) is cleared too.
  const ids = new Set<number>([...targets.map((t) => t.id), ...Object.keys(prev).map(Number)])
  const envs = await envRows(i.app_id)
  const results = await Promise.all(
    [...ids].map(async (id) => {
      const env = envs.find((e) => e.id === id)
      const wantShow = mode === 'show' && targets.some((t) => t.id === id)
      const before = prev[String(id)]
      if (!env) return [id, null] as const
      // Nothing to clear where it never showed.
      if (!wantShow && (!before || before.state === 'cleared' || before.state === 'no_link'))
        return [id, before ?? null] as const
      if (!wantShow && (before?.tries ?? 0) >= MAX_BANNER_TRIES && before?.state !== 'shown')
        return [id, before] as const
      const r: BannerState = wantShow
        ? await push(
            env,
            { text: i.banner_text ?? '', tone: i.banner_tone ?? 'critical', incident_id: i.id },
            deps.banner
          )
        : await push(env, { clear: true, incident_id: i.id }, deps.banner)
      const ok = r === 'shown' || r === 'cleared' || r === 'no_link' || r === 'too_old'
      return [
        id,
        { state: r, at: now.toISOString(), tries: ok ? 0 : (before?.tries ?? 0) + 1 }
      ] as const
    })
  )
  for (const [id, s] of results) if (s) state[String(id)] = s
  const allDone = Object.values(state).every(
    (s) =>
      s.state === (mode === 'show' ? 'shown' : 'cleared') ||
      s.state === 'no_link' ||
      s.state === 'too_old' ||
      (s.tries ?? 0) >= MAX_BANNER_TRIES
  )
  return { state, allDone }
}

function bannerWords(state: Record<string, BannerEnvState>, keys: Map<number, string>): string {
  const parts = Object.entries(state).map(
    ([id, s]) => `${keys.get(Number(id)) ?? id}: ${s.state.replace('_', ' ')}`
  )
  return parts.length ? parts.join(', ') : 'no environment to show it on'
}

async function envKeyMap(appId: number): Promise<Map<number, string>> {
  return new Map((await envRows(appId)).map((e) => [e.id, e.key]))
}

async function appName(appId: number): Promise<string> {
  const a = (await db('nivaro_hub_apps').where({ id: appId }).first('key', 'name')) as
    | { key: string; name: string }
    | undefined
  return a ? String(a.name || a.key) : `app ${appId}`
}

/** Opens an incident (see the header). The route checked the app and the admin. */
export async function openIncident(
  input: OpenInput,
  userId: string,
  deps: IncidentDeps = {}
): Promise<Incident> {
  const now = new Date((deps.now ?? Date.now)())
  if (input.environment_id != null) {
    const env = (await db('nivaro_hub_environments')
      .where({ id: input.environment_id })
      .first('app_id')) as { app_id: number } | undefined
    if (!env || Number(env.app_id) !== input.app_id)
      throw new IncidentError(
        400,
        'BAD_INCIDENT',
        'environment_id is not an environment of this app'
      )
  }
  const id = await insertIncident({
    app_id: input.app_id,
    environment_id: input.environment_id,
    title: input.title,
    severity: input.severity,
    status: 'open',
    summary: input.summary,
    banner_text: input.banner_text,
    banner_tone: input.banner_text ? toneFor(input.severity) : null,
    opened_by: userId || null,
    opened_at: now
  })
  await addEvent(id, 'opened', `${SEV_LABEL[input.severity]} · ${input.title}`, userId, now)
  if (input.freeze) await freezeOn(id, userId, deps)
  let inc = (await readIncident(id)) as Incident
  if (inc.banner_text) inc = await showBanner(inc, userId, deps)
  if (input.page) await pageFor(inc, deps)
  hubNotify('incident.opened', {
    appId: input.app_id,
    envId: input.environment_id,
    detail: input.title,
    link: `/hub/incidents?incident=${id}`,
    dedupKey: `incident:${id}`,
    action: 'open'
  })
  return (await readIncident(id)) as Incident
}

/** The tag on every freeze an incident made (nivaro_hub_freezes.source). */
export const freezeSource = (incidentId: number) => `incident:${incidentId}`

/** The incident's freezes that have not ended, oldest first. */
async function liveFreezes(incidentId: number, now: number): Promise<number[]> {
  const rows = (await db(FREEZES)
    .where({ source: freezeSource(incidentId) })
    .where('ends_at', '>', new Date(now))
    .orderBy('id', 'asc')
    .select('id')) as Array<{ id: number }>
  return rows.map((r) => Number(r.id))
}

/**
 * Freezes deploys for the incident's app (a freeze row the freeze engine judges), idempotent per
 * incident: a freeze still on is kept, and two calls at once (a double click, a freeze racing the
 * open) both insert, then every row but the oldest is ended at once — never an orphan freeze.
 */
export async function freezeOn(id: number, userId: string, deps: IncidentDeps = {}): Promise<void> {
  const inc = await readIncident(id)
  if (!inc) throw new IncidentError(404, 'NOT_FOUND', 'Not found')
  const now = (deps.now ?? Date.now)()
  if ((await liveFreezes(inc.id, now)).length) return
  const mine = Number(
    await insertReturningId(db, FREEZES, {
      app_id: inc.app_id,
      name: `Incident #${inc.id}: ${inc.title}`.slice(0, 120),
      source: freezeSource(inc.id),
      recurrence: 'none',
      starts_at: new Date(now),
      ends_at: new Date(now + FREEZE_FOR_MS),
      days_before: null,
      days_after: null,
      time_zone: null,
      created_by: userId || null,
      created_at: new Date(now),
      updated_at: new Date(now)
    })
  )
  const live = await liveFreezes(inc.id, now)
  const keep = live[0] ?? mine
  const losers = live.filter((x) => x !== keep)
  if (losers.length)
    await db(FREEZES)
      .whereIn('id', losers)
      .update({ ends_at: new Date(now), updated_at: new Date(now) })
  await patchIncident(inc.id, { freeze_id: keep })
  if (keep === mine)
    await addEvent(
      inc.id,
      'freeze',
      'Deploys frozen for this app until the incident is resolved (rollbacks still allowed)',
      userId,
      new Date(now)
    )
}

/** Ends every freeze the incident made, now (a fix must ship, or the incident is over). */
export async function freezeOff(
  inc: Pick<Incident, 'id'>,
  userId: string | null,
  why: string,
  now = new Date()
): Promise<boolean> {
  const n = await db(FREEZES)
    .where({ source: freezeSource(inc.id) })
    .where('ends_at', '>', now)
    .update({ ends_at: now, updated_at: now })
  if (Number(n) > 0) await addEvent(inc.id, 'freeze', why, userId, now)
  return Number(n) > 0
}

/** Whether one of the incident's freezes is on now. */
export async function freezeActive(inc: Pick<Incident, 'id'>, now = Date.now()): Promise<boolean> {
  const rows = (await db(FREEZES)
    .where({ source: freezeSource(inc.id) })
    .where('ends_at', '>', new Date(now))
    .select('starts_at')) as Array<{ starts_at: unknown }>
  return rows.some((r) => new Date(r.starts_at as string).getTime() <= now)
}

/** Shows (or re-pushes) the incident banner and records where it landed. */
export async function showBanner(
  inc: Incident,
  userId: string | null,
  deps: IncidentDeps = {}
): Promise<Incident> {
  const now = new Date((deps.now ?? Date.now)())
  const { state, allDone } = await syncBanner(inc, 'show', deps, now)
  await patchIncident(inc.id, {
    banner_state: state,
    banner_next_at: new Date(now.getTime() + (allDone ? BANNER_REFRESH_MS : BANNER_RETRY_MS))
  })
  await addEvent(
    inc.id,
    'banner',
    `Banner “${inc.banner_text}” — ${bannerWords(state, await envKeyMap(inc.app_id))}`,
    userId,
    now
  )
  return (await readIncident(inc.id)) as Incident
}

/** Removes the banner everywhere it was shown. */
export async function hideBanner(
  inc: Incident,
  userId: string | null,
  deps: IncidentDeps = {},
  log = true
): Promise<Incident> {
  const now = new Date((deps.now ?? Date.now)())
  const { state, allDone } = await syncBanner(inc, 'clear', deps, now)
  await patchIncident(inc.id, {
    banner_state: state,
    banner_next_at: allDone ? null : new Date(now.getTime() + BANNER_RETRY_MS)
  })
  if (log)
    await addEvent(
      inc.id,
      'banner',
      `Banner removed — ${bannerWords(state, await envKeyMap(inc.app_id))}`,
      userId,
      now
    )
  return (await readIncident(inc.id)) as Incident
}

/** Pages on-call for the incident; an app without a rota tells owners + administrators. */
export async function pageFor(inc: Incident, deps: IncidentDeps = {}): Promise<void> {
  const app = await appName(inc.app_id)
  const subject = `Incident (${SEV_LABEL[inc.severity]}): ${app} — ${inc.title}`.slice(0, 200)
  // Only what on-call needs: app, environment, severity, title — never the internal summary.
  const env =
    inc.environment_id == null
      ? null
      : ((await db('nivaro_hub_environments').where({ id: inc.environment_id }).first('key')) as
          | { key: string }
          | undefined)
  const message =
    `${SEV_LABEL[inc.severity]} · ${app}${env ? ` · ${env.key}` : ''}: ${inc.title}`.slice(0, 1000)
  const path = `/hub/incidents?incident=${inc.id}`
  const paged = await openPage(
    {
      app_id: inc.app_id,
      environment_id: inc.environment_id,
      incident_id: inc.id,
      kind: 'incident',
      severity: inc.severity,
      subject,
      message,
      path
    },
    deps
  ).catch(() => null)
  if (paged) {
    await patchIncident(inc.id, { page_id: paged.page_id })
    return
  }
  const people = [
    ...(await (deps.owners ?? activeOwnerIds)(inc.app_id)),
    ...(await (deps.admins ?? activeAdminIds)())
  ]
  const n = await (deps.deliver ?? deliverHubNotice)(
    people,
    {
      subject,
      message,
      path,
      urgent: inc.severity !== 'sev3',
      email: inc.severity !== 'sev3',
      source: { kind: 'hub-incident', label: inc.severity, id: inc.id },
      why: 'You own this app or are a Hub administrator (the app has no on-call rota).'
    },
    deps
  )
  await addEvent(
    inc.id,
    'page',
    `No on-call rota — told the owners and administrators (${n})`,
    null
  )
}

/** Resolves an incident: lifts its freeze, removes its banner, closes its pages. */
export async function resolveIncident(
  id: number,
  userId: string,
  note: string | null,
  deps: IncidentDeps = {}
): Promise<Incident> {
  const inc = await readIncident(id)
  if (!inc) throw new IncidentError(404, 'NOT_FOUND', 'Not found')
  if (inc.status === 'resolved') return inc
  const now = new Date((deps.now ?? Date.now)())
  await patchIncident(id, { status: 'resolved', resolved_by: userId || null, resolved_at: now })
  await addEvent(id, 'resolved', note?.trim() ? note.trim().slice(0, 2000) : null, userId, now)
  await freezeOff(inc, userId, 'Deploy freeze lifted (incident resolved)', now)
  await closeIncidentPages(id, now)
  hubNotify('incident.resolved', {
    appId: inc.app_id,
    envId: inc.environment_id,
    detail: inc.title,
    link: `/hub/incidents?incident=${id}`,
    dedupKey: `incident:${id}`,
    action: 'resolve'
  })
  let after = (await readIncident(id)) as Incident
  if (Object.keys(after.banner_state).length) after = await hideBanner(after, userId, deps)
  // The people who were paged hear that it is over (not urgent).
  const page = inc.page_id != null ? await readPage(inc.page_id) : null
  if (page) {
    const app = await appName(inc.app_id)
    await (deps.deliver ?? deliverHubNotice)(
      pagedUserIds(page),
      {
        subject: `Resolved: ${app} — ${inc.title}`.slice(0, 200),
        message: note?.trim() ? note.trim().slice(0, 1000) : 'The incident was resolved.',
        path: `/hub/incidents?incident=${id}`,
        source: { kind: 'hub-incident', label: 'resolved', id },
        why: 'You were paged for this incident.'
      },
      deps
    ).catch(() => 0)
  }
  return (await readIncident(id)) as Incident
}

/** The banner work the minute tick does: refresh open incidents, finish clears that failed. */
export async function bannerTick(
  incidents: Incident[],
  deps: IncidentDeps = {}
): Promise<{ pushed: number; errors: string[] }> {
  const now = (deps.now ?? Date.now)()
  let pushed = 0
  const errors: string[] = []
  for (const inc of incidents) {
    if (!inc.banner_next_at || Date.parse(inc.banner_next_at) > now) continue
    try {
      // Claim the due slot first (one leader, but never twice for one incident).
      const claimed = await db('nivaro_hub_incidents')
        .where({ id: inc.id })
        .where('banner_next_at', '<=', new Date(now))
        .update({ banner_next_at: new Date(now + BANNER_RETRY_MS) })
      if (!claimed) continue
      if (inc.status === 'open' && inc.banner_text) {
        const { state, allDone } = await syncBanner(inc, 'show', deps, new Date(now))
        await patchIncident(inc.id, {
          banner_state: state,
          banner_next_at: new Date(now + (allDone ? BANNER_REFRESH_MS : BANNER_RETRY_MS))
        })
      } else {
        const { state, allDone } = await syncBanner(inc, 'clear', deps, new Date(now))
        await patchIncident(inc.id, {
          banner_state: state,
          banner_next_at: allDone ? null : new Date(now + BANNER_RETRY_MS)
        })
      }
      pushed++
    } catch (err) {
      errors.push(`incident ${inc.id}: ${(err as Error)?.message ?? 'banner failed'}`)
    }
  }
  return { pushed, errors }
}

/** Incidents whose banner work is due (open with a banner, or resolved with a clear left). */
export async function bannerDue(now = Date.now()): Promise<Incident[]> {
  const { incidentFromRow } = await import('./store.js')
  const rows = (await db('nivaro_hub_incidents')
    .whereNotNull('banner_next_at')
    .where('banner_next_at', '<=', new Date(now))
    .orderBy('banner_next_at', 'asc')
    .limit(50)) as Array<Record<string, unknown>>
  return rows.map(incidentFromRow)
}

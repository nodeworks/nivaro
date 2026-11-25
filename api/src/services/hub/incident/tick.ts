import { db } from '../../../db/index.js'
import { deliverHubNotice, sendHubEvent } from '../notify-events.js'
import { FREEZES } from '../releases/freeze.js'
import {
  bannerDue,
  bannerTick,
  FREEZE_FOR_MS,
  freezeSource,
  type IncidentDeps
} from './incidents.js'
import { closeAlertPages, escalateDuePages, pagedUserIds, pageFromRow } from './paging.js'
import {
  activeAdminIds,
  activeOwnerIds,
  listRotas,
  openIncidents,
  PAGES,
  productionEnvIds
} from './store.js'

/**
 * The incident minute tick (cron hub-incident-tick, Hub only, one leader through the cron lease;
 * crons tick only where cronTicksEnabled()). All state is in the rows, so a tick missed while the
 * Hub was down is picked up by the next one — nothing is held in memory between ticks:
 *
 *   1. pages      escalate pages nobody acknowledged in time (paging.ts escalateDuePages)
 *   2. banners    refresh open incidents' banners, retry failed pushes, finish clears
 *   3. freezes    an incident still open keeps its deploy freeze (extended before it runs out;
 *                 a freeze an administrator lifted stays lifted)
 *   4. outages    for apps WITH an enabled on-call rota: a production environment whose last
 *                 OUTAGE_SAMPLES minute probes all failed raises `uptime_down` (paged to on-call
 *                 through sendHubEvent); once it answers RECOVERY_SAMPLES times in a row the page
 *                 closes and whoever was paged hears it is back
 */

export const OUTAGE_SAMPLES = 3
export const RECOVERY_SAMPLES = 2

export interface TickResult {
  escalated: number
  banners: number
  freezes_extended: number
  outages: number
  recovered: number
  errors: string[]
}

export interface IncidentTickDeps extends IncidentDeps {
  samples?: (envId: number, n: number) => Promise<boolean[]>
  hubEvent?: typeof sendHubEvent
}

async function lastSamples(envId: number, n: number): Promise<boolean[]> {
  const rows = (await db('nivaro_hub_uptime_samples')
    .where({ environment_id: envId })
    .orderBy('at', 'desc')
    .limit(n)
    .select('up')) as Array<{ up: unknown }>
  return rows.map((r) => r.up === true || r.up === 1 || r.up === '1')
}

/** Keeps open incidents' freezes on (never re-opens one an administrator lifted). */
async function keepFreezes(now: number): Promise<number> {
  const open = await openIncidents()
  const tags = open.map((i) => freezeSource(i.id))
  if (!tags.length) return 0
  return Number(
    await db(FREEZES)
      .whereIn('source', tags)
      .where('ends_at', '>', new Date(now))
      .where('ends_at', '<', new Date(now + 86_400_000))
      .update({ ends_at: new Date(now + FREEZE_FOR_MS), updated_at: new Date(now) })
  )
}

/** The outage watch (see the header). */
async function watchOutages(deps: IncidentTickDeps, now: number, errors: string[]) {
  let outages = 0
  let recovered = 0
  const rotas = (await listRotas(null)).filter((r) => r.enabled)
  for (const rota of rotas) {
    let envIds: number[]
    try {
      envIds = await (deps.production ?? productionEnvIds)(rota.app_id)
    } catch {
      continue
    }
    for (const envId of envIds) {
      try {
        const recent = await (deps.samples ?? lastSamples)(envId, OUTAGE_SAMPLES)
        const open = (await db(PAGES)
          .where({ app_id: rota.app_id, environment_id: envId, kind: 'uptime_down' })
          .whereIn('status', ['open', 'acked'])
          .orderBy('id', 'desc')
          .first()) as Record<string, unknown> | undefined
        const down = recent.length >= OUTAGE_SAMPLES && recent.every((u) => !u)
        const up =
          recent.length >= RECOVERY_SAMPLES && recent.slice(0, RECOVERY_SAMPLES).every((u) => u)
        if (down && !open) {
          await (deps.hubEvent ?? sendHubEvent)(
            {
              kind: 'uptime_down',
              appId: rota.app_id,
              envId,
              detail: `${OUTAGE_SAMPLES} probes in a row failed`,
              path: '/hub/on-call'
            },
            deps
          )
          outages++
        } else if (up && open) {
          const page = pageFromRow(open)
          await closeAlertPages(rota.app_id, envId, 'uptime_down', new Date(now))
          // Owners and administrators read the alert's own words; anyone else on the rota a
          // generic line (the app's name only).
          const readers = new Set(
            [
              ...(await (deps.owners ?? activeOwnerIds)(rota.app_id)),
              ...(await (deps.admins ?? activeAdminIds)())
            ].map((u) => u.toUpperCase())
          )
          const app = (await db('nivaro_hub_apps')
            .where({ id: rota.app_id })
            .first('key', 'name')) as { key: string; name: string } | undefined
          const appName = app ? String(app.name || app.key) : `App ${rota.app_id}`
          const people = pagedUserIds(page)
          const base = {
            path: `/hub/on-call?page=${page.id}`,
            source: { kind: 'hub-page', label: 'uptime_up', id: page.id },
            why: 'You were paged when it stopped answering.'
          }
          const deliver = deps.deliver ?? deliverHubNotice
          const own = people.filter((u) => readers.has(u.toUpperCase()))
          const other = people.filter((u) => !readers.has(u.toUpperCase()))
          if (own.length)
            await deliver(
              own,
              {
                ...base,
                subject: page.subject.replace(/^Down:/, 'Back up:'),
                message: 'The environment answers the Hub’s probes again.'
              },
              deps
            ).catch(() => 0)
          if (other.length)
            await deliver(
              other,
              { ...base, subject: `Back up: ${appName}`, message: `${appName} answers again.` },
              deps
            ).catch(() => 0)
          recovered++
        }
      } catch (err) {
        errors.push(`outage ${envId}: ${(err as Error)?.message ?? 'failed'}`)
      }
    }
  }
  return { outages, recovered }
}

export async function runIncidentTick(deps: IncidentTickDeps = {}): Promise<TickResult> {
  const now = (deps.now ?? Date.now)()
  const errors: string[] = []
  const esc = await escalateDuePages(deps).catch((err) => {
    errors.push(`pages: ${(err as Error)?.message ?? 'failed'}`)
    return { escalated: 0, errors: [] as string[] }
  })
  errors.push(...esc.errors)
  const due = await bannerDue(now).catch(() => [])
  const b = await bannerTick(due, deps)
  errors.push(...b.errors)
  const extended = await keepFreezes(now).catch((err) => {
    errors.push(`freezes: ${(err as Error)?.message ?? 'failed'}`)
    return 0
  })
  const o = await watchOutages(deps, now, errors).catch((err) => {
    errors.push(`outages: ${(err as Error)?.message ?? 'failed'}`)
    return { outages: 0, recovered: 0 }
  })
  return {
    escalated: esc.escalated,
    banners: b.pushed,
    freezes_extended: extended,
    outages: o.outages,
    recovered: o.recovered,
    errors
  }
}

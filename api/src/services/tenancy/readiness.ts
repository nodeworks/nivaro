import type { ReadinessResult } from '@nivaro/extension-kit'
import { tenantSource } from '../deployment-mode.js'
import { registerReadinessCheck } from '../readiness.js'
import { getHubTenantSource, type HubSourceDetails } from './hub-source.js'

/**
 * Readiness check `tenant-registry` (Hub phase 5): does this Hub shared deployment have a
 * current list of the apps it serves?
 *
 *   fail  the list was never loaded (no Hub answer, no sealed copy): no app is served
 *   warn  the list is older than 5 min (the Hub has not confirmed it), it is kept in memory only
 *         (no ENCRYPTION_KEY / Redis), or the Hub listed apps this deployment cannot serve
 *   pass  otherwise
 *
 * Scoped to tenantSource() === 'hub': Nivaro Cloud's meta source never reports "loaded", so the
 * check skips there (and on self-hosted). The texts are seen by app admins on the deployment, so
 * they name no other app, connection or token — counts and plain reasons only.
 */

const STALE_MS = 5 * 60_000

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'less than a minute ago'
  if (min < 120) return `${min} min ago`
  return `${Math.round(min / 60)} h ago`
}

export function judgeTenantRegistry(d: HubSourceDetails | null, now: number): ReadinessResult {
  if (!d?.loaded)
    return {
      status: 'fail',
      detail: `This deployment has never loaded its list of apps from the Hub${d?.fetchError ? `: ${d.fetchError}` : ''}. No app is served.`,
      blockers: ['Check HUB_URL and HUB_DEPLOYMENT_TOKEN, and that the Hub lists this deployment.']
    }
  const warnings: string[] = []
  const age = d.confirmedAt === null ? null : now - d.confirmedAt
  if (age === null || age > STALE_MS)
    warnings.push(
      `The list of apps was last confirmed by the Hub ${age === null ? 'at an unknown time' : ago(age)}${d.fetchError ? ` (${d.fetchError})` : ''}; apps are served from that list.`
    )
  if (d.count === 0)
    warnings.push(
      'The Hub lists no app for this deployment: every address answers "No app is served".'
    )
  if (!d.sealedCopy)
    warnings.push(
      `The list of apps is kept in memory only (${d.sealedCopyProblem ?? 'no sealed copy'}): a restart while the Hub is down serves no app.`
    )
  if (d.dropped.length)
    warnings.push(
      `The Hub listed ${d.dropped.length} app${d.dropped.length === 1 ? '' : 's'} this deployment cannot serve (the process log names them).`
    )
  if (warnings.length) return { status: 'warn', detail: warnings[0], blockers: warnings }
  return {
    status: 'pass',
    detail: `The list of apps is current (confirmed ${ago(age ?? 0)}).`
  }
}

let registered = false

export function registerTenantRegistryReadiness(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'tenant-registry',
    label: 'The list of apps is current',
    group: 'Deploy',
    description:
      'On a Hub shared deployment: the list of apps this process serves, fetched from the Hub. Fails when it was never loaded; warns when the Hub has not confirmed it for 5 minutes, when it is kept in memory only, or when the Hub listed apps that cannot be served.',
    ttlMs: 60_000,
    run: async () => {
      if (tenantSource() !== 'hub')
        return { status: 'skip', detail: 'Not a Hub shared deployment.' }
      return judgeTenantRegistry(getHubTenantSource()?.details() ?? null, Date.now())
    }
  })
}

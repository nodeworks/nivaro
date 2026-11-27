// Task 33 (Wave 2 hooks): ECR scan findings in the Hub's vulnerability tab (source `ecr`).
//
// For every managed `aws.ecr_repository` the reader may see (Hub admins: all; owners: their apps'),
// the latest pushed image's scan finding counts by severity, read live through the repository's own
// connection (the engine's context: its hosts, its scrub) with `ecrScanSummary` — a read, never a
// write, so no change is planned. At most 25 repositories, 4 at a time, 8 s each; a repository that
// cannot be read answers its (scrubbed) reason instead of counts. Never throws.

import { ecrScanSummary } from '../aws/ecr.js'
import { contextFor, type OpenConnection, openConnection, regionFor } from '../engine/plan.js'
import { type HubResourceRow, listResources } from '../store.js'

export const ECR_REPOSITORY = 'aws.ecr_repository'
const MAX_REPOS = 25
const PER_REPO_MS = 8_000
const WIDTH = 4

export interface EcrRepositoryFindings {
  source: 'ecr'
  resource_id: number
  name: string | null
  app_id: number | null
  environment_id: number | null
  image: string | null
  digest: string | null
  pushed_at: string | null
  scan_status: string | null
  counts: {
    critical: number
    high: number
    medium: number
    low: number
    informational: number
    undefined: number
  } | null
  error?: string
}

export interface EcrFindingsDeps {
  summary?: typeof ecrScanSummary
  open?: (connectionId: number) => Promise<OpenConnection>
}

/** The repositories one reader may see (null = every app: a Hub administrator). */
export function visibleRepositories(
  rows: HubResourceRow[],
  appIds: number[] | null
): HubResourceRow[] {
  return rows
    .filter(
      (r) =>
        r.type === ECR_REPOSITORY &&
        !r.deleted_at &&
        !!r.external_id &&
        (appIds == null || (r.scope === 'app' && r.app_id != null && appIds.includes(r.app_id)))
    )
    .slice(0, MAX_REPOS)
}

export async function ecrRepositoryFindings(
  appIds: number[] | null,
  deps: EcrFindingsDeps = {}
): Promise<EcrRepositoryFindings[]> {
  if (appIds && !appIds.length) return []
  let rows: HubResourceRow[]
  try {
    rows = visibleRepositories(await listResources({ type: ECR_REPOSITORY }), appIds)
  } catch {
    return []
  }
  const summary = deps.summary ?? ecrScanSummary
  const open = deps.open ?? openConnection
  const conns = new Map<number, Promise<OpenConnection>>()
  const one = async (r: HubResourceRow): Promise<EcrRepositoryFindings> => {
    const base = {
      source: 'ecr' as const,
      resource_id: r.id,
      name: r.name ?? r.external_id,
      app_id: r.app_id,
      environment_id: r.environment_id,
      image: null,
      digest: null,
      pushed_at: null,
      scan_status: null,
      counts: null
    }
    let scrub = (t: string) => t
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), PER_REPO_MS)
    timer.unref?.()
    try {
      if (!conns.has(r.connection_id)) conns.set(r.connection_id, open(r.connection_id))
      const conn = await (conns.get(r.connection_id) as Promise<OpenConnection>)
      if (conn.row.status === 'disabled') return { ...base, error: 'The connection is disabled.' }
      const region = regionFor(conn.row.config, r.desired, r.observed)
      if (!region) return { ...base, error: 'The repository has no region.' }
      const ctx = contextFor(conn, region, { signal: ctl.signal })
      scrub = ctx.scrub
      const s = await Promise.race([
        summary(ctx, String(r.external_id), region),
        new Promise<never>((_, rej) =>
          ctl.signal.addEventListener('abort', () => rej(new Error('ECR did not answer in time.')))
        )
      ])
      const n = (k: string) => s.counts[k] ?? 0
      return {
        ...base,
        image: s.imageTag,
        digest: s.digest,
        pushed_at: s.pushedAt,
        scan_status: s.scanStatus,
        counts:
          s.totalImages && s.scanStatus
            ? {
                critical: n('CRITICAL'),
                high: n('HIGH'),
                medium: n('MEDIUM'),
                low: n('LOW'),
                informational: n('INFORMATIONAL'),
                undefined: n('UNDEFINED')
              }
            : null
      }
    } catch (e) {
      // Scrubbed before it is clipped.
      return {
        ...base,
        error: scrub(e instanceof Error ? e.message : 'ECR could not be read.').slice(0, 200)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  const out: EcrRepositoryFindings[] = []
  for (let i = 0; i < rows.length; i += WIDTH)
    out.push(...(await Promise.all(rows.slice(i, i + WIDTH).map(one))))
  return out
}

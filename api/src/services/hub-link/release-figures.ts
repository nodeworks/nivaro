import { readdir } from 'node:fs/promises'
import { db, migrationsDir } from '../../db/index.js'
import { KNOWN_ENV_KEYS } from '../hub/docker/known-env.js'

/**
 * App side of the Hub link, two read-only extras of GET /api/hub-link/status that the Hub's
 * release operations ask for (services/hub/releases/*). Aggregate counts and build facts only:
 * never a record, a path, a user, a query or a value.
 *
 *  - recent(minutes)  requests answered and 5xx answers in the request log, and front-end crash
 *                     reports filed, over the last `minutes` (1–60). The Hub's automatic
 *                     rollback rule judges them after a promotion. null when a count cannot be
 *                     read in time.
 *  - releaseFacts()   the migration names this build ships and the setting names it knows
 *                     (KNOWN_ENV_KEYS): the Hub diffs two versions' facts for release notes.
 */

export interface RecentFigures {
  minutes: number
  requests: number | null
  errors_5xx: number | null
  crashes: number | null
}

export { recentMinutesParam } from './release-params.js'

function countOf(row: unknown): number | null {
  const v = row && typeof row === 'object' ? Object.values(row as Record<string, unknown>)[0] : null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Counts over the last `minutes`. Each count is read on its own; a failed one is null. */
export async function recentFigures(minutes: number): Promise<RecentFigures> {
  const since = new Date(Date.now() - minutes * 60_000)
  const safe = async (q: () => Promise<unknown>) => {
    try {
      return countOf(await q())
    } catch {
      return null
    }
  }
  const [requests, errors, crashes] = await Promise.all([
    safe(() => db('nivaro_api_logs').where('created_at', '>=', since).count({ n: '*' }).first()),
    safe(() =>
      db('nivaro_api_logs')
        .where('created_at', '>=', since)
        .where('status', '>=', 500)
        .count({ n: '*' })
        .first()
    ),
    safe(() =>
      db('nivaro_issue_occurrences')
        .where('occurred_at', '>=', since)
        .where('source', 'client')
        .count({ n: '*' })
        .first()
    )
  ])
  return { minutes, requests, errors_5xx: errors, crashes }
}

/** What this build carries: its migration names (without extension) and known setting names. */
export async function releaseFacts(): Promise<{ migrations: string[]; env_keys: string[] }> {
  let migrations: string[] = []
  try {
    migrations = (await readdir(migrationsDir))
      .filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts')) || f.endsWith('.js'))
      .map((f) => f.replace(/\.(ts|js)$/, ''))
      .filter((f, i, all) => all.indexOf(f) === i)
      .sort()
  } catch {
    migrations = []
  }
  return { migrations, env_keys: [...KNOWN_ENV_KEYS] }
}

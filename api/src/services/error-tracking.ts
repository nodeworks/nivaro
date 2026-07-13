import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Error tracking into nivaro_issues.
 *
 * Repeat errors dedupe by fingerprint (sha256 of source|route|message): an
 * existing OPEN issue with the same fingerprint gets occurrence_count bumped
 * instead of a new row. Resolving an issue and hitting the error again opens
 * a fresh row — regressions surface as new issues, not silent counters.
 *
 * Fire-and-forget: never throws, never blocks the response path.
 */
export async function trackError(opts: {
  source: 'server' | 'client'
  route: string
  message: string
  stack?: string | null
  userId?: string | null
  severity?: 'low' | 'medium' | 'high' | 'critical'
}): Promise<void> {
  try {
    const message = (opts.message || 'Unknown error').slice(0, 400)
    const fingerprint = createHash('sha256')
      .update(`${opts.source}|${opts.route}|${message}`)
      .digest('hex')

    const existing = await db('nivaro_issues')
      .where({ fingerprint })
      .whereIn('status', ['open', 'acknowledged'])
      .first()

    if (existing) {
      await db('nivaro_issues')
        .where({ id: existing.id })
        .update({
          occurrence_count: db.raw('occurrence_count + 1'),
          last_seen_at: new Date(),
          updated_at: new Date()
        })
      return
    }

    const details = [
      `Route: ${opts.route}`,
      opts.stack ? `\n${String(opts.stack).slice(0, 4000)}` : null
    ]
      .filter(Boolean)
      .join('\n')

    await db('nivaro_issues').insert({
      title: `[${opts.source}] ${opts.route}: ${message}`.slice(0, 500),
      severity: opts.severity ?? 'high',
      status: 'open',
      source: opts.source,
      details,
      fingerprint,
      occurrence_count: 1,
      last_seen_at: new Date(),
      raised_by: opts.userId ?? null,
      created_at: new Date(),
      updated_at: new Date()
    })
  } catch {
    /* tracking must never break the request path */
  }
}

import type { Knex } from 'knex'
import { isMssql } from '../db/dialect.js'

/**
 * The request log (`nivaro_api_logs`) as the FROM of a dashboard or analytics read.
 *
 * On SQL Server it reads WITH (NOLOCK). The log is the hottest append table there is: the
 * logger inserts a batch every few seconds from every process, and a read that scans hours or
 * days of it under locking READ COMMITTED holds page S locks the insert has to cross. In the
 * first week of a production install that was ten deadlocks, the read the victim each time
 * (the partner dependency map five times, the Command Center health counts, the presence
 * "stuck" read), and every one of them also held the logger up while it ran. A database with
 * READ_COMMITTED_SNAPSHOT on does not take those locks, but the app cannot count on that
 * setting being on.
 *
 * The log is append-only, so a dirty read can at most count a request a moment early, or one
 * whose insert then rolls back: fine for counts, rates and "who called what". Never use this
 * for a read whose answer decides a write.
 *
 * Other databases get the plain table. `alias` names it for joined or column-qualified reads.
 */
export function apiLogSource(knex: Knex, alias?: string): Knex.QueryBuilder {
  if (!isMssql(knex)) return knex(alias ? `nivaro_api_logs as ${alias}` : 'nivaro_api_logs')
  return knex.from(
    alias
      ? knex.raw('?? AS ?? WITH (NOLOCK)', ['nivaro_api_logs', alias])
      : knex.raw('?? WITH (NOLOCK)', ['nivaro_api_logs'])
  )
}

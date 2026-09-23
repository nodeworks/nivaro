/**
 * ERP submission payload retention (#528) — see migration 335.
 *
 * Blanks `payload` and `response` on rows older than the configured window,
 * in bounded batches so a first run over years of history never holds a
 * lock for long. Never touches status, attempts, last_error, external_ref or
 * change_signature: the row stays a faithful record of THAT a push happened
 * and what it was for — only the bytes go.
 */
import { db } from '../db/index.js'

const BATCH = 5000
const MAX_BATCHES = 40

export async function erpPayloadRetentionDays(): Promise<number | null> {
  const row = (await db('nivaro_settings')
    .select('erp_submission_payload_retention_days')
    .first()
    .catch(() => null)) as { erp_submission_payload_retention_days: number | null } | null
  const n = Number(row?.erp_submission_payload_retention_days ?? 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function pruneErpSubmissionPayloads(): Promise<{
  days: number | null
  blanked: number
  more: boolean
}> {
  const days = await erpPayloadRetentionDays()
  if (!days) return { days: null, blanked: 0, more: false }
  const cutoff = new Date(Date.now() - days * 86_400_000)
  // Attempt history (migration 347) holds the same bytes per retry — same window.
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = (await db
      .raw(
        `UPDATE TOP (${BATCH}) nivaro_erp_submission_attempts
            SET payload = NULL, response = NULL
          WHERE recorded_at < ?
            AND (payload IS NOT NULL OR response IS NOT NULL)`,
        [cutoff]
      )
      .catch(() => 0)) as unknown
    const n = Array.isArray(res)
      ? Number(res[0] ?? 0)
      : Number((res as { rowCount?: number })?.rowCount ?? 0)
    if (!(n >= BATCH)) break
  }
  let blanked = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = (await db.raw(
      `UPDATE TOP (${BATCH}) nivaro_erp_submissions
          SET payload = NULL, response = NULL
        WHERE created_at < ?
          AND (payload IS NOT NULL OR response IS NOT NULL)`,
      [cutoff]
    )) as unknown
    const n = Array.isArray(res)
      ? Number(res[0] ?? 0)
      : Number((res as { rowCount?: number })?.rowCount ?? 0)
    blanked += n
    if (n < BATCH) return { days, blanked, more: false }
  }
  return { days, blanked, more: true }
}

export interface ErpStorage {
  rows: number
  with_payload: number
  payload_bytes: number
  response_bytes: number
  oldest_with_payload: string | null
  retention_days: number | null
  /** Rows the next pass would blank. */
  due: number
}

export async function erpSubmissionStorage(): Promise<ErpStorage> {
  const days = await erpPayloadRetentionDays()
  const cutoff = days ? new Date(Date.now() - days * 86_400_000) : null
  const [agg] = (await db.raw(
    `SELECT COUNT(*) AS rows_n,
            SUM(CASE WHEN payload IS NOT NULL OR response IS NOT NULL THEN 1 ELSE 0 END) AS with_payload,
            SUM(CAST(DATALENGTH(payload) AS bigint)) AS payload_bytes,
            SUM(CAST(DATALENGTH(response) AS bigint)) AS response_bytes,
            MIN(CASE WHEN payload IS NOT NULL OR response IS NOT NULL THEN created_at END) AS oldest,
            SUM(CASE WHEN ? IS NOT NULL AND created_at < ? AND (payload IS NOT NULL OR response IS NOT NULL) THEN 1 ELSE 0 END) AS due
       FROM nivaro_erp_submissions`,
    [cutoff, cutoff ?? new Date(0)]
  )) as Array<Record<string, unknown>>
  return {
    rows: Number(agg?.rows_n ?? 0),
    with_payload: Number(agg?.with_payload ?? 0),
    payload_bytes: Number(agg?.payload_bytes ?? 0),
    response_bytes: Number(agg?.response_bytes ?? 0),
    oldest_with_payload: agg?.oldest ? new Date(agg.oldest as string).toISOString() : null,
    retention_days: days,
    due: Number(agg?.due ?? 0)
  }
}

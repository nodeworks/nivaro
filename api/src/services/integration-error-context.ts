/**
 * The database side of readable integration errors (integration-error-explain.ts is the pure
 * rule set): gathers the facts a rule needs — the partner's name, the record collection's field
 * list (cached metadata), the stored status — for the rows a console route already loaded, and
 * adds `explanation` to each. Best-effort: a lookup that fails leaves `explanation: null`, never
 * a failed read.
 */
import { getFields } from './collections.js'
import {
  explainIntegrationError,
  type IntegrationErrorExplanation,
  statusFromText
} from './integration-error-explain.js'

const NETWORKISH =
  /econnrefused|enotfound|eai_again|econnreset|ehostunreach|fetch failed|socket hang up|timed? ?out|timeout|aborted|certificate|ssrf/i

/** Field lists per collection, read once per call (metadata is cached service-side). */
async function fieldListsFor(
  collections: string[]
): Promise<Map<string, Array<{ field: string; label: string | null }>>> {
  const out = new Map<string, Array<{ field: string; label: string | null }>>()
  await Promise.all(
    [...new Set(collections.filter(Boolean))].map(async (c) => {
      try {
        const fields = await getFields(c)
        out.set(
          c,
          fields
            .filter((f) => !String(f.field).startsWith('$'))
            // Fields carry no stored label: the explainer title-cases the name.
            .map((f) => ({ field: f.field, label: null }))
        )
      } catch {
        /* an unknown collection: no field matching */
      }
    })
  )
  return out
}

export interface SubmissionLike {
  collection: string
  item: string
  external_api: number | null
  external_api_name?: string | null
  status: string
  last_error: string | null
  endpoint_path?: string | null
  response?: unknown
  record_label?: string | null
}

/**
 * The HTTP status a stored submission most likely got. Rows keep no status column: a non-2xx is
 * stored as "HTTP nnn: …"; a network failure keeps the driver's words; a failure with a stored
 * reply and neither of those is a 2xx whose body said no.
 */
export function submissionStatus(row: SubmissionLike): number | null {
  const fromText = statusFromText(row.last_error)
  if (fromText != null) return fromText
  if (!row.last_error) return null
  if (NETWORKISH.test(row.last_error)) return null
  return row.response != null && row.response !== '' ? 200 : null
}

/** `explanation` for each failed submission (null on the rest). */
export async function explainSubmissions<T extends SubmissionLike>(
  rows: T[],
  apiNames?: Map<number, string>,
  /** false = a non-admin reader: Fix it points only at the record (config pages are admin-only). */
  adminFixes = true
): Promise<Array<T & { explanation: IntegrationErrorExplanation | null }>> {
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'rejected')
  const fields = failed.length ? await fieldListsFor(failed.map((r) => r.collection)) : new Map()
  return rows.map((r) => {
    if (r.status !== 'failed' && r.status !== 'rejected') return { ...r, explanation: null }
    try {
      const explanation = explainIntegrationError({
        partner:
          r.external_api_name ??
          (r.external_api != null ? (apiNames?.get(r.external_api) ?? null) : null),
        apiId: r.external_api,
        httpStatus: submissionStatus(r),
        error: r.last_error,
        body: r.response,
        collection: r.collection,
        item: String(r.item),
        recordLabel: r.record_label ?? null,
        endpoint: r.endpoint_path ?? null,
        fields: fields.get(r.collection) ?? null
      })
      if (explanation && !adminFixes && explanation.fix && explanation.fix.kind !== 'record') {
        return { ...r, explanation: { ...explanation, fix: null, fix_link: null, fix_label: null } }
      }
      return { ...r, explanation }
    } catch {
      return { ...r, explanation: null }
    }
  })
}

export interface CallLike {
  status: number | null
  ok: boolean | number
  error: string | null
  path: string | null
}

/** `explanation` for each failed partner call (call-log / outbound rows). */
export function explainCalls<T extends CallLike>(
  rows: T[],
  partner: { id: number; name: string }
): Array<T & { explanation: IntegrationErrorExplanation | null }> {
  return rows.map((r) => {
    if (r.ok && !r.error) return { ...r, explanation: null }
    try {
      return {
        ...r,
        explanation: explainIntegrationError({
          partner: partner.name,
          apiId: partner.id,
          httpStatus: r.status,
          error: r.error,
          endpoint: r.path ? r.path.split('?')[0] : null
        })
      }
    } catch {
      return { ...r, explanation: null }
    }
  })
}

/** One call's explanation with its stored reply (the expanded call detail). */
export function explainCallDetail(
  row: { response_status: number | null; error: string | null; url: string | null },
  body: unknown,
  partner: { id: number; name: string | null }
): IntegrationErrorExplanation | null {
  try {
    let endpoint: string | null = null
    try {
      endpoint = row.url ? new URL(row.url).pathname : null
    } catch {
      endpoint = row.url ? row.url.split('?')[0] : null
    }
    return explainIntegrationError({
      partner: partner.name,
      apiId: partner.id,
      httpStatus: row.response_status,
      error: row.error,
      body,
      endpoint
    })
  } catch {
    return null
  }
}

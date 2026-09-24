import type { BannerLine } from './obligation-banner'

/** What the header Integrations chip shows about a record, folded from the
 *  partner lines (obligations — "was the partner told") and the request log
 *  (ERP submissions — "what did we actually send"). Pure, so the counts are
 *  unit-testable without a DOM. */
export interface IntegrationChipSummary {
  /** One entry per partner, obligations first (they know about partners
   *  that were never sent anything), then partners only the log knows. */
  partners: Array<{ name: string; status: 'ok' | 'attention' | 'pending' | 'neutral'; tip: string }>
  /** Partners told successfully — the green badge. */
  ok: number
  /** Things a person needs to act on — the red badge: a partner not told
   *  (failed / never told / overdue) or a failed request with no
   *  obligation line explaining it. */
  attention: number
  /** Sends still awaiting an acknowledgement. */
  pending: number
}

export interface ChipSubmission {
  external_api_name?: string | null
  external_api?: number | null
  status: string
  last_error?: string | null
  updated_at?: string | null
  created_at?: string | null
}

const submissionStatus = (s: string): IntegrationChipSummary['partners'][number]['status'] =>
  s === 'accepted'
    ? 'ok'
    : s === 'failed' || s === 'rejected'
      ? 'attention'
      : s === 'pending'
        ? 'pending'
        : 'neutral'

export function integrationChipSummary(
  lines: BannerLine[],
  submissions: ChipSubmission[],
  relative: (iso: string | null | undefined) => string = () => ''
): IntegrationChipSummary {
  const partners: IntegrationChipSummary['partners'] = []
  const seen = new Set<string>()
  for (const l of lines) {
    const status =
      l.tone === 'positive'
        ? 'ok'
        : l.tone === 'danger'
          ? 'attention'
          : l.outcome === 'pending'
            ? 'pending'
            : 'neutral'
    partners.push({ name: l.api, status, tip: `${l.api} · ${l.text}` })
    seen.add(l.api.toLowerCase())
  }
  // Newest submission per integration for partners the obligations do not
  // name (a kind not registered for this collection, an ad-hoc push).
  for (const s of submissions) {
    const name = s.external_api_name ?? (s.external_api != null ? `#${s.external_api}` : 'External')
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    partners.push({
      name,
      status: submissionStatus(s.status),
      tip: `${name} · ${s.status} · ${relative(s.updated_at ?? s.created_at)}${s.last_error ? ` — ${s.last_error.slice(0, 120)}` : ''}`
    })
  }
  return {
    partners,
    ok: partners.filter((p) => p.status === 'ok').length,
    attention: partners.filter((p) => p.status === 'attention').length,
    pending: partners.filter((p) => p.status === 'pending').length
  }
}

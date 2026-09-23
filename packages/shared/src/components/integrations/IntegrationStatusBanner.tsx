import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { type BannerLine, bannerLines } from '../../lib/obligation-banner'
import { cn } from '../../lib/utils'
import { colorPair } from '../QueryTable'

/**
 * One line per partner on the record: were they told, when, and if not, why
 * not. Sits above `ErpFailureBanner`, which keeps the payload/response view
 * and the retry mutation — this answers a different question ("was the
 * partner told, and when") and does not replace it.
 *
 * Renders nothing when the record has no obligations, so a collection with
 * no integrations pays one cached request and shows no chrome.
 */

/** Mirrors `IntegrationObligationsView`'s private `roleForTone` — that
 *  function isn't exported, so this is a small (4-line) duplicate rather
 *  than a cross-file export for a task outside this component's manifest.
 *  Both map the SAME `toneForOutcome` domain onto the SAME `COLOR_ROLES`
 *  names, so the board and this banner can never disagree about what
 *  "overdue" looks like. */
function roleForTone(tone: BannerLine['tone']): 'negative' | 'warning' | 'positive' | null {
  if (tone === 'danger') return 'negative'
  if (tone === 'warning') return 'warning'
  if (tone === 'positive') return 'positive'
  return null
}

export interface IntegrationStatusBannerProps {
  collection: string
  itemId: string | number
}

export function IntegrationStatusBanner({ collection, itemId }: IntegrationStatusBannerProps) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['integration-obligations', 'record', collection, String(itemId)],
    queryFn: () =>
      client.request<{ data: Parameters<typeof bannerLines>[0] }>(
        get(`/integration-obligations/record/${collection}/${encodeURIComponent(String(itemId))}`)
      ),
    enabled: !!collection && !!itemId,
    staleTime: 30_000,
    // A 403 means this viewer may not read the record's integrations — that
    // is an answer, not something to retry.
    retry: false
  })
  const lines = bannerLines(data?.data ?? [])
  if (lines.length === 0) return null

  return (
    <div className='nvr-expand-in space-y-1.5' data-integration-banner>
      {lines.map((l) => {
        const role = roleForTone(l.tone)
        const [accent, accentDark] = role ? colorPair(role) : [null, null]
        return (
          <div
            key={l.api}
            data-integration-line={l.api}
            data-integration-outcome={l.outcome}
            style={
              accent
                ? ({ '--obt': accent, '--obtd': accentDark } as unknown as React.CSSProperties)
                : undefined
            }
            className={cn(
              'flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] dark:border-border dark:bg-card',
              accent && 'border-t-2 border-t-[color:var(--obt)] dark:border-t-[color:var(--obtd)]'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                accent ? 'bg-[color:var(--obt)] dark:bg-[color:var(--obtd)]' : 'bg-slate-400'
              )}
            />
            <p className='min-w-0 flex-1 leading-5 text-slate-700 dark:text-slate-200'>
              <span className='font-semibold text-slate-800 dark:text-foreground'>{l.api}:</span>{' '}
              <span
                data-integration-reason
                className={
                  accent
                    ? 'text-[color:var(--obt)] dark:text-[color:var(--obtd)]'
                    : 'text-slate-500 dark:text-muted-foreground'
                }
              >
                {l.text}
              </span>
            </p>
          </div>
        )
      })}
    </div>
  )
}

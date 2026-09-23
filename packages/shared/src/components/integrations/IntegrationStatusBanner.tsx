import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { bannerLines } from '../../lib/obligation-banner'
import { cn } from '../../lib/utils'
import { colorPair } from '../QueryTable'
import { roleForTone } from './IntegrationObligationsView'

/**
 * One line per partner on the record: were they told, when, and if not, why
 * not. Sits above `ErpFailureBanner`, which keeps the payload/response view
 * and the retry mutation — this answers a different question ("was the
 * partner told, and when") and does not replace it.
 *
 * Renders nothing when the record has no obligations, so a collection with
 * no integrations pays one cached request and shows no chrome.
 *
 * `roleForTone` is imported from `IntegrationObligationsView` (the board)
 * rather than duplicated here, so the board and this banner can never
 * disagree about what "overdue" looks like.
 */

export interface IntegrationStatusBannerProps {
  collection: string
  itemId: string | number
}

/** Send-now on one line of the banner. Shown only for the three outcomes
 *  that mean "the partner still does not have it" (failed/missing/overdue —
 *  `bannerLines`' own `tone === 'danger'` is exactly that set), and only
 *  while the deployment's remediation switch reads on — `remediation_enabled`
 *  rides the SAME record read this banner already makes, never a second
 *  probe per row. Two clicks: the first arms a confirm, a second within a
 *  few seconds actually sends; it disarms on its own so a stray later click
 *  can never fire the send by accident. */
function SendNowButton({
  obligationId,
  collection,
  itemId
}: {
  obligationId: number
  collection: string
  itemId: string | number
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [armed, setArmed] = useState(false)

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { detail: string } }>(
        post(`/integration-obligations/${obligationId}/send`)
      ),
    onSuccess: (res) => {
      toast.message(res?.data?.detail ?? 'Sent')
      void qc.invalidateQueries({
        queryKey: ['integration-obligations', 'record', collection, String(itemId)]
      })
    },
    onError: (err) => {
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? 'Send now failed', { duration: 8000 })
    },
    onSettled: () => setArmed(false)
  })

  return (
    <button
      type='button'
      data-obligation-send-now
      disabled={send.isPending}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        send.mutate()
      }}
      className={cn(
        'ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-60',
        armed
          ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan dark:border-nvr-cyan dark:bg-nvr-cyan/15'
          : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
      )}
    >
      {send.isPending ? (
        <Loader2 className='h-3 w-3 animate-spin' />
      ) : (
        <Send className='h-3 w-3' />
      )}
      {armed ? 'Confirm send?' : 'Send now'}
    </button>
  )
}

export function IntegrationStatusBanner({ collection, itemId }: IntegrationStatusBannerProps) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['integration-obligations', 'record', collection, String(itemId)],
    queryFn: () =>
      client.request<{
        data: Parameters<typeof bannerLines>[0]
        remediation_enabled?: boolean
      }>(get(`/integration-obligations/record/${collection}/${encodeURIComponent(String(itemId))}`)),
    enabled: !!collection && !!itemId,
    staleTime: 30_000,
    // A 403 means this viewer may not read the record's integrations — that
    // is an answer, not something to retry.
    retry: false
  })
  const lines = bannerLines(data?.data ?? [])
  if (lines.length === 0) return null
  const remediationEnabled = data?.remediation_enabled === true

  return (
    <div className='nvr-expand-in space-y-1.5' data-integration-banner>
      {lines.map((l) => {
        const role = roleForTone(l.tone)
        const [accent, accentDark] = role ? colorPair(role) : [null, null]
        const canSend =
          remediationEnabled &&
          (l.outcome === 'failed' || l.outcome === 'missing' || l.outcome === 'overdue')
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
                accent
                  ? 'bg-[color:var(--obt)] dark:bg-[color:var(--obtd)]'
                  : 'bg-slate-400 dark:bg-slate-600'
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
            {canSend && (
              <SendNowButton obligationId={l.obligation_id} collection={collection} itemId={itemId} />
            )}
          </div>
        )
      })}
    </div>
  )
}

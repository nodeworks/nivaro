import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Loader2, RefreshCw, RotateCcw, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { bannerLines } from '../../lib/obligation-banner'
import { requestTransitionRun } from '../../lib/run-transition'
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
  itemId,
  enabled = true
}: {
  obligationId: number
  collection: string
  itemId: string | number
  /** Remediation switch off → the button stays, disabled, and says how to
   *  turn it on: a person looking for the fix should find the path, not a
   *  line with nothing on it. */
  enabled?: boolean
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
      data-obligation-send-now-enabled={enabled}
      disabled={send.isPending || !enabled}
      title={
        enabled
          ? 'Re-send the newest request for this partner (admins)'
          : 'Remediation is off for this deployment — an admin turns it on under Integrations › Remediation, then this sends from here'
      }
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        send.mutate()
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-60',
        armed
          ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan dark:border-nvr-cyan dark:bg-nvr-cyan/15'
          : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
      )}
    >
      {send.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : <Send className='h-3 w-3' />}
      {armed ? 'Confirm send?' : 'Send now'}
    </button>
  )
}

/** The record's obligations, one cached read shared by the banner, the
 *  header Integrations chip and its popup — every transition / retry
 *  invalidates this exact key, so all three move together. */
export function useRecordObligations(collection: string, itemId: string | number) {
  const client = useNivaroClient()
  const query = useQuery({
    queryKey: ['integration-obligations', 'record', collection, String(itemId)],
    queryFn: () =>
      client.request<{
        data: Parameters<typeof bannerLines>[0]
        remediation_enabled?: boolean
      }>(
        get(`/integration-obligations/record/${collection}/${encodeURIComponent(String(itemId))}`)
      ),
    enabled: !!collection && !!itemId,
    staleTime: 30_000,
    // A 403 means this viewer may not read the record's integrations — that
    // is an answer, not something to retry.
    retry: false
  })
  return {
    ...query,
    lines: bannerLines(query.data?.data ?? []),
    remediationEnabled: query.data?.remediation_enabled === true
  }
}

export function IntegrationStatusBanner({ collection, itemId }: IntegrationStatusBannerProps) {
  const { lines, remediationEnabled } = useRecordObligations(collection, itemId)
  if (lines.length === 0) return null
  return (
    <div className='nvr-expand-in' data-integration-banner>
      <IntegrationStatusLines
        collection={collection}
        itemId={itemId}
        lines={lines}
        remediationEnabled={remediationEnabled}
      />
    </div>
  )
}

/** What a reader can DO about a line (Rob 2026-09-24: "the partner status
 *  messages should be actionable"). Every host that renders the lines
 *  passes what it can offer; a missing callback simply hides that action. */
export interface IntegrationLineActions {
  /** Re-send a stored request as-is (the request log's own Retry). */
  onRetry?: (submissionId: number) => void
  /** Show the request (payload + reply) behind a line. */
  onView?: (submissionId: number) => void
  /** Re-fetch the partner status (a pending send may have been acked). */
  onCheck?: () => void
  /** Called after "re-run <transition>" was handed to the pipeline panel —
   *  a popup closes itself so the requirements dialog is in front. */
  onRanTransition?: () => void
  /** Newest submission id per partner name (lower-cased) — how a `missing`
   *  or `failed` line without its own submission still finds one to show. */
  newestSubmissionByApi?: Map<string, { id: number; status: string }>
}

const actionBtn =
  'inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'

/** The lines themselves — one per partner — without the fetch, so the
 *  Integrations popup (which already holds the data) renders the same rows.
 *  Each line ends with what to do about it: a failed send offers Retry
 *  (same payload), the request itself, and — when a transition owns the
 *  send — "re-run <Submit to Warehouse>", which is the real fix once the
 *  rejected data is corrected (the pipeline panel runs it with its own
 *  save-first + requirements dialog); a partner never told offers the
 *  same re-run plus Send now for admins with remediation on; a send
 *  awaiting an ack offers Check now; a told partner offers the request. */
export function IntegrationStatusLines({
  collection,
  itemId,
  lines,
  remediationEnabled,
  actions
}: IntegrationStatusBannerProps & {
  lines: ReturnType<typeof bannerLines>
  remediationEnabled: boolean
  actions?: IntegrationLineActions
}) {
  if (lines.length === 0) return null
  return (
    <div className='space-y-1.5' data-integration-lines>
      {lines.map((l) => {
        const role = roleForTone(l.tone)
        const [accent, accentDark] = role ? colorPair(role) : [null, null]
        const open = l.outcome === 'failed' || l.outcome === 'missing' || l.outcome === 'overdue'
        const canSend = open
        const newest = actions?.newestSubmissionByApi?.get(l.api.toLowerCase())
        const submissionId = l.submission_id ?? newest?.id ?? null
        const canRetry =
          !!actions?.onRetry &&
          submissionId != null &&
          (l.outcome === 'failed' || newest?.status === 'failed')
        const canView = !!actions?.onView && submissionId != null
        const canRerun = !!l.transition_id && !!l.transition_label && open
        const canCheck = !!actions?.onCheck && (l.outcome === 'pending' || l.outcome === 'overdue')
        const rerun = () => {
          const claimed = requestTransitionRun({
            collection,
            item: String(itemId),
            transition_id: l.transition_id as string
          })
          if (!claimed) {
            toast.error(`Open the record to run “${l.transition_label}”`)
            return
          }
          actions?.onRanTransition?.()
        }
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
            <span className='ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1'>
              {canRerun && (
                <button
                  type='button'
                  data-integration-action='rerun'
                  onClick={rerun}
                  title={`Fix what ${l.api} rejected, then run “${l.transition_label}” again — it re-sends from the current values`}
                  className={cn(actionBtn, 'border-nvr-cyan/40 text-nvr-cyan hover:bg-nvr-cyan/10')}
                >
                  <RotateCcw className='h-3 w-3' />
                  Re-run {l.transition_label}
                </button>
              )}
              {canRetry && (
                <button
                  type='button'
                  data-integration-action='retry'
                  onClick={() => actions?.onRetry?.(submissionId as number)}
                  title='Send the same request again, unchanged — for a partner that was down, not for data it rejected'
                  className={actionBtn}
                >
                  <RefreshCw className='h-3 w-3' />
                  Retry
                </button>
              )}
              {canCheck && (
                <button
                  type='button'
                  data-integration-action='check'
                  onClick={() => actions?.onCheck?.()}
                  title='Ask again whether the partner has acknowledged it'
                  className={actionBtn}
                >
                  <RefreshCw className='h-3 w-3' />
                  Check now
                </button>
              )}
              {canView && (
                <button
                  type='button'
                  data-integration-action='view'
                  onClick={() => actions?.onView?.(submissionId as number)}
                  title='Show the request and the reply'
                  className={actionBtn}
                >
                  <Eye className='h-3 w-3' />
                  {l.outcome === 'failed' ? 'View error' : 'View request'}
                </button>
              )}
              {canSend && (
                <SendNowButton
                  obligationId={l.obligation_id}
                  collection={collection}
                  itemId={itemId}
                  enabled={remediationEnabled}
                />
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

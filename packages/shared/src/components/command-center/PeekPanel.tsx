import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { useCcQuery } from './api'
import { CcSidePanel, slaWords } from './panels/map-shared'
import { useCc } from './state'
import { BUTTON, FAINT, FOCUS, MUTED } from './theme'
import type { PeekRecord } from './types'

/**
 * CC-10 — the record in useCc().peek, in a right-side panel over the board (the map keeps its
 * position): title, step, SLA, owners, a few facts, the moves the caller may make (two-step
 * confirm inline, through the normal pipeline transition route) and Open full record.
 * Esc / Close clears the peek. A wallboard link (kiosk) shows no moves.
 *
 * Needs the shell to STORE the peek (setPeek keeps state) and render <PeekPanel /> once.
 */
export function PeekPanel() {
  const cc = useCc()
  const peek = cc.peek
  const close = () => cc.setPeek(null)
  const q = useCcQuery<PeekRecord>(
    '/peek',
    peek ? { collection: peek.collection, id: peek.id } : {},
    { enabled: !!peek, lenses: false, retry: false, staleTime: 15_000 }
  )
  const rec = q.data
  const notFound = q.isError && (q.error as { status?: number } | null)?.status === 404

  return (
    <CcSidePanel
      open={!!peek}
      label='Record preview'
      title={rec ? rec.title : notFound ? 'Not available' : 'Loading…'}
      subtitle={rec?.collection_label}
      onClose={close}
      footer={
        rec && (
          <button
            type='button'
            onClick={() => {
              cc.navigate(cc.recordUrl(rec.collection, rec.id))
              close()
            }}
            className={cn(BUTTON, FOCUS, 'inline-flex items-center gap-1.5')}
          >
            <ExternalLink className='h-3.5 w-3.5' aria-hidden='true' /> Open full record
          </button>
        )
      }
    >
      {q.isLoading && <PeekSkeleton />}
      {notFound && (
        <p className={`text-[12px] ${MUTED}`}>
          This record is not there any more, or you do not have access to it.
        </p>
      )}
      {q.isError && !notFound && (
        <p className='text-[12px] text-[var(--cc-bad-text)]'>Could not load this record.</p>
      )}
      {rec && <PeekBody rec={rec} canAct={!cc.kiosk} />}
    </CcSidePanel>
  )
}

function PeekSkeleton() {
  return (
    <div className='space-y-2' aria-hidden='true'>
      {[70, 45, 90, 60].map((w) => (
        <div
          key={w}
          className='h-3 animate-pulse rounded bg-[var(--cc-chip-hover)]'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

function PeekBody({ rec, canAct }: { rec: PeekRecord; canAct: boolean }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 6000)
    return () => clearTimeout(t)
  }, [armed])
  const move = useMutation({
    mutationFn: (transitionId: string) =>
      client.request(
        post(
          `/pipelines/instance/${encodeURIComponent(rec.collection)}/${encodeURIComponent(rec.id)}/transition`,
          { transition_id: transitionId }
        )
      ),
    onSuccess: (_d, id) => {
      const label = rec.transitions.find((t) => t.key === id)?.label ?? 'Moved'
      toast.success(`${label} — done`)
      setArmed(null)
      void qc.invalidateQueries({ queryKey: ['command-center'] })
    },
    onError: (err: unknown) => {
      setArmed(null)
      toast.error((err as { message?: string }).message || 'That move did not go through')
    }
  })
  const sla = slaWords(rec.sla)
  return (
    <div className='space-y-4 text-[12px]'>
      <div className='flex flex-wrap items-center gap-1.5'>
        {rec.state && (
          <span className='inline-flex items-center gap-1.5 rounded-full bg-[var(--cc-chip)] px-2 py-0.5'>
            <span
              className='h-2 w-2 rounded-full'
              style={{ background: rec.state.color ?? '#00a5cc' }}
              aria-hidden='true'
            />
            {rec.state.label}
          </span>
        )}
        {sla && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              rec.sla === 'breached'
                ? 'bg-red-500/15 text-[var(--cc-bad-text)]'
                : 'bg-amber-500/15 text-[var(--cc-warn-text)]'
            )}
          >
            {sla}
          </span>
        )}
        {rec.sla === 'ok' && (
          <span className={`rounded-full bg-[var(--cc-chip)] px-2 py-0.5 ${MUTED}`}>
            SLA on time
          </span>
        )}
        {!rec.state && <span className={FAINT}>Not in a pipeline</span>}
      </div>

      <div>
        <p className={`mb-1 ${FAINT}`}>Owners</p>
        {rec.owners.length > 0 ? (
          <p className='text-[var(--cc-text)]'>{rec.owners.map((o) => o.name).join(', ')}</p>
        ) : (
          <p className={MUTED}>Nobody owns this step</p>
        )}
      </div>

      {rec.facts.length > 0 && (
        <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5'>
          {rec.facts.map((f) => (
            <div key={f.label} className='contents'>
              <dt className={FAINT}>{f.label}</dt>
              <dd className='min-w-0 break-words text-[var(--cc-text)]'>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {canAct && rec.transitions.length > 0 && (
        <div>
          <p className={`mb-1.5 ${FAINT}`}>Move it</p>
          <div className='flex flex-wrap gap-1.5'>
            {rec.transitions.map((t) => {
              const isArmed = armed === t.key
              return (
                <button
                  key={t.key}
                  type='button'
                  disabled={move.isPending}
                  onClick={() => (isArmed ? move.mutate(t.key) : setArmed(t.key))}
                  aria-label={isArmed ? `Confirm: ${t.label}` : t.label}
                  className={cn(
                    BUTTON,
                    FOCUS,
                    isArmed && 'border-nvr-cyan bg-nvr-cyan text-white hover:bg-nvr-cyan'
                  )}
                >
                  {move.isPending && isArmed ? 'Moving…' : isArmed ? `Confirm ${t.label}` : t.label}
                </button>
              )
            })}
          </div>
          {armed && !move.isPending && (
            <p className={`mt-1.5 ${FAINT}`} role='status'>
              Click again to confirm. Some moves ask for more on the full record.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

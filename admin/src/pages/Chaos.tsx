import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { OctagonX, ShieldOff, Siren } from 'lucide-react'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { type ChaosStatus, chaosKeys, errText, fetchStatus, stopAll } from './chaos/api'
import { ChaosTabNav, PANEL_ID, tabDomId } from './chaos/TabNav'
import { CHAOS_TABS } from './chaos/tabs'

/**
 * Chaos (#2827, #2843) — the console for fault drills: the catalog, runs with their verdicts, the
 * live cockpit while one runs, and one Stop all. Administrators only; the gate
 * (api/src/services/chaos/gate.ts) refuses in cloud mode and on an unflagged production box,
 * and the strip under the header says so instead of hiding the page.
 */
export function ChaosPage() {
  const [params, setParams] = useSearchParams()
  const tab = CHAOS_TABS.find((t) => t.id === params.get('tab')) ?? CHAOS_TABS[0]
  const setTab = (id: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (id === CHAOS_TABS[0].id) next.delete('tab')
        else next.set('tab', id)
        next.delete('run')
        return next
      },
      { replace: true }
    )
  const qc = useQueryClient()
  const { data: status } = useQuery<ChaosStatus>({
    queryKey: chaosKeys.status,
    queryFn: fetchStatus,
    refetchInterval: (q) => (q.state.data?.armed.length ? 5_000 : 30_000)
  })

  // Every run change on any replica lands here; the tabs re-read what they show.
  useEffect(() => {
    const leave = joinWatchRoom('chaos')
    const offRun = adminRealtime.on('chaos:run', () => {
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    })
    const offArmed = adminRealtime.on('chaos:armed', () => {
      void qc.invalidateQueries({ queryKey: chaosKeys.status })
    })
    return () => {
      leave()
      offRun()
      offArmed()
    }
  }, [qc])

  const Body = tab.component
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Siren className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div className='min-w-0 flex-1 basis-[220px]'>
          <h1 className='text-base font-semibold'>Chaos</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Arm a fault for a few minutes, watch what should stay true hold, stop it from here.
          </p>
        </div>
        {status?.allowed && <StopAll status={status} />}
      </header>
      {status && !status.allowed && <GateStrip reason={status.reason} />}
      <ChaosTabNav active={tab} onSelect={setTab} />
      <div
        id={PANEL_ID}
        role='tabpanel'
        aria-labelledby={tabDomId(tab.id)}
        className='flex flex-1 min-h-0 flex-col overflow-hidden bg-slate-50 dark:bg-background'
      >
        <Body key={tab.id} />
      </div>
    </div>
  )
}

/** Why nothing can be armed here. Reads stay available (history, the catalog). */
function GateStrip({ reason }: { reason: string | null }) {
  return (
    <div
      role='status'
      className='flex shrink-0 items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-900 sm:px-6 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
    >
      <ShieldOff className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <div className='min-w-0'>
        <span className='font-medium'>Faults cannot be armed on this instance.</span>{' '}
        <span>{reason ?? 'The chaos gate refused.'}</span>{' '}
        <span className='text-amber-800/80 dark:text-amber-300/80'>
          Past runs and the catalog still read. Drills run on development and staging, or on a
          production box started with{' '}
          <code className='font-mono text-[11.5px]'>CHAOS_ENABLED=true</code> on purpose.
        </span>
      </div>
    </div>
  )
}

/** The one red control on the page: every fault on every replica, socket drills included. */
function StopAll({ status }: { status: ChaosStatus }) {
  const qc = useQueryClient()
  const armed = status.armed.length
  const m = useMutation({
    mutationFn: stopAll,
    onSuccess: (r) => {
      toast.success(
        r.stopped.length
          ? `Stopped ${r.stopped.length} fault${r.stopped.length === 1 ? '' : 's'}`
          : 'Nothing was armed'
      )
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    },
    onError: (e) => toast.error(errText(e, 'Stop all failed'))
  })
  return (
    <div className='flex items-center gap-2'>
      <span
        className={cn(
          'rounded px-2 py-1 text-[11.5px] font-medium tabular-nums',
          armed
            ? 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
            : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
        )}
      >
        {armed ? `${armed} armed` : 'Nothing armed'}
      </span>
      <button
        type='button'
        onClick={() => m.mutate()}
        disabled={m.isPending || !armed}
        data-tip={armed ? 'Clears every fault on every replica' : 'No fault is armed'}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none dark:focus-visible:ring-offset-card',
          // Red only while there is something to stop; at rest it is a quiet outline.
          armed
            ? 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-400 disabled:opacity-60'
            : 'border border-slate-200 text-slate-400 dark:border-border dark:text-muted-foreground/70'
        )}
      >
        <OctagonX className='h-3.5 w-3.5' aria-hidden />
        Stop all
      </button>
    </div>
  )
}

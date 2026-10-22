import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Siren } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * "Declare incident" (#2854). Anyone signed in can say "something is wrong" in one click; the
 * server stamps a `declared` mark on every game day and blind drill in flight, which becomes the
 * run's time to detect. The answer never says whether a drill was running — a responder in a
 * blind drill must not learn it from this button — so the button only confirms the time.
 *
 * Inline two-step (Declare → Declare now / Cancel), no modal. Hosts mount it in the Ops Console
 * header and beside the drill banner. Both copies share the "Declared at" time (one cache key),
 * so declaring from the banner also shows on the page header. The inline texts take the host's
 * colour, so the button reads the same on the red banner and on a plain page header.
 */

const DECLARED_KEY = ['chaos-declared-at'] as const

export function DeclareIncidentButton({ className }: { className?: string }) {
  const client = useNivaroClient()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const { data: declaredAt = null } = useQuery<string | null>({
    queryKey: DECLARED_KEY,
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY
  })
  const [failed, setFailed] = useState(false)

  const declare = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const r = await client.request<{ data: { at: string } }>(post('/chaos/declare', {}))
      qc.setQueryData(DECLARED_KEY, r.data?.at ?? new Date().toISOString())
      setConfirming(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  if (confirming)
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-[12px]', className)}>
        <span className='whitespace-nowrap opacity-80'>Declare an incident now?</span>
        <button
          type='button'
          disabled={busy}
          onClick={() => void declare()}
          className='h-7 whitespace-nowrap rounded-md border border-red-300 bg-white px-2.5 font-medium text-red-700 transition-colors duration-150 hover:border-red-400 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-40 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200 dark:hover:border-red-700 dark:hover:bg-red-900/50'
        >
          {busy ? 'Declaring…' : 'Declare now'}
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={() => setConfirming(false)}
          className='h-7 whitespace-nowrap rounded-md px-2 opacity-80 transition-colors duration-150 hover:bg-black/[0.05] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-white/[0.08]'
        >
          Cancel
        </button>
        {failed && (
          <span role='alert' className='font-medium text-red-700 dark:text-red-400'>
            Not recorded — try again
          </span>
        )}
      </span>
    )

  return (
    <span className={cn('inline-flex items-center gap-2 text-[12px]', className)}>
      <button
        type='button'
        onClick={() => setConfirming(true)}
        data-tip='Mark the moment you noticed something wrong'
        className='inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 font-medium text-slate-700 transition-colors duration-150 hover:border-red-300 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground dark:hover:border-red-800 dark:hover:text-red-400'
      >
        <Siren className='h-3.5 w-3.5 shrink-0' aria-hidden />
        Declare incident
      </button>
      {declaredAt && (
        <span role='status' className='whitespace-nowrap opacity-75'>
          Declared at {time(declaredAt)}
        </span>
      )}
    </span>
  )
}

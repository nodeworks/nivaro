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
 * header and beside the drill banner.
 */
export function DeclareIncidentButton({ className }: { className?: string }) {
  const client = useNivaroClient()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [declaredAt, setDeclaredAt] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const declare = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const r = await client.request<{ data: { at: string } }>(post('/chaos/declare', {}))
      setDeclaredAt(r.data?.at ?? new Date().toISOString())
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
        <span className='text-slate-600 dark:text-muted-foreground'>Declare an incident now?</span>
        <button
          type='button'
          disabled={busy}
          onClick={() => void declare()}
          className='h-7 rounded-md bg-red-600 px-2.5 font-medium text-white transition-colors duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1 disabled:opacity-40 dark:focus-visible:ring-offset-background'
        >
          {busy ? 'Declaring…' : 'Declare now'}
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={() => setConfirming(false)}
          className='h-7 rounded-md px-2 text-slate-600 transition-colors duration-150 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted'
        >
          Cancel
        </button>
        {failed && <span className='text-red-700 dark:text-red-400'>Not recorded — try again</span>}
      </span>
    )

  return (
    <span className={cn('inline-flex items-center gap-2 text-[12px]', className)}>
      <button
        type='button'
        onClick={() => setConfirming(true)}
        className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 font-medium text-slate-700 transition-colors duration-150 hover:border-red-300 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground dark:hover:border-red-800 dark:hover:text-red-400'
      >
        <Siren className='h-3.5 w-3.5' aria-hidden />
        Declare incident
      </button>
      {declaredAt && (
        <span role='status' className='text-slate-500 dark:text-muted-foreground'>
          Declared at {time(declaredAt)}
        </span>
      )}
    </span>
  )
}

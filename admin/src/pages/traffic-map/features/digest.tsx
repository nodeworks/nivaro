import { Mail } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1128 — opt in to the traffic section of the daily summary (busiest callers, new callers,
 * error hot spots and integrations that went silent over the last day). Stored as the
 * `traffic_digest` preference; the section rides the existing daily summary email.
 */
export function DigestToggle() {
  const { user, refetch } = useAuth()
  const frozen = useFrozenSnapshotId()
  const [busy, setBusy] = useState(false)
  if (frozen) return null
  const prefs = (user as { preferences?: { traffic_digest?: unknown } } | null)?.preferences
  const on = prefs?.traffic_digest === true
  const toggle = async () => {
    setBusy(true)
    try {
      await api.patch('/users/me/preferences', { traffic_digest: on ? null : true })
      await refetch()
      toast.success(
        on ? 'Traffic left out of your daily summary' : 'Traffic added to your daily summary'
      )
    } catch {
      toast.error('Could not save the preference')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type='button'
      id='tm-digest'
      aria-pressed={on}
      disabled={busy}
      onClick={() => void toggle()}
      title='Busiest callers, new callers, error hot spots and silent integrations over the last day, in your daily summary email'
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)] disabled:cursor-not-allowed disabled:opacity-60',
        on
          ? 'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      <Mail className='h-3.5 w-3.5' aria-hidden='true' />
      {on ? 'In daily summary' : 'Daily summary'}
    </button>
  )
}

register(toolbarItems, { id: 'digest', order: 80, Component: DigestToggle })

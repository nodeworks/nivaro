import { useQuery } from '@tanstack/react-query'
import { type ComponentType, type ReactNode, useContext } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { TrafficMapContext } from '../context'
import { ConfirmButton } from './shared'

/**
 * Shared bits for the ops / health / capacity features (group E): a polling read of a Traffic Map
 * route (paused with the map), the strip tile frame, the page card frame and a two-click button.
 */

/** GET /api/traffic-map<path> every `intervalMs` while the map is live; `data.data` or null. */
export function useTmRoute<T>(
  key: readonly unknown[],
  path: string | null,
  intervalMs: number
): { data: T | null; error: boolean; loading: boolean; refetch: () => void } {
  const ctx = useContext(TrafficMapContext)
  const paused = ctx?.paused ?? false
  const q = useQuery({
    queryKey: ['traffic-map', 'ops', ...key],
    queryFn: async () => {
      const res = await api.get(`/traffic-map${path}`)
      return (res?.data?.data ?? null) as T | null
    },
    enabled: !!path && !!ctx,
    refetchInterval: paused ? false : intervalMs,
    staleTime: Math.min(intervalMs, 30_000)
  })
  return {
    data: (q.data ?? null) as T | null,
    error: q.isError,
    loading: q.isLoading && !!path,
    refetch: () => void q.refetch()
  }
}

/** Render `C` only inside the Traffic Map page (a strip rendered on its own shows nothing extra). */
export function inMapOnly(C: ComponentType): ComponentType {
  return function InMap() {
    return useContext(TrafficMapContext) ? <C /> : null
  }
}

export const LINK =
  'rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

export const BTN =
  'inline-flex items-center gap-1 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 py-[2px] text-[11.5px] font-medium text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-60'

export const BTN_DANGER =
  'inline-flex items-center gap-1 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-2 py-[2px] text-[11.5px] font-medium text-[var(--tm-error-ink)] transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-60'

export const INPUT =
  'h-7 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px] text-[var(--tm-fg)] placeholder:text-[var(--tm-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

/** A summary-strip cell in the strip's own look (label, big figure, one or two lines). */
export function StripCell({
  label,
  value,
  unit,
  tone,
  testId,
  className,
  children
}: {
  label: string
  value: string
  unit?: string
  tone?: 'bad' | 'warn'
  testId: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn('min-w-0 bg-[var(--tm-card)] px-3.5 pb-2.5 pt-2.5', className)}>
      <div className='text-[12px] font-medium text-[var(--tm-muted)]'>{label}</div>
      <div
        className={cn(
          'mt-0.5 flex items-baseline gap-1.5 text-[22px] font-semibold leading-tight tracking-tight tabular-nums',
          tone === 'bad' && 'text-[var(--tm-error-ink)]',
          tone === 'warn' && 'text-[var(--tm-update)]'
        )}
      >
        <span data-testid={testId}>{value}</span>
        {unit && value !== '—' && (
          <small className='text-[11.5px] font-medium tracking-normal text-[var(--tm-muted)]'>
            {unit}
          </small>
        )}
      </div>
      <div className='mt-1 grid min-w-0 gap-0.5 text-[11.5px] text-[var(--tm-muted)]'>
        {children}
      </div>
    </div>
  )
}

/** A page panel card with a heading row. */
export function PanelCard({
  title,
  hint,
  id,
  actions,
  children
}: {
  title: string
  hint?: ReactNode
  id: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label={title}
      id={id}
    >
      <div className='flex items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>{title}</h2>
          {hint && <p className='text-[11.5px] text-[var(--tm-muted)]'>{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

/**
 * The shared two-click confirm (ConfirmButton) under the ops panels' prop names: the first click
 * arms it ("Click again to …"), the second within 4 s acts; `busy` stops a second fire.
 */
export function TwoClickButton({
  label,
  armedLabel,
  onConfirm,
  busy,
  disabled,
  danger,
  id,
  className
}: {
  label: string
  armedLabel: string
  onConfirm: () => void
  busy?: boolean
  disabled?: boolean
  danger?: boolean
  id?: string
  className?: string
}) {
  return (
    <ConfirmButton
      label={label}
      confirmLabel={armedLabel}
      onConfirm={onConfirm}
      busy={busy}
      disabled={disabled}
      danger={danger}
      id={id}
      className={className}
    />
  )
}

/** "1.2 s", "340 ms", "—". */
export function fmtLag(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms * 10) / 10} ms`
}

/** The server's error text for a failed request. */
export function apiError(e: unknown): string {
  const r = e as { response?: { data?: { error?: string } }; message?: string }
  return r?.response?.data?.error ?? r?.message ?? 'Something went wrong'
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

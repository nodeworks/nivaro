/**
 * Plumbing the group A inspector features share: the entity-detail read (one request for every
 * tap's detail), a two-click confirm button, and the button / link classes on the tm tokens.
 */
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Selection } from '../types'

export const BTN =
  'inline-flex items-center gap-1 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 py-[3px] text-[12px] font-medium leading-tight text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'
export const BTN_DANGER =
  'inline-flex items-center gap-1 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-2 py-[3px] text-[12px] font-medium leading-tight text-[var(--tm-error-ink)] transition-colors duration-150 ease-out hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'
export const LINK =
  'rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
export const INPUT =
  'h-7 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px] text-[var(--tm-fg)] placeholder:text-[var(--tm-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

/** `<lane>/<entity>` of an entity selection; null for anything else. */
export function entityOf(sel: Selection): { key: string; lane: string; entity: string } | null {
  if (sel.kind !== 'entity') return null
  const cut = sel.id.indexOf('/')
  if (cut <= 0) return null
  return { key: sel.id, lane: sel.id.slice(0, cut), entity: sel.id.slice(cut + 1) }
}

/** Error text of a failed admin call (the server's `error`, else the transport message). */
export function errorOf(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong'
}

/**
 * Every tap's `entityDetail` for one entity (GET /traffic-map/entity-detail). One request per
 * entity and window, shared by every panel that reads a slice of it.
 */
export function useEntityDetail<T = unknown>(
  key: string | null,
  tapId: string,
  win: number
): { data: T | undefined; loading: boolean; error: boolean } {
  const q = useQuery({
    queryKey: ['traffic-map', 'entity-detail', key, win],
    queryFn: async () => {
      const res = await api.get('/traffic-map/entity-detail', {
        params: { key, window: win }
      })
      return ((res?.data as { data?: Record<string, unknown> })?.data ?? {}) as Record<
        string,
        unknown
      >
    },
    enabled: !!key,
    staleTime: 10_000,
    refetchInterval: 20_000
  })
  return {
    data: q.data?.[tapId] as T | undefined,
    loading: q.isLoading,
    error: q.isError
  }
}

/**
 * Two-click confirm: the first press arms it ("Revoke key?"), the second within 4 s runs it.
 * Blur or the timeout disarms. Never one click for anything that changes state.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  busy,
  danger,
  disabled,
  id
}: {
  label: ReactNode
  confirmLabel: ReactNode
  onConfirm: () => void
  busy?: boolean
  danger?: boolean
  disabled?: boolean
  id?: string
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return (
    <button
      type='button'
      id={id}
      data-tm-confirm={armed ? 'armed' : 'idle'}
      disabled={disabled || busy}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setArmed(false), 4000)
          return
        }
        setArmed(false)
        onConfirm()
      }}
      className={cn(armed || danger ? BTN_DANGER : BTN, armed && 'ring-1 ring-[var(--tm-error)]')}
    >
      {busy ? 'Working…' : armed ? confirmLabel : label}
    </button>
  )
}

/** A short one-line result/notice under an action. */
export function Note({
  tone = 'muted',
  children
}: {
  tone?: 'muted' | 'ok' | 'error'
  children: ReactNode
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'basis-full text-[11.5px]',
        tone === 'error'
          ? 'text-[var(--tm-error-ink)]'
          : tone === 'ok'
            ? 'text-[var(--tm-fg-2)]'
            : 'text-[var(--tm-muted)]'
      )}
    >
      {children}
    </p>
  )
}

/** A router Link inside the app; a plain anchor where no router is mounted (isolated renders). */
export function SafeLink({
  to,
  children,
  ...rest
}: {
  to: string
  children: ReactNode
  className?: string
  id?: string
  title?: string
  onClick?: (e: React.MouseEvent) => void
  'aria-label'?: string
  [data: `data-${string}`]: string | undefined
}) {
  const inRouter = useInRouterContext()
  if (inRouter)
    return (
      <Link to={to} {...rest}>
        {children}
      </Link>
    )
  return (
    <a href={to} {...rest}>
      {children}
    </a>
  )
}

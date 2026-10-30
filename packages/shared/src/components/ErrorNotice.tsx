import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  ChevronRight,
  Copy,
  LifeBuoy,
  LogIn,
  RotateCw,
  WifiOff
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { openSupportForError, runErrorAction } from '../lib/error-actions'
import {
  copyErrorDetails,
  type DescribeErrorOptions,
  describeError,
  describeLoadError,
  type ErrorAction,
  type ErrorDescription
} from '../lib/error-message'
import { cn } from '../lib/utils'

const ACTION_ICON = {
  retry: RotateCw,
  reload: RotateCw,
  'sign-in': LogIn,
  'go-back': ArrowLeft,
  contact: LifeBuoy
} as const

/**
 * The collapsed "Details for support": the reference (request id), the code
 * and status, a Copy button and a way to ask for help with all of it filled
 * in. Closed by default — the person reads what happened and what to do; the
 * reference is there for whoever helps them.
 */
export function ErrorDetails({
  description: d,
  action,
  className
}: {
  description: ErrorDescription
  /** What the person was doing ("Save record"), for the copy. */
  action?: string
  className?: string
}) {
  const [copied, setCopied] = useState<boolean | null>(null)
  if (!d.requestId && !d.code && !d.status && !d.technical) return null
  return (
    <details data-error-details='' className={cn('group text-[11.5px]', className)}>
      <summary className='inline-flex cursor-pointer list-none items-center gap-1 rounded text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:text-foreground [&::-webkit-details-marker]:hidden'>
        <ChevronRight className='h-3 w-3 transition-transform group-open:rotate-90' aria-hidden />
        Details for support
      </summary>
      <div className='mt-1.5 space-y-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-left text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
        {d.requestId && (
          <p>
            Reference: <span className='select-all font-mono'>{d.requestId}</span>
          </p>
        )}
        {(d.code || d.status) && (
          <p>
            Code:{' '}
            <span className='font-mono'>
              {[d.code, d.status ? `HTTP ${d.status}` : null].filter(Boolean).join(' · ')}
            </span>
          </p>
        )}
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5'>
          <button
            type='button'
            data-error-copy=''
            onClick={() => {
              void copyErrorDetails(d, { action }).then(setCopied)
            }}
            className='inline-flex items-center gap-1 font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
          >
            <Copy className='h-3 w-3' aria-hidden />
            {copied === true ? 'Copied' : copied === false ? 'Could not copy' : 'Copy details'}
          </button>
          <button
            type='button'
            data-error-help=''
            onClick={() => openSupportForError(d, { action })}
            className='inline-flex items-center gap-1 font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
          >
            <LifeBuoy className='h-3 w-3' aria-hidden />
            Ask for help
          </button>
        </div>
      </div>
    </details>
  )
}

/**
 * Any failure, said for a person: what happened, what to do, ONE button that
 * does it, and the reference tucked into "Details for support". Pass the
 * error itself (`error`) — or an already-read `description` — never its text.
 *
 *   variant 'inline'  a panel or widget's degraded state (default)
 *           'page'    fills the area the content would have used
 *           'banner'  a strip above a list or form
 *
 * `onRetry` makes "Try again" re-run the read or the action; without it a
 * retry reloads the page. `what` reads a failed load ("Couldn’t load the
 * dashboard") instead of a failed action.
 */
export function ErrorNotice({
  error,
  description,
  what,
  fallback,
  onRetry,
  actionLabel,
  action: actionOverride,
  variant = 'inline',
  centered: centeredProp = false,
  fieldLabels,
  className
}: {
  error?: unknown
  description?: ErrorDescription
  /** For a failed read: lower-case noun, "the dashboard", "this list". */
  what?: string
  /** Title when nothing says more ("Could not save"). */
  fallback?: string
  onRetry?: () => void
  /** What the person was doing, for the support copy ("Save record"). */
  actionLabel?: string
  /** Replace the offered action (or `null` for none). */
  action?: ErrorAction | null
  variant?: 'inline' | 'page' | 'banner'
  /** Inline only: stack and centre it (a widget's empty body). */
  centered?: boolean
  fieldLabels?: DescribeErrorOptions['fieldLabels']
  className?: string
}) {
  const d = useMemo(
    () =>
      description ??
      (what
        ? describeLoadError(error, what, { fieldLabels })
        : describeError(error, fallback, { fieldLabels })),
    [description, error, what, fallback, fieldLabels]
  )
  const action = actionOverride === undefined ? d.action : actionOverride
  const Icon =
    d.kind === 'offline' || d.kind === 'network'
      ? WifiOff
      : d.kind === 'forbidden'
        ? Ban
        : AlertTriangle
  const ActionIcon = action ? ACTION_ICON[action.kind] : null
  const button = action && ActionIcon && (
    <button
      type='button'
      data-error-action={action.kind}
      onClick={() => runErrorAction(action.kind, d, { retry: onRetry, action: actionLabel })}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        variant === 'banner'
          ? 'h-6 shrink-0 rounded border border-amber-400/60 bg-white px-2 text-[12px] text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15'
          : variant === 'page'
            ? 'h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] text-slate-800 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
            : 'rounded text-[12px] text-sky-700 hover:underline dark:text-nvr-cyan'
      )}
    >
      <ActionIcon className='h-3 w-3' aria-hidden />
      {action.label}
    </button>
  )

  if (variant === 'banner') {
    return (
      <div
        role='alert'
        data-error-notice='banner'
        data-error-kind={d.kind ?? ''}
        className={cn(
          'flex shrink-0 flex-wrap items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
          className
        )}
      >
        <Icon aria-hidden className='mt-0.5 h-3.5 w-3.5 shrink-0' />
        <div className='min-w-0 flex-1'>
          <p className='font-medium'>{d.title}</p>
          {d.hint && <p className='text-amber-800 dark:text-amber-200/80'>{d.hint}</p>}
          <ErrorDetails description={d} action={actionLabel} className='mt-1' />
        </div>
        {button}
      </div>
    )
  }

  const centered = variant === 'page' || centeredProp
  const body = (
    <div
      role='alert'
      data-error-notice={variant}
      data-load-error=''
      data-error-kind={d.kind ?? ''}
      className={cn(
        'flex gap-2 text-[12px] text-slate-600 dark:text-muted-foreground',
        centered ? 'max-w-[360px] flex-col items-center text-center' : 'items-start',
        variant !== 'page' && className
      )}
    >
      <Icon
        className={cn(
          'shrink-0 text-amber-500',
          centered ? 'h-5 w-5' : 'mt-px h-3.5 w-3.5',
          d.kind === 'forbidden' && 'text-slate-400'
        )}
        aria-hidden
      />
      <div className={cn('min-w-0', centered && 'flex flex-col items-center gap-1')}>
        <p
          className={cn(
            'leading-snug [text-wrap:balance]',
            centered
              ? 'text-[13.5px] font-semibold text-slate-900 dark:text-foreground'
              : 'font-medium text-slate-800 dark:text-foreground'
          )}
        >
          {d.title}
        </p>
        {d.hint && <p className='leading-snug [text-wrap:balance]'>{d.hint}</p>}
        {button && <div className={centered ? 'mt-1.5' : 'mt-1'}>{button}</div>}
        <ErrorDetails description={d} action={actionLabel} className='mt-1.5' />
      </div>
    </div>
  )
  if (variant !== 'page') return body
  return (
    <div className={cn('flex min-h-[200px] flex-1 items-center justify-center p-8', className)}>
      {body}
    </div>
  )
}

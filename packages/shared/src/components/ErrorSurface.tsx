import { Ban, Compass, ServerCrash } from 'lucide-react'
import type { ReactNode } from 'react'
import { describeError } from '../lib/error-message'
import { isRawErrorText } from '../lib/safe-error'
import { ErrorDetails } from './ErrorNotice'

/**
 * Error surface family (#324): 403/404/500 as one designed system — a name
 * for what happened, an honest cause line, and the one right action. The
 * smart-404 (#219) and AccessDeniedPanel remain the record-scoped variants;
 * this is the page-level chrome.
 *
 * `detail` is shown only when it is a plain sentence; raw text (a status line,
 * a stack, SQL, a JavaScript error) never is. Pass the `error` itself to put
 * its reference in a collapsed "Details for support" with Copy.
 */
const spec500Title = 'Something broke rendering this page'

export function ErrorSurface({
  variant,
  detail,
  error,
  action
}: {
  variant: '403' | '404' | '500'
  detail?: string
  error?: unknown
  action?: ReactNode
}) {
  const plainDetail = detail && !isRawErrorText(detail) ? detail : null
  const described =
    error !== undefined && error !== null
      ? describeError(error)
      : detail && !plainDetail
        ? { title: spec500Title, technical: detail.slice(0, 500) }
        : null
  const spec = {
    '403': {
      icon: Ban,
      tint: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
      title: "You don't have access to this page",
      body: 'Your role doesn’t include it. If you need it, ask an administrator.'
    },
    '404': {
      icon: Compass,
      tint: 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground',
      title: 'This page doesn’t exist',
      body: 'The link may be old, or the thing it pointed at was deleted or renamed.'
    },
    '500': {
      icon: ServerCrash,
      tint: 'bg-red-100 text-red-500 dark:bg-red-500/15 dark:text-red-400',
      title: 'Something broke rendering this page',
      body: 'The error was reported automatically. Trying again usually works.'
    }
  }[variant]
  const Icon = spec.icon
  return (
    <div className='nvr-rise-in flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center'>
      <div className={`flex h-12 w-12 items-center justify-center rounded-full ${spec.tint}`}>
        <Icon className='h-6 w-6' />
      </div>
      <p className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>{spec.title}</p>
      <p className='max-w-[440px] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        {spec.body}
      </p>
      {plainDetail && (
        <p className='max-w-[520px] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          {plainDetail.length > 300 ? `${plainDetail.slice(0, 300)}…` : plainDetail}
        </p>
      )}
      {action && <div className='mt-1'>{action}</div>}
      {described && <ErrorDetails description={described} className='mt-1' />}
    </div>
  )
}

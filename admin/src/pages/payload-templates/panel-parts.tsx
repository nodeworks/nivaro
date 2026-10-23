import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { type DraftBody, errorMessage, usePreview } from './api'
import { JsonDiff } from './JsonDiff'
import { RecordPicker } from './RecordPicker'

// ─── Pieces every preview-column panel shares ───────────────────────────────

export const OUTLINE_BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'

export const PRIMARY_BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-semibold text-white hover:bg-nvr-cyan/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 dark:focus-visible:ring-offset-background'

/** A solid neutral button for confirming a draft-changing step (cyan stays Publish-only). */
export const STRONG_BTN = cn(
  OUTLINE_BTN,
  'border-slate-900 bg-slate-900 text-white hover:bg-slate-800 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
)

export const SECTION_LABEL = 'text-[12px] font-semibold text-slate-700 dark:text-slate-200'

export type SegmentOption<T extends string> = { value: T; label: ReactNode; off?: string }

/** The page's segmented toggle (same look and a11y as the preview's Draft · Live · Diff). */
export function Segmented<T extends string>({
  legend,
  value,
  options,
  onChange
}: {
  legend: string
  value: T
  options: SegmentOption<T>[]
  onChange: (v: T) => void
}) {
  return (
    <fieldset className='inline-flex shrink-0 rounded-md border border-slate-200 p-0.5 dark:border-border'>
      <legend className='sr-only'>{legend}</legend>
      {options.map((o) => (
        <span key={o.value} data-tip={o.off}>
          <button
            type='button'
            aria-pressed={value === o.value}
            disabled={!!o.off}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded px-2.5 py-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
              value === o.value
                ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-foreground'
                : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            )}
          >
            {o.label}
          </button>
        </span>
      ))}
    </fieldset>
  )
}

/** Title bar + scrolling body (+ optional pinned footer) in the preview column. */
export function PanelFrame({
  title,
  panel,
  onClose,
  children,
  footer,
  actions
}: {
  title: ReactNode
  panel: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className='flex min-h-0 flex-1 flex-col bg-white dark:bg-card' data-payload-panel={panel}>
      <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-border'>
        <h2 className='min-w-0 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {title}
        </h2>
        <span className='flex-1' />
        {actions}
        <button
          type='button'
          onClick={onClose}
          className='inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground'
          data-payload-panel-close
        >
          <X className='h-3.5 w-3.5' />
          Back to preview
        </button>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto'>{children}</div>
      {footer && (
        <div className='shrink-0 border-t border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
          {footer}
        </div>
      )}
    </div>
  )
}

export function Bars({ rows = [70, 45, 60, 38] }: { rows?: number[] }) {
  return (
    <div className='space-y-2' aria-hidden>
      {rows.map((w, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          key={i}
          className='h-3 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

export function InlineError({
  title,
  error,
  onRetry
}: {
  title: string
  error: unknown
  onRetry?: () => void
}) {
  return (
    <div
      className='rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
      role='alert'
    >
      <p className='font-medium'>{title}</p>
      <p className='mt-0.5 break-words'>{errorMessage(error)}</p>
      {onRetry && (
        <button
          type='button'
          onClick={onRetry}
          className='mt-2 inline-flex items-center gap-1 text-[12px] font-medium underline underline-offset-2'
        >
          <RefreshCw className='h-3 w-3' />
          Try again
        </button>
      )}
    </div>
  )
}

export function EditWarningNote({ text }: { text: string }) {
  return (
    <div
      className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
      role='note'
      data-payload-edit-warning
    >
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
      <p>{text}</p>
    </div>
  )
}

/** A body is "map" or "code"; say which in words. */
export const modeWord = (b: DraftBody | null | undefined) =>
  b?.mode === 'code' ? 'Liquid' : 'a field map'

type Side = { label: string; body: DraftBody | null }

/**
 * Two template bodies compared either as the payload they send for one real
 * record (the server renders both) or as their template source.
 */
export function BodyCompare({
  templateKey,
  collection,
  recordId,
  onRecordChange,
  before,
  after,
  sameText
}: {
  templateKey: string
  collection: string
  recordId: string | null
  onRecordChange: (id: string) => void
  before: Side
  after: Side
  sameText?: { payload: string; template: string }
}) {
  const [view, setView] = useState<'payload' | 'template'>('payload')
  const beforeQ = usePreview(templateKey, {
    which: 'draft',
    recordId,
    draft: before.body,
    enabled: view === 'payload' && !!before.body
  })
  const afterQ = usePreview(templateKey, {
    which: 'draft',
    recordId,
    draft: after.body,
    enabled: view === 'payload' && !!after.body
  })

  let body: ReactNode
  if (view === 'template') {
    const bs = before.body
    const as = after.body
    body = (
      <>
        {bs && as && bs.mode !== as.mode && (
          <p className='mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {before.label} is {modeWord(bs)}; {after.label} is {modeWord(as)}.
          </p>
        )}
        <JsonDiff
          before={bs ? bs.body : undefined}
          after={as ? as.body : undefined}
          beforeLabel={before.label}
          afterLabel={after.label}
          showPaths={!!bs && !!as && bs.mode === 'map' && as.mode === 'map'}
          sameText={sameText?.template ?? 'The two templates are the same.'}
        />
      </>
    )
  } else if (!recordId) {
    body = (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Pick a {collection} record to compare the bodies it would send.
      </p>
    )
  } else if (beforeQ.isError || afterQ.isError) {
    body = (
      <InlineError
        title='The comparison could not render.'
        error={beforeQ.error ?? afterQ.error}
        onRetry={() => {
          void beforeQ.refetch()
          void afterQ.refetch()
        }}
      />
    )
  } else if (
    (before.body && (!beforeQ.data || beforeQ.isPlaceholderData)) ||
    (after.body && (!afterQ.data || afterQ.isPlaceholderData))
  ) {
    // A placeholder is the previous record's render: never diff it against this record's.
    body = <Bars rows={[72, 48, 64, 40, 56]} />
  } else {
    const skipped = afterQ.data?.skipped ?? beforeQ.data?.skipped
    body = (
      <>
        {skipped && (
          <p className='mb-2 text-[12px] text-amber-800 dark:text-amber-300'>
            This record wouldn't send this: {skipped}
          </p>
        )}
        <JsonDiff
          before={before.body ? beforeQ.data?.body : undefined}
          after={after.body ? afterQ.data?.body : undefined}
          beforeLabel={before.label}
          afterLabel={after.label}
          sameText={sameText?.payload ?? 'Both send the same body for this record.'}
        />
      </>
    )
  }

  return (
    <div data-payload-compare>
      <div className='mb-2.5 flex flex-wrap items-center gap-2'>
        <Segmented
          legend='Compare'
          value={view}
          onChange={setView}
          options={[
            { value: 'payload', label: 'Payload' },
            { value: 'template', label: 'Template' }
          ]}
        />
        {view === 'payload' && (
          <RecordPicker
            templateKey={templateKey}
            collection={collection}
            value={recordId}
            onChange={onRecordChange}
          />
        )}
      </div>
      {body}
    </div>
  )
}

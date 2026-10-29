import { ChevronRight, Wrench } from 'lucide-react'
import { useId, useState } from 'react'
import { useItemNavigation, useNavigation } from '../../../context'
import { cn } from '../../../lib/utils'
import { TONE_SOFT, TONE_TEXT } from './tone'

/** GET answers' `explanation` (api services/integration-error-explain.ts). */
export type IntegrationFixTarget =
  | { kind: 'record'; collection: string; item: string; field?: string | null }
  | {
      kind: 'external_api'
      id: number
      section?: 'auth' | 'endpoints' | 'connection' | 'response' | null
    }
  | { kind: 'partner'; id: number }
  | { kind: 'payload_template'; api_id: number; key: string }

export interface IntegrationErrorExplanation {
  sentence: string
  cause: string
  fix_label: string | null
  fix: IntegrationFixTarget | null
  fix_link: string | null
  field: string | null
  detail: string | null
  rule: string
}

/**
 * A failed call in plain words (#18): the sentence, a Fix it link to the record field / config
 * most likely at fault, and the raw error behind "Show raw". Hosts map links through their
 * NavigationContext (record → itemUrl with `focus=<field>`, config → consoleUrl).
 */
export function ErrorExplanation({
  explanation,
  raw,
  compact = false,
  className
}: {
  explanation: IntegrationErrorExplanation | null | undefined
  /** The stored error text, shown only on request. */
  raw?: string | null
  /** One line, no raw toggle — list rows. */
  compact?: boolean
  className?: string
}) {
  const nav = useNavigation()
  const items = useItemNavigation()
  const [showRaw, setShowRaw] = useState(false)
  const rawId = useId()
  if (!explanation) {
    if (!raw) return null
    return (
      <p
        className={cn(
          'whitespace-pre-wrap break-words rounded px-2 py-1.5 text-[11.5px]',
          TONE_SOFT.negative,
          TONE_TEXT.negative,
          className
        )}
      >
        {raw}
      </p>
    )
  }
  const fix = explanation.fix
  let href: string | null = null
  let open: (() => void) | null = null
  if (fix?.kind === 'record') {
    const target = {
      collection: fix.collection,
      itemId: fix.item,
      query: fix.field ? { focus: fix.field } : null
    }
    href = items.urlFor(target)
    open = () => items.open(target)
  } else if (explanation.fix_link) {
    href = nav.consoleUrl ? nav.consoleUrl(explanation.fix_link) : explanation.fix_link
    const to = href
    open = to ? () => nav.navigate(to) : null
  }

  const fixLink =
    href && open ? (
      <a
        href={href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          open?.()
        }}
        data-integration-fix={explanation.cause}
        className='inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted'
      >
        <Wrench className='h-3 w-3' aria-hidden />
        {explanation.fix_label ?? 'Fix it'}
      </a>
    ) : null

  if (compact) {
    return (
      <span
        className={cn('flex min-w-0 items-center gap-2', className)}
        data-integration-explanation={explanation.rule}
      >
        <span
          className={cn('min-w-0 truncate text-[11.5px]', TONE_TEXT.negative)}
          data-tip={explanation.sentence.length > 70 ? explanation.sentence : undefined}
        >
          {explanation.sentence}
        </span>
        {fixLink}
      </span>
    )
  }

  return (
    <div
      className={cn('space-y-1.5 rounded px-2 py-1.5', TONE_SOFT.negative, className)}
      data-integration-explanation={explanation.rule}
    >
      <div className='flex flex-wrap items-start gap-2'>
        <p className={cn('min-w-0 flex-1 text-[12px] font-medium', TONE_TEXT.negative)}>
          {explanation.sentence}
        </p>
        {fixLink}
      </div>
      {raw && (
        <div>
          <button
            type='button'
            aria-expanded={showRaw}
            aria-controls={rawId}
            onClick={(e) => {
              e.stopPropagation()
              setShowRaw((v) => !v)
            }}
            className='inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground'
          >
            <ChevronRight
              className={cn('h-3 w-3 transition-transform', showRaw && 'rotate-90')}
              aria-hidden
            />
            {showRaw ? 'Hide raw' : 'Show raw'}
          </button>
          {showRaw && (
            <pre
              id={rawId}
              className='mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-card p-2 font-mono text-[11px] text-foreground'
            >
              {raw}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

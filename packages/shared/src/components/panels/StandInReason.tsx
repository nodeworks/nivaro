import { ArrowUpRight } from 'lucide-react'
import { useNavigation } from '../../context'
import { cn } from '../../lib/utils'

/**
 * Why a stand-in holds the record's current step (Rob 2026-11-14) — the
 * `stand_in_reason` of GET /pipelines/instance/:collection/:item
 * (api services/stand-in-reason.ts). Said the same way in the pipeline
 * panel's Owners section and the record header's Owners roster.
 */
export interface StandInReason {
  state: { id: string; label: string }
  people: Array<{ id: string; name: string }>
  why_unassigned: {
    kind: 'no_groups' | 'uncovered' | 'no_match' | 'empty_group' | 'not_required'
    sentence: string
    values?: Array<{ label: string; value: string }>
  }
  why_this_person: { kind: 'creator' | 'field'; sentence: string }
  /** Administrators only. */
  detail?: string
  /** Administrators only — an admin path, resolved through the host's consoleUrl. */
  matrix_href?: string
}

/** The person ids a reason says stand in (upper-cased for comparison). */
export function standInIds(reason: StandInReason | null | undefined): Set<string> {
  return new Set((reason?.people ?? []).map((p) => String(p.id).toUpperCase()))
}

/** The small "stand-in" mark beside a person — information, not a warning. */
export function StandInMark({ className }: { className?: string }) {
  return (
    <span
      data-stand-in-mark=''
      className={cn(
        'shrink-0 rounded border border-slate-300 px-1 text-[10px] font-medium leading-tight text-slate-500 dark:border-slate-600 dark:text-slate-400',
        className
      )}
      data-tip='Nobody is assigned to this step. The record is in their queue, but only the step’s owners can move it.'
    >
      stand-in
    </span>
  )
}

/** The why lines: nobody is assigned because…, this person stands in because…,
 *  and (administrators) the closest group + a link to the owner matrix. */
export function StandInReasonLines({
  reason,
  className,
  onNavigate
}: {
  reason: StandInReason
  className?: string
  /** Called before the matrix link navigates (a roster closes itself). */
  onNavigate?: () => void
}) {
  const nav = useNavigation()
  const values = reason.why_unassigned.values ?? []
  const href = reason.matrix_href
    ? nav.consoleUrl
      ? nav.consoleUrl(reason.matrix_href)
      : reason.matrix_href
    : null
  const external = !!href && /^https?:\/\//.test(href)
  return (
    <div
      data-owners-stand-in={reason.why_unassigned.kind}
      className={cn('space-y-0.5 text-[11.5px] leading-snug', className)}
    >
      <p
        className='text-slate-600 dark:text-slate-300'
        data-stand-in-why='unassigned'
        data-tip={
          values.length > 0 ? values.map((v) => `${v.label}: ${v.value}`).join(' · ') : undefined
        }
      >
        {reason.why_unassigned.sentence}
      </p>
      <p className='text-slate-500 dark:text-slate-400' data-stand-in-why='person'>
        {reason.why_this_person.sentence}
      </p>
      {reason.detail && (
        <p className='text-slate-500 dark:text-slate-400' data-stand-in-why='detail'>
          {reason.detail}
        </p>
      )}
      {href && (
        <a
          href={href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          onClick={(e) => {
            onNavigate?.()
            if (external || e.metaKey || e.ctrlKey || e.shiftKey) return
            e.preventDefault()
            nav.navigate(href)
          }}
          data-stand-in-matrix=''
          className='inline-flex items-center gap-0.5 rounded pt-0.5 font-medium text-nvr-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-nvr-cyan'
        >
          Open owner matrix
          <ArrowUpRight className='h-3 w-3' aria-hidden />
        </a>
      )}
    </div>
  )
}

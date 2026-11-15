import { ExternalLink, History, Users } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useActorNames } from '../../lib/live-list'
import {
  type ChangedRow,
  changedNoticeText,
  changeLineText,
  type OpenRow,
  openNoticeText,
  type SelectionSum
} from '../../lib/selection-watch'
import { formatRelative } from '../../lib/utils'
import { LiveCount } from '../LiveCount'

/**
 * What a bulk bar says before it acts on the selection (realtime round 8, items 5–7):
 *
 *   ● 2 of these are open by Beth right now                    Skip those · Continue
 *   ● 3 selected rows changed since you picked them             Review · Continue
 *
 * One quiet line each, inside the bar (never a toast or a dialog), only while there is
 * something to say. "Skip those" takes the rows out of the selection; "Continue" keeps them
 * and stops saying so until something new happens; "Review" lists who changed what (as the
 * viewer may read it) with a link to each record.
 */

export type NoticeTone = 'dark' | 'light'

export interface OpenInput {
  key: string
  /** Viewer ids the presence rules let this person see. */
  viewerIds: string[]
  /** Everyone else with it open (named or not). */
  viewerCount: number
  /** Who holds the edit lock (null = nobody / the viewer). */
  lockName?: string | null
}

const TONE = {
  dark: {
    line: 'text-slate-200 dark:text-foreground',
    soft: 'text-slate-400 dark:text-muted-foreground',
    dot: 'bg-amber-300 dark:bg-amber-400',
    btn: 'h-7 rounded-md px-2 text-[12px] font-medium text-slate-200 hover:bg-white/10 hover:text-white dark:text-foreground dark:hover:bg-muted',
    btnStrong:
      'h-7 rounded-md border border-white/20 px-2.5 text-[12px] font-medium text-white hover:bg-white/10 dark:border-border dark:text-foreground dark:hover:bg-muted',
    list: 'border-white/10 dark:border-border',
    link: 'text-[#7fe7ff] hover:text-white dark:text-nvr-cyan dark:hover:text-foreground'
  },
  light: {
    line: 'text-slate-700 dark:text-slate-200',
    soft: 'text-slate-500 dark:text-slate-400',
    dot: 'bg-amber-500 dark:bg-amber-400',
    btn: 'h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted',
    btnStrong:
      'h-7 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted',
    list: 'border-slate-100 dark:border-border',
    link: 'text-nvr-navy hover:text-nvr-cyan dark:text-nvr-cyan dark:hover:text-foreground'
  }
} as const

function NoticeLine({
  tone,
  icon,
  text,
  children,
  data
}: {
  tone: NoticeTone
  icon: ReactNode
  text: string
  children: ReactNode
  data: string
}) {
  const t = TONE[tone]
  return (
    <div
      {...{ [data]: '' }}
      role='status'
      className='nvr-fade-in flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1'
    >
      {/* Dot, icon and words stay together; on a narrow screen the words wrap beside the
          icon and the buttons drop to their own line, right-aligned. */}
      <span className='flex min-w-0 flex-1 basis-[15rem] items-start gap-2'>
        <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} />
        <span aria-hidden className={`mt-[2px] shrink-0 ${t.soft}`}>
          {icon}
        </span>
        <span className={`min-w-0 text-[12.5px] leading-5 ${t.line}`}>{text}</span>
      </span>
      <span className='ml-auto flex shrink-0 items-center gap-1'>{children}</span>
    </div>
  )
}

export function BulkSelectionNotices({
  tone,
  total,
  open,
  changed,
  labelOf,
  onSkip,
  onAcknowledgeChanged,
  onOpenRecord,
  framed
}: {
  tone: NoticeTone
  /** Draw its own card (a floating bar has no room inside it). */
  framed?: boolean
  /** How many rows are selected. */
  total: number
  open: readonly OpenInput[]
  changed: readonly ChangedRow[]
  /** A row's label when the list knows it (open rows). */
  labelOf?: (key: string) => string | null
  /** Take these rows out of the selection. */
  onSkip: (keys: string[]) => void
  /** Keep these changed rows; they count as seen as they are now. */
  onAcknowledgeChanged: (keys: string[]) => void
  onOpenRecord?: (row: { collection: string; id: string }) => void
}) {
  const t = TONE[tone]
  const viewerIds = useMemo(() => [...new Set(open.flatMap((o) => o.viewerIds))], [open])
  const names = useActorNames(viewerIds)
  const openRows: OpenRow[] = useMemo(
    () =>
      open
        .map((o) => {
          const named = o.viewerIds.map((id) => names.get(id)).filter((n): n is string => !!n)
          const all = o.lockName && !named.includes(o.lockName) ? [o.lockName, ...named] : named
          return {
            key: o.key,
            names: all,
            unnamed: Math.max(0, o.viewerCount - named.length),
            editing: !!o.lockName
          }
        })
        .filter((o) => o.editing || o.names.length > 0 || o.unnamed > 0),
    [open, names]
  )
  // "Continue" on the open-by line holds until the set of rows it speaks of changes.
  const openSig = openRows
    .map((o) => o.key)
    .sort()
    .join(',')
  const [openAck, setOpenAck] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const openText = openSig && openSig !== openAck ? openNoticeText(openRows, total) : null
  const changedText = changedNoticeText(changed.length)
  if (!openText && !changedText) return null

  return (
    <div
      data-bulk-notices=''
      className={
        framed
          ? 'nvr-fade-in flex w-[min(640px,calc(100vw-2rem))] flex-col gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-[0_6px_20px_rgba(15,30,45,0.12)] dark:border-border dark:bg-card dark:shadow-none'
          : 'flex w-full basis-full flex-col gap-1'
      }
    >
      {openText && (
        <NoticeLine
          tone={tone}
          icon={<Users className='h-3.5 w-3.5' />}
          text={openText}
          data='data-bulk-open-notice'
        >
          <button
            type='button'
            className={t.btn}
            onClick={() => onSkip(openRows.map((o) => o.key))}
            data-tip='Leave these out of the selection'
          >
            Skip {openRows.length === 1 ? 'it' : 'those'}
          </button>
          <button type='button' className={t.btnStrong} onClick={() => setOpenAck(openSig)}>
            Continue
          </button>
        </NoticeLine>
      )}
      {changedText && (
        <NoticeLine
          tone={tone}
          icon={<History className='h-3.5 w-3.5' />}
          text={changedText}
          data='data-bulk-changed-notice'
        >
          <button
            type='button'
            className={t.btn}
            aria-expanded={reviewing}
            onClick={() => setReviewing((v) => !v)}
          >
            {reviewing ? 'Hide' : 'Review'}
          </button>
          <button
            type='button'
            className={t.btnStrong}
            onClick={() => {
              setReviewing(false)
              onAcknowledgeChanged(changed.map((c) => c.key))
            }}
          >
            Continue
          </button>
        </NoticeLine>
      )}
      {changedText && reviewing && (
        <ul
          data-bulk-changed-list=''
          className={`ml-[22px] max-h-40 overflow-y-auto border-l pl-3 text-[12px] ${t.list}`}
        >
          {changed.map((c) => (
            <li key={c.key} className='flex min-w-0 items-baseline gap-2 py-0.5'>
              {/* Side by side on a wide bar; the record above what happened on a phone. */}
              <span className='flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2'>
                <span className={`min-w-0 truncate font-medium ${t.line}`}>
                  {c.label ?? labelOf?.(c.key) ?? `#${c.id}`}
                </span>
                <span className={`min-w-0 truncate ${t.soft}`}>
                  {changeLineText(c)} · {formatRelative(c.at)}
                </span>
              </span>
              {onOpenRecord && !c.deleted && (
                <button
                  type='button'
                  onClick={() => onOpenRecord({ collection: c.collection, id: c.id })}
                  className={`ml-auto inline-flex shrink-0 items-center gap-1 ${t.link}`}
                >
                  Open
                  <ExternalLink aria-hidden className='h-3 w-3' />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * "12 selected · Amount $48,200 · Hours 31" — the selection's count and sums, each number
 * cross-fading in place when a selected row changes live (LiveCount: no fade in Calm / Off
 * or with reduced motion). `known` < `total`: some selected rows were never on screen, so the
 * sums say what they cover.
 */
export function SelectionFigures({
  tone,
  total,
  sums,
  known,
  labelOf,
  format,
  noun = 'item'
}: {
  tone: NoticeTone
  total: number
  sums: readonly SelectionSum[]
  known: number
  labelOf: (key: string) => string
  format: (key: string, value: number) => string
  noun?: string
}) {
  const t = TONE[tone]
  const count = (
    <span
      className={
        tone === 'dark'
          ? 'text-[13px] font-medium text-nvr-cyan dark:text-nvr-cyan'
          : 'text-[12px] font-semibold text-slate-700 dark:text-slate-200'
      }
    >
      <LiveCount value={total} /> {noun}
      {total === 1 ? '' : 's'} selected
    </span>
  )
  if (sums.length === 0) return count
  return (
    <span data-selection-figures='' className='inline-flex flex-wrap items-baseline gap-x-3'>
      {count}
      {sums.slice(0, 3).map((s) => (
        <span
          key={s.key}
          className='inline-flex items-baseline gap-1.5 text-[12px]'
          data-tip={
            known < total
              ? `Sum of the ${known} selected rows this list has shown`
              : `Sum of the ${s.counted} selected rows with a value`
          }
        >
          <span className={t.soft}>{labelOf(s.key)}</span>
          <LiveCount
            value={s.sum}
            format={(v) => format(s.key, Number(v))}
            className={`tabular-nums font-medium ${t.line}`}
          />
        </span>
      ))}
    </span>
  )
}

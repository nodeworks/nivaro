import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  FileEdit,
  GitBranch,
  Layers,
  Send,
  Workflow
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { cn } from '../../../../lib/utils'
import { useOverflowTip } from '../../../TipLayer'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../ui/sheet'
import { Skeleton } from '../../../ui/skeleton'
import { type EventPathTarget, eventPathTargetKey, useEventPath } from '../api'
import { CodeBlock, HttpStatusChip, isTruncatedBody, pretty, StatusPill } from '../drill'
import { agoText, exactTime, TONE_BORDER, TONE_SOFT, TONE_TEXT } from '../tone'
import type { PathDetail, PathNode } from '../types'
import { ancestorsOf, flattenVisible, formatOffset, summarySentence } from './pathModel'

export interface EventPathSheetProps {
  /** An event (`source` + `id`, optionally read through its `record`), or a
   *  chain opened directly by id — where a replay link leads. */
  target: EventPathTarget | null
  event?: { label?: string | null; item_label?: string | null } | null
  onClose: () => void
  onOpenRecord?: (collection: string, id: string) => void
  /** Replay links — the chain this one replayed, or a replay of it. The host
   *  swaps the sheet's target to `{ chainId }`. Absent = the links read as text. */
  onOpenEvent?: (target: { chainId: string }) => void
}

const KIND_ICON: Record<PathNode['kind'], typeof Send> = {
  request: ArrowRightLeft,
  cron: Clock,
  import: Layers,
  feed: Clock,
  write: FileEdit,
  transition: GitBranch,
  flow: Workflow,
  push: Send,
  attempt: Send,
  partner_call: ArrowRightLeft,
  group: Layers
}

/** At most this many field changes open under one step. */
const MAX_CHANGES = 40

/** The step indent per tree level, px. */
const INDENT = 18

function PathSkeleton() {
  return (
    <div className='space-y-2 px-2' aria-busy data-path-loading>
      {[88, 72, 80, 64, 76].map((w) => (
        <Skeleton key={w} className='h-7' style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

/** A small label · value line inside a step's detail. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex min-w-0 items-baseline gap-2 text-[12px]'>
      <span className='w-[88px] shrink-0 text-muted-foreground'>{label}</span>
      <span className='min-w-0 text-foreground [overflow-wrap:anywhere]'>{children}</span>
    </div>
  )
}

function ErrorBox({ text }: { text: string }) {
  return (
    <p
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-[12px] [overflow-wrap:anywhere]',
        TONE_BORDER.negative,
        TONE_SOFT.negative,
        TONE_TEXT.negative
      )}
      data-path-error
    >
      {text}
    </p>
  )
}

/** What a step opens to — field changes, a push, a partner call, a flow run
 *  or a transition. Bodies only arrive for admins; others see summaries. */
function StepDetailView({ node }: { node: PathNode }) {
  const d = node.detail as PathDetail | null | undefined
  const reason = node.reason ? (
    <p className='text-[12px] text-muted-foreground' data-path-reason>
      {node.inferred ? 'Matched because ' : ''}
      {node.reason}
    </p>
  ) : null
  let body: ReactNode = null
  if (d?.type === 'changes') {
    const rows = d.changes.slice(0, MAX_CHANGES)
    body = rows.length ? (
      <div>
        <table className='w-full table-fixed text-[12px]' data-path-changes>
          <tbody>
            {rows.map((c) => (
              <tr key={c.field} className='align-top'>
                <td className='w-[34%] py-0.5 pr-3 text-muted-foreground [overflow-wrap:anywhere]'>
                  {c.label || c.field}
                </td>
                <td className='py-0.5 text-foreground [overflow-wrap:anywhere]'>
                  <span className='text-muted-foreground line-through decoration-border'>
                    {c.old || '—'}
                  </span>{' '}
                  <span className='whitespace-nowrap'>
                    <span className='text-muted-foreground'>→ </span>
                    {c.new || '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.changes.length > MAX_CHANGES && (
          <p className='mt-1 text-[11.5px] text-muted-foreground'>
            and {d.changes.length - MAX_CHANGES} more fields
          </p>
        )}
      </div>
    ) : (
      <p className='text-[12px] text-muted-foreground'>No field changes were recorded.</p>
    )
  } else if (d?.type === 'push') {
    const req = pretty(d.request ?? null)
    const res = pretty(d.response ?? null)
    body = (
      <div className='space-y-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <StatusPill status={d.status} />
          {d.http_status != null && (
            <HttpStatusChip
              status={d.http_status}
              ok={d.http_status >= 200 && d.http_status < 300}
            />
          )}
          {d.attempts != null && (
            <span className='text-[12px] tabular-nums text-muted-foreground'>
              {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
            </span>
          )}
          <span className='text-[12px] tabular-nums text-muted-foreground'>
            Submission #{d.submission_id}
          </span>
        </div>
        {d.error && <ErrorBox text={d.error} />}
        {req && (
          <CodeBlock
            label='Request'
            value={req}
            fold
            truncated={isTruncatedBody(d.request ?? null)}
          />
        )}
        {res && (
          <CodeBlock
            label='Response'
            value={res}
            fold
            truncated={isTruncatedBody(d.response ?? null)}
          />
        )}
      </div>
    )
  } else if (d?.type === 'call') {
    const ok = d.status != null && d.status >= 200 && d.status < 300
    body = (
      <div className='space-y-1.5'>
        <p className='font-mono text-[12px] text-foreground [overflow-wrap:anywhere]'>
          <span className='font-semibold'>{d.method}</span> {d.url}
        </p>
        <div className='flex flex-wrap items-center gap-2'>
          <HttpStatusChip status={d.status ?? null} ok={ok} />
          {d.duration_ms != null && (
            <span className='text-[12px] tabular-nums text-muted-foreground'>
              {d.duration_ms < 1000
                ? `${Math.round(d.duration_ms)} ms`
                : `${(d.duration_ms / 1000).toFixed(1)} s`}
            </span>
          )}
        </div>
        {d.error && <ErrorBox text={d.error} />}
      </div>
    )
  } else if (d?.type === 'flow') {
    body = (
      <div className='space-y-1.5'>
        <Fact label='Status'>
          <StatusPill status={d.status} />
        </Fact>
        {d.halted_at && <Fact label='Stopped at'>{d.halted_at}</Fact>}
        {d.error && <ErrorBox text={d.error} />}
      </div>
    )
  } else if (d?.type === 'transition') {
    body = (
      <div className='space-y-1.5'>
        <Fact label='Moved'>
          {d.from || 'Start'} <span className='text-muted-foreground'>→</span> {d.to || '—'}
        </Fact>
        {d.comment && <Fact label='Comment'>{d.comment}</Fact>}
      </div>
    )
  }
  return (
    <div
      className='mb-1 mt-0.5 space-y-2 rounded-md border border-border bg-card px-3 py-2.5'
      data-path-detail={node.key}
    >
      <p className='text-[11.5px] tabular-nums text-muted-foreground' data-tip={exactTime(node.at)}>
        {new Date(node.at).toLocaleString()}
      </p>
      {reason}
      {body ??
        (!reason && (
          <p className='text-[12px] text-muted-foreground'>Nothing more was recorded.</p>
        ))}
    </div>
  )
}

function StepRow({
  node,
  depth,
  hasChildren,
  expanded,
  open,
  onToggle,
  onOpen,
  onOpenRecord
}: {
  node: PathNode
  depth: number
  hasChildren: boolean
  expanded: boolean
  open: boolean
  onToggle: () => void
  onOpen: () => void
  onOpenRecord?: (collection: string, id: string) => void
}) {
  const Icon = node.failed ? AlertTriangle : (KIND_ICON[node.kind] ?? Layers)
  const rec = node.record
  const recordLabel = rec ? rec.label || `${rec.collection.replace(/_/g, ' ')} ${rec.item}` : null
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen()
    }
  }
  return (
    <li
      data-path-step={node.key}
      data-path-kind={node.kind}
      data-path-failed={node.failed ? '' : undefined}
      data-path-open={open ? '' : undefined}
      className='scroll-mt-10'
      style={{ paddingLeft: depth * INDENT }}
    >
      <div className={cn(depth > 0 && 'border-l border-border pl-2')}>
        <div
          className={cn(
            'flex items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors',
            node.failed
              ? 'bg-[#fef2f2] dark:bg-[#3b1219]'
              : open
                ? 'bg-card ring-1 ring-inset ring-border'
                : 'hover:bg-card'
          )}
        >
          {hasChildren ? (
            <button
              type='button'
              data-path-toggle={node.key}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse step' : 'Expand step'}
              onClick={onToggle}
              className='mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
              {expanded ? (
                <ChevronDown className='h-3.5 w-3.5' aria-hidden />
              ) : (
                <ChevronRight className='h-3.5 w-3.5' aria-hidden />
              )}
            </button>
          ) : (
            <span className='h-4 w-4 shrink-0' aria-hidden />
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: the row holds a nested record button */}
          <div
            role='button'
            tabIndex={0}
            aria-expanded={open}
            data-path-row={node.key}
            onClick={onOpen}
            onKeyDown={onKey}
            className='flex min-w-0 flex-1 cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded text-[12.5px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            <Icon
              className={cn(
                'h-3.5 w-3.5 shrink-0 translate-y-0.5',
                node.failed ? TONE_TEXT.negative : 'text-muted-foreground'
              )}
              aria-hidden
            />
            <span
              className='w-[62px] shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground'
              data-tip={exactTime(node.at)}
            >
              {formatOffset(node.offset_ms)}
            </span>
            {node.who && <span className='font-medium text-foreground'>{node.who}</span>}
            {rec && recordLabel && (
              <RecordChip
                collection={rec.collection}
                item={rec.item}
                label={recordLabel}
                onOpenRecord={onOpenRecord}
              />
            )}
            <span
              className={cn(
                'min-w-0 [overflow-wrap:anywhere]',
                node.failed ? cn('font-medium', TONE_TEXT.negative) : 'text-foreground'
              )}
            >
              {node.summary}
            </span>
            {node.inferred && (
              <span
                className='text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground'
                data-path-inferred
                data-tip={node.reason ?? 'Matched by account and time'}
              >
                inferred
              </span>
            )}
          </div>
        </div>
        {open && <StepDetailView node={node} />}
      </div>
    </li>
  )
}

/**
 * One integration event opened into its full chain: the call, cron, import
 * or feed that started it, every write and transition it caused, the flows
 * that ran and the partner pushes that went out — as a tree. Opens on the
 * first failure, expanded and scrolled to.
 */
export function EventPathSheet({
  target,
  event,
  onClose,
  onOpenRecord,
  onOpenEvent
}: EventPathSheetProps) {
  const q = useEventPath(target)
  const path = q.data ?? null
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** The step the failure-first pass wants on screen — scrolled to ONCE. */
  const pendingScrollRef = useRef<string | null>(null)
  /** Which target + root the failure-first pass last ran for. */
  const initFor = useRef<string | null>(null)
  const targetKey = target ? eventPathTargetKey(target) : null

  // Failure-first: expand to and open the first failure; else expand the
  // root. Once per target + root — a background refetch that returns the
  // same path keeps whatever the person expanded and opened since.
  useEffect(() => {
    if (!path) return
    const id = `${targetKey}|${path.root.key}`
    if (initFor.current === id) return
    initFor.current = id
    const keys = new Set<string>([path.root.key])
    if (path.first_failure) {
      for (const k of ancestorsOf(path.root, path.first_failure)) keys.add(k)
      setOpen(path.first_failure)
      pendingScrollRef.current = path.first_failure
    } else {
      setOpen(null)
      pendingScrollRef.current = null
    }
    setExpanded(keys)
  }, [path, targetKey])

  const rows = useMemo(() => (path ? flattenVisible(path.root, expanded) : []), [path, expanded])
  // Empty means the tree has nothing under its root — never "the person
  // collapsed the root", which must keep the chevron to expand it again.
  const pathHasSteps =
    !!path && (path.root.children.length > 0 || (path.root.members?.length ?? 0) > 0)

  // Scroll to the failure-first step once it has rendered, then never again:
  // expanding, collapsing or opening a step must not pull the view back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check as rows render
  useEffect(() => {
    const key = pendingScrollRef.current
    if (!key || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-path-step="${CSS.escape(key)}"]`)
    if (!el) return
    pendingScrollRef.current = null
    // `start`, not `center`: an open step's detail can be taller than the
    // body, and centring it would push its own heading off the top. The
    // row's scroll margin keeps a little of its parent in view above it.
    el.scrollIntoView({ block: 'start' })
  }, [rows])
  if (!target) return null

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const errMsg =
    (q.error as { response?: { error?: string } } | null)?.response?.error ??
    (q.error instanceof Error ? q.error.message : null)

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className='flex flex-col gap-0 overflow-hidden p-0'
        style={{ width: 720, maxWidth: '94vw' }}
        data-event-path={targetKey ?? undefined}
        data-path-mode={path?.mode ?? (q.isError ? 'error' : 'loading')}
      >
        <div className='shrink-0 border-b border-border px-6 pb-4 pt-5'>
          <SheetTitle className='pr-8 text-[15px] font-semibold leading-snug'>
            {path
              ? summarySentence(path, event ?? undefined)
              : q.isError
                ? 'Path unavailable'
                : 'Loading path…'}
          </SheetTitle>
          <SheetDescription asChild>
            <div className='mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground'>
              {path && (
                <span
                  data-path-badge={path.mode}
                  data-tip={
                    path.mode === 'inferred'
                      ? 'Recorded before chains existed. Steps were matched by account and time; each says why.'
                      : 'Every step was recorded on this chain as it happened.'
                  }
                  className={
                    path.mode === 'exact'
                      ? 'rounded-full bg-[#dcfce7] px-2 py-0.5 font-medium text-[#166534] dark:bg-[#14532d] dark:text-[#bbf7d0]'
                      : 'rounded-full bg-[#fef3c7] px-2 py-0.5 font-medium text-[#92400e] dark:bg-[#451a03] dark:text-[#fde68a]'
                  }
                >
                  {path.mode === 'exact' ? 'Exact' : 'Inferred'}
                </span>
              )}
              {path && (
                <span className='tabular-nums' data-tip={exactTime(path.root.at)}>
                  {agoText(path.root.at)}
                </span>
              )}
              {path?.replay_of &&
                (onOpenEvent ? (
                  <button
                    type='button'
                    data-path-replay-of={path.replay_of}
                    className='underline decoration-border underline-offset-2 hover:text-foreground'
                    onClick={() => onOpenEvent({ chainId: path.replay_of as string })}
                  >
                    Replay of an earlier event
                  </button>
                ) : (
                  <span data-path-replay-of>Replay of an earlier event</span>
                ))}
              {path && path.replayed_as.length > 0 && (
                <span data-path-replayed>
                  Replayed {path.replayed_as.length}×
                  {onOpenEvent &&
                    path.replayed_as.map((r, i) => (
                      <button
                        key={r}
                        type='button'
                        data-path-replay={r}
                        className='ml-1.5 underline decoration-border underline-offset-2 hover:text-foreground'
                        onClick={() => onOpenEvent({ chainId: r })}
                      >
                        #{i + 1}
                      </button>
                    ))}
                </span>
              )}
              {path?.truncated && <span>Showing the first {path.step_count} steps</span>}
              {path?.hidden_steps ? (
                <span data-path-hidden>
                  {path.hidden_steps} step{path.hidden_steps === 1 ? '' : 's'} on records you can't
                  open
                </span>
              ) : null}
            </div>
          </SheetDescription>
        </div>
        <div
          ref={scrollRef}
          className='min-h-0 flex-1 overflow-y-auto bg-muted/30 px-4 py-4'
          data-path-body
        >
          {q.isLoading && <PathSkeleton />}
          {q.isError && (
            <p className={cn('px-2 text-[13px]', TONE_TEXT.negative)}>
              Couldn't load this path{errMsg ? ` · ${errMsg}` : ''}.
            </p>
          )}
          {path && !pathHasSteps && (
            <>
              <ol className='mb-3 space-y-0.5'>
                <StepRow
                  node={path.root}
                  depth={0}
                  hasChildren={false}
                  expanded={false}
                  open={open === path.root.key}
                  onToggle={() => {}}
                  onOpen={() => setOpen(open === path.root.key ? null : path.root.key)}
                  onOpenRecord={onOpenRecord}
                />
              </ol>
              <p className='px-2 text-[13px] text-muted-foreground' data-path-empty>
                {path.mode === 'inferred'
                  ? 'Nothing matched this event within the window.'
                  : 'No recorded writes for this event.'}
              </p>
            </>
          )}
          {path && pathHasSteps && (
            <ol className='space-y-0.5'>
              {rows.map(({ node, depth }) => (
                <StepRow
                  key={node.key}
                  node={node}
                  depth={depth}
                  hasChildren={node.children.length > 0 || (node.members?.length ?? 0) > 0}
                  expanded={expanded.has(node.key)}
                  open={open === node.key}
                  onToggle={() => toggle(node.key)}
                  onOpen={() => setOpen(open === node.key ? null : node.key)}
                  onOpenRecord={onOpenRecord}
                />
              ))}
            </ol>
          )}
          {path && path.warnings.length > 0 && (
            <p className='mt-4 px-2 text-[11px] text-muted-foreground' data-path-warnings>
              Some steps could not be read: {path.warnings.join('; ')}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** The record a step touched — a button when the host can open records, else
 *  plain text; the full label rides an instant tip whenever it is cut off. */
function RecordChip({
  collection,
  item,
  label,
  onOpenRecord
}: {
  collection: string
  item: string
  label: string
  onOpenRecord?: (collection: string, id: string) => void
}) {
  const ref = useOverflowTip<HTMLElement>(label)
  const key = `${collection}:${item}`
  if (onOpenRecord) {
    return (
      <button
        ref={ref as RefObject<HTMLButtonElement>}
        type='button'
        data-path-record={key}
        onClick={(e) => {
          e.stopPropagation()
          onOpenRecord(collection, item)
        }}
        className='max-w-[220px] truncate rounded border border-border bg-card px-1.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      >
        {label}
      </button>
    )
  }
  // No host handler: plain text, so a click falls through to the row.
  return (
    <span
      ref={ref as RefObject<HTMLSpanElement>}
      data-path-record={key}
      className='max-w-[220px] truncate rounded border border-border bg-card px-1.5 text-[11.5px] font-medium text-foreground'
    >
      {label}
    </span>
  )
}

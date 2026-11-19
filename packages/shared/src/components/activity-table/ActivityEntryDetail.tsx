import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  ExternalLink,
  History,
  Layers,
  Link2,
  UserRound
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useNavigation, useNivaroClient } from '../../context'
import {
  type ActivityLabels,
  activityWhy,
  fieldLabel,
  parseTransitionComment,
  recordPhrase,
  renderActivitySentence,
  valueText
} from '../../lib/activity-sentence'
import { ACTOR_KIND_WORDS, type ActorKind, plainValueLines } from '../../lib/activity-table'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatNumber } from '../../lib/utils'
import { useActivityLabels } from '../ActivityEntry'
import { ErrorNotice } from '../ErrorNotice'
import { UndoButton } from '../UndoButton'
import { UserAvatar } from '../UserAvatar'
import {
  ActionLabel,
  personInitials,
  RecordLink,
  RequestCell,
  recordLinkTarget,
  requestHref,
  requestTip,
  sourceWords,
  WhenText
} from './parts'
import type { ActivityEntryDetailData, ActivityTableRow, FieldChange } from './types'

/**
 * One activity entry to the last leaf (GET /api/activity/:id/detail): the sentence, every field
 * it changed old → new (link values named as the reader may see them), who did it and how, the
 * request that wrote it, the record before and after, the entries of the same request and the
 * same burst, and the record as it was saved. JSON only behind "View raw".
 */

export interface ActivityDrillTarget {
  /** Show this person's activity (the table filtered to them). */
  person?: string
  /** Show this record's activity. */
  record?: { collection: string; item: string }
  /** Show every entry of one burst. */
  group_key?: string
}

const PERSON_KIND_NOTE: Record<string, string | null> = {
  person: null,
  deleted: 'Account deleted — its entries stay in the log',
  redacted: 'Redacted by the retention policy',
  placeholder: 'Placeholder account',
  machine: 'Service account',
  unnamed: 'The account has no name or email'
}

function Section({
  title,
  icon: Icon,
  children,
  aside
}: {
  title: string
  icon?: typeof History
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <section className='nvr-rise-in border-t border-slate-100 px-5 py-4 dark:border-border'>
      <div className='mb-2 flex items-center justify-between gap-2'>
        <h3 className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          {Icon && <Icon className='h-3.5 w-3.5 text-slate-400' aria-hidden />}
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-baseline gap-3 py-1 text-[12.5px]'>
      <dt className='w-28 shrink-0 text-slate-500 dark:text-slate-400'>{label}</dt>
      <dd className='min-w-0 flex-1 break-words text-slate-800 dark:text-slate-100'>{children}</dd>
    </div>
  )
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='inline-flex items-center gap-1 text-[12px] font-medium text-nvr-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
    >
      {children}
    </button>
  )
}

/** A changed value as words; a link value names its record; objects become lines. */
function ValueView({
  collection,
  field,
  value,
  labels,
  linkLabels
}: {
  collection: string | null
  field: string
  value: unknown
  labels?: ActivityLabels | null
  linkLabels?: ActivityLabels | null
}) {
  const target = labels?.links?.[`${collection ?? ''}.${field}`]
  if (target && value != null && typeof value !== 'object') {
    return (
      <RecordLink
        row={{ collection: target, item: String(value), action: 'update' }}
        labels={linkLabels}
        className='whitespace-normal'
      />
    )
  }
  if (value != null && typeof value === 'object') {
    const lines = plainValueLines(value)
    return (
      <span className='block space-y-0.5'>
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list of lines
          <span key={i} className='block'>
            {l}
          </span>
        ))}
      </span>
    )
  }
  const words = valueText(collection, field, value, labels)
  return <span className={cn(words === 'empty' && 'italic text-slate-400')}>{words}</span>
}

function ChangesTable({
  changes,
  collection,
  labels,
  linkLabels
}: {
  changes: FieldChange[]
  collection: string | null
  labels?: ActivityLabels | null
  linkLabels?: ActivityLabels | null
}) {
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
      <table className='w-full text-[12.5px]'>
        <thead className='bg-slate-50 text-left text-[11px] text-slate-500 dark:bg-white/[0.03] dark:text-slate-400'>
          <tr>
            <th scope='col' className='w-[34%] px-3 py-1.5 font-medium'>
              Field
            </th>
            <th scope='col' className='px-3 py-1.5 font-medium'>
              Before
            </th>
            <th scope='col' className='w-4 px-0 py-1.5' aria-hidden />
            <th scope='col' className='px-3 py-1.5 font-medium'>
              After
            </th>
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border'>
          {changes.map((c) => (
            <tr key={c.field} className='align-top'>
              <th
                scope='row'
                className='px-3 py-2 text-left font-medium text-slate-700 dark:text-slate-200'
                data-tip={c.field}
              >
                {fieldLabel(collection, c.field, labels)}
              </th>
              {c.hidden ? (
                <td colSpan={3} className='px-3 py-2 italic text-slate-500 dark:text-slate-400'>
                  Changed — the value is withheld
                </td>
              ) : (
                <>
                  <td className='px-3 py-2 text-slate-500 line-through decoration-slate-300 dark:text-slate-400 dark:decoration-slate-600'>
                    {c.no_previous ? (
                      <span className='italic no-underline'>not kept</span>
                    ) : (
                      <ValueView
                        collection={collection}
                        field={c.field}
                        value={c.from}
                        labels={labels}
                        linkLabels={linkLabels}
                      />
                    )}
                  </td>
                  <td className='px-0 py-2 text-slate-400' aria-hidden>
                    <ArrowRight className='mt-0.5 h-3 w-3' />
                  </td>
                  <td className='px-3 py-2 text-slate-900 dark:text-slate-50'>
                    <ValueView
                      collection={collection}
                      field={c.field}
                      value={c.to}
                      labels={labels}
                      linkLabels={linkLabels}
                    />
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MiniRow({
  row,
  labels,
  onOpen,
  hint
}: {
  row: ActivityTableRow
  labels?: ActivityLabels | null
  onOpen: (id: number) => void
  hint?: string
}) {
  return (
    <li>
      <button
        type='button'
        onClick={() => onOpen(row.id)}
        className='group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
      >
        <span className='min-w-20 shrink-0 whitespace-nowrap pt-px text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
          {hint ?? <WhenText at={row.timestamp} />}
        </span>
        <span className='min-w-0 flex-1 text-slate-700 dark:text-slate-200'>
          {renderActivitySentence(row, labels)}
        </span>
        <ChevronRight
          className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500'
          aria-hidden
        />
      </button>
    </li>
  )
}

function useDetail(id: number) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['activity-detail', id],
    queryFn: async () =>
      (
        (await client.request(
          get<{ data: ActivityEntryDetailData }>(`/activity/${id}/detail`)
        )) as {
          data: ActivityEntryDetailData
        }
      ).data,
    staleTime: 60_000,
    retry: false
  })
}

export function ActivityEntryDetail({
  id,
  onOpenEntry,
  onDrill,
  className
}: {
  id: number
  onOpenEntry: (id: number) => void
  /** Show the table filtered to a person / record / burst (absent = those links hide). */
  onDrill?: (t: ActivityDrillTarget) => void
  className?: string
}) {
  const { data, isLoading, error, refetch } = useDetail(id)
  const { navigate, userUrl, consoleUrl } = useNavigation()
  const [raw, setRaw] = useState(false)
  const [snapOpen, setSnapOpen] = useState(false)

  const entry = data?.entry
  const forLabels = useMemo(() => {
    if (!data) return []
    const rel = data.related
    const fields = [
      ...new Set([
        ...data.changes.map((c) => c.field),
        ...(snapOpen && data.snapshot ? Object.keys(data.snapshot) : [])
      ])
    ]
    return [
      { ...data.entry, changes: null, changed_fields: fields },
      ...(rel
        ? [
            ...rel.same_request,
            ...rel.same_group.rows,
            ...(rel.before ? [rel.before] : []),
            ...(rel.after ? [rel.after] : [])
          ]
        : [])
    ]
  }, [data, snapOpen])
  const labels = useActivityLabels(forLabels)
  // Second pass: the records link values point at, named as the reader may see them.
  const linkRefs = useMemo(() => {
    if (!data || !labels?.links) return []
    const out: Array<{ action: string; collection: string; item: string }> = []
    const c = data.entry.collection ?? ''
    const add = (field: string, v: unknown) => {
      const target = labels.links?.[`${c}.${field}`]
      if (target && v != null && typeof v !== 'object')
        out.push({ action: 'read', collection: target, item: String(v) })
    }
    for (const ch of data.changes) {
      add(ch.field, ch.from)
      add(ch.field, ch.to)
    }
    if (snapOpen && data.snapshot) for (const [k, v] of Object.entries(data.snapshot)) add(k, v)
    return out
  }, [data, labels, snapOpen])
  const linkLabels = useActivityLabels(linkRefs, { enabled: linkRefs.length > 0 })

  if (isLoading)
    return (
      <div className={cn('space-y-3 p-5', className)} aria-busy>
        <div className='h-5 w-3/4 animate-pulse rounded bg-slate-100 dark:bg-white/5' />
        <div className='h-3 w-1/3 animate-pulse rounded bg-slate-100 dark:bg-white/5' />
        <div className='h-32 animate-pulse rounded-lg bg-slate-100 dark:bg-white/5' />
        <div className='h-20 animate-pulse rounded-lg bg-slate-100 dark:bg-white/5' />
      </div>
    )
  if (error || !data || !entry)
    return (
      <div className={cn('p-5', className)}>
        <ErrorNotice error={error} what='this entry' onRetry={() => void refetch()} />
      </div>
    )

  const why = activityWhy(entry)
  const transition = /transition/.test(entry.action) ? parseTransitionComment(entry.comment) : null
  const rel = data.related
  const record =
    entry.collection && entry.item
      ? { collection: entry.collection, item: String(entry.item) }
      : null
  const recordName = recordPhrase(entry.collection, entry.item, labels)
  const kind = (
    typeof entry.actor === 'object' && entry.actor ? entry.actor.kind : 'person'
  ) as ActorKind
  // A deleted account has no profile page left to open.
  const profile =
    data.person && data.person.kind !== 'deleted'
      ? userUrl
        ? userUrl(data.person.id)
        : `/users/${data.person.id}`
      : null
  const reqUrl = entry.request ? requestHref(entry.request) : null

  return (
    <div className={cn('pb-6', className)} data-activity-detail={entry.id}>
      <header className='px-5 pb-4 pt-5'>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500 dark:text-slate-400'>
          <ActionLabel
            action={entry.action}
            className='font-medium text-slate-700 dark:text-slate-200'
          />
          <span>{formatDateTime(entry.timestamp)}</span>
          <span className='font-mono text-[11px]'>#{entry.id}</span>
        </div>
        <p
          className='mt-2 text-[15px] font-medium leading-snug text-slate-900 [text-wrap:pretty] dark:text-slate-50'
          data-activity-sentence
        >
          {renderActivitySentence(entry, labels)}
        </p>
        {(why.note || why.reason || why.approval) && (
          <div className='mt-3 space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700 dark:bg-white/[0.04] dark:text-slate-200'>
            {why.note && <p className='italic'>“{why.note}”</p>}
            {why.reason && <p>Reason: {why.reason}</p>}
            {why.approval && <p>Approval: {why.approval}</p>}
          </div>
        )}
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <UndoButton activityId={entry.id} onDone={() => void refetch()} />
          {record && recordLinkTarget(entry, labels) && (
            <RecordLink
              row={entry}
              labels={labels}
              className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2.5 text-[12px] no-underline hover:no-underline dark:border-border'
            />
          )}
        </div>
      </header>

      {data.changes.length > 0 ? (
        <Section
          title={entry.action === 'create' ? 'What it was created with' : 'What changed'}
          icon={History}
          aside={
            <span className='text-[11px] text-slate-500 dark:text-slate-400'>
              {data.changes.length === 1
                ? '1 field'
                : `${formatNumber(data.changes.length)} fields`}
            </span>
          }
        >
          <ChangesTable
            changes={data.changes}
            collection={entry.collection}
            labels={labels}
            linkLabels={linkLabels}
          />
        </Section>
      ) : transition && (transition.from || transition.to) ? (
        <Section title='What changed' icon={History}>
          <p className='flex flex-wrap items-center gap-2 text-[13px]'>
            <span className='rounded bg-slate-100 px-1.5 py-0.5 dark:bg-white/[0.06]'>
              {transition.from ?? 'Any step'}
            </span>
            <ArrowRight className='h-3.5 w-3.5 text-slate-400' aria-hidden />
            <span className='rounded bg-nvr-cyan/10 px-1.5 py-0.5 font-medium text-slate-900 dark:text-slate-50'>
              {transition.to ?? '—'}
            </span>
            {transition.via && <span className='text-slate-500'>via {transition.via}</span>}
          </p>
        </Section>
      ) : entry.comment && !why.reason && !why.note ? (
        <Section title='Stored note' icon={History}>
          <p className='whitespace-pre-wrap break-words text-[12.5px] text-slate-700 dark:text-slate-200'>
            {entry.comment}
          </p>
        </Section>
      ) : null}

      <Section title='Who' icon={UserRound}>
        {data.person ? (
          <div className='flex items-start gap-3'>
            <UserAvatar
              userId={data.person.id}
              className='h-9 w-9 shrink-0 rounded-full object-cover'
              fallback={
                <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[12px] font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-200'>
                  {personInitials(data.person.name ?? '?')}
                </span>
              }
            />
            <div className='min-w-0 flex-1'>
              <p className='truncate text-[13px] font-medium text-slate-900 dark:text-slate-50'>
                {data.person.name ?? 'Deleted user'}
              </p>
              <p className='truncate text-[12px] text-slate-500 dark:text-slate-400'>
                {[
                  PERSON_KIND_NOTE[data.person.kind ?? 'person'],
                  data.person.role,
                  data.person.email,
                  data.person.status && data.person.status !== 'active' ? data.person.status : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className='mt-1.5 flex flex-wrap gap-3'>
                {onDrill && (
                  <LinkButton onClick={() => onDrill({ person: data.person!.id })}>
                    Their activity
                  </LinkButton>
                )}
                {profile && (
                  <LinkButton onClick={() => navigate(profile)}>
                    Open profile <ExternalLink className='h-3 w-3' aria-hidden />
                  </LinkButton>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
            {entry.user
              ? 'An account that has since been removed — its entries stay in the log.'
              : `No person — ${ACTOR_KIND_WORDS[kind]?.toLowerCase() ?? 'the system'}.`}
          </p>
        )}
        <dl className='mt-3'>
          {kind !== 'person' && <Fact label='Acting as'>{ACTOR_KIND_WORDS[kind] ?? kind}</Fact>}
          <Fact label='Came in through'>{sourceWords(entry)}</Fact>
          {entry.ip && <Fact label='Address'>{entry.ip}</Fact>}
          {entry.user_agent && (
            <Fact label='Browser'>
              <span className='font-mono text-[11px] text-slate-500 dark:text-slate-400'>
                {entry.user_agent}
              </span>
            </Fact>
          )}
        </dl>
      </Section>

      {entry.request && (
        <Section
          title='The request'
          icon={Link2}
          aside={
            reqUrl ? (
              <LinkButton
                onClick={() => navigate(consoleUrl ? (consoleUrl(reqUrl) ?? reqUrl) : reqUrl)}
              >
                Request story <ExternalLink className='h-3 w-3' aria-hidden />
              </LinkButton>
            ) : null
          }
        >
          <dl>
            <Fact label='Request'>
              {entry.request.method || entry.request.path ? (
                <span className='font-mono text-[11.5px]'>
                  {entry.request.method} {entry.request.path}
                </span>
              ) : (
                <span className='text-slate-500'>{requestTip(entry.request)}</span>
              )}
            </Fact>
            {entry.request.status != null && (
              <Fact label='Answer'>
                <span
                  className={cn(
                    entry.request.status >= 400 && 'font-medium text-red-600 dark:text-red-400'
                  )}
                >
                  {entry.request.status}
                </span>
                {entry.request.latency_ms != null && (
                  <span className='text-slate-500'>
                    {' '}
                    · {formatNumber(Math.round(entry.request.latency_ms))} ms
                  </span>
                )}
              </Fact>
            )}
            <Fact label={entry.request.request_id ? 'Request id' : 'Chain id'}>
              <RequestCell request={entry.request} />
            </Fact>
          </dl>
          {rel && rel.same_request.length > 0 && (
            <>
              <p className='mt-3 text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>
                Also written by this request
              </p>
              <ul className='-mx-2 mt-1'>
                {rel.same_request.map((r) => (
                  <MiniRow key={r.id} row={r} labels={labels} onOpen={onOpenEntry} />
                ))}
              </ul>
            </>
          )}
        </Section>
      )}

      {record && rel && (
        <Section
          title={recordName ?? 'The record'}
          icon={History}
          aside={
            onDrill ? (
              <LinkButton onClick={() => onDrill({ record })}>
                {rel.on_record === 1
                  ? 'Its only entry'
                  : `All ${formatNumber(rel.on_record)} entries`}
              </LinkButton>
            ) : null
          }
        >
          {!rel.before && !rel.after ? (
            <p className='text-[12.5px] text-slate-500 dark:text-slate-400'>
              The only change on this record.
            </p>
          ) : (
            <ul className='-mx-2'>
              {rel.before && (
                <MiniRow row={rel.before} labels={labels} onOpen={onOpenEntry} hint='Before' />
              )}
              {rel.after && (
                <MiniRow row={rel.after} labels={labels} onOpen={onOpenEntry} hint='After' />
              )}
            </ul>
          )}
        </Section>
      )}

      {rel && rel.same_group.count > 1 && (
        <Section
          title={`Part of a run of ${formatNumber(rel.same_group.count)}`}
          icon={Layers}
          aside={
            onDrill && entry.group_key ? (
              <LinkButton onClick={() => onDrill({ group_key: entry.group_key as string })}>
                See all {formatNumber(rel.same_group.count)}
              </LinkButton>
            ) : null
          }
        >
          <p className='mb-1 text-[12px] text-slate-500 dark:text-slate-400'>
            One bulk change, import, automation or assistant request wrote these together.
          </p>
          <ul className='-mx-2'>
            {rel.same_group.rows.map((r) => (
              <MiniRow key={r.id} row={r} labels={labels} onOpen={onOpenEntry} />
            ))}
          </ul>
        </Section>
      )}

      {data.snapshot && (
        <Section title='The record as saved' icon={History}>
          <button
            type='button'
            aria-expanded={snapOpen}
            onClick={() => setSnapOpen((v) => !v)}
            className='flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-300 dark:hover:text-slate-50'
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-200',
                !snapOpen && '-rotate-90'
              )}
              aria-hidden
            />
            {snapOpen ? 'Hide' : 'Show'} every field (
            {formatNumber(Object.keys(data.snapshot).length)})
          </button>
          {snapOpen && (
            <dl className='nvr-expand-in mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 px-3 dark:divide-border dark:border-border'>
              {Object.entries(data.snapshot).map(([k, v]) => (
                <div key={k} className='flex items-baseline gap-3 py-1.5 text-[12.5px]'>
                  <dt
                    className='w-[38%] shrink-0 truncate text-slate-500 dark:text-slate-400'
                    data-tip={k}
                  >
                    {fieldLabel(entry.collection, k, labels)}
                  </dt>
                  <dd className='min-w-0 flex-1 break-words text-slate-800 dark:text-slate-100'>
                    <ValueView
                      collection={entry.collection}
                      field={k}
                      value={v}
                      labels={labels}
                      linkLabels={linkLabels}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      )}

      <div className='border-t border-slate-100 px-5 pt-3 dark:border-border'>
        <button
          type='button'
          aria-expanded={raw}
          onClick={() => setRaw((v) => !v)}
          className='flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:text-slate-100'
        >
          <Code2 className='h-3.5 w-3.5' aria-hidden />
          {raw ? 'Hide raw' : 'View raw'}
        </button>
        {raw && (
          <pre className='nvr-expand-in mt-2 max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 dark:bg-white/[0.04] dark:text-slate-300'>
            {JSON.stringify(
              { entry: data.entry, changes: data.changes, revision: data.revision },
              null,
              2
            )}
          </pre>
        )}
      </div>
    </div>
  )
}

/** "‹ Newer · Older ›" for stepping through the table's rows from the drawer. */
export function EntryStepper({
  onPrev,
  onNext,
  position
}: {
  onPrev?: () => void
  onNext?: () => void
  position?: string
}) {
  return (
    <div className='flex items-center gap-1'>
      <button
        type='button'
        onClick={onPrev}
        disabled={!onPrev}
        aria-label='Previous entry'
        className='flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
      >
        <ChevronLeft className='h-4 w-4' />
      </button>
      {position && <span className='text-[11.5px] tabular-nums text-slate-500'>{position}</span>}
      <button
        type='button'
        onClick={onNext}
        disabled={!onNext}
        aria-label='Next entry'
        className='flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
      >
        <ChevronRight className='h-4 w-4' />
      </button>
    </div>
  )
}

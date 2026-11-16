import { GitMerge, History } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  autoMerge,
  diffTextBlocks,
  type FieldMergeKind,
  fieldMergeKind,
  type HunkPick,
  mergedSet,
  mergedText,
  mergeSetValues,
  setItemKey,
  setValueLike
} from '../../lib/field-merge'
import { liveMotionAllowed } from '../../lib/live-preference'
import { htmlToText } from '../../lib/sanitize-html'
import { diffWindow } from '../../lib/text-diff-window'
import { choiceLabel, cn, formatDate, formatDateTime, formatRelative } from '../../lib/utils'
import { RelativeTime } from '../RelativeTime'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { RemoteFieldChange } from './FieldAffordances'
import { parseJson } from './helpers'
import type { CMSField } from './types'
import { useRecordLabels } from './useRecordLabels'

/**
 * Someone else's save landing in an open form (realtime round 2, item 1):
 *
 *  - a field the person has NOT touched takes the new value quietly: a short
 *    fade on the field and a tiny dot beside its label; hover / focus on the
 *    dot says who changed it, when, and old → new (RemoteChangeMark);
 *  - a field the person HAS edited keeps their value and shows one calm line
 *    under it — "Beth saved X" with Keep mine / Take theirs / Merge
 *    (RemoteConflictNotice; merge rules in lib/field-merge.ts);
 *  - "See changes" in the header lists every field others changed since the
 *    record was opened (RemoteChangesButton).
 *
 * Values are the ones the viewer's own read returned (the refetch runs as
 * the viewer), so a field they may not read never shows here.
 */

const short = (v: unknown, max = 80): string => {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.length === 0 ? 'empty' : v.map((x) => short(x, 30)).join(', ')
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v)
      return s.length > max ? `${s.slice(0, max)}…` : s
    } catch {
      return String(v)
    }
  }
  const raw = String(v)
  const s = /[<&]/.test(raw) ? htmlToText(raw).trim() : raw
  const one = s.replace(/\s+/g, ' ')
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** A value as the person reads it: a related record's label, a choice's text, else short text. */
export function useShown(
  field: CMSField | null,
  relatedCollection: string | null,
  values: unknown[]
) {
  const looked = useRecordLabels(relatedCollection, values, !!relatedCollection)
  const choices = useMemo(() => {
    const parsed = parseJson<{ choices?: Array<{ text: string; value: unknown }> }>(field?.options)
    return new Map((parsed?.choices ?? []).map((c) => [String(c.value), choiceLabel(c.text)]))
  }, [field?.options])
  return (v: unknown, max?: number): string => {
    if (v != null && typeof v !== 'object') {
      const k = String(v)
      if (looked.has(k)) return looked.get(k) as string
      if (choices.has(k)) return choices.get(k) as string
    }
    return short(v, max)
  }
}

/** No fade: reduced motion, or live updates set to Calm/Off (lib/live-preference.ts). */
const reducedMotion = () => !liveMotionAllowed()

/** The quiet fade on a field whose value just changed under the person (never with reduced motion). */
export function fadeChangedField(el: HTMLElement | null | undefined): void {
  if (!el || typeof el.animate !== 'function' || reducedMotion()) return
  el.animate(
    [
      { boxShadow: '0 0 0 3px rgba(0, 206, 255, 0.28)', borderRadius: '6px' },
      { boxShadow: '0 0 0 3px rgba(0, 206, 255, 0)', borderRadius: '6px' }
    ],
    { duration: 1600, easing: 'ease-out' }
  )
}

/** "Beth changed this 2m ago: Draft → Approved". */
export function remoteChangeText(
  change: Pick<RemoteFieldChange, 'by' | 'at' | 'was'>,
  now: unknown,
  shown: (v: unknown) => string = (v) => short(v)
): string {
  const who = change.by ?? 'Someone'
  const when = formatRelative(change.at)
  return `${who} changed this ${when === 'just now' ? 'just now' : when}: ${shown(change.was)} → ${shown(now)}`
}

/**
 * The tiny mark beside a field's label after someone else's save changed it.
 * Hover or focus says who / when / old → new; a click clears it. Fades the
 * field once when it first appears.
 */
export function RemoteChangeMark({
  change,
  now,
  field,
  relatedCollection,
  onDismiss
}: {
  change: RemoteFieldChange
  /** The value the field holds now (the other person's). */
  now: unknown
  field: CMSField | null
  relatedCollection?: string | null
  onDismiss: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const shown = useShown(field, relatedCollection ?? null, [change.was, now])
  const text = remoteChangeText(change, now, (v) => shown(v, 60))
  // One fade per change (a new `at` = a newer save of the same field).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fade once per change
  useEffect(() => {
    const wrap = ref.current?.closest<HTMLElement>('[data-field]')
    const control =
      wrap?.querySelector<HTMLElement>('[data-field-control]') ??
      wrap?.querySelector<HTMLElement>(
        'input, textarea, [contenteditable="true"], button[role="combobox"]'
      )
    fadeChangedField(control ?? wrap)
  }, [change.at])
  return (
    <button
      ref={ref}
      type='button'
      data-remote-change-mark
      data-tip={`${text} · click to clear`}
      aria-label={text}
      onClick={onDismiss}
      className='group inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60'
    >
      <span className='h-1.5 w-1.5 rounded-full bg-sky-500 transition-transform group-hover:scale-125 dark:bg-sky-400' />
    </button>
  )
}

/**
 * Under a field the person edited when someone else saved it: their value
 * stays; one calm line says what the other person saved and offers Keep mine
 * / Take theirs / Merge (Merge only where the field can merge — long text and
 * sets; a locked field only takes theirs).
 */
export function RemoteConflictNotice({
  change,
  mine,
  field,
  relatedCollection,
  locked,
  onKeepMine,
  onTakeTheirs,
  onMerge
}: {
  change: RemoteFieldChange
  mine: unknown
  field: CMSField | null
  relatedCollection?: string | null
  locked?: boolean
  onKeepMine: () => void
  onTakeTheirs?: () => void
  onMerge?: (value: unknown) => void
}) {
  const [merging, setMerging] = useState(false)
  const shown = useShown(field, relatedCollection ?? null, [change.theirs, mine])
  const kind: FieldMergeKind = fieldMergeKind(field, mine, change.theirs)
  const canMerge = !locked && !!onMerge && kind !== 'none'
  // Outlined small buttons (44 px tall on a touch screen) — bare text read as
  // a label next to the cyan "Use merged".
  const btn =
    'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3.5'
  const quietBtn =
    'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
  return (
    <div
      data-remote-change-ghost
      data-remote-conflict
      className='nvr-expand-in rounded-md border border-amber-200/80 bg-amber-50/60 px-2 py-1.5 text-[11.5px] text-slate-700 dark:border-amber-400/25 dark:bg-amber-400/[0.06] dark:text-slate-200'
    >
      {/* Always stacked: the sentence takes the full width, the buttons sit on their own row
          under it (rt2-conflict r-1116b — side by side, a field column squeezed the sentence
          to ~150 px over five lines). */}
      <div className='flex flex-col items-start gap-1.5'>
        {/* The dot travels with its sentence: never alone on a line of its own. */}
        <span className='flex w-full min-w-0 items-start gap-2'>
          <span className='mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400' />
          <span className='min-w-0'>
            <span className='font-medium'>{change.by ?? 'Someone'}</span> saved{' '}
            <span
              className='font-medium text-slate-900 dark:text-slate-50'
              data-tip={shown(change.theirs, 400)}
            >
              {shown(change.theirs)}
            </span>
            <span className='text-slate-500 dark:text-slate-400'>
              {' '}
              · <RelativeTime value={change.at} />
            </span>
          </span>
        </span>
        <span className='flex flex-wrap items-center gap-1.5 pl-3.5'>
          {!locked && (
            <button
              type='button'
              onClick={onKeepMine}
              data-remote-keep-mine
              className={cn(btn, quietBtn)}
            >
              Keep mine
            </button>
          )}
          {onTakeTheirs && (
            <button
              type='button'
              onClick={onTakeTheirs}
              data-remote-take-theirs
              className={cn(
                btn,
                'border-amber-300 bg-amber-100 text-amber-950 hover:bg-amber-200/70 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-100 dark:hover:bg-amber-400/25'
              )}
            >
              Take theirs
            </button>
          )}
          {canMerge && (
            <button
              type='button'
              onClick={() => setMerging((v) => !v)}
              data-remote-merge
              aria-expanded={merging}
              className={cn(btn, quietBtn)}
            >
              <GitMerge className='h-3 w-3' />
              Merge
            </button>
          )}
        </span>
      </div>
      {merging && canMerge && (
        <FieldMergePanel
          kind={kind}
          base={change.was}
          mine={mine}
          theirs={change.theirs}
          by={change.by ?? 'Someone'}
          flat
          shown={(v) => shown(v, 120)}
          onCancel={() => setMerging(false)}
          onApply={(v) => {
            setMerging(false)
            onMerge?.(v)
          }}
        />
      )}
    </div>
  )
}

/**
 * The merge itself, inline under the notice. Sets: every value either side
 * has, ticked when it stays; what one side removed is listed (unticked) so it
 * can be put back. Long text: unchanged parts dimmed, each part that differs
 * with Yours / Theirs / Both; plain text stays editable before it is used.
 */
export function FieldMergePanel({
  kind,
  base,
  mine,
  theirs,
  by,
  shown,
  flat,
  onApply,
  onCancel
}: {
  /** Inside the amber conflict notice: no card of its own (one bordered panel, not three). */
  flat?: boolean
  kind: FieldMergeKind
  base: unknown
  mine: unknown
  theirs: unknown
  by: string
  shown: (v: unknown) => string
  onApply: (value: unknown) => void
  onCancel: () => void
}) {
  const rich = kind === 'rich'
  const setItemsList = useMemo(
    () => (kind === 'set' ? mergeSetValues(base, mine, theirs) : []),
    [kind, base, mine, theirs]
  )
  const hunks = useMemo(
    () => (kind === 'text' || kind === 'rich' ? diffTextBlocks(base, mine, theirs, rich) : []),
    [kind, base, mine, theirs, rich]
  )
  const [flips, setFlips] = useState<Map<string, boolean>>(() => new Map())
  const [picks, setPicks] = useState<Map<number, HunkPick>>(() => new Map())
  const merged =
    kind === 'set'
      ? setValueLike(mergedSet(setItemsList, flips), mine)
      : kind === 'text' || kind === 'rich'
        ? mergedText(hunks, picks, rich)
        : autoMerge(kind, base, mine, theirs)
  // Plain text: the result stays editable; a new pick rewrites it.
  const [edited, setEdited] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pick starts from the picks again
  useEffect(() => setEdited(null), [picks])
  const result = kind === 'text' && edited !== null ? edited : merged
  const firstRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    firstRef.current?.querySelector<HTMLElement>('button, input, textarea')?.focus()
  }, [])
  const blockText = (b: string) => (rich ? htmlToText(b).trim() : b) || '(blank line)'
  return (
    <div
      ref={firstRef}
      data-field-merge
      className={cn(
        'mt-2 space-y-2',
        flat
          ? 'border-t border-amber-200/80 pt-2 dark:border-amber-400/20'
          : 'rounded-md border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'
      )}
    >
      {kind === 'set' && (
        <ul className='flex flex-wrap gap-1.5' aria-label='Merged values'>
          {setItemsList.map((it) => {
            const k = setItemKey(it.value)
            const on = flips.get(k) ?? it.keep
            const note =
              it.removedBy === 'theirs'
                ? `removed by ${by}`
                : it.removedBy === 'mine'
                  ? 'removed by you'
                  : it.addedBy === 'theirs'
                    ? `added by ${by}`
                    : it.addedBy === 'mine'
                      ? 'added by you'
                      : null
            return (
              <li key={k}>
                <button
                  type='button'
                  aria-pressed={on}
                  data-merge-item={String(it.value)}
                  onClick={() => setFlips((m) => new Map(m).set(k, !on))}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors [@media(pointer:coarse)]:min-h-[44px]',
                    on
                      ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-slate-100'
                      : 'border-slate-200 bg-white text-slate-500 dark:border-border dark:bg-transparent dark:text-slate-400'
                  )}
                >
                  {/* Only the value is struck when it is left out — never the note. */}
                  <span className={on ? undefined : 'line-through'}>{shown(it.value)}</span>
                  {note && (
                    <span className='text-[11px] text-slate-500 dark:text-slate-400'>· {note}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {(kind === 'text' || kind === 'rich') && (
        <ol className='max-h-64 space-y-1 overflow-y-auto pr-1' aria-label='Parts that differ'>
          {hunks.map((h, idx) => {
            if (h.same)
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: hunks are positional
                  key={idx}
                  className='truncate px-1 text-[11px] text-slate-500 dark:text-slate-400'
                >
                  {h.mine.length === 1
                    ? blockText(h.mine[0])
                    : `${h.mine.length} unchanged ${rich ? 'paragraphs' : 'lines'}`}
                </li>
              )
            const pick = picks.get(idx) ?? h.pick
            const opt = (p: HunkPick, label: string) => (
              <button
                type='button'
                aria-pressed={pick === p}
                data-merge-pick={p}
                onClick={() => setPicks((m) => new Map(m).set(idx, p))}
                className={cn(
                  'inline-flex h-6 items-center rounded px-2 text-[11px] font-medium [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3.5',
                  pick === p
                    ? 'bg-[#0f172a] text-[#ffffff] dark:bg-[#e2e8f0] dark:text-[#0f172a]'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
                )}
              >
                {label}
              </button>
            )
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: hunks are positional
                key={idx}
                data-merge-hunk
                data-merge-conflict={h.conflict ? '' : undefined}
                className={cn(
                  'rounded border px-1.5 py-1',
                  h.conflict
                    ? 'border-amber-200 dark:border-amber-400/30'
                    : 'border-slate-100 dark:border-border'
                )}
              >
                <div className='grid gap-1 text-[11.5px] sm:grid-cols-2'>
                  <div className='min-w-0'>
                    <p className='text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                      Yours
                    </p>
                    <p className='whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200'>
                      {h.mine.length ? h.mine.map(blockText).join('\n') : '(nothing)'}
                    </p>
                  </div>
                  <div className='min-w-0'>
                    <p className='text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                      {by}
                    </p>
                    <p className='whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200'>
                      {h.theirs.length ? h.theirs.map(blockText).join('\n') : '(nothing)'}
                    </p>
                  </div>
                </div>
                <div className='mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1'>
                  {h.conflict && (
                    <span className='text-[11px] text-amber-700 dark:text-amber-300'>
                      You both changed this
                    </span>
                  )}
                  <span
                    role='group'
                    aria-label='Which version to keep'
                    className='inline-flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'
                  >
                    {opt('mine', 'Yours')}
                    {opt('theirs', 'Theirs')}
                    {opt('both', 'Both')}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {kind === 'text' && (
        <label className='block'>
          <span className='text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
            Result — edit it before you use it if you like
          </span>
          <textarea
            data-merge-result
            value={String(result ?? '')}
            onChange={(e) => setEdited(e.target.value)}
            rows={Math.min(8, Math.max(3, String(result ?? '').split('\n').length))}
            className='mt-0.5 w-full rounded border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-800 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/40 dark:border-border dark:bg-background dark:text-slate-100'
          />
        </label>
      )}
      {kind === 'rich' && (
        <div className='rounded bg-slate-50 px-2 py-1 text-[11.5px] text-slate-700 dark:bg-muted/40 dark:text-slate-200'>
          <p className='text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>Result</p>
          <p className='whitespace-pre-wrap'>
            {htmlToText(String(result ?? '')).trim() || 'empty'}
          </p>
        </div>
      )}
      <div className='flex items-center justify-end gap-1.5'>
        <button
          type='button'
          onClick={onCancel}
          className='inline-flex h-7 items-center rounded-md px-2.5 text-[11.5px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted [@media(pointer:coarse)]:h-11'
        >
          Cancel
        </button>
        <button
          type='button'
          data-merge-apply
          onClick={() => onApply(result)}
          className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[11.5px] font-medium text-white hover:brightness-95 [@media(pointer:coarse)]:h-11'
        >
          Use merged
        </button>
      </div>
    </div>
  )
}

/** Columns the system stamps on every save — never "a change by others" a person needs to see. */
const SYSTEM_STAMPS = new Set([
  'date_updated',
  'updated_at',
  'user_updated',
  'updated_by',
  'date_created',
  'created_at',
  'user_created',
  'created_by',
  'modified_at',
  'modified_by',
  'date_modified',
  'last_modified',
  'last_updated',
  // EFP-style stamps: `changed` / `created` carry the save time on workflows.
  'changed',
  'created'
])

export function isSystemStampField(name: string): boolean {
  return SYSTEM_STAMPS.has(name)
}

const DATE_ONLY = new Set(['date'])
const DATE_TIME = new Set(['datetime', 'dateTime', 'timestamp', 'time-stamp'])

/** One value in "See changes", formatted the way the form shows it. */
function ChangeValue({
  value,
  field,
  relatedCollection
}: {
  value: unknown
  field: CMSField | null
  relatedCollection: string | null
}) {
  const shown = useShown(field, relatedCollection, [value])
  if (value != null && value !== '' && field) {
    if (DATE_ONLY.has(field.type)) return <>{formatDate(String(value)) || 'empty'}</>
    if (DATE_TIME.has(field.type)) return <>{formatDateTime(String(value)) || 'empty'}</>
  }
  return <>{shown(value, 60)}</>
}

/**
 * Old → new in "See changes". Long text shows the part that differs (lib/text-diff-window):
 * a head cut made both sides read the same whenever the edit was past it (rt2-conflict).
 */
function ChangeDiff({
  was,
  now,
  field,
  relatedCollection
}: {
  was: unknown
  now: unknown
  field: CMSField | null
  relatedCollection: string | null
}) {
  const shown = useShown(field, relatedCollection, [was, now])
  const plain =
    (typeof was === 'string' || was == null) &&
    (typeof now === 'string' || now == null) &&
    !(field && (DATE_ONLY.has(field.type) || DATE_TIME.has(field.type)))
  const win = plain ? diffWindow(shown(was, 100000), shown(now, 100000)) : null
  return (
    <p className='mt-0.5 break-words text-slate-500 dark:text-slate-400'>
      <span className='line-through decoration-slate-300 dark:decoration-slate-600'>
        {win ? (
          win.before
        ) : (
          <ChangeValue value={was} field={field} relatedCollection={relatedCollection} />
        )}
      </span>{' '}
      →{' '}
      <span className='text-slate-700 dark:text-slate-200'>
        {win ? (
          win.after
        ) : (
          <ChangeValue value={now} field={field} relatedCollection={relatedCollection} />
        )}
      </span>
    </p>
  )
}

export interface RemoteChangeLogEntry {
  field: string
  by: string | null
  at: string
  was: unknown
  now: unknown
}

/**
 * "See changes": every field others changed since this record was opened —
 * who, when, old → new. A field still in conflict with the person's own edit
 * offers Keep mine / Take theirs here too. Shows only once something changed.
 */
export function RemoteChangesButton({
  entries,
  conflicts,
  labelOf,
  fieldOf,
  relatedOf,
  onKeepMine,
  onTakeTheirs,
  onJump
}: {
  entries: RemoteChangeLogEntry[]
  /** The field's config, to format values as the form does. */
  fieldOf?: (field: string) => CMSField | null
  /** The collection a link field points at, to show the linked record's name. */
  relatedOf?: (field: string) => string | null
  /** field → the open conflict on it. */
  conflicts: Record<string, RemoteFieldChange>
  labelOf: (field: string) => string
  onKeepMine: (field: string) => void
  onTakeTheirs: (field: string) => void
  onJump?: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  // A save stamps date_updated / user_updated: noise, not a change to read.
  const shownEntries = entries.filter((e) => !isSystemStampField(e.field))
  if (shownEntries.length === 0) return null
  const open_ = Object.values(conflicts).filter((c) => c.conflict).length
  const newest = [...shownEntries].reverse()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-remote-changes-button
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium shadow-sm transition-colors',
            open_ > 0
              ? 'border-amber-300 text-amber-800 hover:bg-amber-50 dark:border-amber-400/30 dark:text-amber-200 dark:hover:bg-amber-400/10'
              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-100 dark:hover:bg-muted'
          )}
        >
          <History className='h-3.5 w-3.5' />
          See changes
          <span className='rounded-full bg-slate-100 px-1.5 text-[10.5px] tabular-nums text-slate-700 dark:bg-slate-700 dark:text-slate-100'>
            {shownEntries.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        collisionPadding={16}
        className='w-[360px] max-w-[calc(100vw-32px)] p-0'
        data-remote-changes-panel
      >
        <div className='border-b border-slate-100 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
            Changed by others since you opened this
          </p>
          {open_ > 0 && (
            <p className='text-[11px] text-amber-700 dark:text-amber-300'>
              {open_} {open_ === 1 ? 'field you are also editing' : 'fields you are also editing'} —
              choose which value to keep.
            </p>
          )}
        </div>
        <ul className='max-h-80 divide-y divide-slate-100 overflow-y-auto overscroll-contain dark:divide-border'>
          {newest.map((e, i) => {
            const c = conflicts[e.field]
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: one field can change twice in the same instant
                key={`${e.field}-${e.at}-${i}`}
                className='px-3 py-2 text-[11.5px]'
                data-remote-change-entry={e.field}
              >
                <div className='flex items-baseline justify-between gap-2'>
                  <button
                    type='button'
                    onClick={() => {
                      onJump?.(e.field)
                      setOpen(false)
                    }}
                    className='truncate text-left font-medium text-slate-800 hover:underline dark:text-slate-100'
                  >
                    {labelOf(e.field)}
                  </button>
                  <span className='shrink-0 text-[10.5px] text-slate-500 dark:text-slate-400'>
                    {e.by ?? 'Someone'} · <RelativeTime value={e.at} />
                  </span>
                </div>
                <ChangeDiff
                  was={e.was}
                  now={e.now}
                  field={fieldOf?.(e.field) ?? null}
                  relatedCollection={relatedOf?.(e.field) ?? null}
                />
                {c?.conflict && i === newest.findIndex((x) => x.field === e.field) && (
                  <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                    <span className='mr-auto text-[11px] text-amber-700 dark:text-amber-300'>
                      You changed this too
                    </span>
                    <button
                      type='button'
                      onClick={() => onKeepMine(e.field)}
                      className='inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted [@media(pointer:coarse)]:h-11'
                    >
                      Keep mine
                    </button>
                    <button
                      type='button'
                      onClick={() => onTakeTheirs(e.field)}
                      className='inline-flex h-7 items-center rounded-md border border-amber-300 bg-amber-100 px-2.5 text-[11px] font-medium text-amber-950 hover:bg-amber-200/70 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-100 dark:hover:bg-amber-400/25 [@media(pointer:coarse)]:h-11'
                    >
                      Take theirs
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

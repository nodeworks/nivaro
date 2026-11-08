import { type ReactNode, useState } from 'react'
import { createPortal } from 'react-dom'
import { htmlToText } from '../../lib/sanitize-html'
import { titleCase } from '../../lib/utils'
import { collisionNumberText, differingTails } from './collision-format'
import {
  classifyLineConflicts,
  mergedLinePreview,
  mergeReady,
  mergeTheirsKeys,
  previewFields
} from './line-merge'
import { type LineCollision, lineConflictKey } from './line-midair'

/**
 * Mid-air collision merge dialog: someone else saved the same fields since
 * this draft loaded. Per field, keep THEIRS (adopt the newer value) or MINE
 * (overwrite it) — the retry writes only what was explicitly kept, against
 * the newer revision baseline. Defaults to theirs: overwriting a colleague's
 * work should be the deliberate choice, not the path of least resistance.
 */
export function MidairCollisionDialog({
  collision,
  fieldLabel,
  onCancel,
  onResolve,
  title = 'Someone else changed this record',
  intro = 'These fields were saved by someone else while you were editing. Pick which value wins for each — everything else you changed saves normally.',
  cancelLabel = 'Cancel save',
  formatValue = collisionNumberText,
  topSlot,
  replaceBody
}: {
  collision: {
    conflicts: Array<{ field: string; current_value: unknown }>
    mine: Record<string, unknown>
  }
  fieldLabel: (field: string) => string
  onCancel: () => void
  onResolve: (takeTheirs: Set<string>) => void
  title?: string
  intro?: string
  cancelLabel?: string
  /** A value as a person reads it (money, plain numbers); null = shown as text. */
  formatValue?: (key: string, v: unknown) => string | null
  /** Under the intro (the line chooser's Theirs or mine / Merge switch). */
  topSlot?: ReactNode
  /** Another view's list + buttons in place of the Theirs / Mine pairs (Merge). */
  replaceBody?: ReactNode
}) {
  const [takeTheirs, setTakeTheirs] = useState<Set<string>>(
    () => new Set(collision.conflicts.map((c) => c.field))
  )
  // Portal into the hosting dialog (a record drill sheet) when there is one —
  // a modal sheet's lock makes everything outside it unclickable.
  const [host, setHost] = useState<HTMLElement | null>(null)
  // Rich text reads as text here, never as raw <p> markup.
  const fmt = (key: string, v: unknown) => {
    if (v == null || v === '') return '—'
    const shown = formatValue(key, v)
    if (shown != null) return shown
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 120)
    const str = String(v)
    const text = /<[a-z][^>]*>/i.test(str) ? htmlToText(str) : str
    return text.trim() ? text.slice(0, 200) : '—'
  }
  // Both sides of one field, a long shared start cut so the change shows.
  const pair = (key: string, theirs: unknown, mine: unknown) => {
    const t = fmt(key, theirs)
    const m = fmt(key, mine)
    if (t === '—' || m === '—') return { t, m }
    const d = differingTails(t, m)
    return { t: d.a, m: d.b }
  }
  const anchor = (
    <span
      hidden
      ref={(el) => {
        if (el && !host)
          setHost((el.closest('[role="dialog"]') as HTMLElement | null) ?? document.body)
      }}
    />
  )
  if (!host) return anchor
  return createPortal(
    <div
      role='dialog'
      aria-modal='true'
      aria-labelledby='nvr-midair-title'
      className='pointer-events-auto fixed inset-0 z-[130] flex items-center justify-center'
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <button
        type='button'
        aria-label='Close'
        tabIndex={-1}
        className='absolute inset-0 cursor-default bg-black/40'
        onClick={onCancel}
      />
      <div className='relative w-[560px] max-w-[94vw] rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-border dark:bg-card'>
        <p
          id='nvr-midair-title'
          className='text-[14px] font-semibold text-slate-900 dark:text-foreground'
        >
          {title}
        </p>
        <p className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>{intro}</p>
        {topSlot}
        {replaceBody ?? (
          <>
            <div className='mt-3 max-h-[320px] space-y-2 overflow-y-auto'>
              {collision.conflicts.map((c, ci) => {
                const theirs = takeTheirs.has(c.field)
                const shown = pair(c.field, c.current_value, collision.mine[c.field])
                const labelId = `nvr-midair-field-${ci}`
                return (
                  <div
                    key={c.field}
                    className='rounded-md border border-slate-200 p-2.5 dark:border-border'
                  >
                    <p
                      id={labelId}
                      className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'
                    >
                      {fieldLabel(c.field)}
                    </p>
                    <fieldset
                      aria-labelledby={labelId}
                      className='m-0 mt-1.5 grid min-w-0 grid-cols-2 gap-2 border-0 p-0'
                    >
                      <button
                        type='button'
                        aria-pressed={theirs}
                        onClick={() => setTakeTheirs((prev) => new Set([...prev, c.field]))}
                        className={
                          theirs
                            ? 'rounded-md border-2 border-nvr-cyan/60 bg-nvr-cyan/5 px-2.5 py-1.5 text-left'
                            : 'rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border'
                        }
                      >
                        <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                          Theirs (current)
                        </p>
                        <p className='mt-0.5 break-words text-[12px] text-slate-700 dark:text-foreground'>
                          {shown.t}
                        </p>
                      </button>
                      <button
                        type='button'
                        aria-pressed={!theirs}
                        onClick={() =>
                          setTakeTheirs((prev) => {
                            const next = new Set(prev)
                            next.delete(c.field)
                            return next
                          })
                        }
                        className={
                          !theirs
                            ? 'rounded-md border-2 border-amber-400/70 bg-amber-50 px-2.5 py-1.5 text-left dark:bg-amber-400/10'
                            : 'rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border'
                        }
                      >
                        <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                          Mine (overwrite)
                        </p>
                        <p className='mt-0.5 break-words text-[12px] text-slate-700 dark:text-foreground'>
                          {shown.m}
                        </p>
                      </button>
                    </fieldset>
                  </div>
                )
              })}
            </div>
            <div className='mt-4 flex items-center justify-end gap-2'>
              <button
                type='button'
                onClick={onCancel}
                className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-600 dark:border-border dark:text-muted-foreground'
              >
                {cancelLabel}
              </button>
              <button
                type='button'
                onClick={() => onResolve(takeTheirs)}
                className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white'
              >
                Apply &amp; save
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    host
  )
}

/** The Theirs / Mine chooser for LINES (a10-3 / H4): one row per conflicting
 *  field of each line ("Line 3 · Quantity"). Keys are `lineConflictKey`s;
 *  `onResolve` gets the keys the person left on "Theirs". Used by the record
 *  form (staged lines) and by immediate-save grids (InlineTableField). */
export function LineCollisionDialog({
  lines,
  fieldLabel,
  onCancel,
  onResolve,
  intro = 'These values were saved by someone else after you changed them. Pick which value wins for each — the rest of your changes are saved.',
  cancelLabel = 'Decide later',
  formatValue = collisionNumberText,
  hideField
}: {
  lines: LineCollision[]
  fieldLabel?: (field: string) => string
  onCancel: () => void
  onResolve: (theirsKeys: Set<string>) => void
  intro?: string
  cancelLabel?: string
  /** A line value as a person reads it, by the line's own field name. */
  formatValue?: (field: string, v: unknown) => string | null
  /** Fields the merge preview never shows (links shown as ids, internal columns). */
  hideField?: (line: LineCollision, field: string) => boolean
}) {
  const [mode, setMode] = useState<'pick' | 'merge'>('pick')
  const label = (f: string) => fieldLabel?.(f) || titleCase(f.replace(/_/g, ' '))
  const fieldOf = (k: string): string => {
    for (const lc of lines)
      for (const c of lc.conflicts) if (lineConflictKey(lc, c.field) === k) return c.field
    return k
  }
  return (
    <MidairCollisionDialog
      title={
        lines.length === 1
          ? `Someone else changed ${lines[0].label}`
          : `Someone else changed ${lines.length} lines`
      }
      intro={intro}
      cancelLabel={cancelLabel}
      collision={{
        conflicts: lines.flatMap((lc) =>
          lc.conflicts.map((c) => ({
            field: lineConflictKey(lc, c.field),
            current_value: c.current_value
          }))
        ),
        mine: Object.fromEntries(
          lines.flatMap((lc) =>
            lc.conflicts.map((c) => [lineConflictKey(lc, c.field), lc.mine[c.field]])
          )
        )
      }}
      formatValue={(k, v) => formatValue(fieldOf(k), v)}
      fieldLabel={(k) => {
        for (const lc of lines) {
          for (const c of lc.conflicts) {
            if (lineConflictKey(lc, c.field) === k) return `${lc.label} · ${label(c.field)}`
          }
        }
        return k
      }}
      onCancel={onCancel}
      onResolve={onResolve}
      topSlot={<ResolveModeSwitch mode={mode} onMode={setMode} />}
      replaceBody={
        mode === 'merge' ? (
          <LineMergeBody
            lines={lines}
            label={label}
            formatValue={formatValue}
            hideField={hideField}
            cancelLabel={cancelLabel}
            onCancel={onCancel}
            onResolve={onResolve}
          />
        ) : undefined
      }
    />
  )
}

/** Theirs or mine (one pick per value) / Merge (Rob, army 11). */
function ResolveModeSwitch({
  mode,
  onMode
}: {
  mode: 'pick' | 'merge'
  onMode: (m: 'pick' | 'merge') => void
}) {
  const btn = (m: 'pick' | 'merge', text: string) => (
    <button
      type='button'
      aria-pressed={mode === m}
      data-resolve-mode={m}
      onClick={() => onMode(m)}
      className={
        mode === m
          ? 'h-7 rounded-md bg-white px-3 text-[12px] font-medium text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
          : 'h-7 rounded-md px-3 text-[12px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      }
    >
      {text}
    </button>
  )
  return (
    <fieldset className='m-0 mt-3 inline-flex min-w-0 gap-1 rounded-lg border-0 bg-slate-100 p-1 dark:bg-muted'>
      <legend className='sr-only'>How to settle it</legend>
      {btn('pick', 'Theirs or mine')}
      {btn('merge', 'Merge')}
    </fieldset>
  )
}

/**
 * The merge view: what merges on its own (only you changed it, you both set
 * the same value, derived figures), the real conflicts to pick — nothing
 * preselected — and the line as it would be saved. "Save merged" waits until
 * every conflict has a pick (line-merge.ts holds the rules).
 */
function LineMergeBody({
  lines,
  label,
  formatValue,
  hideField,
  cancelLabel,
  onCancel,
  onResolve
}: {
  lines: LineCollision[]
  label: (field: string) => string
  formatValue: (field: string, v: unknown) => string | null
  hideField?: (line: LineCollision, field: string) => boolean
  cancelLabel: string
  onCancel: () => void
  onResolve: (theirsKeys: Set<string>) => void
}) {
  const [picks, setPicks] = useState<Map<string, 'theirs' | 'mine'>>(() => new Map())
  const classified = lines.map((l) => ({ line: l, fields: classifyLineConflicts(l) }))
  const all = classified.flatMap((c) => c.fields)
  const open = all.filter((f) => f.kind === 'conflict' && !picks.has(f.key)).length
  const ready = mergeReady(all, picks)
  const fmt = (field: string, v: unknown) => {
    if (v == null || v === '') return '—'
    const n = formatValue(field, v)
    if (n != null) return n
    if (typeof v === 'object') return '—'
    const str = String(v)
    const text = /<[a-z][^>]*>/i.test(str) ? htmlToText(str) : str
    return text.trim() ? text.slice(0, 120) : '—'
  }
  const pick = (key: string, side: 'theirs' | 'mine') =>
    setPicks((prev) => new Map(prev).set(key, side))
  return (
    <>
      <div className='mt-3 max-h-[360px] space-y-3 overflow-y-auto' data-merge-view=''>
        {classified.map(({ line, fields }) => {
          const conflictFields = new Set(line.conflicts.map((c) => c.field))
          const derived = new Set((line.derived ?? []).map((d) => d.field))
          const onlyMine = Object.keys(line.edit ?? {}).filter(
            (f) =>
              !conflictFields.has(f) &&
              !derived.has(f) &&
              f !== 'id' &&
              !f.startsWith('_') &&
              !hideField?.(line, f)
          )
          const merged = mergedLinePreview(line, picks)
          const shown = previewFields(line, (f) => !!hideField?.(line, f))
          return (
            <div
              key={`${line.key}:${line.rowId}`}
              className='rounded-md border border-slate-200 p-2.5 dark:border-border'
            >
              <p className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                {line.label}
              </p>
              <ul className='mt-1 space-y-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                {onlyMine.map((f) => (
                  <li key={`m:${f}`}>
                    {label(f)}: yours ({fmt(f, line.edit?.[f])}) — only you changed it
                  </li>
                ))}
                {fields
                  .filter((f) => f.kind === 'same')
                  .map((f) => (
                    <li key={`s:${f.key}`}>
                      {label(f.field)}: you both set {fmt(f.field, f.theirs)}
                    </li>
                  ))}
                {fields
                  .filter((f) => f.kind === 'derived')
                  .map((f) => (
                    <li key={`d:${f.key}`}>
                      {label(f.field)}: worked out again from the merged values
                    </li>
                  ))}
                <li>Anything else they changed stays as they saved it.</li>
              </ul>
              {fields
                .filter((f) => f.kind === 'conflict')
                .map((f) => {
                  const side = picks.get(f.key)
                  const id = `nvr-merge-${line.rowId}-${f.field}`
                  return (
                    <div key={f.key} className='mt-2'>
                      <p
                        id={id}
                        className='text-[12px] font-medium text-amber-700 dark:text-amber-300'
                      >
                        {label(f.field)} — you both changed it. Pick one:
                      </p>
                      <fieldset
                        aria-labelledby={id}
                        className='m-0 mt-1 grid min-w-0 grid-cols-2 gap-2 border-0 p-0'
                      >
                        <button
                          type='button'
                          aria-pressed={side === 'theirs'}
                          data-merge-pick='theirs'
                          onClick={() => pick(f.key, 'theirs')}
                          className={
                            side === 'theirs'
                              ? 'rounded-md border-2 border-nvr-cyan/60 bg-nvr-cyan/5 px-2.5 py-1.5 text-left'
                              : 'rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border'
                          }
                        >
                          <span className='block text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                            Theirs
                          </span>
                          <span className='mt-0.5 block text-[12px] text-slate-700 dark:text-foreground'>
                            {fmt(f.field, f.theirs)}
                          </span>
                        </button>
                        <button
                          type='button'
                          aria-pressed={side === 'mine'}
                          data-merge-pick='mine'
                          onClick={() => pick(f.key, 'mine')}
                          className={
                            side === 'mine'
                              ? 'rounded-md border-2 border-amber-400/70 bg-amber-50 px-2.5 py-1.5 text-left dark:bg-amber-400/10'
                              : 'rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border'
                          }
                        >
                          <span className='block text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                            Mine
                          </span>
                          <span className='mt-0.5 block text-[12px] text-slate-700 dark:text-foreground'>
                            {fmt(f.field, f.mine)}
                          </span>
                        </button>
                      </fieldset>
                    </div>
                  )
                })}
              {shown.length > 0 && (
                <div
                  className='mt-2 rounded-md bg-slate-50 px-2.5 py-1.5 dark:bg-muted/40'
                  data-merge-preview=''
                >
                  <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                    After the merge
                  </p>
                  <p className='mt-0.5 text-[12px] text-slate-700 dark:text-foreground'>
                    {shown.map((f) => `${label(f)} ${fmt(f, merged[f])}`).join(' · ')}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className='mt-4 flex flex-wrap items-center justify-end gap-2'>
        {!ready && (
          <p
            className='mr-auto text-[12px] text-slate-500 dark:text-muted-foreground'
            role='status'
          >
            Pick a value for {open} {open === 1 ? 'field' : 'fields'} to save.
          </p>
        )}
        <button
          type='button'
          onClick={onCancel}
          className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-600 dark:border-border dark:text-muted-foreground'
        >
          {cancelLabel}
        </button>
        <button
          type='button'
          disabled={!ready}
          onClick={() => onResolve(mergeTheirsKeys(all, picks))}
          className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50'
        >
          Save merged
        </button>
      </div>
    </>
  )
}

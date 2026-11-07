import { useState } from 'react'
import { createPortal } from 'react-dom'
import { htmlToText } from '../../lib/sanitize-html'
import { titleCase } from '../../lib/utils'
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
  cancelLabel = 'Cancel save'
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
}) {
  const [takeTheirs, setTakeTheirs] = useState<Set<string>>(
    () => new Set(collision.conflicts.map((c) => c.field))
  )
  // Portal into the hosting dialog (a record drill sheet) when there is one —
  // a modal sheet's lock makes everything outside it unclickable.
  const [host, setHost] = useState<HTMLElement | null>(null)
  // Rich text reads as text here, never as raw <p> markup.
  const fmt = (v: unknown) => {
    if (v == null || v === '') return '—'
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 120)
    const str = String(v)
    const text = /<[a-z][^>]*>/i.test(str) ? htmlToText(str) : str
    return text.trim() ? text.slice(0, 200) : '—'
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
        <div className='mt-3 max-h-[320px] space-y-2 overflow-y-auto'>
          {collision.conflicts.map((c) => {
            const theirs = takeTheirs.has(c.field)
            return (
              <div
                key={c.field}
                className='rounded-md border border-slate-200 p-2.5 dark:border-border'
              >
                <p className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                  {fieldLabel(c.field)}
                </p>
                <div className='mt-1.5 grid grid-cols-2 gap-2'>
                  <button
                    type='button'
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
                      {fmt(c.current_value)}
                    </p>
                  </button>
                  <button
                    type='button'
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
                      {fmt(collision.mine[c.field])}
                    </p>
                  </button>
                </div>
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
  cancelLabel = 'Decide later'
}: {
  lines: LineCollision[]
  fieldLabel?: (field: string) => string
  onCancel: () => void
  onResolve: (theirsKeys: Set<string>) => void
  intro?: string
  cancelLabel?: string
}) {
  const label = (f: string) => fieldLabel?.(f) || titleCase(f.replace(/_/g, ' '))
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
    />
  )
}

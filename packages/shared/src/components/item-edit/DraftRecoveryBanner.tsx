import { ExternalLink, History, RotateCcw, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useItemNavigation } from '../../context'
import { draftFilledBack, draftIsFromOtherDevice, type StoredDraft } from '../../lib/draft-store'
import { diffWindow } from '../../lib/text-diff-window'
import { titleCase } from '../../lib/utils'
import { RelativeTime } from '../RelativeTime'

/**
 * "Restore your unsaved changes from N min ago" — shown once at the top of
 * a record form when a persisted draft exists for this record and user
 * (tab crash, expired session, accidental navigation). Lists the diff
 * (field: was → will be) plus staged lines / links, and offers Restore or
 * Discard. Nothing is applied until the person chooses.
 */
export interface DraftRecoveryBannerProps {
  draft: StoredDraft
  /** Field key → label (from the form's field config). */
  labelFor: (field: string) => string
  /** The record's CURRENT loaded values (what Restore would overwrite). */
  current: Record<string, unknown>
  /** The loaded record changed since the draft was captured. */
  recordChanged: boolean
  onRestore: () => void
  onDiscard: () => void
  /** This draft was already created as a record (its id; '' = id unknown):
   *  the banner says so instead of offering a plain restore. */
  createdId?: string | null
  /** The record's collection — for the created record's link. */
  collection?: string
  /** A value as the person knows it (a related record's label, a choice's
   *  text) — ids meant nothing to someone deciding whether to restore.
   *  Absent = the value as stored. */
  renderValue?: (field: string, value: unknown) => ReactNode
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return str.length > 60 ? `${str.slice(0, 60)}…` : str
}

/** Two plain text values, at least one past the head cut: their differing part (never ids,
 *  choices or objects — those go through renderValue / fmt). */
function longTextPair(was: unknown, now: unknown) {
  const text = (v: unknown) => typeof v === 'string' || v == null
  if (!text(was) || !text(now)) return null
  const a = was == null ? '' : String(was)
  const b = now == null ? '' : String(now)
  if (a.length <= 60 && b.length <= 60) return null
  const w = diffWindow(a.replace(/\s+/g, ' '), b.replace(/\s+/g, ' '))
  return { before: w.before || 'empty', after: w.after || 'empty' }
}

export function DraftRecoveryBanner({
  draft,
  labelFor,
  current,
  recordChanged,
  onRestore,
  onDiscard,
  createdId = null,
  collection,
  renderValue
}: DraftRecoveryBannerProps) {
  const [open, setOpen] = useState(false)
  // "from 2m ago" moves while the offer sits open (army5 b09-N3b): <RelativeTime> rides the
  // tab's one shared ticker.
  // A draft another device of this person's stored (rt4 #21): "Continue your draft from your
  // laptop" — they are carrying on, not recovering from a crash.
  const otherDevice = draftIsFromOtherDevice(draft) ? draft.device : null
  const itemNav = useItemNavigation()
  const fields = Object.entries(draft.fields ?? {})
  // The person's own edits, counted as the Leave dialog counts them (army6 L2); what a rule
  // filled from those picks is named apart. Same rule as the restore (draftFilledBack): an
  // existing record's fields, or a draft of filled fields only, all count as the person's.
  const filledSet = draftFilledBack(draft)
  const filled = fields.filter(([k]) => filledSet.has(k)).length
  const own = fields.length - filled
  const created = createdId !== null
  const rows = Object.values(draft.pending_rows ?? {}).reduce((n, r) => n + r.length, 0)
  const edits = Object.values(draft.pending_edits ?? {}).reduce(
    (n, e) => n + Object.keys(e).length,
    0
  )
  const deletes = Object.values(draft.pending_deletes ?? {}).reduce((n, x) => n + x.length, 0)
  const links = Object.values(draft.m2m_links ?? {}).reduce((n, x) => n + x.length, 0)
  const unlinks = Object.values(draft.m2m_unlinks ?? {}).reduce((n, x) => n + x.length, 0)
  const parts: string[] = []
  if (own) parts.push(`${own} field${own === 1 ? '' : 's'}`)
  if (filled) parts.push(`${filled} filled in from ${own === 1 ? 'it' : 'them'}`)
  if (rows) parts.push(`${rows} new line${rows === 1 ? '' : 's'}`)
  if (edits) parts.push(`${edits} line edit${edits === 1 ? '' : 's'}`)
  if (deletes) parts.push(`${deletes} line removal${deletes === 1 ? '' : 's'}`)
  if (links) parts.push(`${links} link${links === 1 ? '' : 's'}`)
  if (unlinks) parts.push(`${unlinks} unlink${unlinks === 1 ? '' : 's'}`)

  return (
    <div
      className='mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
      data-nvr-draft-recovery
    >
      {/* Two blocks that wrap: the message (icon + title, then what it holds) and the actions.
          The message keeps an 18rem basis, so on a phone or a narrow column the actions take
          their own row instead of squeezing the title to one word per line; at desktop width
          the title stays on one line beside them. */}
      <div className='flex flex-wrap items-start gap-x-3 gap-y-2'>
        <div className='flex min-w-0 flex-1 basis-[18rem] items-start gap-2'>
          <History className='mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400' />
          <div className='min-w-0'>
            {created ? (
              <p className='font-semibold' data-nvr-draft-created>
                {/* No row id (Rob's no-internal-ids rule): "Open the record" links to it. */}
                These changes from <RelativeTime value={draft.saved_at} /> were already saved as a
                new record — restoring them makes a second one.
              </p>
            ) : (
              <p className='font-semibold' data-nvr-draft-other-device={otherDevice?.label}>
                {otherDevice ? (
                  <>Continue your draft from your {otherDevice.label}</>
                ) : (
                  <>Restore your unsaved changes from</>
                )}{' '}
                {otherDevice ? '(' : ''}
                <RelativeTime value={draft.saved_at} />
                {otherDevice ? ')' : ''}?
              </p>
            )}
            <p className='mt-0.5 text-[11.5px] text-amber-800/90 dark:text-amber-200/85'>
              {parts.join(' · ')}
              {parts.length > 0 && ' · '}
              <button
                type='button'
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className='whitespace-nowrap rounded underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
              >
                {open ? 'Hide changes' : 'Show changes'}
              </button>
              {!!draft.dropped_fields && (
                <span className='ml-1' data-nvr-draft-dropped>
                  ({draft.dropped_fields} field{draft.dropped_fields === 1 ? '' : 's'} you can no
                  longer edit {draft.dropped_fields === 1 ? 'was' : 'were'} left out)
                </span>
              )}
            </p>
            {recordChanged && (
              <span className='mt-1 inline-block rounded bg-amber-200/70 px-1 py-px text-[10.5px] font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-500/30 dark:text-amber-100'>
                record changed since — review before restoring
              </span>
            )}
          </div>
        </div>
        <div className='flex shrink-0 flex-wrap items-center gap-2 max-sm:pl-6'>
          {created && createdId && collection && (
            <a
              href={itemNav.urlFor({ collection, itemId: createdId })}
              onClick={(e) => {
                e.preventDefault()
                itemNav.open({ collection, itemId: createdId })
              }}
              className='inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:brightness-95'
              data-nvr-draft-open-created
            >
              <ExternalLink className='h-3.5 w-3.5' /> Open the record
            </a>
          )}
          {/* The app's one primary (cyan) — never a solid orange that appears nowhere else. */}
          <button
            type='button'
            onClick={onRestore}
            className={
              created
                ? 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 text-[12px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-500/15'
                : 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:brightness-95'
            }
            data-nvr-draft-restore
          >
            <RotateCcw className='h-3.5 w-3.5' />{' '}
            {created ? 'Restore anyway' : otherDevice ? 'Continue' : 'Restore'}
          </button>
          <button
            type='button'
            onClick={onDiscard}
            className='inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 text-[12px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-500/15'
            data-nvr-draft-discard
          >
            <Trash2 className='h-3.5 w-3.5' /> Discard
          </button>
        </div>
      </div>
      {open && (
        <div className='mt-2 max-h-[240px] space-y-1 overflow-y-auto border-t border-amber-200/70 pt-2 dark:border-amber-500/30'>
          {fields.map(([k, v]) => {
            // Long text shows the part that differs: a 60-character head cut made the old and
            // new text read the same whenever the edit was past it (rt4-sync r-1116b).
            const win = longTextPair(current[k], v)
            return (
              <div key={k} className='text-[11.5px]'>
                <span className='font-medium'>
                  {labelFor(k) || titleCase(k.replace(/_/g, ' '))}
                </span>
                <p className='break-words text-amber-800/80 dark:text-amber-200/80'>
                  <span className='line-through opacity-70'>
                    {win ? win.before : renderValue ? renderValue(k, current[k]) : fmt(current[k])}
                  </span>{' '}
                  <span className='font-medium text-amber-900 dark:text-amber-100'>
                    {win ? win.after : renderValue ? renderValue(k, v) : fmt(v)}
                  </span>
                </p>
              </div>
            )
          })}
          {Object.entries(draft.pending_rows ?? {})
            .filter(([, r]) => r.length > 0)
            .map(([k, r]) => (
              <p key={k} className='text-[11.5px]'>
                {r.length} new line{r.length === 1 ? '' : 's'} in{' '}
                {titleCase(k.split('.')[0].replace(/_/g, ' '))}
              </p>
            ))}
          {edits > 0 && (
            <p className='text-[11.5px]'>
              {edits} edited line{edits === 1 ? '' : 's'}
            </p>
          )}
          {deletes > 0 && (
            <p className='text-[11.5px]'>
              {deletes} line removal{deletes === 1 ? '' : 's'}
            </p>
          )}
          {links > 0 && (
            <p className='text-[11.5px]'>
              {links} relation link{links === 1 ? '' : 's'}
            </p>
          )}
          {unlinks > 0 && (
            <p className='text-[11.5px]'>
              {unlinks} relation removal{unlinks === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

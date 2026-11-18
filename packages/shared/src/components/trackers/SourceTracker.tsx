import { Gitlab, Link2 } from 'lucide-react'
import { useMemo } from 'react'
import { useHeaderAnchor } from '../item-edit/HeaderTools'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { TrackerLinkPanel, type TrackerPanelMode } from './TrackerLinkPanel'
import { type TrackerSyncLike, ticketLabelsFor } from './tracker-model'
import type { SourceTracker } from './use-tracker-link'

/**
 * The GitLab panel for a support ticket or a record, fed by useSourceTracker. Renders nothing
 * unless this person may create on a connection that syncs the kind (GitLab sync off, no such
 * connection, or not in its create roles = nothing); the read-only chip is SourceTrackerChips.
 */
export function SourceTrackerPanel({
  tracker,
  source,
  sourceTitle,
  fixedLabels,
  initialMode,
  onClose
}: {
  tracker: SourceTracker
  source: { kind: 'ticket' | 'record'; id: string }
  sourceTitle?: string | null
  fixedLabels?: (sync: TrackerSyncLike | undefined) => string[]
  initialMode?: TrackerPanelMode
  onClose?: () => void
}) {
  if (!tracker.canCreate) return null
  const chip = tracker.isAdmin ? null : (tracker.chips[0] ?? null)
  return (
    <TrackerLinkPanel
      source={source}
      admin={tracker.isAdmin}
      connections={tracker.connections}
      link={tracker.link}
      chip={chip}
      pending={tracker.failed}
      creating={tracker.creating}
      slow={tracker.slow}
      onCheckAgain={tracker.checkAgain}
      sourceTitle={sourceTitle}
      fixedLabels={fixedLabels}
      initialMode={initialMode}
      onClose={onClose}
      onCreated={tracker.markCreating}
      onChanged={tracker.refresh}
    />
  )
}

/**
 * A support ticket's GitLab block in the ticket sheet — for the people who work the ticket (the
 * host only mounts it for them); the requester sees the header chip only.
 */
export function TicketTrackerSection({
  tracker,
  ticket
}: {
  tracker: SourceTracker
  ticket: { id: number; title: string; priority?: string | null; status?: string | null }
}) {
  const fixed = useMemo(
    () => (sync: TrackerSyncLike | undefined) => ticketLabelsFor(ticket, sync),
    [ticket]
  )
  if (!tracker.canCreate) return null
  return (
    <section data-ticket-gitlab>
      <h3 className='mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
        <Gitlab className='h-3.5 w-3.5 text-orange-600 dark:text-orange-400' aria-hidden />
        GitLab
      </h3>
      <SourceTrackerPanel
        tracker={tracker}
        source={{ kind: 'ticket', id: String(ticket.id) }}
        sourceTitle={ticket.title}
        fixedLabels={fixed}
      />
    </section>
  )
}

/**
 * The record page's GitLab popover: opened from the record's ⋯ menu ("Create GitLab issue",
 * "Link GitLab issue", or an administrator's "GitLab issue #482"), anchored beside the More
 * button like the page's other helper surfaces — never a centred dialog.
 */
export function RecordTrackerPopover({
  tracker,
  recordId,
  recordLabel,
  mode,
  anchor,
  onOpenChange
}: {
  tracker: SourceTracker
  /** `<collection>:<id>` */
  recordId: string
  recordLabel?: string | null
  mode: TrackerPanelMode | null
  anchor: HTMLElement | null
  onOpenChange: (open: boolean) => void
}) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor])
  if (!mode || !tracker.canCreate) return null
  const title =
    mode === 'create'
      ? 'Create GitLab issue'
      : mode === 'link'
        ? 'Link GitLab issue'
        : 'GitLab issue'
  return (
    <Popover open onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as { current: HTMLElement }} />
      <PopoverContent
        align='end'
        role='dialog'
        aria-label={title}
        className='max-h-[min(80vh,640px)] w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain p-0'
        data-record-gitlab={mode}
      >
        <div className='px-4 pt-3.5'>
          <p className='flex items-center gap-1.5 text-[13.5px] font-semibold text-slate-900 dark:text-slate-100'>
            <Gitlab className='h-3.5 w-3.5 text-orange-600 dark:text-orange-400' aria-hidden />
            {title}
          </p>
          {recordLabel && (
            <p className='mt-0.5 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
              {recordLabel}
            </p>
          )}
        </div>
        <div className='px-4 pb-4 pt-3'>
          <SourceTrackerPanel
            tracker={tracker}
            source={{ kind: 'record', id: recordId }}
            sourceTitle={recordLabel}
            initialMode={mode}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

const MENU_ROW =
  'inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'

/**
 * The record ⋯ menu rows: "Create GitLab issue" / "Link GitLab issue", or an administrator's
 * "GitLab issue #482". The popover each opens sits beside the header button that stays on
 * screen (useHeaderAnchor) — the menu row closes with the click.
 */
export function RecordGitlabMenuEntries({
  tracker,
  onOpen
}: {
  tracker: SourceTracker
  onOpen: (mode: TrackerPanelMode, anchor: HTMLElement) => void
}) {
  const anchorOf = useHeaderAnchor()
  if (!tracker.canCreate) return null
  const open = (m: TrackerPanelMode) => (e: { currentTarget: HTMLElement }) =>
    onOpen(m, anchorOf() ?? e.currentTarget)
  if (tracker.link)
    return (
      <button
        type='button'
        data-nvr-menu-close
        data-record-gitlab-open
        data-tip='Resync, unlink or see what else is on it'
        onClick={open('idle')}
        className={MENU_ROW}
      >
        <Gitlab className='h-3.5 w-3.5' />
        GitLab issue #{tracker.link.iid}
      </button>
    )
  if (tracker.chips.length > 0 || tracker.creating) return null
  return (
    <>
      <button
        type='button'
        data-nvr-menu-close
        data-record-gitlab-create
        data-tip='Open a GitLab issue about this record'
        onClick={open('create')}
        className={MENU_ROW}
      >
        <Gitlab className='h-3.5 w-3.5' />
        Create GitLab issue
      </button>
      <button
        type='button'
        data-nvr-menu-close
        data-record-gitlab-link
        data-tip='Link a GitLab issue that already exists'
        onClick={open('link')}
        className={MENU_ROW}
      >
        <Link2 className='h-3.5 w-3.5' />
        Link GitLab issue
      </button>
    </>
  )
}

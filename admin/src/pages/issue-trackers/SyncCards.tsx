import { Check, ChevronsUpDown, Plus, Trash2, TriangleAlert, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { cn, formatDateTime } from '@/lib/utils'
import {
  duplicateLabels,
  type GitlabLabel,
  LANE_KEYS,
  type Role,
  SEVERITIES,
  type SyncOptions,
  TICKET_LANE_KEYS,
  TICKET_PRIORITIES
} from './api'
import { LabelPicker } from './LabelPicker'

type Patch = (patch: Partial<SyncOptions>) => void

// ── Building blocks ─────────────────────────────────────────────────────────

export function SettingsCard({
  title,
  hint,
  action,
  children,
  className
}: {
  title: string
  hint?: ReactNode
  /** A button beside the title (the card's own main action). */
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card',
        className
      )}
    >
      <div className='flex flex-wrap items-start justify-between gap-x-4 gap-y-2'>
        <div className='min-w-0 flex-1 basis-[260px]'>
          <h3 id={id} className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            {title}
          </h3>
          {hint && (
            <p className='mt-0.5 max-w-[68ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {hint}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Group({
  title,
  children,
  className
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-2.5', className)}>
      <h4 className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>{title}</h4>
      {children}
    </div>
  )
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
}) {
  const id = useId()
  return (
    <div className='flex items-start justify-between gap-4'>
      <div className='min-w-0'>
        <Label htmlFor={id} className='cursor-pointer text-[12px] font-medium'>
          {label}
        </Label>
        {hint && (
          <p className='mt-0.5 max-w-[60ch] text-[11px] text-slate-500 dark:text-muted-foreground'>
            {hint}
          </p>
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className='mt-0.5' />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div
      role='radiogroup'
      aria-label={ariaLabel}
      className='inline-flex h-8 max-w-full overflow-hidden rounded-md border border-slate-200 dark:border-border'
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: segmented control, same as SyncJobs direction
        <button
          key={o.value}
          type='button'
          role='radio'
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'border-r border-slate-200 px-3 text-[12px] font-medium transition-colors last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:border-border',
            value === o.value
              ? 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan'
              : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-muted/50'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function RolePicker({
  roles,
  value,
  onChange
}: {
  roles: Role[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const has = (id: string) => value.some((v) => v.toLowerCase() === id.toLowerCase())
  const nameOf = (id: string) =>
    roles.find((r) => r.id.toLowerCase() === id.toLowerCase())?.name ?? id
  return (
    <div className='flex min-h-8 max-w-xl flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1'>
      {value.map((id) => (
        <span
          key={id}
          className='inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 py-px pl-1.5 pr-0.5 text-[11.5px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
        >
          {nameOf(id)}
          <button
            type='button'
            aria-label={`Remove ${nameOf(id)}`}
            onClick={() => onChange(value.filter((v) => v !== id))}
            className='rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted dark:hover:text-slate-100'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            role='combobox'
            aria-expanded={open}
            aria-label='Roles that can create GitLab issues'
            className='inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
          >
            {value.length ? <Plus className='h-3 w-3' /> : null}
            {value.length ? 'Add role' : 'Admins only — add a role'}
            <ChevronsUpDown className='h-3 w-3 opacity-50' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-[260px] p-0' align='start'>
          <Command>
            <CommandInput placeholder='Find a role…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandEmpty className='px-3 py-4 text-center text-[12px] text-muted-foreground'>
                No role matches.
              </CommandEmpty>
              <CommandGroup>
                {roles.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={r.name}
                    onSelect={() =>
                      onChange(has(r.id) ? value.filter((v) => v !== r.id) : [...value, r.id])
                    }
                  >
                    <span className='flex-1 truncate text-[12px]'>{r.name}</span>
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 text-nvr-cyan',
                        has(r.id) ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

const LABEL_NAMES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  normal: 'Normal',
  urgent: 'Urgent',
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
  done: 'Done or cancelled'
}

// ── Sync options ────────────────────────────────────────────────────────────

type Recur = 'reopen' | 'join' | 'new'
const recurOf = (s: SyncOptions): Recur =>
  s.recur_when_closed === 'new' ? 'new' : s.reopen_on_recur ? 'reopen' : 'join'

/** The server keeps seen-again notes to one an hour (normalizeSync clamps to 60). */
const SEEN_NOTE_MIN_MINUTES = 60

/**
 * Minutes between seen-again notes. The box keeps what is typed; only a whole
 * number is written, so emptying the box to type a new value never saves 0.
 */
function SeenMinutes({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  // a save or discard brings a new value from outside: show it
  useEffect(() => {
    setText((t) => (Number(t) === value && t.trim() !== '' ? t : String(value)))
  }, [value])
  const n = Number(text)
  const short = text.trim() !== '' && Number.isFinite(n) && n < SEEN_NOTE_MIN_MINUTES
  return (
    <div className='space-y-1 pl-0.5'>
      <div className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
        <Label htmlFor='tracker-seen-minutes' className='text-[12px] font-normal'>
          At most one note every
        </Label>
        <Input
          id='tracker-seen-minutes'
          type='number'
          inputMode='numeric'
          min={SEEN_NOTE_MIN_MINUTES}
          step={15}
          value={text}
          aria-describedby={short ? 'tracker-seen-minutes-hint' : undefined}
          onChange={(e) => {
            const raw = e.target.value
            setText(raw)
            if (raw.trim() === '') return
            const v = Math.floor(Number(raw))
            if (Number.isFinite(v) && v >= 0) onChange(v)
          }}
          className='h-7 w-20 text-[12px] tabular-nums'
        />
        <span>minutes</span>
      </div>
      {short && (
        <p
          id='tracker-seen-minutes-hint'
          className='text-[11px] text-amber-800 dark:text-amber-300'
        >
          GitLab gets at most one note an hour — anything shorter is saved as 60 minutes.
        </p>
      )}
    </div>
  )
}

/**
 * Issues opened directly in GitLab → the issue log. Shown while the issue log syncs (off, the
 * switch would do nothing). The switch-on time is the server's: before the first save it says so.
 */
function ImportFromGitlab({
  sync,
  labels,
  unavailable,
  onChange
}: {
  sync: SyncOptions
  labels: GitlabLabel[] | undefined
  unavailable: string | null
  onChange: Patch
}) {
  const on = sync.import_new_issues
  return (
    <Group title='Issues opened in GitLab'>
      <SwitchRow
        label='Bring new GitLab issues into Nivaro'
        hint="Issues people open in the default project or a rule's project join the issue log, linked."
        checked={on}
        onChange={(v) => onChange({ import_new_issues: v })}
      />
      {on && (
        <div className='space-y-1.5' data-import-options>
          <LabelRow
            label='Only with the label'
            className='sm:grid-cols-[150px_minmax(12rem,26rem)]'
          >
            <LabelPicker
              ariaLabel='Only bring in GitLab issues with this label'
              placeholder='Any label'
              labels={labels}
              unavailable={unavailable}
              value={sync.import_label || undefined}
              onChange={(v) => onChange({ import_label: v ?? '' })}
            />
          </LabelRow>
          <p className='text-[11px] text-slate-500 dark:text-muted-foreground' data-import-since>
            {sync.import_since
              ? `Issues opened since ${formatDateTime(sync.import_since)}; adding the label brings in an older open one.`
              : 'Starts with issues opened after you save.'}
          </p>
        </div>
      )}
    </Group>
  )
}

export function SyncOptionsCard({
  sync,
  roles,
  labels,
  unavailable = null,
  onChange
}: {
  sync: SyncOptions
  roles: Role[]
  labels?: GitlabLabel[]
  unavailable?: string | null
  onChange: Patch
}) {
  const source = (k: keyof SyncOptions['sources'], v: boolean) =>
    onChange({ sources: { ...sync.sources, [k]: v } })
  return (
    <SettingsCard title='What syncs and how'>
      <Group title='What syncs'>
        <p className='-mt-1 max-w-[64ch] text-[11px] text-slate-500 dark:text-muted-foreground'>
          Each works on its own. One switched off gets no rules, no create or link and no sync.
        </p>
        <div className='space-y-2' data-sync-sources>
          {(
            [
              [
                'issue',
                'Issue log',
                'Errors and problems logged in Nivaro; rules can open issues.'
              ],
              [
                'ticket',
                'Support tickets',
                'Requests people raise; rules and the desk send them to GitLab.'
              ],
              ['record', 'Records', 'Any record; sent by hand from its ⋯ menu.']
            ] as const
          ).map(([k, label, hint]) => (
            <SwitchRow
              key={k}
              label={label}
              hint={hint}
              checked={sync.sources[k]}
              onChange={(v) => source(k, v)}
            />
          ))}
        </div>
      </Group>

      {sync.sources.issue && (
        <>
          <div className='border-t border-slate-100 dark:border-border' />
          <ImportFromGitlab
            sync={sync}
            labels={labels}
            unavailable={unavailable}
            onChange={onChange}
          />
        </>
      )}

      <div className='border-t border-slate-100 dark:border-border' />

      <Group title='Back and forth'>
        <SwitchRow
          label='Sync comments both ways'
          hint='Comments on a field stay in Nivaro.'
          checked={sync.comments}
          onChange={(v) => onChange({ comments: v })}
        />
        <SwitchRow
          label='Close the GitLab issue when it is resolved here'
          checked={sync.close_on_resolve}
          onChange={(v) => onChange({ close_on_resolve: v })}
        />
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <span className='text-[12px] font-medium'>When GitLab closes an issue, mark it</span>
          <Segmented
            ariaLabel='When GitLab closes an issue, mark it'
            value={sync.status_map.closed}
            options={[
              { value: 'resolved', label: 'Resolved' },
              { value: 'closed', label: 'Closed' }
            ]}
            onChange={(v) => onChange({ status_map: { closed: v } })}
          />
        </div>
        <SwitchRow
          label='Also change GitLab issues people wrote'
          hint='Off: on an issue Nivaro did not create it only adds comments — no closing, reopening or label changes.'
          checked={sync.push_to_linked}
          onChange={(v) => onChange({ push_to_linked: v })}
        />
      </Group>

      <div className='border-t border-slate-100 dark:border-border' />

      <Group title='When a problem comes back'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <span className='text-[12px] font-medium'>If its GitLab issue is closed</span>
          <Segmented<Recur>
            ariaLabel='If its GitLab issue is closed'
            value={recurOf(sync)}
            options={[
              { value: 'reopen', label: 'Reopen it' },
              { value: 'join', label: 'Note it, keep closed' },
              { value: 'new', label: 'Open a new issue' }
            ]}
            onChange={(v) =>
              onChange(
                v === 'new'
                  ? { recur_when_closed: 'new' }
                  : { recur_when_closed: 'reopen', reopen_on_recur: v === 'reopen' }
              )
            }
          />
        </div>
        <SwitchRow
          label='Add a note when it is seen again'
          checked={sync.seen_note}
          onChange={(v) => onChange({ seen_note: v })}
        />
        {sync.seen_note && (
          <SeenMinutes
            value={sync.seen_note_min_minutes}
            onChange={(n) => onChange({ seen_note_min_minutes: n })}
          />
        )}
      </Group>

      <div className='border-t border-slate-100 dark:border-border' />

      <Group title='Who can create GitLab issues from tickets and records'>
        <RolePicker
          roles={roles}
          value={sync.create_roles}
          onChange={(v) => onChange({ create_roles: v })}
        />
        <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Admins always can. People in these roles can send a ticket or record they may edit; the
          issue log stays admin-only.
        </p>
      </Group>
    </SettingsCard>
  )
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** Label pickers are sized to their labels, not to the page (long names wrap inside). */
const LABEL_ROW_COLS = 'sm:grid-cols-[150px_minmax(0,36rem)]'

function LabelRow({
  label,
  children,
  className
}: {
  label: string
  children: ReactNode
  /** The columns from `sm` up (default: a 150px name column and a picker up to 36rem). */
  className?: string
}) {
  return (
    <div className={cn('grid items-start gap-1.5 sm:gap-3', className ?? LABEL_ROW_COLS)}>
      <span className='pt-1.5 text-[12px] text-slate-600 dark:text-slate-300'>{label}</span>
      {children}
    </div>
  )
}

export function LabelsCard({
  sync,
  labels,
  unavailable,
  onChange
}: {
  sync: SyncOptions
  labels: GitlabLabel[] | undefined
  unavailable: string | null
  onChange: Patch
}) {
  const l = sync.labels
  const setLabels = (patch: Partial<SyncOptions['labels']>) =>
    onChange({ labels: { ...l, ...patch } })
  const [newSource, setNewSource] = useState('')
  const sources = Object.keys(l.by_source)
  const newKey = newSource.trim().toLowerCase().slice(0, 100)
  const duplicate = !!newKey && sources.includes(newKey)
  const addSource = () => {
    if (!newKey || duplicate) return
    const key = newKey
    setLabels({ by_source: { ...l.by_source, [key]: [] } })
    setNewSource('')
  }
  return (
    <SettingsCard
      title='Labels on new issues'
      hint='Added when Nivaro opens a GitLab issue. A name the project does not have is created in GitLab the first time it is used.'
    >
      <LabelRow label='Every issue'>
        <LabelPicker
          multi
          ariaLabel='Labels on every issue'
          labels={labels}
          unavailable={unavailable}
          value={l.always}
          onChange={(v) => setLabels({ always: v })}
        />
      </LabelRow>
      <Group title='By severity'>
        {SEVERITIES.map((s) => (
          <LabelRow key={s} label={LABEL_NAMES[s]}>
            <LabelPicker
              multi
              ariaLabel={`Labels for ${LABEL_NAMES[s]} severity`}
              labels={labels}
              unavailable={unavailable}
              value={l.by_severity[s] ?? []}
              onChange={(v) => {
                const next = { ...l.by_severity }
                if (v.length) next[s] = v
                else delete next[s]
                setLabels({ by_severity: next })
              }}
            />
          </LabelRow>
        ))}
      </Group>
      <Group title='By source'>
        {sources.length === 0 && (
          <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Add a source (the issue log's source, such as server or browser) to label its issues.
          </p>
        )}
        {sources.map((src) => (
          <div
            key={src}
            className='grid items-start gap-1.5 sm:grid-cols-[150px_minmax(0,36rem)_auto] sm:justify-start sm:gap-3'
          >
            <span className='truncate pt-1.5 font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
              {src}
            </span>
            <LabelPicker
              multi
              ariaLabel={`Labels for source ${src}`}
              labels={labels}
              unavailable={unavailable}
              value={l.by_source[src] ?? []}
              onChange={(v) => setLabels({ by_source: { ...l.by_source, [src]: v } })}
            />
            <Button
              type='button'
              variant='ghost'
              size='sm'
              aria-label={`Remove source ${src}`}
              className='h-8 px-2 text-slate-400 hover:text-red-600'
              onClick={() => {
                const next = { ...l.by_source }
                delete next[src]
                setLabels({ by_source: next })
              }}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </Button>
          </div>
        ))}
        <div className='flex flex-wrap items-center gap-2'>
          <Input
            aria-label='New source'
            aria-invalid={duplicate || undefined}
            aria-describedby={duplicate ? 'tracker-new-source-dupe' : undefined}
            value={newSource}
            placeholder='e.g. browser'
            maxLength={100}
            onChange={(e) => setNewSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addSource()
              }
            }}
            className='h-7 w-40 font-mono text-[12px]'
          />
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-7 gap-1 px-2 text-[11.5px]'
            disabled={!newKey || duplicate}
            onClick={addSource}
          >
            <Plus className='h-3 w-3' />
            Add source
          </Button>
          {duplicate && (
            <span
              id='tracker-new-source-dupe'
              role='alert'
              className='text-[11px] text-amber-800 dark:text-amber-300'
            >
              {newKey} already has its own row.
            </span>
          )}
        </div>
      </Group>
      <LabelRow label='When an example joins'>
        <LabelPicker
          multi
          ariaLabel='Labels added when an example joins'
          labels={labels}
          unavailable={unavailable}
          value={l.on_example}
          onChange={(v) => setLabels({ on_example: v })}
        />
      </LabelRow>
    </SettingsCard>
  )
}

// ── Priority & lanes ────────────────────────────────────────────────────────

function MapRows<K extends string>({
  keys,
  map,
  labels,
  unavailable,
  noun,
  onChange
}: {
  keys: readonly K[]
  map: Partial<Record<K, string>>
  labels: GitlabLabel[] | undefined
  unavailable: string | null
  noun: string
  onChange: (next: Partial<Record<K, string>>) => void
}) {
  return (
    <div className='space-y-2'>
      {keys.map((k) => (
        <LabelRow
          key={k}
          label={LABEL_NAMES[k] ?? k}
          className='sm:grid-cols-[7rem_minmax(12rem,26rem)]'
        >
          <LabelPicker
            ariaLabel={`GitLab label for ${noun} ${LABEL_NAMES[k] ?? k}`}
            labels={labels}
            unavailable={unavailable}
            value={map[k]}
            onChange={(v) => {
              const next = { ...map }
              if (v) next[k] = v
              else delete next[k]
              onChange(next)
            }}
          />
        </LabelRow>
      ))}
    </div>
  )
}

function DupeWarning({ dupes }: { dupes: string[] }) {
  if (!dupes.length) return null
  return (
    <p
      role='alert'
      className='flex items-start gap-1.5 text-[11.5px] text-amber-800 dark:text-amber-300'
    >
      <TriangleAlert className='mt-px h-3.5 w-3.5 shrink-0' />
      <span>
        {dupes.map((d) => `“${d}”`).join(', ')} {dupes.length === 1 ? 'is' : 'are'} used twice. A
        label coming back from GitLab can mean only one priority or lane — give each its own.
      </span>
    </p>
  )
}

/** A priority or lane column: as wide as its rows, so its Two-way switch sits beside them. */
const MAP_GROUP = 'max-w-[34rem]'

export function PriorityLanesCard({
  sync,
  labels,
  unavailable = null,
  onChange
}: {
  sync: SyncOptions
  labels: GitlabLabel[] | undefined
  unavailable?: string | null
  onChange: Patch
}) {
  const issueDupes = duplicateLabels(sync.priority_map, sync.lane_map)
  const ticketDupes = duplicateLabels(sync.ticket_priority_map, sync.ticket_lane_map)
  return (
    <SettingsCard
      title='Priority and lanes'
      hint='One GitLab label per priority and per status. The old one comes off when it changes.'
    >
      <div className='grid gap-6 lg:grid-cols-2'>
        <Group title='Priority' className={MAP_GROUP}>
          <MapRows
            keys={SEVERITIES}
            map={sync.priority_map}
            labels={labels}
            unavailable={unavailable}
            noun='priority'
            onChange={(v) => onChange({ priority_map: v })}
          />
          <SwitchRow
            label='Two-way'
            hint='A priority label changed in GitLab changes the priority here.'
            checked={sync.priority_two_way}
            onChange={(v) => onChange({ priority_two_way: v })}
          />
        </Group>
        <Group title='Lanes' className={MAP_GROUP}>
          <MapRows
            keys={LANE_KEYS}
            map={sync.lane_map}
            labels={labels}
            unavailable={unavailable}
            noun='status'
            onChange={(v) => onChange({ lane_map: v })}
          />
          <SwitchRow
            label='Two-way'
            hint='Moving an issue to a lane in GitLab changes its status here.'
            checked={sync.lanes_two_way}
            onChange={(v) => onChange({ lanes_two_way: v })}
          />
        </Group>
      </div>
      <DupeWarning dupes={issueDupes} />

      {sync.sources.ticket && (
        <>
          <div className='border-t border-slate-100 dark:border-border' />
          <h4 className='text-[12px] font-semibold text-slate-900 dark:text-foreground'>
            Support tickets
          </h4>
          <div className='grid gap-6 lg:grid-cols-2'>
            <Group title='Priority' className={MAP_GROUP}>
              <MapRows
                keys={TICKET_PRIORITIES}
                map={sync.ticket_priority_map}
                labels={labels}
                unavailable={unavailable}
                noun='ticket priority'
                onChange={(v) => onChange({ ticket_priority_map: v })}
              />
            </Group>
            <Group title='Lanes' className={MAP_GROUP}>
              <MapRows
                keys={TICKET_LANE_KEYS}
                map={sync.ticket_lane_map}
                labels={labels}
                unavailable={unavailable}
                noun='ticket status'
                onChange={(v) => onChange({ ticket_lane_map: v })}
              />
            </Group>
          </div>
          <DupeWarning dupes={ticketDupes} />
        </>
      )}
    </SettingsCard>
  )
}

// ── Similar tickets ─────────────────────────────────────────────────────────

const pct = (n: number) => `${Math.round(n * 100)}%`

function Slider({
  id,
  label,
  hint,
  value,
  onChange,
  disabled
}: {
  id: string
  label: string
  hint: string
  value: number
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <div className='space-y-1'>
      <div className='flex items-baseline justify-between gap-3'>
        <Label htmlFor={id} className='text-[12px] font-medium'>
          {label}
        </Label>
        <span className='text-[12px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
          {pct(value)}
        </span>
      </div>
      <input
        id={id}
        type='range'
        min={0.5}
        max={0.99}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className='h-1.5 w-full cursor-pointer accent-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'
      />
      <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
    </div>
  )
}

export function SimilarCard({ sync, onChange }: { sync: SyncOptions; onChange: Patch }) {
  const s = sync.similar
  const set = (patch: Partial<SyncOptions['similar']>) => {
    const next = { ...s, ...patch }
    // Suggesting can never need more likeness than joining.
    if (next.suggest_at > next.join_at) next.suggest_at = next.join_at
    onChange({ similar: next })
  }
  return (
    <SettingsCard
      title='Similar tickets'
      hint='Before a new GitLab issue is opened, Nivaro looks for an open one that reads the same.'
    >
      <SwitchRow
        label='Look for similar GitLab issues'
        checked={s.enabled}
        onChange={(v) => set({ enabled: v })}
      />
      <div className='grid gap-5 sm:grid-cols-2'>
        <Slider
          id='tracker-join-at'
          label='Join at'
          hint='At or above this, it joins the existing issue as an example instead of opening one.'
          value={s.join_at}
          disabled={!s.enabled}
          onChange={(v) => set({ join_at: v })}
        />
        <Slider
          id='tracker-suggest-at'
          label='Suggest at'
          hint='At or above this, people creating an issue by hand see it as a likely match.'
          value={s.suggest_at}
          disabled={!s.enabled}
          onChange={(v) => set({ suggest_at: Math.min(v, s.join_at) })}
        />
      </div>
    </SettingsCard>
  )
}

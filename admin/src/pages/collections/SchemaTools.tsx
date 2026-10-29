import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Circle,
  Database,
  FileText,
  Inbox,
  Plus,
  Share2,
  Sparkles,
  Waypoints,
  X
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ExplainButton } from '@/components/explain-button'
import { useOpenSchemaProposals } from '@/components/schema-proposals-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { type DBTableSummary, schemaApi } from '@/lib/schema-api'
import { cn } from '@/lib/utils'
import { matchesFilter } from './page-model'

/**
 * The data-model tools that used to live on the Data Model list page, now on
 * Collections for administrators (Rob 2026-10-29: one Collections page).
 */

export type SchemaPanel = 'create' | 'proposals' | 'describe' | null

/** "New table" + a "Data model" menu: ERD, Graph, Proposals, Design with AI, Describe. */
export function SchemaToolsMenu({
  onPanel,
  onDesign
}: {
  onPanel: (p: SchemaPanel) => void
  onDesign: () => void
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const waiting = useOpenSchemaProposals().data?.length ?? 0
  const item = (icon: ReactNode, text: string, onClick: () => void, extra?: ReactNode) => (
    <button
      type='button'
      onClick={() => {
        setOpen(false)
        onClick()
      }}
      className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/[0.06]'
    >
      <span className='text-slate-500 dark:text-slate-400'>{icon}</span>
      <span className='flex-1'>{text}</span>
      {extra}
    </button>
  )
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[12px] font-medium text-slate-600 hover:bg-slate-50 dark:border-white/[0.1] dark:text-slate-300 dark:hover:bg-white/[0.05]'
          >
            Data model
            {waiting > 0 && (
              <span
                className='inline-flex min-w-[16px] items-center justify-center rounded-full bg-nvr-cyan px-1 text-[10px] font-semibold text-white'
                data-tip={`${waiting} schema proposal${waiting === 1 ? '' : 's'} waiting`}
              >
                {waiting}
              </span>
            )}
            <ChevronDown className='h-3 w-3' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='end' className='w-56 p-1'>
          {item(<Share2 className='h-3.5 w-3.5' />, 'Entity diagram (ERD)', () =>
            navigate('/data-model/erd')
          )}
          {item(<Waypoints className='h-3.5 w-3.5' />, 'Relation graph', () =>
            navigate('/data-model/graph')
          )}
          {item(
            <Inbox className='h-3.5 w-3.5' />,
            'Schema proposals',
            () => onPanel('proposals'),
            waiting > 0 ? (
              <span className='text-[11px] tabular-nums text-nvr-cyan'>{waiting}</span>
            ) : null
          )}
          {item(<Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />, 'Design with AI', onDesign)}
          {item(<FileText className='h-3.5 w-3.5' />, 'Describe the data model', () =>
            onPanel('describe')
          )}
        </PopoverContent>
      </Popover>
      <Button size='sm' className='h-7 text-[12px]' onClick={() => onPanel('create')}>
        <Plus className='mr-1 h-3.5 w-3.5' /> New table
      </Button>
    </>
  )
}

/** Inline "Create table" — the new table opens in its editor. */
export function CreateTableInline({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: (n: string) => schemaApi.createTable({ name: n }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['data-model-tables'] })
      void qc.invalidateQueries({ queryKey: ['collections'] })
      toast.success(`Table "${result.data.name}" created`)
      navigate(`/data-model/${result.data.name}`)
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not create the table'
      )
  })
  return (
    <PanelShell title='New table' onClose={onClose}>
      <div className='flex flex-wrap items-end gap-2'>
        <div className='space-y-1'>
          <Label htmlFor='cl-new-table' className='text-[12px] font-medium'>
            Table name
          </Label>
          <Input
            id='cl-new-table'
            // biome-ignore lint/a11y/noAutofocus: the panel opens for this one field
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.length >= 2) create.mutate(name)
              if (e.key === 'Escape') onClose()
            }}
            placeholder='e.g. articles'
            className='h-8 w-64 font-mono text-[13px]'
          />
        </div>
        <Button
          size='sm'
          className='h-8'
          disabled={name.length < 2 || create.isPending}
          onClick={() => create.mutate(name)}
        >
          {create.isPending ? 'Creating…' : 'Create table'}
        </Button>
      </div>
      <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
        Lowercase letters, numbers and underscores. It opens in the editor, where you register it
        and add fields.
      </p>
    </PanelShell>
  )
}

export function DescribePanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title='Describe the data model' onClose={onClose}>
      <ExplainButton kind='data-model' params={{}} label='Describe again' autoRun />
    </PanelShell>
  )
}

export function PanelShell({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.03]'>
      <div className='mb-3 flex items-center justify-between'>
        <h2 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h2>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close'
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.06] dark:hover:text-slate-300'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {children}
    </section>
  )
}

/**
 * Tables the database has that are not collections: unregistered business
 * tables (open one to register it) and Nivaro's own system tables. Admin
 * only, collapsed by default, filtered by the page filter.
 */
export function OtherTablesSections({
  filter,
  collapsed,
  onToggle,
  renderSection
}: {
  filter: string
  collapsed: Record<string, boolean>
  onToggle: (key: string) => void
  renderSection: (args: {
    key: string
    label: string
    icon: ReactNode
    count: number
    open: boolean
    onToggle: () => void
    body: ReactNode
  }) => ReactNode
}) {
  const { data } = useQuery({
    queryKey: ['data-model-tables'],
    queryFn: schemaApi.listTables,
    staleTime: 60_000
  })
  const tables = (data?.data ?? []).filter(
    (t) =>
      !t.registered &&
      matchesFilter({ collection: t.name, display_name: t.display_name } as never, filter)
  )
  const unregistered = tables.filter((t) => !t.name.startsWith('nivaro_'))
  const system = tables.filter((t) => t.name.startsWith('nivaro_'))
  const narrowing = !!filter.trim()
  const list = (rows: DBTableSummary[]) => (
    <ul className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
      {rows.map((t) => (
        <li key={t.name}>
          <Link
            to={`/data-model/${encodeURIComponent(t.name)}`}
            className='flex items-center gap-2.5 px-4 py-1.5 text-[12.5px] transition-colors hover:bg-[#00ceff]/[0.04] dark:hover:bg-[#00ceff]/[0.06]'
          >
            <span className='min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-200'>
              {t.name}
            </span>
            <span className='text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
              {t.column_count} columns
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
  const section = (key: string, label: string, icon: ReactNode, rows: DBTableSummary[]) =>
    rows.length === 0
      ? null
      : renderSection({
          key,
          label,
          icon,
          count: rows.length,
          open: narrowing || !collapsed[key],
          onToggle: () => onToggle(key),
          body: list(rows)
        })
  return (
    <>
      {section(
        '__unregistered__',
        'Unregistered tables',
        <Circle className={cn('h-3 w-3 text-slate-400')} />,
        unregistered
      )}
      {section(
        '__system__',
        'System tables',
        <Database className='h-3 w-3 text-slate-400' />,
        system
      )}
    </>
  )
}

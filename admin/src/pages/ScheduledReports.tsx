import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  Clock,
  FileDown,
  Loader2,
  Mail,
  Plus,
  Send,
  Trash2
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface ScheduledReport {
  id: number
  name: string
  report_type: 'collection' | 'queue'
  collection: string | null
  queue_id: string | null
  recipients: string[]
  cron_schedule: string
  orientation: string
  row_limit: number
  is_active: boolean
  last_run_at: string | null
  last_run_status: string | null
}

function TargetCombobox({
  value,
  onChange,
  options,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          className='h-8 w-48 justify-between px-2 text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty>No matches</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === o.value ? 'opacity-100' : 'opacity-0')}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const CRON_PRESETS = [
  { label: 'Daily 8am', value: '0 8 * * *' },
  { label: 'Weekdays 8am', value: '0 8 * * 1-5' },
  { label: 'Mondays 8am', value: '0 8 * * 1' },
  { label: 'First of month', value: '0 8 1 * *' }
]

export function ScheduledReportsPage() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<'collection' | 'queue'>('collection')
  const [target, setTarget] = useState('')
  const [recipients, setRecipients] = useState('')
  const [cron, setCron] = useState('0 8 * * 1-5')
  const [landscape, setLandscape] = useState(false)

  const { data: reports = [], isLoading } = useQuery({
    queryKey: ['scheduled-reports'],
    queryFn: () =>
      api.get<{ data: ScheduledReport[] }>('/scheduled-reports').then((r) => r.data.data)
  })
  const { data: collections = [] } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections?tables_only=true')
        .then((r) => r.data.data)
  })
  const { data: queues = [] } = useQuery({
    queryKey: ['queues'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; name: string }> }>('/queues').then((r) => r.data.data)
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['scheduled-reports'] })

  const create = useMutation({
    mutationFn: () =>
      api.post('/scheduled-reports', {
        name,
        report_type: type,
        collection: type === 'collection' ? target : null,
        queue_id: type === 'queue' ? target : null,
        recipients: recipients
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
        cron_schedule: cron,
        orientation: landscape ? 'landscape' : 'portrait'
      }),
    onSuccess: () => {
      invalidate()
      setCreating(false)
      setName('')
      setTarget('')
      setRecipients('')
      toast.success('Report scheduled — cron activates on next server restart, or use Send now')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to create report')
    }
  })

  const toggle = useMutation({
    mutationFn: (r: ScheduledReport) =>
      api.patch(`/scheduled-reports/${r.id}`, { is_active: !r.is_active }),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/scheduled-reports/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Report deleted')
    }
  })
  const runNow = useMutation({
    mutationFn: (id: number) => api.post(`/scheduled-reports/${id}/run`),
    onSuccess: () => {
      invalidate()
      toast.success('Report sent')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Send failed')
    }
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <FileDown className='h-4 w-4 text-nvr-cyan' />
            <div>
              <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
                Scheduled Reports
              </h1>
              <p className='text-[12px] text-muted-foreground'>
                PDF snapshots of collections or queues, emailed on a schedule.
              </p>
            </div>
          </div>
          <Button size='sm' onClick={() => setCreating((v) => !v)}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New report
          </Button>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-8 dark:bg-background'>
        <div className='mx-auto max-w-3xl space-y-4'>
          {creating && (
            <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
              <div className='flex flex-wrap items-end gap-3'>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>Name</p>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className='h-8 w-52 text-[13px]'
                    placeholder='Weekly open items'
                  />
                </div>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>Source</p>
                  <div className='flex items-center rounded-lg border border-slate-200 p-0.5 dark:border-border'>
                    {(['collection', 'queue'] as const).map((t) => (
                      <button
                        key={t}
                        type='button'
                        onClick={() => {
                          setType(t)
                          setTarget('')
                        }}
                        className={cn(
                          'h-7 rounded-md px-2.5 text-[11px] font-medium capitalize',
                          type === t
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-400 hover:text-slate-700'
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>
                    {type === 'collection' ? 'Collection' : 'Queue'}
                  </p>
                  <TargetCombobox
                    value={target}
                    onChange={setTarget}
                    options={
                      type === 'collection'
                        ? collections
                            .filter((c) => !c.collection.startsWith('nivaro_'))
                            .map((c) => ({ value: c.collection, label: c.collection }))
                        : queues.map((q) => ({ value: q.id, label: q.name }))
                    }
                    placeholder={type === 'collection' ? 'Select collection…' : 'Select queue…'}
                  />
                </div>
              </div>
              <div className='flex flex-wrap items-end gap-3'>
                <div className='min-w-64 flex-1'>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>
                    Recipients (comma-separated)
                  </p>
                  <Input
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                    className='h-8 text-[13px]'
                    placeholder='ops@company.com, cfo@company.com'
                  />
                </div>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>Schedule (cron)</p>
                  <div className='flex items-center gap-1.5'>
                    <Input
                      value={cron}
                      onChange={(e) => setCron(e.target.value)}
                      className='h-8 w-32 font-mono text-[12px]'
                    />
                    {CRON_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type='button'
                        onClick={() => setCron(p.value)}
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-medium',
                          cron === p.value
                            ? 'bg-[#00ceff1a] text-nvr-navy dark:text-[#00ceff]'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-muted'
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className='flex items-center gap-2 pb-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                  <Switch checked={landscape} onCheckedChange={setLandscape} /> Landscape
                </label>
                <Button
                  size='sm'
                  disabled={
                    !name.trim() || !target.trim() || !recipients.trim() || create.isPending
                  }
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </div>
          )}

          {isLoading ? (
            <p className='text-[13px] text-slate-400'>Loading…</p>
          ) : reports.length === 0 && !creating ? (
            <div className='rounded-xl border-2 border-dashed border-slate-200 py-16 text-center dark:border-border'>
              <Mail className='mx-auto h-8 w-8 text-slate-300' />
              <p className='mt-3 text-[13px] font-medium text-slate-500'>No scheduled reports</p>
              <p className='mt-1 text-[12px] text-slate-400'>
                Email a PDF snapshot of any collection or queue on a cron.
              </p>
            </div>
          ) : (
            <div className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
              {reports.map((r) => (
                <div key={r.id} className='flex items-center gap-3 px-4 py-3'>
                  <Switch checked={r.is_active} onCheckedChange={() => toggle.mutate(r)} />
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-200'>
                      {r.name}
                    </p>
                    <p className='truncate text-[11px] text-slate-400'>
                      {r.report_type === 'queue' ? `queue ${r.queue_id}` : r.collection} ·{' '}
                      <Clock className='inline h-3 w-3' /> <code>{r.cron_schedule}</code> ·{' '}
                      {r.recipients.length} recipient{r.recipients.length !== 1 ? 's' : ''}
                      {r.last_run_at &&
                        ` · last run ${formatRelative(r.last_run_at)} (${r.last_run_status})`}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={runNow.isPending}
                    onClick={() => runNow.mutate(r.id)}
                  >
                    {runNow.isPending && runNow.variables === r.id ? (
                      <Loader2 className='mr-1 h-3 w-3 animate-spin' />
                    ) : (
                      <Send className='mr-1 h-3 w-3' />
                    )}
                    Send now
                  </Button>
                  <button
                    type='button'
                    onClick={() => remove.mutate(r.id)}
                    className='rounded p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500'
                    aria-label='Delete report'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

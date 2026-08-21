import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Play } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronsUpDown } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Automation Tests — saved regression cases for flows: a payload dry-runs the
 * flow (side-effect ops render, never send) and expectations assert against
 * the trace. Run one or the whole suite; red/green per test.
 */

interface AutoTest {
  id: number
  name: string
  flow_id: string
  flow_name: string | null
  payload: Record<string, unknown> | null
  expectations: Record<string, unknown> | null
  is_active: boolean
  last_status: 'pass' | 'fail' | null
  last_run_at: string | null
  last_detail: string | null
}

function FlowCombobox({
  value,
  onChange,
  options,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 text-[12.5px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.label}
                  onSelect={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'

export default function AutomationTests() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [flowId, setFlowId] = useState('')
  const [payloadText, setPayloadText] = useState('{}')
  const [expectationsText, setExpectationsText] = useState(
    '{\n  "no_errors": true,\n  "preview_contains": []\n}'
  )
  const [runningId, setRunningId] = useState<number | 'suite' | null>(null)

  const { data: tests = [] } = useQuery<AutoTest[]>({
    queryKey: ['automation-tests'],
    queryFn: () => api.get('/automation-tests').then((r) => r.data.data)
  })
  const { data: flows = [] } = useQuery<Array<{ id: string; name: string; status: string }>>({
    queryKey: ['automation-flows'],
    queryFn: () => api.get('/flows').then((r) => r.data.data ?? [])
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['automation-tests'] })

  const create = useMutation({
    mutationFn: () => {
      let payload: unknown
      let expectations: unknown
      try {
        payload = JSON.parse(payloadText)
      } catch {
        throw new Error('Payload is not valid JSON')
      }
      try {
        expectations = JSON.parse(expectationsText)
      } catch {
        throw new Error('Expectations is not valid JSON')
      }
      return api.post('/automation-tests', { name, flow_id: flowId, payload, expectations })
    },
    onSuccess: () => {
      setShowCreate(false)
      setName('')
      invalidate()
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message)
  })
  const patchTest = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/automation-tests/${id}`, body),
    onSuccess: invalidate
  })
  const removeTest = useMutation({
    mutationFn: (id: number) => api.delete(`/automation-tests/${id}`),
    onSuccess: invalidate
  })

  const runOne = async (id: number) => {
    setRunningId(id)
    try {
      const r = await api.post(`/automation-tests/${id}/run`)
      const res = r.data.data as { status: string; detail: string }
      ;(res.status === 'pass' ? toast.success : toast.error)(res.detail, { duration: 8000 })
    } finally {
      setRunningId(null)
      invalidate()
    }
  }
  const runSuite = async () => {
    setRunningId('suite')
    try {
      const r = await api.post('/automation-tests/run')
      const d = r.data.data as { total: number; failed: number }
      ;(d.failed === 0 ? toast.success : toast.error)(
        `${d.total - d.failed}/${d.total} passed${d.failed ? ` — ${d.failed} failing` : ''}`,
        { duration: 10000 }
      )
    } finally {
      setRunningId(null)
      invalidate()
    }
  }

  const failing = tests.filter((t) => t.is_active && t.last_status === 'fail').length

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <FlaskConical className='h-5 w-5 text-muted-foreground' />
            <div>
              <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Automation Tests
              </h1>
              <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                Saved regression cases for flows — each dry-runs with a fixed payload and asserts
                against the trace. Run the suite after any deploy or flow edit.
              </p>
            </div>
          </div>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={() => setShowCreate((v) => !v)}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-600 hover:border-slate-300 dark:border-border dark:text-muted-foreground'
            >
              {showCreate ? 'Close' : '＋ New test'}
            </button>
            <button
              type='button'
              disabled={runningId != null || tests.filter((t) => t.is_active).length === 0}
              onClick={() => void runSuite()}
              className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
            >
              <Play className='h-3.5 w-3.5' strokeWidth={2} />
              {runningId === 'suite' ? 'Running…' : 'Run suite'}
            </button>
          </div>
        </div>
      </header>

      <div className='flex-1 space-y-3 overflow-y-auto p-6'>
        {failing > 0 && (
          <div className='rounded-lg border border-red-200 bg-red-50/60 px-4 py-2.5 text-[12.5px] font-medium text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400'>
            {failing} test{failing === 1 ? '' : 's'} failing
          </div>
        )}

        {showCreate && (
          <div className='max-w-[760px] rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Test name' className={inputCls} />
              <FlowCombobox
                value={flowId}
                onChange={setFlowId}
                options={flows.map((f) => ({
                  value: f.id,
                  label: `${f.name}${f.status !== 'active' ? ' (inactive)' : ''}`
                }))}
                placeholder='Pick a flow…'
              />
            </div>
            <p className='mt-2 text-[11px] text-slate-400'>Trigger payload (what the flow receives):</p>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              rows={4}
              className='mt-1 w-full rounded-md border border-slate-200 bg-background px-2.5 py-2 font-mono text-[11.5px] dark:border-border'
            />
            <p className='mt-2 text-[11px] text-slate-400'>
              Expectations — no_errors, min_steps, op_statuses {'{key: "resolve"}'},
              preview_contains [strings], output_contains [{'{path, value}'}]:
            </p>
            <textarea
              value={expectationsText}
              onChange={(e) => setExpectationsText(e.target.value)}
              rows={5}
              className='mt-1 w-full rounded-md border border-slate-200 bg-background px-2.5 py-2 font-mono text-[11.5px] dark:border-border'
            />
            <button
              type='button'
              disabled={!name.trim() || !flowId || create.isPending}
              onClick={() => create.mutate()}
              className='mt-2.5 h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
            >
              Create test
            </button>
          </div>
        )}

        {tests.length === 0 && !showCreate && (
          <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-border'>
            <p className='text-[13px] font-medium text-slate-600 dark:text-foreground'>No tests yet</p>
            <p className='mt-1 text-[12px] text-slate-400'>
              Save a regression case for a critical flow (the MDSi push, owner notifications) so a
              deploy can't silently break it.
            </p>
          </div>
        )}
        <div className='space-y-1.5'>
          {tests.map((t) => (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border bg-white px-4 py-2.5 dark:bg-card',
                t.last_status === 'fail' && t.is_active
                  ? 'border-red-200 dark:border-red-500/30'
                  : 'border-slate-200 dark:border-border',
                !t.is_active && 'opacity-60'
              )}
            >
              <span
                className={cn(
                  'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
                  t.last_status === 'pass'
                    ? 'bg-emerald-500'
                    : t.last_status === 'fail'
                      ? 'bg-red-500'
                      : 'bg-slate-300'
                )}
              />
              <div className='min-w-0 flex-1'>
                <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {t.name}
                  <Link
                    to={`/flows/${t.flow_id}`}
                    className='ml-2 text-[11.5px] font-normal text-slate-400 underline decoration-dotted underline-offset-2 hover:text-nvr-cyan'
                  >
                    {t.flow_name ?? 'flow'}
                  </Link>
                </p>
                <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {t.last_detail ?? 'Never run'}
                  {t.last_run_at && (
                    <span className='ml-1.5 text-[11px] text-slate-400'>
                      · {new Date(t.last_run_at).toLocaleString()}
                    </span>
                  )}
                </p>
              </div>
              <div className='flex shrink-0 items-center gap-2'>
                <button
                  type='button'
                  disabled={runningId != null}
                  onClick={() => void runOne(t.id)}
                  className='inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-600 hover:border-slate-300 disabled:opacity-50 dark:border-border dark:text-muted-foreground'
                >
                  <Play className='h-3 w-3' strokeWidth={2} />
                  {runningId === t.id ? 'Running…' : 'Run'}
                </button>
                <button
                  type='button'
                  onClick={() => patchTest.mutate({ id: t.id, body: { is_active: !t.is_active } })}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    t.is_active
                      ? 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400'
                      : 'border-slate-200 text-slate-400 dark:border-border'
                  )}
                >
                  {t.is_active ? 'Active' : 'Off'}
                </button>
                <button
                  type='button'
                  onClick={() => {
                    if (window.confirm(`Delete test "${t.name}"?`)) removeTest.mutate(t.id)
                  }}
                  className='text-[13px] text-slate-300 hover:text-red-500'
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

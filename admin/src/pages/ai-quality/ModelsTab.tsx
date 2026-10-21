import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Chip, cardCls, Empty, ErrorNote, errMsg, Loading, money, tdCls, thCls } from './shared'

interface Trial {
  at: string
  baseline_model: string
  skipped?: string
  compare?: Array<{
    model: string
    text?: string
    error?: string
    cost_usd: number | null
    latency_ms: number
  }>
  replay?: {
    model: string
    done: number
    total: number
    items: Array<{
      question: string
      original: string
      replay: string
      original_cost: number | null
      replay_cost: number | null
      error?: string
    }>
  }
}
interface Model {
  model_id: string
  source: string
  status: 'available' | 'retired'
  first_seen: string
  last_seen: string
  retired_at: string | null
  trial_at: string | null
  trial: Trial | null
}
interface Data {
  ready: boolean
  settings: { enabled: boolean; auto_trial: boolean; auto_trial_max_usd: number }
  last_check: {
    at: string
    source: string
    checked: number
    new_models: string[]
    retired_models: string[]
    note?: string
  } | null
  models: Model[]
}

const day = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—')
const FRESH_MS = 14 * 86_400_000

export function ModelsTab() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['ai-quality', 'catalogue'],
    queryFn: async () => (await api.get('/ai/catalogue')).data.data as Data
  })
  const inUse = useQuery({
    queryKey: ['ai-quality', 'config'],
    queryFn: async () => (await api.get('/ai/quality/config')).data.data as { models: string[] }
  })
  const set = useMutation({
    mutationFn: async (catalogue: Partial<Data['settings']>) =>
      api.put('/ai/spend/settings', { catalogue }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-quality', 'catalogue'] }),
    onError: (e) => toast.error(errMsg(e))
  })
  const check = useMutation({
    mutationFn: async () => api.post('/ai/catalogue/check'),
    onSuccess: () => {
      toast.success('Checking now. A new model also runs its side-by-side, which takes a minute.')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-quality', 'catalogue'] }), 8000)
    },
    onError: (e) => toast.error(errMsg(e))
  })
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const used = new Set(inUse.data?.models ?? [])
  return (
    <div className='space-y-4'>
      <div className={cn(cardCls, 'space-y-3 text-[12px]')}>
        <div className='flex flex-wrap items-center gap-3'>
          <Switch
            checked={d.settings.enabled}
            onCheckedChange={(v) => set.mutate({ enabled: v })}
            aria-label='Nightly model check'
          />
          <span className='font-medium'>Nightly check of the models the provider offers</span>
          <Button
            size='sm'
            variant='outline'
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            Check now
          </Button>
        </div>
        <p className='text-slate-500 dark:text-muted-foreground'>
          Uses the provider’s model list where it has one, otherwise a one-token probe per model we
          know of. Nothing here ever switches a model: a new one just gets compared so you can see
          it side by side first, and a retired one still in the settings raises a readiness warning.
        </p>
        <div className='flex flex-wrap items-center gap-3'>
          <Switch
            checked={d.settings.auto_trial}
            onCheckedChange={(v) => set.mutate({ auto_trial: v })}
            aria-label='Compare new models automatically'
          />
          <span>
            Compare a new model automatically (Compare, plus a replay of 5 saved questions)
          </span>
        </div>
        {d.last_check && (
          <p>
            Last check {new Date(d.last_check.at).toLocaleString()}: {d.last_check.checked} model(s)
            via {d.last_check.source}; {d.last_check.new_models.length} new,{' '}
            {d.last_check.retired_models.length} retired.
            {d.last_check.note ? ` ${d.last_check.note}` : ''}
          </p>
        )}
      </div>

      {!d.ready ? (
        <Empty>The catalogue starts after the latest database update has run.</Empty>
      ) : d.models.length === 0 ? (
        <Empty>No check has run yet. Use Check now, or wait for tonight.</Empty>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full text-[12px]'>
            <thead className='border-b border-slate-200 dark:border-border'>
              <tr>
                <th className={thCls}>Model</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>First seen</th>
                <th className={thCls}>Last seen</th>
                <th className={thCls}>Side-by-side</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {d.models.map((m) => {
                const fresh = Date.now() - new Date(m.first_seen).getTime() < FRESH_MS
                return (
                  <ModelRow
                    key={m.model_id}
                    m={m}
                    fresh={fresh}
                    inUse={used.has(m.model_id)}
                    open={open === m.model_id}
                    toggle={() => setOpen(open === m.model_id ? null : m.model_id)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ModelRow({
  m,
  fresh,
  inUse,
  open,
  toggle
}: {
  m: Model
  fresh: boolean
  inUse: boolean
  open: boolean
  toggle: () => void
}) {
  return (
    <>
      <tr>
        <td className={cn(tdCls, 'font-mono')}>
          {m.model_id} {inUse && <Chip tone='neutral'>in use</Chip>}
        </td>
        <td className={tdCls}>
          {m.status === 'retired' ? (
            <Chip tone={inUse ? 'bad' : 'warn'}>retired {day(m.retired_at)}</Chip>
          ) : fresh ? (
            <Chip tone='good'>new</Chip>
          ) : (
            <Chip tone='neutral'>offered</Chip>
          )}
        </td>
        <td className={tdCls}>{day(m.first_seen)}</td>
        <td className={tdCls}>{day(m.last_seen)}</td>
        <td className={tdCls}>
          {m.trial ? (
            <button
              type='button'
              className='text-nvr-navy underline dark:text-nvr-cyan'
              onClick={toggle}
            >
              {open ? 'Hide' : m.trial.skipped ? 'Why skipped' : 'View'}
            </button>
          ) : (
            <span className='text-slate-400'>—</span>
          )}
        </td>
      </tr>
      {open && m.trial && (
        <tr>
          <td colSpan={5} className='bg-slate-50 px-3 py-3 dark:bg-background'>
            <TrialView t={m.trial} />
          </td>
        </tr>
      )}
    </>
  )
}

function TrialView({ t }: { t: Trial }) {
  return (
    <div className='space-y-3 text-[12px]'>
      <p className='text-slate-500 dark:text-muted-foreground'>
        Run {new Date(t.at).toLocaleString()} against {t.baseline_model}.
      </p>
      {t.compare && (
        <div className='grid gap-3 md:grid-cols-2'>
          {t.compare.map((c) => (
            <div key={c.model} className={cn(cardCls, 'space-y-1')}>
              <p className='font-mono font-medium'>{c.model}</p>
              <p className='text-slate-500 dark:text-muted-foreground'>
                {c.latency_ms} ms · {money(c.cost_usd)}
              </p>
              <p className='whitespace-pre-wrap'>{c.error ? `Failed: ${c.error}` : c.text}</p>
            </div>
          ))}
        </div>
      )}
      {t.skipped && (
        <p className='text-amber-700 dark:text-amber-400'>Replay skipped. {t.skipped}</p>
      )}
      {t.replay && (
        <div className='space-y-2'>
          <p className='font-medium'>
            Replay of {t.replay.done} of {t.replay.total} saved questions on{' '}
            <span className='font-mono'>{t.replay.model}</span>
          </p>
          {t.replay.items.map((i, n) => (
            <div key={n} className={cn(cardCls, 'space-y-2')}>
              <p className='font-medium'>{i.question}</p>
              <div className='grid gap-3 md:grid-cols-2'>
                <div>
                  <p className='text-slate-500 dark:text-muted-foreground'>
                    Now · {money(i.original_cost)}
                  </p>
                  <p className='whitespace-pre-wrap'>{i.original || '—'}</p>
                </div>
                <div>
                  <p className='text-slate-500 dark:text-muted-foreground'>
                    New model · {money(i.replay_cost)}
                  </p>
                  <p className='whitespace-pre-wrap'>
                    {i.error ? `Failed: ${i.error}` : i.replay || '—'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ToggleLeft, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'

// Feature flags (#651): ship features dark, turn them on per role or as a
// stable percentage rollout. Clients read GET /feature-flags/mine; this page
// is the admin registry.

interface Flag {
  id: number
  key: string
  label: string | null
  description: string | null
  enabled: boolean
  role_ids: string[]
  percentage: number | null
}
interface Role {
  id: string
  name: string
}

export function FeatureFlagsPage() {
  const qc = useQueryClient()
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const { data: flags = [] } = useQuery({
    queryKey: ['feature-flags'],
    queryFn: () => api.get<{ data: Flag[] }>('/feature-flags').then((r) => r.data.data)
  })
  const { data: roles = [] } = useQuery({
    queryKey: ['roles-lite'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['feature-flags'] })

  const create = useMutation({
    mutationFn: () => api.post('/feature-flags', { key: newKey.trim(), label: newLabel.trim() || null }),
    onSuccess: () => {
      setNewKey('')
      setNewLabel('')
      invalidate()
      toast.success('Flag created (off by default)')
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Create failed'
      )
  })
  const patch = useMutation({
    mutationFn: (p: { id: number } & Record<string, unknown>) =>
      api.patch(`/feature-flags/${p.id}`, p),
    onSuccess: invalidate,
    onError: () => toast.error('Update failed')
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/feature-flags/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Flag deleted')
    }
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2'>
          <ToggleLeft className='h-4 w-4 text-nvr-cyan' />
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            Feature Flags
          </h1>
        </div>
        <p className='mt-0.5 max-w-[72ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Ship features dark and turn them on per role or as a gradual percentage. Clients read
          their effective set from <code className='font-mono text-[11.5px]'>/feature-flags/mine</code>.
        </p>
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto p-6'>
        <div className='mb-4 flex flex-wrap items-end gap-2'>
          <div>
            <p className='mb-1 text-[11px] font-medium text-slate-500'>Key</p>
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder='new_dashboard'
              className='h-8 w-52 font-mono text-[12.5px]'
            />
          </div>
          <div>
            <p className='mb-1 text-[11px] font-medium text-slate-500'>Label</p>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder='New dashboard experience'
              className='h-8 w-64 text-[12.5px]'
            />
          </div>
          <Button
            size='sm'
            disabled={!newKey.trim() || create.isPending}
            onClick={() => create.mutate()}
            className='h-8'
          >
            <Plus className='mr-1 h-3.5 w-3.5' /> Add flag
          </Button>
        </div>

        {flags.length === 0 ? (
          <p className='text-[12.5px] text-slate-400'>
            No flags yet — add one and reference it from client code before shipping the feature.
          </p>
        ) : (
          <div className='space-y-2'>
            {flags.map((f) => (
              <div
                key={f.id}
                className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
              >
                <div className='flex flex-wrap items-center gap-3'>
                  <Switch
                    checked={f.enabled}
                    onCheckedChange={(v) => patch.mutate({ id: f.id, enabled: v })}
                  />
                  <code className='font-mono text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
                    {f.key}
                  </code>
                  {f.label && (
                    <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                      {f.label}
                    </span>
                  )}
                  {f.percentage != null && f.percentage < 100 && (
                    <Badge>{f.percentage}% rollout</Badge>
                  )}
                  <button
                    type='button'
                    onClick={() => remove.mutate(f.id)}
                    className='ml-auto rounded p-1 text-slate-400 hover:text-red-500'
                    aria-label='Delete flag'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-2'>
                  <div className='flex items-center gap-1.5'>
                    <span className='text-[11px] text-slate-500'>Rollout %</span>
                    <Input
                      type='number'
                      min={0}
                      max={100}
                      defaultValue={f.percentage ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        patch.mutate({ id: f.id, percentage: v === '' ? null : Number(v) })
                      }}
                      placeholder='all'
                      className='h-7 w-20 text-[12px] tabular-nums'
                    />
                  </div>
                  <div className='flex flex-wrap items-center gap-1.5'>
                    <span className='text-[11px] text-slate-500'>Roles</span>
                    {roles.map((r) => {
                      const on = f.role_ids.includes(r.id)
                      return (
                        <button
                          key={r.id}
                          type='button'
                          onClick={() =>
                            patch.mutate({
                              id: f.id,
                              role_ids: on
                                ? f.role_ids.filter((x) => x !== r.id)
                                : [...f.role_ids, r.id]
                            })
                          }
                          className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                            on
                              ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border'
                          }`}
                        >
                          {r.name}
                        </button>
                      )
                    })}
                    {f.role_ids.length === 0 && (
                      <span className='text-[11px] text-slate-400'>every role</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

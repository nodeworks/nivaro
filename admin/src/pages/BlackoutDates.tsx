import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarOff, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type BlackoutDate = {
  id: string
  date: string
  label: string
  scope: string[] | null
}

// ─── Predefined scopes ──────────────────────────────────────────────────────────
// Mirrors GET /api/blackout-dates/scopes. Stable list, hardcoded for the UI.

const PREDEFINED_SCOPES = [
  { value: 'mdsi', label: 'MDSi Delivery', description: 'MDSi order delivery scheduling' },
  { value: 'flows', label: 'Scheduled Flows', description: 'Prevents flow execution on this date' },
  { value: 'pipeline', label: 'Pipeline Processing', description: 'Pipeline state resolution' },
  {
    value: 'workflow',
    label: 'Workflow Auto-Advance',
    description: 'Workflow condition evaluation'
  }
]

// ─── Main page ────────────────────────────────────────────────────────────────

export function BlackoutDatesPage() {
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [form, setForm] = useState({ date: '', label: '' })
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['blackout-dates'],
    queryFn: () => api.get('/blackout-dates').then((r) => r.data)
  })

  const dates: BlackoutDate[] = data?.data ?? []

  const create = useMutation({
    mutationFn: (body: { date: string; label: string; scope: string[] }) =>
      api.post('/blackout-dates', body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blackout-dates'] })
      setForm({ date: '', label: '' })
      setSelectedScopes([])
      toast.success('Blackout date added')
    },
    onError: () => toast.error('Failed to add blackout date')
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/blackout-dates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blackout-dates'] })
      setPendingDelete(null)
      toast.success('Blackout date removed')
    },
    onError: () => toast.error('Failed to remove blackout date')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.date || !form.label.trim()) {
      toast.error('Date and label are required')
      return
    }
    create.mutate({ date: form.date, label: form.label, scope: selectedScopes })
  }

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center gap-3'>
          <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>
            Blackout Dates
          </h1>
          {data && (
            <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'>
              {dates.length}
            </span>
          )}
        </div>
      </div>

      <div className='p-8'>
        <div className='grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]'>
          {/* List */}
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            {isLoading ? (
              <div className='divide-y divide-slate-100'>
                {(['a', 'b', 'c'] as const).map((k) => (
                  <div key={k} className='flex items-center gap-4 px-5 py-4'>
                    <Skeleton className='h-4 w-24' />
                    <Skeleton className='h-4 w-40' />
                  </div>
                ))}
              </div>
            ) : isError ? (
              <div className='py-20 text-center text-[13px] text-red-500'>
                Failed to load blackout dates.
              </div>
            ) : dates.length === 0 ? (
              <div className='flex flex-col items-center justify-center py-20'>
                <div className='flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100'>
                  <CalendarOff className='h-8 w-8 text-slate-400' />
                </div>
                <h3 className='mt-4 text-[15px] font-semibold text-slate-700'>No blackout dates</h3>
                <p className='mt-1.5 text-[13px] text-slate-400'>
                  Add dates on which actions should be blocked.
                </p>
              </div>
            ) : (
              <table className='w-full text-left'>
                <thead>
                  <tr className='border-b border-slate-100 bg-slate-50'>
                    <th className='px-5 py-2.5 text-[11px] font-medium text-slate-500'>Date</th>
                    <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Label</th>
                    <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Scope</th>
                    <th className='w-16 px-5 py-2.5' />
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100'>
                  {dates.map((d) => (
                    <tr key={d.id} className='group hover:bg-slate-50'>
                      <td className='px-5 py-3.5 text-[13px] font-medium text-slate-800'>
                        {d.date ? formatDate(d.date) : '—'}
                      </td>
                      <td className='px-4 py-3.5 text-[13px] text-slate-600'>{d.label}</td>
                      <td className='px-4 py-3.5 text-[13px] text-slate-500'>
                        {!d.scope || d.scope.length === 0 ? (
                          <Badge variant='secondary' className='text-xs'>
                            All
                          </Badge>
                        ) : (
                          <div className='flex flex-wrap gap-1'>
                            {d.scope.map((s) => {
                              const label = PREDEFINED_SCOPES.find((p) => p.value === s)?.label ?? s
                              return (
                                <Badge key={s} variant='outline' className='text-xs'>
                                  {label}
                                </Badge>
                              )
                            })}
                          </div>
                        )}
                      </td>
                      <td className='px-5 py-3.5'>
                        <div className='flex items-center justify-end'>
                          {pendingDelete === d.id ? (
                            <div className='flex items-center gap-1'>
                              <button
                                type='button'
                                className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600'
                                onClick={() => remove.mutate(d.id)}
                              >
                                Confirm
                              </button>
                              <button
                                type='button'
                                className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50'
                                onClick={() => setPendingDelete(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type='button'
                              className='rounded-lg p-1.5 text-slate-400 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-red-50 hover:text-red-500'
                              onClick={() => setPendingDelete(d.id)}
                              aria-label='Delete blackout date'
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Add form */}
          <div className='h-fit rounded-xl border border-slate-200 bg-white p-6'>
            <h2 className='mb-4 text-[13px] font-semibold text-slate-900'>Add Blackout Date</h2>
            <form onSubmit={handleSubmit} className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='bd-date'>
                  Date <span className='text-red-500'>*</span>
                </Label>
                <Input
                  id='bd-date'
                  type='date'
                  value={form.date}
                  onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))}
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='bd-label'>
                  Label <span className='text-red-500'>*</span>
                </Label>
                <Input
                  id='bd-label'
                  value={form.label}
                  onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
                  placeholder='e.g. Year-end freeze'
                />
              </div>
              <div className='space-y-2'>
                <Label>
                  Scope{' '}
                  <span className='text-muted-foreground text-xs'>(empty = all contexts)</span>
                </Label>
                <div className='border rounded-md p-3 space-y-2'>
                  {PREDEFINED_SCOPES.map((scope) => (
                    <div key={scope.value} className='flex items-start gap-2'>
                      <Checkbox
                        id={`scope-${scope.value}`}
                        className='mt-0.5'
                        checked={selectedScopes.includes(scope.value)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedScopes((prev) => [...prev, scope.value])
                          } else {
                            setSelectedScopes((prev) => prev.filter((s) => s !== scope.value))
                          }
                        }}
                      />
                      <label htmlFor={`scope-${scope.value}`} className='text-sm cursor-pointer'>
                        <div className='font-medium'>{scope.label}</div>
                        <div className='text-muted-foreground text-xs'>{scope.description}</div>
                      </label>
                    </div>
                  ))}
                </div>
                {selectedScopes.length === 0 && (
                  <p className='text-xs text-muted-foreground'>
                    No scopes selected — this date blocks all contexts.
                  </p>
                )}
              </div>
              <Button type='submit' className='w-full gap-2' disabled={create.isPending}>
                <Plus className='h-3.5 w-3.5' />
                {create.isPending ? 'Adding…' : 'Add'}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

/**
 * Audience confirm threshold (#3080) — stored under the `audience_confirm` key of this
 * instance's settings override row. Saving an alert, rule, flow, field watch or broadcast that
 * reaches more people than this (or a whole role, or everyone) asks the saver to confirm first.
 */
export function AudienceConfirmSettingsCard() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['audience-confirm-settings'],
    queryFn: () =>
      api
        .get<{ data: { threshold: number } }>('/audience-preview/settings')
        .then((r) => r.data.data)
  })
  const [value, setValue] = useState('')
  useEffect(() => {
    if (data) setValue(String(data.threshold))
  }, [data])
  const save = useMutation({
    mutationFn: () =>
      api.patch('/audience-preview/settings', { threshold: Number(value) }).then((r) => r.data),
    onSuccess: () => {
      toast.success('Audience confirm threshold saved')
      void qc.invalidateQueries({ queryKey: ['audience-confirm-settings'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e?.response?.data?.error ?? 'Could not save the threshold')
  })
  const n = Number(value)
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100000
  return (
    <div
      data-audience-confirm-settings
      className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        Confirm before telling many people
      </h3>
      <p className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Saving an alert, rule, flow, field watch or broadcast that reaches more people than this —
        or a whole role, or everyone — shows who it reaches and asks for a confirm first. The
        confirm is logged. 0 asks for every audience. This instance only.
      </p>
      <div className='mt-3 flex items-center gap-2'>
        <Input
          type='number'
          min={0}
          max={100000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className='h-8 w-28 text-[12.5px] tabular-nums'
          aria-label='People before a confirm is needed'
        />
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>people</span>
        <Button
          type='button'
          size='sm'
          disabled={!valid || save.isPending || String(data?.threshold) === value}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

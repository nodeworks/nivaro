import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Megaphone, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Announcement banners — admin-authored, role-targeted, time-windowed
 * messages shown at the top of every app. Ack counts show reach.
 */

interface Announcement {
  id: number
  message: string
  severity: 'info' | 'warn' | 'critical'
  roles: string[] | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  created_at: string | null
  ack_count: number
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-sky-500',
  warn: 'bg-amber-500',
  critical: 'bg-red-500'
}

export default function Announcements() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState('')
  const [severity, setSeverity] = useState<'info' | 'warn' | 'critical'>('info')
  const [endsAt, setEndsAt] = useState('')

  const { data: items = [], isLoading } = useQuery<Announcement[]>({
    queryKey: ['announcements-admin'],
    queryFn: () => api.get<{ data: Announcement[] }>('/announcements').then((r) => r.data.data)
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['announcements-admin'] })
    void qc.invalidateQueries({ queryKey: ['announcements-active'] })
  }

  const create = useMutation({
    mutationFn: () =>
      api.post('/announcements', {
        message: message.trim(),
        severity,
        ends_at: endsAt || null
      }),
    onSuccess: () => {
      toast.success('Announcement published')
      setMessage('')
      setEndsAt('')
      setCreating(false)
      invalidate()
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/announcements/${id}`, body),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message)
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/announcements/${id}`),
    onSuccess: () => {
      toast.success('Announcement deleted')
      invalidate()
    },
    onError: (err: Error) => toast.error(err.message)
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <Megaphone className='h-5 w-5 text-muted-foreground' />
            <div>
              <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Announcements
              </h1>
              <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                Banners shown at the top of every app — maintenance windows, testing rounds,
                go-live notices. Dismissing acknowledges; the count shows reach.
              </p>
            </div>
          </div>
          <Button size='sm' onClick={() => setCreating((v) => !v)}>
            <Plus className='h-3.5 w-3.5' /> New announcement
          </Button>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='max-w-[820px] space-y-4'>
          {creating && (
            <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                placeholder='Maintenance Friday 6–8pm ET — saves may fail briefly.'
                className='text-[13px]'
              />
              <div className='mt-3 flex flex-wrap items-center gap-3'>
                <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
                  {(['info', 'warn', 'critical'] as const).map((sv) => (
                    <button
                      key={sv}
                      type='button'
                      onClick={() => setSeverity(sv)}
                      className={cn(
                        'flex items-center gap-1.5 rounded px-2 py-0.5 text-[11.5px] font-medium capitalize transition-colors',
                        severity === sv
                          ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                          : 'text-slate-400 hover:text-slate-600'
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[sv])} />
                      {sv}
                    </button>
                  ))}
                </span>
                <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  Ends
                  <Input
                    type='datetime-local'
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    className='h-7 w-[190px] text-[12px]'
                  />
                </label>
                <Button
                  size='sm'
                  disabled={!message.trim() || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? (
                    <>
                      <Loader2 className='h-3.5 w-3.5 animate-spin' /> Publishing…
                    </>
                  ) : (
                    'Publish'
                  )}
                </Button>
              </div>
            </div>
          )}

          {isLoading && <p className='text-[12px] text-slate-400'>Loading…</p>}
          {!isLoading && items.length === 0 && !creating && (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Nothing published yet.
            </p>
          )}
          {items.map((a) => (
            <div
              key={a.id}
              className='flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
            >
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[a.severity])} />
              <div className='min-w-0 flex-1'>
                <p className='text-[13px] text-slate-800 dark:text-foreground'>{a.message}</p>
                <p className='mt-0.5 text-[11px] text-slate-400'>
                  {a.created_at ? `published ${formatRelative(a.created_at)}` : ''}
                  {a.ends_at ? ` · ends ${new Date(a.ends_at).toLocaleString()}` : ''}
                  {` · seen by ${a.ack_count}`}
                </p>
              </div>
              <label className='flex shrink-0 items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                <Switch
                  checked={a.is_active}
                  onCheckedChange={(v) => patch.mutate({ id: a.id, body: { is_active: v } })}
                />
                {a.is_active ? 'Live' : 'Off'}
              </label>
              <Button
                variant='ghost'
                size='sm'
                className='h-7 w-7 shrink-0 p-0 text-slate-300 hover:text-red-600'
                onClick={() => remove.mutate(a.id)}
              >
                <Trash2 className='h-3.5 w-3.5' />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

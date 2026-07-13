import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Globe, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

/**
 * Public dashboard link manager — mint token URLs anyone can view without
 * signing in, list active links with view counts, revoke.
 */

interface DashLink {
  id: number
  token: string
  url: string
  expires_at: string | null
  is_active: boolean
  view_count: number
}

export function DashboardLinkPopover({ dashboardId }: { dashboardId: string }) {
  const queryClient = useQueryClient()
  const [expiresDays, setExpiresDays] = useState<number | null>(null)

  const { data: links = [] } = useQuery({
    queryKey: ['dashboard-links', dashboardId],
    queryFn: () =>
      api.get<{ data: DashLink[] }>(`/dashboard-links/for/${dashboardId}`).then((r) => r.data.data)
  })

  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: DashLink }>('/dashboard-links/', {
        dashboard_id: dashboardId,
        expires_in_days: expiresDays
      }),
    onSuccess: (r) => {
      const url = `${window.location.origin}${r.data.data.url}`
      void navigator.clipboard.writeText(url)
      toast.success('Public link created and copied')
      queryClient.invalidateQueries({ queryKey: ['dashboard-links', dashboardId] })
    },
    onError: () => toast.error('Could not create link')
  })

  const revoke = useMutation({
    mutationFn: (id: number) => api.delete(`/dashboard-links/${id}`),
    onSuccess: () => {
      toast.success('Link revoked')
      queryClient.invalidateQueries({ queryKey: ['dashboard-links', dashboardId] })
    }
  })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' className='gap-1.5'>
          <Globe className='h-3.5 w-3.5' />
          Public link
          {links.length > 0 && (
            <span className='rounded-full bg-accent px-1.5 text-[10px] text-nvr-navy dark:text-nvr-cyan'>
              {links.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-3' align='end'>
        <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Public dashboard links
        </p>
        <p className='mt-0.5 text-[11px] text-slate-400'>
          Anyone with the link sees a live read-only view — no sign-in.
        </p>

        <div className='mt-2.5 flex items-center gap-1.5'>
          {[null, 7, 30].map((d) => (
            <button
              key={d ?? 'never'}
              type='button'
              onClick={() => setExpiresDays(d)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${expiresDays === d ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan' : 'border-slate-200 text-slate-400 dark:border-border'}`}
            >
              {d ? `${d} days` : 'No expiry'}
            </button>
          ))}
          <Button
            size='sm'
            className='ml-auto h-6 px-2 text-[11px]'
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </div>

        {links.length > 0 && (
          <div className='mt-3 space-y-1.5 border-t border-slate-100 pt-2.5 dark:border-border'>
            {links.map((l) => (
              <div key={l.id} className='flex items-center gap-2 text-[11.5px]'>
                <code className='truncate font-mono text-[10.5px] text-slate-500'>
                  /d/{l.token.slice(0, 10)}…
                </code>
                <span className='shrink-0 text-slate-400'>
                  {l.view_count} view{l.view_count === 1 ? '' : 's'}
                  {l.expires_at ? ` · expires ${formatRelative(l.expires_at)}` : ''}
                </span>
                <button
                  type='button'
                  title='Copy URL'
                  className='ml-auto text-slate-400 hover:text-nvr-navy dark:hover:text-nvr-cyan'
                  onClick={() => {
                    void navigator.clipboard.writeText(`${window.location.origin}/d/${l.token}`)
                    toast.success('Copied')
                  }}
                >
                  <Copy className='h-3 w-3' />
                </button>
                <button
                  type='button'
                  title='Revoke'
                  className='text-slate-400 hover:text-red-500'
                  onClick={() => revoke.mutate(l.id)}
                >
                  <Trash2 className='h-3 w-3' />
                </button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

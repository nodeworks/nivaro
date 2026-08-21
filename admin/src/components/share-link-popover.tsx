import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Link2, Loader2, Share2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface ShareLink {
  id: string
  token: string
  url: string
  expires_at: string | null
  view_count: number
  created_at: string
}

const EXPIRY_OPTIONS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: 'Never', value: 0 }
]

export function ShareLinkPopover({
  collection,
  item,
  triggerClassName
}: {
  collection: string
  item: string
  triggerClassName?: string
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [expiry, setExpiry] = useState(7)
  const [copied, setCopied] = useState<string | null>(null)

  const { data: links = [] } = useQuery({
    queryKey: ['share-links', collection, item],
    queryFn: () =>
      api
        .get<{ data: ShareLink[] }>(`/share-links/for/${collection}/${item}`)
        .then((r) => r.data.data),
    enabled: open
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['share-links', collection, item] })

  const create = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ShareLink }>('/share-links', {
          collection,
          item,
          expires_in_days: expiry || null
        })
        .then((r) => r.data.data),
    onSuccess: (link) => {
      invalidate()
      copyLink(link)
    },
    onError: () => toast.error('Failed to create share link')
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/share-links/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Link revoked')
    }
  })

  function copyLink(link: ShareLink) {
    const url = `${window.location.origin}${link.url}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(link.id)
      toast.success('Share link copied')
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className={triggerClassName}
          title='Share read-only link'
        >
          <Share2 className='h-3.5 w-3.5' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-3' align='end'>
        <p className='mb-1 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          Share this record
        </p>
        <p className='mb-3 text-[11px] text-muted-foreground'>
          Read-only page rendered through the record's layout. Anyone with the link can view it.
        </p>
        <div className='mb-3 flex items-center gap-2'>
          <div className='flex items-center rounded-lg border border-slate-200 p-0.5 dark:border-border'>
            {EXPIRY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type='button'
                onClick={() => setExpiry(o.value)}
                className={cn(
                  'h-6 rounded-md px-2 text-[11px] font-medium',
                  expiry === o.value
                    ? 'bg-nvr-cyan/15 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                    : 'text-slate-400 hover:text-slate-700'
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <Button
            size='sm'
            className='h-7'
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? (
              <Loader2 className='mr-1 h-3 w-3 animate-spin' />
            ) : (
              <Link2 className='mr-1 h-3 w-3' />
            )}
            Create
          </Button>
        </div>

        {links.length > 0 && (
          <div className='space-y-1.5 border-t border-slate-100 pt-2 dark:border-border'>
            {links.map((l) => (
              <div key={l.id} className='flex items-center gap-1.5 text-[11px]'>
                <span className='min-w-0 flex-1 truncate font-mono text-slate-500'>
                  …/share/{l.token.slice(0, 10)}…
                </span>
                <span className='shrink-0 text-slate-400'>
                  {l.view_count} view{l.view_count !== 1 ? 's' : ''}
                  {l.expires_at ? ` · exp ${formatRelative(l.expires_at)}` : ''}
                </span>
                <button
                  type='button'
                  onClick={() => copyLink(l)}
                  className='shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-nvr-navy dark:hover:bg-muted'
                  aria-label='Copy link'
                >
                  {copied === l.id ? (
                    <Check className='h-3 w-3 text-green-500' />
                  ) : (
                    <Copy className='h-3 w-3' />
                  )}
                </button>
                <button
                  type='button'
                  onClick={() => revoke.mutate(l.id)}
                  className='shrink-0 rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500'
                  aria-label='Revoke link'
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

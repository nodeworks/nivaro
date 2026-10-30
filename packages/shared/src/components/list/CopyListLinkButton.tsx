import { Check, Link2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { copyListLink } from '../../lib/list-link'
import { cn } from '../../lib/utils'

/**
 * #3233 — "Copy link" on a list / queue toolbar: the URL with this view's
 * filters, sort, columns, search and page size. Whoever opens it sees the same
 * view through their own access — the link carries settings, never rows.
 */
export function CopyListLinkButton({
  listKey,
  getState,
  className
}: {
  /** `cbv:<collection>` / `queue:<id>` — ties the link to this list. */
  listKey: string
  /** The view's state (plain JSON — interfaces welcome). */
  getState: () => object
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const onCopy = async () => {
    const result = await copyListLink(listKey, getState() as Record<string, unknown>)
    if (result === 'copied') {
      toast.success('Link copied')
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } else if (result === 'too-long') {
      toast.error('This view is too big for a link — save it as a shared view instead')
    } else {
      toast.error('Could not copy the link')
    }
  }
  return (
    <button
      type='button'
      onClick={() => void onCopy()}
      aria-label='Copy link to this view'
      data-tip='Copy link to this view'
      data-copy-list-link=''
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200',
        className
      )}
    >
      {copied ? (
        <Check className='h-4 w-4 text-emerald-500 dark:text-emerald-400' />
      ) : (
        <Link2 className='h-4 w-4' />
      )}
    </button>
  )
}

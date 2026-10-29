import { Search } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'

/** "1,248 members" — the true total, with the match count while searching (#3082). */
export function memberCountLabel(total: number, searching: boolean): string {
  const n = total.toLocaleString('en-US')
  if (searching) return `${n} ${total === 1 ? 'match' : 'matches'}`
  return `${n} ${total === 1 ? 'member' : 'members'}`
}

/** Search box for a paged member list. Commits on every change (popover inputs never wait for blur). */
export function MemberSearchBox({
  value,
  onChange,
  className
}: {
  value: string
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className='pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400' />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder='Search by name or @handle…'
        aria-label='Search members'
        className='h-7 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 text-[12px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-300 dark:border-white/10 dark:bg-white/5 dark:text-slate-100'
        data-chat-member-search
      />
    </div>
  )
}

/**
 * End-of-list marker: loads the next page when scrolled into view (where the
 * browser supports it) and always offers a button as the fallback.
 */
export function MemberLoadMore({
  hasMore,
  loading,
  onLoad
}: {
  hasMore: boolean
  loading: boolean
  onLoad: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  useEffect(() => {
    const el = ref.current
    if (!hasMore || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadRef.current()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore])
  if (!hasMore) return null
  return (
    <div ref={ref} className='py-1.5 text-center'>
      <button
        type='button'
        onClick={onLoad}
        disabled={loading}
        className='text-[11px] font-medium text-slate-500 hover:text-slate-800 disabled:opacity-60 dark:text-slate-400 dark:hover:text-slate-100'
        data-chat-member-more
      >
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}

/** The presence dot used beside a member: green when online, nothing otherwise. */
export function MemberOnlineDot({ online }: { online: boolean }) {
  if (!online) return null
  return (
    <span
      className='h-2 w-2 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400'
      title='Online'
      role='img'
      aria-label='Online'
    />
  )
}

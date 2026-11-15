import { newMatchesText } from '../lib/live-search'

/**
 * "2 new matches · Show" — the quiet pill a live results page raises when records start
 * matching after the page loaded. It floats over the top of the results (no height of its own),
 * so nothing the person is reading moves when it appears. Put it first inside the scrolling
 * results container.
 */
export function LiveNewMatchesPill({
  count,
  onShow,
  className
}: {
  count: number
  onShow: () => void
  className?: string
}) {
  return (
    <div className={`sticky top-0 z-10 h-0 overflow-visible ${className ?? ''}`} data-live-new>
      <div className='flex justify-center pt-2'>
        {count > 0 && (
          <output aria-live='polite'>
            <button
              type='button'
              onClick={onShow}
              className='inline-flex items-center gap-1.5 rounded-full border border-nvr-cyan/40 bg-white px-3 py-1 text-[12px] text-slate-700 shadow-sm transition-colors hover:bg-nvr-cyan/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:bg-card dark:text-foreground dark:hover:bg-nvr-cyan/15'
            >
              <span className='h-1.5 w-1.5 rounded-full bg-nvr-cyan' aria-hidden />
              {newMatchesText(count)}
              <span aria-hidden>·</span>
              <span className='font-medium underline underline-offset-2'>Show</span>
            </button>
          </output>
        )}
      </div>
    </div>
  )
}

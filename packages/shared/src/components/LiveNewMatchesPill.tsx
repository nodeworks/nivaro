import { newMatchesText } from '../lib/live-search'

/**
 * "2 new matches · Show" — the quiet pill a live results page raises when records start
 * matching after the page loaded. Put it first inside the scrolling results container.
 *
 * It is a sticky row of its own (pass the container's background in `className`), never a
 * float over a result: floating, it sat across a section heading and the selected row's
 * highlight (rt8 review). Nothing renders — and no room is taken — while there is nothing new.
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
    <output aria-live='polite' className='contents'>
      {count > 0 && (
        <div
          className={`nvr-fade-in sticky top-0 z-10 flex justify-center py-1.5 ${className ?? ''}`}
          data-live-new
        >
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
        </div>
      )}
    </output>
  )
}

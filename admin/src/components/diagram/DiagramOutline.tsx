import { ArrowDown } from 'lucide-react'
import type { Diagram } from '@/lib/diagram/layout'

/**
 * Stacked (vertical) form of a Diagram for narrow screens: one card per box in
 * reading order, with its outgoing arrows listed underneath.
 */
export function DiagramOutline({ diagram }: { diagram: Diagram }) {
  const title = new Map(diagram.nodes.map((n) => [n.id, n.title]))
  const ordered = [...diagram.nodes].sort((a, b) => a.layer - b.layer || a.y - b.y)
  return (
    <ol className='flex-1 space-y-2 overflow-y-auto bg-slate-50 p-3 dark:bg-[#0b1220]'>
      {ordered.map((n) => {
        const outs = diagram.edges.filter((e) => e.from === n.id)
        return (
          <li
            key={n.id}
            className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
          >
            <div className='flex flex-wrap items-center gap-1.5'>
              <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                {n.title}
              </span>
              {n.tags?.map((t) => (
                <span
                  key={t}
                  className='rounded-full border border-slate-300 px-1.5 text-[10px] font-semibold text-slate-600 dark:border-slate-600 dark:text-slate-300'
                >
                  {t}
                </span>
              ))}
            </div>
            {n.notes?.map((t) => (
              <p key={t} className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
                {t}
              </p>
            ))}
            {outs.length > 0 && (
              <ul className='mt-2 space-y-1.5 border-t border-slate-100 pt-2 dark:border-border'>
                {outs.map((e) => (
                  <li key={e.id} className='flex gap-2 text-[12px]'>
                    <ArrowDown className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
                    <span>
                      {e.lines?.map((l, i) => (
                        <span
                          key={l}
                          className={
                            i === 0
                              ? 'block font-medium text-slate-800 dark:text-foreground'
                              : 'block text-slate-500 dark:text-slate-400'
                          }
                        >
                          {l}
                        </span>
                      ))}
                      <span className='block text-slate-500 dark:text-slate-400'>
                        {e.back ? 'goes back to ' : 'then '}
                        <strong className='font-semibold'>{title.get(e.to)}</strong>
                        {e.dashed ? ' (alternate path)' : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}

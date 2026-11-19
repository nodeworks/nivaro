/**
 * The SQL it ran: the heaviest statement shapes the trace kept, by total time, each with its
 * runs, average and share of the request's SQL wait. TEXT only — bound values are never kept
 * for this page. Every row opens its leaf (full text, tables, plan).
 */
import { cn } from '@/lib/utils'
import { fmtMs, type Leaf } from './logic'
import type { Story } from './types'
import { Hint, LeafRow, Panel, Section, TonePill } from './ui'

export function SqlSection({
  story,
  leaf,
  onOpen
}: {
  story: Story
  leaf: Leaf | null
  onOpen: (l: Leaf) => void
}) {
  const t = story.trace
  if (!t) return null
  const shapes = t.statements
  return (
    <Section
      id='sql'
      title='SQL it ran'
      count={`${t.queries} ${t.queries === 1 ? 'statement' : 'statements'} · ${fmtMs(t.sql_ms)}`}
      aside={
        shapes.length > 0 && shapes.length < t.queries ? (
          <span className='text-slate-500 dark:text-muted-foreground'>
            The {shapes.length} heaviest shapes · statement text only, never the values
          </span>
        ) : (
          <span className='text-slate-500 dark:text-muted-foreground'>
            Statement text only, never the values
          </span>
        )
      }
    >
      <Panel>
        {shapes.length === 0 ? (
          <Hint className='px-4 py-3'>This request ran no SQL.</Hint>
        ) : (
          <>
            <div
              aria-hidden
              className='grid grid-cols-[88px_48px_minmax(0,1fr)_auto] gap-3 border-b border-slate-100 px-4 py-1.5 text-[11px] text-slate-400 dark:border-border dark:text-muted-foreground'
            >
              <span className='text-right'>Total</span>
              <span className='text-right'>Runs</span>
              <span>Statement</span>
              <span />
            </div>
            <ol className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {shapes.map((s) => (
                <li key={s.index}>
                  <LeafRow
                    list='sql'
                    selected={leaf?.type === 'sql' && leaf.index === s.index}
                    onOpen={() => onOpen({ type: 'sql', index: s.index })}
                    className='grid grid-cols-[88px_48px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2'
                  >
                    <span className='grid justify-items-end gap-1'>
                      <span className='text-[12px] font-medium tabular-nums text-slate-900 dark:text-foreground'>
                        {fmtMs(s.ms)}
                      </span>
                      <span
                        aria-hidden
                        className='h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
                      >
                        <span
                          className='block h-full rounded-full bg-nvr-cyan'
                          style={{ width: `${Math.max(2, Math.round(s.share * 100))}%` }}
                        />
                      </span>
                    </span>
                    <span
                      className={cn(
                        'text-right text-[12px] tabular-nums',
                        s.n > 1
                          ? 'text-slate-800 dark:text-foreground'
                          : 'text-slate-400 dark:text-muted-foreground'
                      )}
                    >
                      ×{s.n}
                    </span>
                    <span className='truncate font-mono text-[11.5px] text-slate-700 dark:text-slate-300'>
                      {s.sql}
                    </span>
                    <span className='flex items-center gap-1'>
                      {s.repeat_n != null && <TonePill tone='warn'>N+1</TonePill>}
                      {s.wide && <TonePill tone='warn'>select *</TonePill>}
                    </span>
                  </LeafRow>
                </li>
              ))}
            </ol>
          </>
        )}
      </Panel>
    </Section>
  )
}

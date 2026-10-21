import { useQuery } from '@tanstack/react-query'
import { Puzzle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface AiExtensionTool {
  name: string
  title: string
  extension: string
  description: string
  read_only: boolean
  replayable: boolean
  enabled: boolean
  shadowed: boolean
  stats: { calls: number; errors: number; last_used_at: string | null; last_error: string | null }
}

/**
 * Ask AI tools extensions registered (#2735): which extension each comes
 * from, whether answers that use it may be shared, and how it has been doing
 * since this server started.
 */
export function ExtensionToolsTab() {
  const q = useQuery({
    queryKey: ['ai-quality', 'extension-tools'],
    queryFn: async () =>
      (await api.get('/ai/quality/extension-tools')).data.data as AiExtensionTool[]
  })
  if (q.isLoading)
    return (
      <div className='space-y-2'>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className='h-12 w-full' />
        ))}
      </div>
    )
  if (q.isError)
    return (
      <p className='text-[12px] text-red-600 dark:text-red-400'>
        The extension tools could not be read. Try again in a moment.
      </p>
    )
  const tools = q.data ?? []
  if (!tools.length)
    return (
      <div className='flex flex-col items-start gap-2 py-10'>
        <Puzzle className='h-5 w-5 text-slate-400' />
        <p className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
          No extension adds Ask AI tools
        </p>
        <p className='max-w-[65ch] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          An extension can give Ask AI its own tools with ctx.ai.registerTool. They run as the
          person asking, and an answer that used one stays that person's unless the tool only reads
          and says it may be replayed for others.
        </p>
      </div>
    )
  return (
    <div className='space-y-3'>
      <p className='max-w-[80ch] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
        Tools extensions give Ask AI. Each runs as the person asking. Shared answers show only when
        every tool they used can be replayed as the reader; counts are since this server started.
      </p>
      <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
              <th className='px-3 py-2 font-medium'>Tool</th>
              <th className='px-3 py-2 font-medium'>Extension</th>
              <th className='px-3 py-2 font-medium'>Sharing</th>
              <th className='px-3 py-2 text-right font-medium'>Calls</th>
              <th className='px-3 py-2 text-right font-medium'>Failed</th>
              <th className='px-3 py-2 font-medium'>Last used</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border'>
            {tools.map((t) => (
              <tr key={t.name} className='align-top hover:bg-slate-50 dark:hover:bg-muted/40'>
                <td className='max-w-[420px] px-3 py-2'>
                  <div className='flex items-center gap-1.5'>
                    <span className='font-mono text-slate-900 dark:text-foreground'>{t.name}</span>
                    {!t.enabled && <Chip tone='muted'>Extension off</Chip>}
                    {t.shadowed && (
                      <Chip
                        tone='warn'
                        tip='A built-in Ask AI tool has this name, so it is never offered'
                      >
                        Name taken
                      </Chip>
                    )}
                  </div>
                  <p className='mt-0.5 line-clamp-2 text-slate-500 dark:text-muted-foreground'>
                    {t.description}
                  </p>
                </td>
                <td className='px-3 py-2 font-mono text-slate-700 dark:text-foreground/80'>
                  {t.extension}
                </td>
                <td className='px-3 py-2'>
                  {t.replayable ? (
                    <Chip tone='ok' tip='Only reads, and declared replayable for other readers'>
                      Shareable
                    </Chip>
                  ) : (
                    <Chip
                      tone='muted'
                      tip={
                        t.read_only
                          ? 'Only reads, but not declared replayable — answers stay the asker’s'
                          : 'May change data — answers stay the asker’s'
                      }
                    >
                      Asker only
                    </Chip>
                  )}
                </td>
                <td className='px-3 py-2 text-right tabular-nums'>{t.stats.calls}</td>
                <td
                  className={cn(
                    'px-3 py-2 text-right tabular-nums',
                    t.stats.errors > 0 && 'text-red-600 dark:text-red-400'
                  )}
                  data-tip={t.stats.last_error ?? undefined}
                >
                  {t.stats.errors}
                </td>
                <td className='whitespace-nowrap px-3 py-2 text-slate-500 dark:text-muted-foreground'>
                  {t.stats.last_used_at ? formatRelative(t.stats.last_used_at) : 'Never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Chip({
  tone,
  tip,
  children
}: {
  tone: 'ok' | 'warn' | 'muted'
  tip?: string
  children: React.ReactNode
}) {
  return (
    <span
      data-tip={tip}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium',
        tone === 'ok' &&
          'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        tone === 'warn' && 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
        tone === 'muted' && 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

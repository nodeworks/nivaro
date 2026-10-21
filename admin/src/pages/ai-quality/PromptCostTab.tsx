import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { cardCls, DaysSelect, Empty, ErrorNote, Loading, tdCls, thCls, whole } from './shared'

interface Part {
  part: string
  label: string
  avg_tokens: number
  avg_cached: number
  share: number
  cached_share: number
}
interface Block {
  avg_total: number
  cached_pct: number
  parts: Part[]
}
interface Data {
  days: number
  ready: boolean
  calls_measured: number
  features: Array<Block & { feature: string; calls: number; biggest: string[] }>
  releases: Array<Block & { version: string; calls: number }>
}

// one fixed ramp so a part keeps its colour in every bar (light and dark)
const SWATCH: Record<string, string> = {
  tool_definitions: 'bg-slate-500 dark:bg-slate-400',
  system_rules: 'bg-sky-600 dark:bg-sky-400',
  data_guide: 'bg-teal-600 dark:bg-teal-400',
  glossary: 'bg-emerald-600 dark:bg-emerald-400',
  catalogues: 'bg-amber-500 dark:bg-amber-400',
  playbooks: 'bg-orange-600 dark:bg-orange-400',
  attachments: 'bg-rose-500 dark:bg-rose-400',
  history: 'bg-violet-600 dark:bg-violet-400',
  question: 'bg-slate-300 dark:bg-slate-600'
}

function Bar({ parts }: { parts: Part[] }) {
  return (
    <div
      className='flex h-3 w-full overflow-hidden rounded bg-slate-100 dark:bg-muted'
      role='img'
      aria-label={parts.map((p) => `${p.label} ${p.share}%`).join(', ')}
    >
      {parts.map((p) => (
        <div
          key={p.part}
          className={SWATCH[p.part] ?? 'bg-slate-400'}
          style={{ width: `${p.share}%` }}
          data-tip={`${p.label}: ${whole(p.avg_tokens)} tokens a call (${p.share}%)`}
        />
      ))}
    </div>
  )
}

export function PromptCostTab() {
  const [days, setDays] = useState(14)
  const q = useQuery({
    queryKey: ['ai-quality', 'prompt-cost', days],
    queryFn: async () => (await api.get('/ai/prompt-cost', { params: { days } })).data.data as Data
  })
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  if (!d.ready)
    return <Empty>Per-part token counts start once the latest database update has run.</Empty>
  if (d.features.length === 0)
    return (
      <Empty>
        No measured AI calls in the last {days} days. New calls are measured as they happen.
      </Empty>
    )
  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center gap-3'>
        <DaysSelect value={days} onChange={setDays} options={[7, 14, 30]} />
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Tokens each part of the request carried, counted from what was sent and scaled to the
          provider’s own prompt count. Only the stable start of a prompt can be cached.
        </p>
      </div>
      <div className='space-y-3'>
        {d.features.map((f) => (
          <div key={f.feature} className={cn(cardCls, 'space-y-2 text-[12px]')}>
            <div className='flex flex-wrap items-baseline justify-between gap-2'>
              <h3 className='text-sm font-semibold'>{f.feature}</h3>
              <p className='text-slate-500 dark:text-muted-foreground'>
                {whole(f.calls)} calls · {whole(f.avg_total)} tokens a call · {f.cached_pct}% served
                from cache
              </p>
            </div>
            <Bar parts={f.parts} />
            <p>
              Biggest: {f.biggest.join(', ')}
              {f.parts[0] && f.parts[0].share >= 50 && (
                <span className='text-amber-700 dark:text-amber-400'>
                  {' '}
                  — {f.parts[0].label.toLowerCase()} is over half of every call.
                </span>
              )}
            </p>
            <table className='w-full'>
              <thead>
                <tr>
                  <th className={thCls}>Part</th>
                  <th className={cn(thCls, 'text-right')}>Tokens a call</th>
                  <th className={cn(thCls, 'text-right')}>Share</th>
                  <th className={cn(thCls, 'text-right')}>Cached</th>
                  <th className={cn(thCls, 'text-right')}>Uncached</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {f.parts.map((p) => (
                  <tr key={p.part}>
                    <td className={tdCls}>
                      <span
                        className={cn('mr-2 inline-block h-2 w-2 rounded-sm', SWATCH[p.part])}
                      />
                      {p.label}
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{whole(p.avg_tokens)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{p.share}%</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>
                      {whole(p.avg_cached)} ({p.cached_share}%)
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>
                      {whole(p.avg_tokens - p.avg_cached)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <section className='space-y-2'>
        <h2 className='text-sm font-semibold'>By release</h2>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Average tokens a call, all features together, for the release that made the call. Growth
          here is prompt bloat shipping.
        </p>
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full text-[12px]'>
            <thead className='border-b border-slate-200 dark:border-border'>
              <tr>
                <th className={thCls}>Release</th>
                <th className={cn(thCls, 'text-right')}>Calls</th>
                <th className={cn(thCls, 'text-right')}>Tokens a call</th>
                <th className={cn(thCls, 'text-right')}>Against previous</th>
                <th className={thCls}>Biggest parts</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {d.releases.map((r, i) => {
                const prev = i > 0 ? d.releases[i - 1].avg_total : null
                const delta = prev ? Math.round(((r.avg_total - prev) / prev) * 1000) / 10 : null
                return (
                  <tr key={r.version}>
                    <td className={cn(tdCls, 'font-mono')}>{r.version}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{whole(r.calls)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{whole(r.avg_total)}</td>
                    <td
                      className={cn(
                        tdCls,
                        'text-right tabular-nums',
                        delta != null && delta > 10 && 'text-amber-700 dark:text-amber-400'
                      )}
                    >
                      {delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta}%`}
                    </td>
                    <td className={tdCls}>
                      {r.parts
                        .slice(0, 3)
                        .map((p) => `${p.label} ${whole(p.avg_tokens)}`)
                        .join(' · ')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Package } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/utils'

/**
 * What shipped, release by release.
 *
 * Sourced from the tags themselves (changelog.json, generated at build time),
 * so it cannot drift from what was actually released — and the running build is
 * marked, which is the question people usually arrive with: "is the fix I was
 * promised in the thing I am looking at?"
 */

interface Entry {
  section: string
  scope: string | null
  text: string
  hash: string | null
}
interface Release {
  version: string
  tag: string
  date: string
  count: number
  sections: Array<{ label: string; entries: Entry[] }>
}

const SECTION_TONE: Record<string, string> = {
  Added: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Fixed: 'bg-sky-50 text-sky-700 border-sky-200',
  Performance: 'bg-violet-50 text-violet-700 border-violet-200',
  Changed: 'bg-amber-50 text-amber-700 border-amber-200',
  Documentation: 'bg-slate-50 text-slate-600 border-slate-200',
  Other: 'bg-slate-50 text-slate-600 border-slate-200'
}

export default function Changelog() {
  const { data, isLoading } = useQuery({
    queryKey: ['changelog'],
    queryFn: () =>
      api
        .get<{ data: { releases: Release[]; running?: string; generated_at?: string | null } }>(
          '/changelog'
        )
        .then((r) => r.data.data),
    staleTime: 10 * 60_000
  })

  const releases = data?.releases ?? []
  const running = data?.running

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4'>
        <h1 className='text-[15px] font-semibold text-slate-900'>Changelog</h1>
        <p className='mt-0.5 text-[12px] text-slate-500'>
          Every released version, newest first, taken from the release tags.
          {running && (
            <>
              {' '}
              This instance is running <span className='font-medium text-slate-700'>{running}</span>.
            </>
          )}
        </p>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5'>
        {isLoading && <p className='text-[12px] text-slate-400'>Loading…</p>}

        {!isLoading && releases.length === 0 && (
          <p className='rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-[12px] text-slate-400'>
            No releases recorded. changelog.json is generated at build time — run{' '}
            <span className='font-mono'>node scripts/build-changelog.mjs</span>.
          </p>
        )}

        <div className='mx-auto max-w-3xl space-y-4'>
          {releases.map((r) => {
            const isRunning = running === r.version
            return (
              <section
                key={r.tag}
                className={cn(
                  'overflow-hidden rounded-xl border bg-white',
                  isRunning ? 'border-nvr-cyan/50 ring-1 ring-nvr-cyan/20' : 'border-slate-200'
                )}
              >
                <div className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5'>
                  <Package className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  <span className='text-[13px] font-semibold text-slate-900'>{r.version}</span>
                  {isRunning && (
                    <span className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy'>
                      <CheckCircle2 className='h-3 w-3' />
                      Running here
                    </span>
                  )}
                  <span className='ml-auto text-[11px] text-slate-400'>
                    {r.date ? formatDate(r.date) : ''} · {r.count} change
                    {r.count === 1 ? '' : 's'}
                  </span>
                </div>

                <div className='space-y-3 px-4 py-3'>
                  {r.sections.length === 0 && (
                    <p className='text-[12px] italic text-slate-400'>
                      No changes recorded beyond the release itself.
                    </p>
                  )}
                  {r.sections.map((s) => (
                    <div key={s.label}>
                      <span
                        className={cn(
                          'inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium',
                          SECTION_TONE[s.label] ?? SECTION_TONE.Other
                        )}
                      >
                        {s.label}
                      </span>
                      <ul className='mt-1.5 space-y-1'>
                        {s.entries.map((e, i) => (
                          <li key={`${e.hash ?? i}`} className='flex gap-2 text-[12.5px] leading-snug'>
                            <span className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-300' />
                            <span className='text-slate-700'>
                              {e.scope && (
                                <span className='font-mono text-[11px] text-slate-400'>
                                  {e.scope}{' '}
                                </span>
                              )}
                              {e.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

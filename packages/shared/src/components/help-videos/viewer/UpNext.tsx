import { Play } from 'lucide-react'
import { useApiFetchConfig } from '../../../context'
import type { HelpVideoDto } from '../types'
import { formatDuration, isGettingReady } from './format'

const rowButton =
  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'

/** "Up next" (#1530): poster, title and length; clicking plays it in the same sheet. */
export function UpNextList({
  videos,
  onPick,
  prominent = false
}: {
  videos: HelpVideoDto[]
  onPick: (id: string) => void
  /** After the video ends: a larger first row that invites the next one. */
  prominent?: boolean
}) {
  const { apiBase } = useApiFetchConfig()
  const origin = apiBase.replace(/\/api$/, '')
  if (!videos.length) return null
  return (
    <section
      aria-label='Up next'
      data-hv-up-next
      data-hv-up-next-prominent={prominent ? '' : undefined}
    >
      <h3 className='mb-1 text-[12px] font-medium text-muted-foreground'>Up next</h3>
      <ul className='divide-y divide-border overflow-hidden rounded-md border border-border text-[13px]'>
        {videos.map((v, i) => {
          const big = prominent && i === 0
          return (
            <li key={v.id}>
              <button
                type='button'
                className={`${rowButton} ${big ? 'bg-muted/40' : ''}`}
                onClick={() => onPick(v.id)}
                data-hv-up-next-item={v.id}
              >
                <span
                  className={`relative shrink-0 overflow-hidden rounded bg-[#0b0f17] ${big ? 'h-[54px] w-24' : 'h-9 w-16'}`}
                  aria-hidden
                >
                  {v.poster_url && (
                    <img
                      src={`${origin}${v.poster_url}`}
                      alt=''
                      className='h-full w-full object-cover'
                      loading='lazy'
                      crossOrigin='use-credentials'
                    />
                  )}
                  {big && (
                    <span className='absolute inset-0 flex items-center justify-center text-white'>
                      <Play className='h-5 w-5 fill-current drop-shadow' />
                    </span>
                  )}
                </span>
                <span className='min-w-0 flex-1'>
                  <span className={`block truncate ${big ? 'font-medium' : ''}`}>{v.title}</span>
                  {big && v.description && (
                    <span className='block truncate text-[12px] text-muted-foreground'>
                      {v.description}
                    </span>
                  )}
                </span>
                <span className='shrink-0 text-[12px] tabular-nums text-muted-foreground'>
                  {isGettingReady(v) ? 'Getting ready' : formatDuration(v.duration_ms)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

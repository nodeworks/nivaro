import { useQuery } from '@tanstack/react-query'
import { PlayCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { FormVideos } from '../help-videos/api'
import { LazyHelpVideoSheet } from '../help-videos/viewer/LazyHelpVideoSheet'

/**
 * The videos attached to single fields and sections of a collection's form
 * (#2615) — one request per form, shared by every label on it through the
 * query cache. No live listener per label: the editor's attach invalidates
 * this key, and a minute later a record page picks up what others changed.
 */
export function useFormHelpVideos(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['help-videos', 'form', collection ?? ''] as const,
    enabled: !!collection,
    staleTime: 60_000,
    queryFn: () =>
      client
        .request(get<{ data: FormVideos }>('/help-videos/for-form', { collection }))
        .then((r) => r.data)
  })
}

/**
 * A small play button beside a field or section label when a help video is
 * attached to it; opens the regular player (more than one: "Up next" lists
 * the others). Renders nothing otherwise. The server already dropped videos
 * this viewer's role may not see.
 */
export function FormHelpVideoButton({
  collection,
  kind,
  name,
  label
}: {
  collection: string
  kind: 'field' | 'section'
  name: string
  label: string
}) {
  const { data } = useFormHelpVideos(collection)
  const listed = kind === 'field' ? data?.fields?.[name] : data?.sections?.[name]
  const videos = Array.isArray(listed) ? listed : []
  const [watching, setWatching] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  if (!videos.length && !watching) return null
  const first = videos[0]
  return (
    <>
      {first && (
        <button
          ref={trigger}
          type='button'
          data-form-help-video={`${kind}:${name}`}
          aria-label={`Watch ${first.title} (help for ${label})`}
          data-tip={
            videos.length > 1
              ? `Watch: ${first.title} and ${videos.length - 1} more`
              : `Watch: ${first.title}`
          }
          onClick={(e) => {
            // Section headers fold on click; the button only plays.
            e.stopPropagation()
            setWatching(first.id)
          }}
          className='inline-flex items-center rounded text-slate-400 transition-colors hover:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-500 dark:hover:text-nvr-cyan'
        >
          <PlayCircle className='h-3.5 w-3.5' />
        </button>
      )}
      <LazyHelpVideoSheet
        videoId={watching}
        open={!!watching}
        onOpenChange={(o) => !o && setWatching(null)}
        upNext={videos}
        onPick={setWatching}
        returnFocusRef={trigger}
      />
    </>
  )
}

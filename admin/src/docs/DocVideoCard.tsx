import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  HelpVideoSheet,
  helpVideoApi,
  NavigationContext,
  NivaroProvider,
  useHelpVideo,
  useHelpVideosFor,
  useNivaroClient
} from '@nivaro/shared'
import { PlayCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

// A help video inside a docs section (#1528c): a poster card that opens the
// help-video sheet. The video is named by id, or by the page key it is
// tagged to (GET /help-videos/for?page=<key>, the same lookup a screen's
// Videos button makes). Both answer only what this reader may watch — a
// not-found or an empty answer renders nothing, so the docs never promise a
// video the reader cannot open.

const client = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

type VideoNode = { id?: string; key?: string; label?: string; t_ms?: number; caption?: string }

export function DocVideoCard({ node }: { node: VideoNode }) {
  const navigate = useNavigate()
  if (!node.id && !node.key) return null
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider
        value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
      >
        <Card node={node} />
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}

function formatDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function Card({ node }: { node: VideoNode }) {
  const [open, setOpen] = useState(false)
  const nivaro = useNivaroClient()
  const byId = useHelpVideo(node.id ?? null)
  const byKey = useHelpVideosFor({ page: node.key }, !node.id && !!node.key)
  // A page key names a place authors can tag under "Where it shows"; the
  // docs register it the way a screen's Videos button does, so it is offered
  // there before any video exists for it.
  const pageKey = node.id ? null : (node.key ?? null)
  useEffect(() => {
    if (!pageKey) return
    void helpVideoApi(nivaro)
      .registerPage(pageKey, node.label ?? `Docs: ${pageKey}`, 'admin')
      .catch(() => {})
  }, [pageKey, node.label, nivaro])
  const video = node.id ? byId.data : byKey.data?.data[0]
  if (!video?.published) return null
  const length = formatDuration(video.duration_ms)
  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='mb-4 flex w-full max-w-[520px] items-stretch gap-3 overflow-hidden rounded-lg border border-slate-200 bg-white text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:hover:bg-muted'
        aria-label={`Watch: ${video.title || 'Untitled video'}`}
        data-doc-video={video.id}
      >
        <span className='relative block w-[160px] shrink-0 bg-slate-100 dark:bg-slate-800'>
          {video.poster_url && (
            <img
              src={video.poster_url}
              alt=''
              className='h-full w-full object-cover'
              loading='lazy'
            />
          )}
          <span className='absolute inset-0 grid place-content-center'>
            <PlayCircle className='h-8 w-8 text-white drop-shadow' aria-hidden />
          </span>
        </span>
        <span className='flex min-w-0 flex-1 flex-col justify-center py-2 pr-3'>
          <span className='text-[0.85rem] font-medium text-slate-800 dark:text-foreground'>
            {video.title || 'Untitled video'}
          </span>
          <span className='text-[0.75rem] text-slate-500 dark:text-slate-400'>
            {[
              'Video',
              length,
              node.t_ms && node.t_ms > 0 ? `starts at ${formatDuration(node.t_ms)}` : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {node.caption && (
            <span className='mt-1 text-[0.8rem] text-slate-600 dark:text-slate-300'>
              {node.caption}
            </span>
          )}
        </span>
      </button>
      <HelpVideoSheet
        videoId={video.id}
        open={open}
        onOpenChange={setOpen}
        startAtMs={node.t_ms ?? null}
        showMe={false}
      />
    </>
  )
}

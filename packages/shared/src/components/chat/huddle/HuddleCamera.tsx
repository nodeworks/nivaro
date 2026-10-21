import { MicOff, Video, VideoOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '../../../lib/utils'
import { cameraStore, cameraSupported, pausedCameras, videoLayout } from './huddle-camera'
import type { HuddlePeer, LivePeer } from './huddle-store'

/** The camera toggle in the huddle controls (#2858); hidden where there is no camera API. */
export function HuddleCameraButton({ disabled }: { disabled?: boolean }) {
  const cam = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot)
  const supported = useMemo(cameraSupported, [])
  if (!supported) return null
  const on = !!cam.stream
  return (
    <button
      type='button'
      onClick={() => cameraStore.toggle()}
      disabled={disabled || cam.starting}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40',
        on
          ? 'bg-nvr-cyan/15 text-slate-900 dark:text-slate-100'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
      )}
      aria-pressed={on}
      aria-label={on ? 'Turn your camera off' : 'Turn your camera on'}
      data-tip={on ? 'Camera off' : 'Camera on'}
      data-huddle-camera={on ? 'on' : 'off'}
    >
      {on ? (
        <VideoOff className='h-3.5 w-3.5' strokeWidth={2} />
      ) : (
        <Video className='h-3.5 w-3.5' strokeWidth={2} />
      )}
    </button>
  )
}

function Tile({
  stream,
  name,
  muted,
  mirror,
  note,
  speaking
}: {
  stream: MediaStream
  name: string
  muted?: boolean
  mirror?: boolean
  note?: string
  speaking?: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    void el.play().catch(() => null)
    return () => {
      el.srcObject = null
    }
  }, [stream])
  return (
    <div
      className={cn(
        'relative aspect-video overflow-hidden rounded-lg bg-[#0f172a] ring-2 transition-[box-shadow] duration-200',
        speaking ? 'ring-nvr-cyan' : 'ring-transparent'
      )}
      data-huddle-tile={mirror ? 'mine' : 'peer'}
    >
      <video
        ref={ref}
        muted
        playsInline
        className={cn('h-full w-full object-cover', mirror && '-scale-x-100')}
      />
      {note && (
        <span className='absolute inset-0 flex items-center justify-center bg-[#0f172a]/75 px-3 text-center text-[11px] font-medium text-white'>
          {note}
        </span>
      )}
      <span className='absolute bottom-1.5 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white'>
        <span className='truncate'>{name}</span>
        {muted && <MicOff className='h-3 w-3 shrink-0' strokeWidth={2} aria-label='muted' />}
      </span>
    </div>
  )
}

/**
 * Camera tiles in the stage (#2858): one, two or a 2x2 grid; a narrow stage
 * (phone width, a slim chat dock) gets a sideways-scrolling strip. My own view
 * is mirrored, like a mirror. Cameras past the live limit are not shown — the
 * people behind them see why on their own tile.
 */
export function HuddleVideoGrid({
  peers,
  roster,
  muted
}: {
  peers: LivePeer[]
  roster: HuddlePeer[]
  muted: boolean
}) {
  const cam = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot)
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const paused = useMemo(() => pausedCameras(roster), [roster])
  const live = peers.filter((p) => p.camera && !paused.has(p.socket))
  const count = live.length + (cam.stream ? 1 : 0)
  if (!count) return <div ref={wrap} />
  const layout = videoLayout(count, width)
  return (
    <div
      ref={wrap}
      className={cn(
        'mt-1.5',
        layout === 'strip'
          ? 'flex snap-x gap-1.5 overflow-x-auto pb-0.5 [&>*]:w-[148px] [&>*]:shrink-0 [&>*]:snap-start'
          : layout === 'two'
            ? 'grid max-w-[560px] grid-cols-2 gap-1.5'
            : 'grid max-w-[320px] grid-cols-1'
      )}
      data-huddle-video={layout}
    >
      {cam.stream && (
        <Tile
          stream={cam.stream}
          name='You'
          muted={muted}
          mirror
          note={cam.paused ? 'Video paused to keep the call smooth' : undefined}
        />
      )}
      {live.map((p) => (
        <Tile
          key={p.socket}
          stream={p.camera as MediaStream}
          name={p.name ?? 'Someone'}
          muted={p.muted}
          speaking={!!(p as { speaking?: boolean }).speaking}
        />
      ))}
    </div>
  )
}

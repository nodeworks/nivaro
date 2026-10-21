import { Headphones, Mic, MicOff, PhoneOff, PictureInPicture2 } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cn } from '../../../lib/utils'
import { chatAvatarColor, chatInitials } from '../chat-core'
import { huddleSpeaking } from './huddle-speaking'
import { formatElapsed, type HuddleState, huddleStore, type LivePeer } from './huddle-store'

/**
 * The huddle mini-player (#2853): Document Picture-in-Picture (Chrome, Edge)
 * opens a small always-on-top window holding who is here (and who is
 * speaking, when the store says), the timer, mute and leave, and a thumbnail
 * of a shared screen.
 *
 * It renders into its own React root inside the PiP document, reading only the
 * huddle store — so it keeps going when the chat panel closes or another room
 * opens, exactly like the huddle's sound. The page's stylesheets are copied in
 * and its theme class followed, so it looks like the app in light and dark.
 * Leaving the huddle closes it; closing it changes nothing else.
 */

export interface PipMe {
  id: string
  name: string
}

type DocPip = { requestWindow(o?: { width?: number; height?: number }): Promise<Window> }

function docPip(): DocPip | null {
  if (typeof window === 'undefined') return null
  const d = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture
  return d && typeof d.requestWindow === 'function' ? d : null
}

export function pipSupported(): boolean {
  return !!docPip()
}

/** Copy the page's CSS and theme into the PiP document. */
function copyLook(from: Document, to: Document) {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n')
      const style = to.createElement('style')
      style.textContent = css
      to.head.appendChild(style)
    } catch {
      // A cross-origin sheet hides its rules: link it instead.
      if (!sheet.href) continue
      const link = to.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      to.head.appendChild(link)
    }
  }
  syncTheme(from, to)
  to.title = 'Huddle'
}

function syncTheme(from: Document, to: Document) {
  const src = from.documentElement
  const dst = to.documentElement
  dst.className = src.className
  // White-label colours (--nvr-cyan …) live on the root's inline style.
  const style = src.getAttribute('style')
  if (style) dst.setAttribute('style', style)
  else dst.removeAttribute('style')
  for (const a of ['data-theme', 'lang', 'dir']) {
    const v = src.getAttribute(a)
    if (v == null) dst.removeAttribute(a)
    else dst.setAttribute(a, v)
  }
}

type Listener = () => void

class PipController {
  private win: Window | null = null
  private root: Root | null = null
  private offs: Array<() => void> = []
  private listeners = new Set<Listener>()
  private opening = false
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => !!this.win
  private emit() {
    for (const l of this.listeners) l()
  }

  isOpen() {
    return !!this.win
  }

  /** Must run inside a click (or the browser's auto-PiP action): PiP needs user activation. */
  async open(me: PipMe | null): Promise<boolean> {
    const d = docPip()
    const s = huddleStore.getSnapshot()
    if (!d || this.opening || (s.status !== 'live' && s.status !== 'joining')) return false
    if (this.win) {
      this.win.focus()
      return true
    }
    this.opening = true
    let win: Window
    try {
      win = await d.requestWindow({ width: 320, height: 240 })
    } catch {
      return false
    } finally {
      this.opening = false
    }
    copyLook(document, win.document)
    win.document.body.className =
      'm-0 bg-slate-50 font-sans text-slate-900 antialiased dark:bg-background dark:text-slate-100'
    const mount = win.document.createElement('div')
    mount.className = 'h-screen'
    win.document.body.appendChild(mount)
    this.win = win
    this.root = createRoot(mount)
    this.root.render(<PipView me={me} win={win} />)
    const theme = new MutationObserver(() => syncTheme(document, win.document))
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    })
    const onHide = () => this.closed()
    win.addEventListener('pagehide', onHide)
    this.offs = [
      () => theme.disconnect(),
      () => win.removeEventListener('pagehide', onHide),
      huddleStore.subscribe(() => {
        const st = huddleStore.getSnapshot().status
        if (st !== 'live' && st !== 'joining') this.close()
      })
    ]
    this.emit()
    return true
  }

  close() {
    const win = this.win
    this.closed()
    win?.close()
  }

  private closed() {
    if (!this.win) return
    for (const off of this.offs) off()
    this.offs = []
    const root = this.root
    this.root = null
    this.win = null
    // Unmount after the current render pass (pagehide can fire mid-commit).
    queueMicrotask(() => root?.unmount())
    this.emit()
  }
}

export const huddlePip = new PipController()

function Disc({
  id,
  name,
  speaking,
  muted
}: {
  id: string
  name: string | null
  speaking?: boolean
  muted?: boolean
}) {
  return (
    <span className='relative inline-flex shrink-0' data-tip={name ?? 'Someone'}>
      <span
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold text-[#04263b] ring-2 ring-offset-2 ring-offset-slate-50 transition-[box-shadow] duration-200 dark:ring-offset-background',
          speaking ? 'ring-emerald-500 dark:ring-emerald-400' : 'ring-transparent'
        )}
        style={{ backgroundColor: chatAvatarColor(id) }}
        role='img'
        aria-label={`${name ?? 'Someone'}${speaking ? ', speaking' : ''}${muted ? ', muted' : ''}`}
      >
        {chatInitials(name)}
      </span>
      {muted && (
        <span className='absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white ring-1 ring-slate-200 dark:bg-card dark:ring-border'>
          <MicOff className='h-2.5 w-2.5 text-red-600 dark:text-red-300' strokeWidth={2.25} />
        </span>
      )}
    </span>
  )
}

function Thumb({ stream, label }: { stream: MediaStream; label: string }) {
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
    <div className='relative min-h-0 flex-1 overflow-hidden rounded-md bg-[#0f172a]'>
      <video ref={ref} muted playsInline className='h-full w-full object-contain' />
      <span className='absolute bottom-1 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white'>
        {label}
      </span>
    </div>
  )
}

function PipView({ me, win }: { me: PipMe | null; win: Window }) {
  const state: HuddleState = useSyncExternalStore(huddleStore.subscribe, huddleStore.getSnapshot)
  // #2845 — who is speaking, from the same engine as the stage's rings.
  const talk = useSyncExternalStore(huddleSpeaking.subscribe, huddleSpeaking.getSnapshot)
  const [, tick] = useState(0)
  useEffect(() => {
    // The PiP window's own timer: the hidden tab's timers are throttled.
    const t = win.setInterval(() => tick((n) => n + 1), 1000)
    return () => win.clearInterval(t)
  }, [win])
  const shared = state.peers.find((p) => p.video)
  const camera = state.peers.find((p) => p.camera)
  const thumb = shared?.video
    ? { stream: shared.video, label: `${shared.name ?? 'Someone'}'s screen` }
    : state.localScreen
      ? { stream: state.localScreen, label: 'Your screen' }
      : camera?.camera
        ? { stream: camera.camera, label: camera.name ?? 'Someone' }
        : null
  const people: Array<
    Pick<LivePeer, 'socket' | 'user' | 'name' | 'muted'> & { speaking: boolean }
  > = [
    ...(me
      ? [
          {
            socket: 'me',
            user: me.id,
            name: me.name,
            muted: state.muted,
            speaking: talk.selfSpeaking
          }
        ]
      : []),
    ...state.peers.map((p) => ({ ...p, speaking: !!talk.speaking[p.socket] }))
  ]
  const live = state.status === 'live'
  return (
    <div className='flex h-full flex-col gap-2 p-2.5 text-[12px]' data-huddle-pip>
      <div className='flex items-center gap-1.5'>
        <Headphones className='h-3.5 w-3.5 text-nvr-cyan' strokeWidth={2} />
        <span className='font-medium'>{live ? 'Huddle' : 'Connecting…'}</span>
        {live && state.startedAt && (
          <span className='tabular-nums text-slate-500 dark:text-slate-400'>
            {formatElapsed(Date.now() - state.startedAt)}
          </span>
        )}
        <span className='ml-auto text-[11px] text-slate-500 dark:text-slate-400'>
          {people.length} {people.length === 1 ? 'person' : 'people'}
        </span>
      </div>
      {thumb ? (
        <Thumb stream={thumb.stream} label={thumb.label} />
      ) : (
        <div className='flex min-h-0 flex-1 items-center'>
          {people.length <= 1 && (
            <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              Only you so far.
            </span>
          )}
        </div>
      )}
      <div className='flex items-center gap-2'>
        <div className='flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1 pl-1'>
          {people.slice(0, 5).map((p) => (
            <Disc key={p.socket} id={p.user} name={p.name} speaking={p.speaking} muted={p.muted} />
          ))}
          {people.length > 5 && (
            <span className='text-[11px] text-slate-500 dark:text-slate-400'>
              +{people.length - 5}
            </span>
          )}
        </div>
        <button
          type='button'
          onClick={() => huddleStore.setMuted(!state.muted)}
          disabled={!live}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40',
            state.muted
              ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300'
              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-white/10'
          )}
          aria-pressed={state.muted}
          aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {state.muted ? (
            <MicOff className='h-4 w-4' strokeWidth={2} />
          ) : (
            <Mic className='h-4 w-4' strokeWidth={2} />
          )}
        </button>
        <button
          type='button'
          onClick={() => huddleStore.leave()}
          className='flex h-8 items-center gap-1 rounded-md bg-red-600 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-1'
          aria-label='Leave the huddle'
        >
          <PhoneOff className='h-3.5 w-3.5' strokeWidth={2} />
          Leave
        </button>
      </div>
    </div>
  )
}

// ── The one-time pop-out offer (the button is a row of the call bar's ⋯) ────
const PREF_KEY = 'nvr-huddle-pip'

type PipPref = 'asked' | 'auto'

function readPref(): PipPref | null {
  try {
    const v = window.localStorage.getItem(PREF_KEY)
    return v === 'asked' || v === 'auto' ? v : null
  } catch {
    return null
  }
}

function writePref(v: PipPref) {
  try {
    window.localStorage.setItem(PREF_KEY, v)
  } catch {
    /* private window: the offer may come back next time */
  }
}

type MediaSessionPip = {
  setActionHandler(action: string, handler: (() => void) | null): void
}

function mediaSession(): MediaSessionPip | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as unknown as { mediaSession?: MediaSessionPip }).mediaSession ?? null
}

let autoPip: boolean | null = null

/** Chrome can pop a call out by itself when the tab is hidden (the media session's auto PiP).
 *  Probed once: the probe clears the handler, so it must run before any is set. */
export function autoPipSupported(): boolean {
  if (autoPip != null) return autoPip
  const ms = mediaSession()
  if (!ms || !pipSupported()) {
    autoPip = false
    return autoPip
  }
  try {
    ms.setActionHandler('enterpictureinpicture', null)
    autoPip = true
  } catch {
    autoPip = false
  }
  return autoPip
}

/**
 * The pop-out offer: the first time the tab is hidden during a huddle, coming
 * back shows one small line offering the mini-player — once, remembered in
 * this browser. "Every time" turns on the browser's own automatic pop-out
 * where it has one.
 */
export function useHuddlePip(active: boolean, me: PipMe | null) {
  const open = useSyncExternalStore(huddlePip.subscribe, huddlePip.getSnapshot, () => false)
  const [supported] = useState(pipSupported)
  const [auto] = useState(autoPipSupported)
  const [offer, setOffer] = useState(false)
  const meRef = useRef(me)
  meRef.current = me

  useEffect(() => {
    if (!active || !supported || readPref()) return
    let away = false
    const onVis = () => {
      if (document.hidden) {
        if (!huddlePip.isOpen()) away = true
      } else if (away) {
        away = false
        if (!readPref() && !huddlePip.isOpen()) setOffer(true)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [active, supported])

  const [prefTick, setPrefTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefTick re-reads the stored choice
  useEffect(() => {
    const ms = mediaSession()
    if (!active || !auto || !ms || readPref() !== 'auto') return
    try {
      ms.setActionHandler('enterpictureinpicture', () => void huddlePip.open(meRef.current))
    } catch {
      return
    }
    return () => {
      try {
        ms.setActionHandler('enterpictureinpicture', null)
      } catch {
        /* gone with the page */
      }
    }
  }, [active, auto, prefTick])

  useEffect(() => {
    if (!active) setOffer(false)
  }, [active])

  return {
    supported,
    open,
    toggle: () => (huddlePip.isOpen() ? huddlePip.close() : void huddlePip.open(meRef.current)),
    offer,
    autoSupported: auto,
    acceptOffer: (always: boolean) => {
      writePref(always && auto ? 'auto' : 'asked')
      setPrefTick((n) => n + 1)
      setOffer(false)
      void huddlePip.open(meRef.current)
    },
    dismissOffer: () => {
      writePref('asked')
      setOffer(false)
    }
  }
}

export type HuddlePipHandle = ReturnType<typeof useHuddlePip>

export function HuddlePipOffer({ pip }: { pip: HuddlePipHandle }) {
  if (!pip.offer || pip.open) return null
  const link =
    'rounded px-1.5 py-0.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
  return (
    <div
      className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11.5px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
      role='status'
      data-huddle-pip-offer
    >
      <PictureInPicture2 className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' strokeWidth={2} />
      <span className='min-w-0 flex-1'>
        Keep the huddle on top when you switch to another tab or app?
      </span>
      <span className='flex items-center gap-1'>
        <button
          type='button'
          onClick={() => pip.acceptOffer(false)}
          className={cn(link, 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90')}
        >
          Pop out
        </button>
        {pip.autoSupported && (
          <button
            type='button'
            onClick={() => pip.acceptOffer(true)}
            className={cn(
              link,
              'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/10'
            )}
            data-tip='Pop out by itself whenever you leave this tab during a huddle'
          >
            Every time
          </button>
        )}
        <button
          type='button'
          onClick={pip.dismissOffer}
          className={cn(
            link,
            'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/10'
          )}
        >
          No thanks
        </button>
      </span>
    </div>
  )
}

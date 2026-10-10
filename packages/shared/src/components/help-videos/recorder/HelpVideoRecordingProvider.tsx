import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useNavigation } from '../../../context'
import { modalHostOf } from '../../ui/popover'
import { helpVideoKeys } from '../api'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import { useHelpVideosPath } from '../viewer/HelpVideoSheet'
import { HelpVideoWalkHost } from '../walk/HelpVideoWalk'
import { HelpVideoRecorder } from './HelpVideoRecorder'
import {
  isRecordingWindow,
  type RecordingHandoff,
  takeHandoff,
  tokenFromSearch,
  withoutRecordParam
} from './recordingWindow'

export type StartRecordingOptions = {
  /** Where the new video shows (a new recording only). */
  contexts?: HelpVideoContext[]
  /** Re-record this video instead of making a new one. */
  videoId?: string
  /** Called with the saved video when the caller is still mounted. When the
   *  caller is gone (or gave none) the provider opens the editor instead. */
  onDone?: (video: HelpVideoDto) => void
  /** An element of the caller. When it sits inside a modal dialog or sheet, the
   *  setup dialog and the recording bar mount inside that modal (a modal makes
   *  everything outside it unclickable). Absent = the element focused at start. */
  from?: HTMLElement | null
}

export const RECORDING_BUSY = 'A recording is already in progress.'

type Session = StartRecordingOptions & {
  alive: () => boolean
  host: HTMLElement | null
  /** Inside a recording window (#1516): what the opener handed over. */
  handoff?: RecordingHandoff | null
}

/**
 * Inside a recording window (#1516), the setup the opener left under the
 * token in the URL. The token leaves the URL either way, so a reload is a
 * plain page. Null in every other window.
 */
export function takeRecordingHandoff(): RecordingHandoff | null {
  if (typeof window === 'undefined') return null
  const token = tokenFromSearch(window.location.search)
  if (!token) return null
  const handoff = isRecordingWindow() ? takeHandoff(token) : null
  try {
    window.history.replaceState(window.history.state, '', withoutRecordParam(window.location.href))
  } catch {
    /* the token stays in the URL; it is spent anyway */
  }
  return handoff
}

type RecordingContextValue = {
  start: (session: Session) => boolean
  active: boolean
}

const RecordingContext = createContext<RecordingContextValue | null>(null)

/** What finishing a recording does, whoever hosts the recorder. */
function useFinish() {
  const qc = useQueryClient()
  const nav = useNavigation()
  const path = useHelpVideosPath()
  return useCallback(
    (s: Session, video: HelpVideoDto) => {
      void qc.invalidateQueries({ queryKey: helpVideoKeys.all })
      // The draft key sits outside `all` on purpose; an open editor reloads from this one.
      if (s.videoId) void qc.invalidateQueries({ queryKey: ['help-video-draft', s.videoId] })
      if (s.onDone && s.alive()) s.onDone(video)
      else nav.navigate(path(`?edit=${video.id}`))
    },
    [qc, nav, path]
  )
}

/**
 * Holds ONE recorder for the whole app. A walkthrough means clicking through
 * other screens, and a recorder mounted inside a screen ends the take at the
 * first route change.
 *
 * Placement (hosts: admin, efp-new): mount it ONCE, ABOVE the router outlet
 * and ABOVE every screen that calls useHelpVideoRecording(), and INSIDE a
 * QueryClientProvider, a NivaroProvider and an app-level NavigationContext
 * (navigate plus helpVideosPath). Without a NavigationContext it falls back
 * to window.location.href and the default /help-videos path.
 */
export function HelpVideoRecordingProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const current = useRef<Session | null>(null)
  const finish = useFinish()

  const start = useCallback((s: Session) => {
    if (current.current) return false
    current.current = s
    setSession(s)
    return true
  }, [])

  const value = useMemo(() => ({ start, active: !!session }), [start, session])

  // A recording window (#1516) opens the recorder as soon as the app is up,
  // with the setup the opener handed over.
  useEffect(() => {
    const h = takeRecordingHandoff()
    if (!h) return
    start({
      videoId: h.videoId,
      contexts: h.contexts,
      handoff: h,
      alive: () => true,
      host: null
    })
  }, [start])

  return (
    <RecordingContext.Provider value={value}>
      {children}
      <HelpVideoRecorder
        open={!!session}
        videoId={session?.videoId}
        contexts={session?.contexts}
        defaultTitle={session?.handoff?.defaultTitle}
        handoff={session?.handoff}
        barHost={session?.host}
        // "Gone", never "cancelled": the limit notice calls onDone and then onClose.
        onClose={() => {
          current.current = null
          setSession(null)
        }}
        onDone={(video) => {
          const s = current.current
          if (!s) return
          finish(s, video)
          // Done: the editor must not sit under a leftover dialog, and
          // `active` must not stay true.
          current.current = null
          setSession(null)
        }}
      />
      {/* The guided walk outlives the sheet that starts it when a provider hosts it. */}
      <HelpVideoWalkHost />
    </RecordingContext.Provider>
  )
}

/**
 * Start a recording from anywhere. With a provider above, the recording
 * survives this component unmounting. Without one, `fallback` is a local
 * recorder the caller renders (it ends with the caller), so nothing breaks
 * before a host mounts the provider.
 */
export function useHelpVideoRecording(): {
  /** false when a recording is already in progress (show RECORDING_BUSY). */
  start: (opts?: StartRecordingOptions) => boolean
  active: boolean
  /** Render this somewhere in the caller. Null when a provider hosts the recorder. */
  fallback: ReactNode
} {
  const ctx = useContext(RecordingContext)
  const finish = useFinish()
  const [local, setLocal] = useState<Session | null>(null)
  const alive = useRef(true)
  const localRef = useRef<Session | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const start = useCallback(
    (opts: StartRecordingOptions = {}) => {
      const from = opts.from ?? (document.activeElement as HTMLElement | null)
      const s: Session = {
        ...opts,
        alive: () => alive.current,
        host: modalHostOf(from) ?? null
      }
      if (ctx) return ctx.start(s)
      if (localRef.current) return false
      localRef.current = s
      setLocal(s)
      return true
    },
    [ctx]
  )

  const fallback =
    !ctx && local ? (
      <HelpVideoRecorder
        open
        videoId={local.videoId}
        contexts={local.contexts}
        barHost={local.host}
        onClose={() => {
          localRef.current = null
          setLocal(null)
        }}
        onDone={(video) => {
          finish(local, video)
          localRef.current = null
          setLocal(null)
        }}
      />
    ) : null

  return { start, active: ctx ? ctx.active : !!local, fallback }
}

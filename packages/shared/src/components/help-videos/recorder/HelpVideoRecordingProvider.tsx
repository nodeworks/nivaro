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
import { helpVideoKeys } from '../api'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import { useHelpVideosPath } from '../viewer/HelpVideoSheet'
import { HelpVideoRecorder } from './HelpVideoRecorder'

export type StartRecordingOptions = {
  /** Where the new video shows (a new recording only). */
  contexts?: HelpVideoContext[]
  /** Re-record this video instead of making a new one. */
  videoId?: string
  /** Called with the saved video when the caller is still mounted. When the
   *  caller is gone (or gave none) the provider opens the editor instead. */
  onDone?: (video: HelpVideoDto) => void
}

export const RECORDING_BUSY = 'A recording is already in progress.'

type Session = StartRecordingOptions & { alive: () => boolean }

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
 * first route change. Hosts mount this once, above their router outlet.
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

  return (
    <RecordingContext.Provider value={value}>
      {children}
      <HelpVideoRecorder
        open={!!session}
        videoId={session?.videoId}
        contexts={session?.contexts}
        // "Gone", never "cancelled": the limit notice calls onDone and then onClose.
        onClose={() => {
          current.current = null
          setSession(null)
        }}
        onDone={(video) => {
          const s = current.current
          if (s) finish(s, video)
        }}
      />
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
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const start = useCallback(
    (opts: StartRecordingOptions = {}) => {
      const s: Session = { ...opts, alive: () => alive.current }
      if (ctx) return ctx.start(s)
      setLocal((cur) => cur ?? s)
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
        onClose={() => setLocal(null)}
        onDone={(video) => finish(local, video)}
      />
    ) : null

  return { start, active: ctx ? ctx.active : !!local, fallback }
}

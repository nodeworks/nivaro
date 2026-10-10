/**
 * Watch together (#1399) — the bar under the player: start sharing (you
 * lead), the roster, Copy watch link, Discuss (post the link to this moment
 * into a chat room) and Stop / Leave. Following happens here too: the
 * leader's playhead arrives over the socket and drives this player through
 * its controls. The logic is in ./watch-together.
 */
import { canOpenChatRoom, openChatRoom } from '@nivaro/shared'
import { Crown, Link2, MessageSquare, Users, X } from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { getSocket } from '@/lib/socket'
import type { ReplayControls } from './controls'
import { getDockRequest, getFloatingReplay } from './floating-store'
import {
  deniedText,
  followAction,
  getWatchSession,
  hostLeft,
  hostName,
  INITIAL_WATCH,
  leaderShouldSend,
  makeWatchKey,
  type RemoteState,
  replayLink,
  setWatchSession,
  useWatchSession,
  type Viewer,
  type WatchSession,
  watchReducer
} from './watch-together'

const pill =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2 text-[11.5px] text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted/40'

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.message(text)
  }
}

/** Joins the session's room while mounted and keeps the player in step. */
function useWatchRoom(
  recordingId: string,
  session: WatchSession | null,
  controlsRef: { current: ReplayControls | null },
  ready: boolean
) {
  const [state, dispatch] = useReducer(watchReducer, INITIAL_WATCH)
  const roleRef = useRef(state.role)
  roleRef.current = state.role
  const key = session?.key ?? null

  useEffect(() => {
    if (!key || !ready) return
    dispatch({ type: 'reset' })
    const socket = getSocket()
    const lead = () => getWatchSession()?.role === 'leader'
    let last: { time: number; playing: boolean; speed: number; at: number } | null = null
    const sendState = (force: boolean) => {
      const c = controlsRef.current
      if (!c || roleRef.current !== 'leader') return
      const now = { time: c.getTime(), playing: c.isPlaying(), speed: c.getSpeed(), at: Date.now() }
      if (!force && !leaderShouldSend(last, now)) return
      last = now
      socket.emit('replay:state', { key, playing: now.playing, time: now.time, speed: now.speed })
    }
    const join = () => socket.emit('replay:join', { key, recording: recordingId, lead: lead() })
    const onJoined = (p: { key?: string; leader?: boolean }) => {
      if (p?.key !== key) return
      dispatch({ type: 'joined', leader: !!p.leader })
      roleRef.current = p.leader ? 'leader' : 'follower'
      const s = getWatchSession()
      if (s && s.key === key && s.role !== roleRef.current) {
        setWatchSession({ ...s, role: roleRef.current })
      }
      if (p.leader) sendState(true)
    }
    const onRoster = (p: { key?: string; viewers?: Viewer[] }) => {
      if (p?.key === key) dispatch({ type: 'roster', viewers: p.viewers ?? [] })
    }
    const onState = (p: RemoteState & { key?: string }) => {
      if (p?.key !== key || roleRef.current !== 'follower') return
      dispatch({ type: 'remote', state: p })
      const c = controlsRef.current
      if (!c) return
      const step = followAction(
        { time: c.getTime(), playing: c.isPlaying(), speed: c.getSpeed() },
        p
      )
      if (step.speed != null) c.setSpeed(step.speed)
      if (step.seekTo != null || step.play != null) c.playAt(p.playing, step.seekTo ?? c.getTime())
    }
    const onNeedState = (p: { key?: string }) => {
      if (p?.key === key) sendState(true)
    }
    const onDenied = (p: { key?: string | null; reason?: string }) => {
      if (p?.key === key) dispatch({ type: 'denied', reason: p.reason ?? '' })
    }
    socket.on('replay:joined', onJoined)
    socket.on('replay:roster', onRoster)
    socket.on('replay:state', onState)
    socket.on('replay:need-state', onNeedState)
    socket.on('replay:denied', onDenied)
    // A reconnect re-authenticates and re-joins.
    socket.on('auth:ok', join)
    join()
    const beat = setInterval(() => sendState(false), 500)
    return () => {
      clearInterval(beat)
      socket.off('replay:joined', onJoined)
      socket.off('replay:roster', onRoster)
      socket.off('replay:state', onState)
      socket.off('replay:need-state', onNeedState)
      socket.off('replay:denied', onDenied)
      socket.off('auth:ok', join)
      socket.emit('replay:leave', { key })
      // Handing the replay to the floating window (or back) keeps the session;
      // closing it ends it.
      const handoff = getFloatingReplay()?.recording.id ?? getDockRequest()?.recording.id
      if (handoff !== recordingId && getWatchSession()?.key === key) setWatchSession(null)
    }
  }, [key, ready, recordingId, controlsRef])

  const takeLead = () => {
    const s = getWatchSession()
    if (!s || !key) return
    setWatchSession({ ...s, role: 'leader' })
    getSocket().emit('replay:join', { key, recording: recordingId, lead: true })
  }

  return { state, takeLead }
}

function Roster({ viewers }: { viewers: Viewer[] }) {
  if (viewers.length === 0) return null
  const shown = viewers.slice(0, 5)
  return (
    <span className='flex min-w-0 items-center gap-1' data-watch-roster=''>
      {shown.map((v) => (
        <span
          key={v.id}
          className='inline-flex max-w-[120px] items-center gap-1 truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
          title={v.leader ? `${v.name} — leading` : v.name}
        >
          {v.leader && <Crown className='h-3 w-3 shrink-0 text-amber-500' />}
          <span className='truncate'>{v.name}</span>
        </span>
      ))}
      {viewers.length > shown.length && (
        <span className='text-[11px] text-slate-400'>+{viewers.length - shown.length}</span>
      )}
    </span>
  )
}

interface ChatRoomRow {
  room: string
  kind: string
  label: string | null
}

/** Post the link to this moment (and the watch party, when there is one) into a chat room. */
function DiscussButton({ link }: { link: () => string }) {
  const [open, setOpen] = useState(false)
  const [rooms, setRooms] = useState<ChatRoomRow[] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let gone = false
    api
      .get<{ data: ChatRoomRow[] }>('/chat/rooms')
      .then((r) => !gone && setRooms((r.data.data ?? []).filter((x) => x.kind !== 'entity')))
      .catch(() => !gone && setRooms([]))
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => {
      gone = true
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  async function post(r: ChatRoomRow) {
    setBusy(true)
    try {
      const url = link()
      await api.post('/chat/messages', {
        room: r.room,
        message: note.trim() ? `${note.trim()} ${url}` : `Watching a session replay: ${url}`,
        mentions: []
      })
      toast.success(`Posted to ${r.label ?? r.room}`)
      setOpen(false)
      setNote('')
      if (canOpenChatRoom()) openChatRoom(r.room, r.label ?? undefined)
    } catch {
      toast.error('Could not post to that room')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={boxRef} className='relative'>
      <button
        type='button'
        className={pill}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-watch-discuss=''
        title='Post a link to this moment into a chat room'
      >
        <MessageSquare className='h-3 w-3' /> Discuss
      </button>
      {open && (
        <div className='absolute bottom-full left-0 z-20 mb-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-card'>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Add a note (optional)'
            className='mb-1.5 h-7 w-full rounded border border-slate-200 bg-transparent px-2 text-[12px] dark:border-border'
          />
          <div className='max-h-48 overflow-y-auto'>
            {rooms == null ? (
              <p className='px-1 py-2 text-[11.5px] text-slate-400'>Loading rooms…</p>
            ) : rooms.length === 0 ? (
              <p className='px-1 py-2 text-[11.5px] text-slate-400'>
                No chat rooms — use Copy link instead.
              </p>
            ) : (
              rooms.map((r) => (
                <button
                  key={r.room}
                  type='button'
                  disabled={busy}
                  onClick={() => void post(r)}
                  className='block w-full truncate rounded px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-muted/40'
                >
                  {r.label ?? r.room}
                </button>
              ))
            )}
          </div>
          <button
            type='button'
            className='mt-1.5 flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11.5px] text-slate-500 hover:bg-slate-50 dark:hover:bg-muted/40'
            onClick={() => {
              void copy(link(), 'Link')
              setOpen(false)
            }}
          >
            <Link2 className='h-3 w-3' /> Copy link
          </button>
        </div>
      )}
    </div>
  )
}

export function WatchTogetherBar({
  recordingId,
  controlsRef,
  ready
}: {
  recordingId: string
  controlsRef: { current: ReplayControls | null }
  ready: boolean
}) {
  const session = useWatchSession(recordingId)
  const { state, takeLead } = useWatchRoom(recordingId, session, controlsRef, ready)
  if (!ready) return null

  const origin = window.location.origin
  const linkAt = (withKey: boolean) =>
    replayLink(
      origin,
      recordingId,
      controlsRef.current?.getTime() ?? 0,
      withKey ? session?.key : null
    )

  if (!session) {
    return (
      <div className='mt-1.5 flex flex-wrap items-center gap-2' data-watch-together=''>
        <button
          type='button'
          className={pill}
          data-watch-start=''
          title='Share a link — admins who open it follow your playhead, pauses and seeks'
          onClick={() => {
            const key = makeWatchKey()
            setWatchSession({ recordingId, key, role: 'leader' })
            void copy(
              replayLink(origin, recordingId, controlsRef.current?.getTime() ?? 0, key),
              'Watch link'
            )
          }}
        >
          <Users className='h-3 w-3' /> Watch together
        </button>
        <DiscussButton link={() => linkAt(false)} />
      </div>
    )
  }

  const leading = state.role === 'leader'
  const host = hostName(state)
  return (
    <div
      className='mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-violet-500/5 px-2 py-1'
      data-watch-together=''
      data-watch-role={state.role ?? 'joining'}
    >
      <span className='flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-violet-700 dark:text-violet-300'>
        <Users className='h-3.5 w-3.5' />
        {state.status === 'denied'
          ? deniedText(state.denied)
          : state.status === 'joining'
            ? 'Joining…'
            : leading
              ? 'You are leading'
              : hostLeft(state)
                ? 'The host left'
                : `Following ${host ?? 'the host'}`}
      </span>
      <Roster viewers={state.viewers} />
      <span className='flex-1' />
      {state.status === 'joined' && !leading && hostLeft(state) && (
        <button type='button' className={pill} onClick={takeLead} data-watch-take-lead=''>
          <Crown className='h-3 w-3' /> Take the lead
        </button>
      )}
      <button
        type='button'
        className={pill}
        onClick={() => void copy(linkAt(true), 'Watch link')}
        data-watch-copy=''
      >
        <Link2 className='h-3 w-3' /> Copy watch link
      </button>
      <DiscussButton link={() => linkAt(true)} />
      <button
        type='button'
        className={pill}
        onClick={() => setWatchSession(null)}
        data-watch-stop=''
      >
        <X className='h-3 w-3' /> {leading ? 'Stop' : 'Leave'}
      </button>
    </div>
  )
}

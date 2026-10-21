import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { useOptionalRealtime } from '../../../lib/realtime'
import type { SfuTokenConfig } from './huddle-sfu'
import {
  type HuddlePeer,
  type HuddleState,
  huddleStore,
  huddleSupport,
  type IceConfig
} from './huddle-store'
import { startHuddleExtras } from './useHuddleAudio'

const EMPTY: HuddlePeer[] = []

/**
 * A room's huddle, for its header and stage: who is in it (live roster), my
 * own state when I am in one (any room), and the controls. Everything is
 * silent when the host mounted no realtime adapter, the browser has no
 * WebRTC, or the instance turned huddles off — the buttons simply do not
 * render.
 */
export function useHuddle(room: string | null) {
  const realtime = useOptionalRealtime()
  const client = useNivaroClient()
  const support = useMemo(huddleSupport, [])
  const usable = !!realtime && support.audio && !!room

  // With a room, the answer carries a TURN credential for it; the plain lookup below only
  // asks whether huddles are on.
  const fetchIce = useCallback(
    (forRoom?: string) =>
      client
        .request<{ data: IceConfig }>(get('/chat/huddle/ice', forRoom ? { room: forRoom } : {}))
        .then((r) => r.data),
    [client]
  )
  const { data: ice } = useQuery({
    queryKey: ['nvr-huddle-ice'],
    queryFn: () => fetchIce(),
    enabled: usable,
    staleTime: 5 * 60_000
  })
  const enabled = usable && ice?.enabled !== false

  // #2859: the LiveKit token for a large huddle, minted for my socket once I am in the roster.
  const fetchSfu = useCallback(
    (forRoom: string, socket: string) =>
      client
        .request<{ data: SfuTokenConfig }>(get('/chat/huddle/sfu-token', { room: forRoom, socket }))
        .then((r) => r.data),
    [client]
  )

  useEffect(() => {
    if (realtime && support.audio) huddleStore.attach(realtime, fetchIce, fetchSfu)
    if (support.audio) startHuddleExtras() // #2845–#2848
  }, [realtime, support.audio, fetchIce, fetchSfu])

  const state: HuddleState = useSyncExternalStore(huddleStore.subscribe, huddleStore.getSnapshot)

  // The first paint reads the roster over REST; broadcasts keep it fresh after.
  const { data: presence } = useQuery({
    queryKey: ['nvr-huddle-presence', room],
    queryFn: () =>
      client
        .request<{ data: { room: string; peers: HuddlePeer[] } }>(
          get('/chat/huddle/presence', { room: room as string })
        )
        .then((r) => r.data.peers),
    enabled,
    staleTime: 20_000,
    refetchInterval: 60_000
  })
  useEffect(() => {
    if (room && presence) huddleStore.seedRoster(room, presence)
  }, [room, presence])
  const roster = useSyncExternalStore(
    huddleStore.subscribeRosters,
    () => (room ? (huddleStore.roster(room) ?? presence ?? EMPTY) : EMPTY),
    () => EMPTY
  )

  const active = state.status === 'joining' || state.status === 'live'
  const inThis = !!room && state.room === room && active
  const inOther = !!state.room && state.room !== room && active

  return {
    support,
    enabled,
    state,
    /** Everyone in this room's huddle (me included when I am in). */
    roster,
    inThis,
    inOther,
    maxParticipants: ice?.max_participants ?? 8,
    join: () => {
      if (room) void huddleStore.join(room)
    },
    leave: () => huddleStore.leave(),
    toggleMute: () => huddleStore.setMuted(!state.muted),
    toggleShare: () => (state.sharing ? huddleStore.stopShare() : void huddleStore.startShare()),
    clearError: () => huddleStore.clearError()
  }
}

export type HuddleHandle = ReturnType<typeof useHuddle>

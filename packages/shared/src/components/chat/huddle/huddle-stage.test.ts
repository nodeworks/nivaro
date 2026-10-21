import { describe, expect, it, vi } from 'vitest'
import { MAX_LIVE_CAMERAS, pausedCameras, videoLayout } from './huddle-camera'
import {
  contentRect,
  DRAW_CHANNEL_ID,
  drawStore,
  MARK_LIFE_MS,
  markOpacity,
  parseDrawMsg
} from './huddle-draw'
import { HUDDLE_REACTIONS, handQueue, isHuddleReaction, reactionFeed } from './huddle-reactions'
import { type HuddleTransport, huddleStore, mergeRoster } from './huddle-store'

describe('raised hands (#2857)', () => {
  it('queues people in the order their hands went up, skipping lowered ones', () => {
    const q = handQueue([
      { socket: 'A', hand_at: 30 },
      { socket: 'B', hand_at: null },
      { socket: 'C', hand_at: 10 },
      { socket: 'D' },
      { socket: 'E', hand_at: 30 }
    ])
    expect(q.map((p) => p.socket)).toEqual(['C', 'A', 'E'])
  })

  it('knows the six reactions and nothing else', () => {
    expect(HUDDLE_REACTIONS).toHaveLength(6)
    expect(isHuddleReaction('👍')).toBe(true)
    expect(isHuddleReaction('💩')).toBe(false)
    expect(isHuddleReaction(1)).toBe(false)
  })

  it('a reaction cannot be sent outside a live huddle', () => {
    expect(reactionFeed.send('👍', 'U1')).toBe(false)
    expect(reactionFeed.getSnapshot()).toHaveLength(0)
  })
})

describe('camera limit (#2858)', () => {
  const roster = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ socket: `S${i}`, cam: `c${i}`, cam_at: 100 - i }))

  it('keeps the first four cameras (by when they went on) live and pauses the rest', () => {
    expect(pausedCameras(roster(4)).size).toBe(0)
    // cam_at runs backwards here: S4 went on first, S0 last.
    expect([...pausedCameras(roster(6))].sort()).toEqual(['S0', 'S1'])
    expect(MAX_LIVE_CAMERAS).toBe(4)
  })

  it('ignores people without a camera', () => {
    expect(
      pausedCameras([
        ...roster(4),
        { socket: 'X', cam: null, cam_at: null },
        { socket: 'Y', cam: undefined, cam_at: undefined }
      ]).size
    ).toBe(0)
  })

  it('lays out one, two-column, or a strip when narrow', () => {
    expect(videoLayout(1, 600)).toBe('one')
    expect(videoLayout(3, 600)).toBe('two')
    expect(videoLayout(3, 320)).toBe('strip')
    expect(videoLayout(1, 320)).toBe('one')
    expect(videoLayout(2, 0)).toBe('two')
  })

  it('a roster merge keeps the camera stream and takes the new stage fields', () => {
    const camera = {} as MediaStream
    const merged = mergeRoster(
      [
        {
          socket: 'S1',
          user: 'U1',
          name: 'A',
          muted: false,
          screen: false,
          since: 1,
          audio: null,
          video: null,
          camera,
          connection: 'connected'
        }
      ],
      [
        {
          socket: 'S1',
          user: 'U1',
          name: 'A',
          muted: true,
          screen: false,
          since: 1,
          hand_at: 5,
          cam: 'c1',
          cam_at: 3
        }
      ],
      'ME'
    )
    expect(merged[0]).toMatchObject({ camera, muted: true, hand_at: 5, cam: 'c1' })
  })
})

describe('drawing messages (#2856)', () => {
  it('accepts well-formed messages and clamps coordinates to 0–1', () => {
    expect(parseDrawMsg(JSON.stringify({ t: 'pt', s: 'S1', x: 1.4, y: -2 }))).toEqual({
      t: 'pt',
      s: 'S1',
      x: 1,
      y: 0
    })
    expect(
      parseDrawMsg(JSON.stringify({ t: 'st', s: 'S1', id: 'a1', tool: 'pen', k: 2, p: [0.1, 0.2] }))
    ).toEqual({ t: 'st', s: 'S1', id: 'a1', tool: 'pen', k: 2, p: [0.1, 0.2] })
    expect(parseDrawMsg(JSON.stringify({ t: 'clr', s: 'S1' }))).toEqual({ t: 'clr', s: 'S1' })
  })

  it('drops junk from another browser', () => {
    expect(parseDrawMsg('not json')).toBeNull()
    expect(parseDrawMsg({} as unknown as string)).toBeNull()
    expect(parseDrawMsg(JSON.stringify({ t: 'pt', s: 'S1', x: 'a', y: 0 }))).toBeNull()
    expect(
      parseDrawMsg(JSON.stringify({ t: 'st', s: 'S1', id: 'a', tool: 'laser', k: 0, p: [] }))
    ).toBeNull()
    expect(
      parseDrawMsg(JSON.stringify({ t: 'st', s: 'S1', id: 'a', tool: 'pen', k: 0, p: [1] }))
    ).toBeNull()
    expect(
      parseDrawMsg(JSON.stringify({ t: 'st', s: 'S 1', id: 'a', tool: 'pen', k: 0, p: [] }))
    ).toBeNull()
    expect(parseDrawMsg('x'.repeat(20_000))).toBeNull()
    expect(DRAW_CHANNEL_ID).toBeGreaterThan(0)
  })

  it('fades marks over their last second and maps onto a letterboxed picture', () => {
    expect(markOpacity(0)).toBe(1)
    expect(markOpacity(MARK_LIFE_MS - 500)).toBeCloseTo(0.5)
    expect(markOpacity(MARK_LIFE_MS)).toBe(0)
    // A 16:9 picture in a square box sits in a band across the middle.
    expect(contentRect(160, 160, 1600, 900)).toEqual({ x: 0, y: 35, w: 160, h: 90 })
    expect(contentRect(100, 50, 0, 0)).toEqual({ x: 0, y: 0, w: 100, h: 50 })
  })

  it('builds strokes from incremental chunks, fills gaps, clears, and forgets after 4 s', () => {
    const t0 = 1_000_000
    drawStore.apply('P1', { t: 'st', s: 'SCR', id: 'x', tool: 'pen', k: 0, p: [0.1, 0.1] }, t0)
    drawStore.apply('P1', { t: 'st', s: 'SCR', id: 'x', tool: 'pen', k: 2, p: [0.3, 0.3] }, t0)
    const mark = drawStore.getSnapshot().marks.get('SCR')?.[0]
    expect(mark?.pts).toEqual([
      [0.1, 0.1],
      [0.1, 0.1],
      [0.3, 0.3]
    ])
    drawStore.apply('P2', { t: 'pt', s: 'SCR', x: 0.5, y: 0.5 }, t0)
    expect(drawStore.pointing('SCR', t0)).toBe(2)
    expect(drawStore.prune(t0 + MARK_LIFE_MS - 1)).toBe(true)
    expect(drawStore.prune(t0 + MARK_LIFE_MS)).toBe(false)
    expect(drawStore.getSnapshot().marks.size).toBe(0)

    drawStore.apply('P1', { t: 'pt', s: 'SCR', x: 0.5, y: 0.5 }, t0)
    drawStore.apply('P1', { t: 'clr', s: 'SCR' }, t0)
    expect(drawStore.getSnapshot().pointers.size).toBe(0)
  })
})

describe('store extensions', () => {
  it('a plugged-in module gets the transport and can unplug', () => {
    const offs: string[] = []
    const transport: HuddleTransport = {
      on: (ev) => () => offs.push(ev),
      emit: vi.fn()
    }
    huddleStore.attach(transport, async () => ({
      enabled: true,
      iceServers: [],
      ttl_s: 60,
      max_participants: 8
    }))
    const attach = vi.fn(() => [() => offs.push('ext')])
    const unplug = huddleStore.use({ attach })
    expect(attach).toHaveBeenCalledWith(transport)
    // Not in a huddle: nothing is sent (attach itself may subscribe to live badges, #2851).
    expect(huddleStore.send('huddle:react', { emoji: '👍' })).toBe(false)
    expect(transport.emit).not.toHaveBeenCalledWith('huddle:react', expect.anything())
    unplug()
    expect(offs).toContain('ext')
  })
})

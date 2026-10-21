import { describe, expect, it } from 'vitest'
import {
  formatElapsed,
  huddleStore,
  type LivePeer,
  mergeRoster,
  peerSummary,
  politeFor
} from './huddle-store'

const peer = (socket: string, over: Partial<LivePeer> = {}): LivePeer => ({
  socket,
  user: `U-${socket}`,
  name: socket,
  muted: false,
  screen: false,
  since: 1,
  audio: null,
  video: null,
  connection: 'new',
  ...over
})

describe('politeFor', () => {
  it('is deterministic and opposite on the two sides', () => {
    expect(politeFor('A', 'B')).toBe(true)
    expect(politeFor('B', 'A')).toBe(false)
  })
})

describe('mergeRoster', () => {
  it('keeps streams for peers that stay, drops the ones who left, never lists me', () => {
    const audio = {} as MediaStream
    const current = [peer('S1', { audio, connection: 'connected' }), peer('S2')]
    const next = mergeRoster(
      current,
      [
        { socket: 'S1', user: 'U-S1', name: 'Rob', muted: true, screen: false, since: 1 },
        { socket: 'S3', user: 'U-S3', name: 'Amy', muted: false, screen: true, since: 2 },
        { socket: 'ME', user: 'U-ME', name: 'Me', muted: false, screen: false, since: 3 }
      ],
      'ME'
    )
    expect(next.map((p) => p.socket)).toEqual(['S1', 'S3'])
    expect(next[0]).toMatchObject({ audio, connection: 'connected', muted: true, name: 'Rob' })
    expect(next[1]).toMatchObject({ screen: true, connection: 'new', audio: null })
  })
})

describe('peerSummary + formatElapsed', () => {
  it('names up to two people, then counts', () => {
    expect(peerSummary([])).toBe('')
    expect(peerSummary([{ name: 'Rob' }])).toBe('Rob')
    expect(peerSummary([{ name: 'Rob' }, { name: null }])).toBe('Rob and Someone')
    expect(peerSummary([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('A, B and 1 other')
    expect(peerSummary([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])).toBe(
      'A, B and 2 others'
    )
  })
  it('formats m:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
  })
})

describe('SFU source routing in the store (#2858)', () => {
  const store = huddleStore as any
  const stream = (id: string) => ({ id }) as unknown as MediaStream

  it('files a camera under the camera tile and a screen under the screen slot, per socket', () => {
    store.set({
      room: 'ch:1',
      status: 'live',
      self: 'ME',
      mode: 'sfu',
      peers: [peer('A'), peer('B')]
    })
    try {
      store.onSfuTrack('A', 'camera', stream('cam-a'))
      store.onSfuTrack('B', 'screen', stream('scr-b'))
      let s = huddleStore.getSnapshot()
      expect(s.peers.find((p) => p.socket === 'A')).toMatchObject({
        camera: { id: 'cam-a' },
        video: null
      })
      expect(s.peers.find((p) => p.socket === 'B')).toMatchObject({ video: { id: 'scr-b' } })
      expect(s.peers.find((p) => p.socket === 'B')?.camera ?? null).toBeNull()

      // A paused (muted) camera leaves its tile; the screen of someone else stays.
      store.onSfuTrackEnd('A', 'camera')
      s = huddleStore.getSnapshot()
      expect(s.peers.find((p) => p.socket === 'A')?.camera).toBeNull()
      expect(s.peers.find((p) => p.socket === 'B')?.video).toMatchObject({ id: 'scr-b' })

      // Closing the mesh after the switch keeps what the SFU delivers, drops mesh-only frames.
      store.updatePeer('A', { video: stream('mesh-frozen') })
      store.closeMeshLinks()
      s = huddleStore.getSnapshot()
      expect(s.peers.find((p) => p.socket === 'A')?.video).toBeNull()
      expect(s.peers.find((p) => p.socket === 'B')?.video).toMatchObject({ id: 'scr-b' })
    } finally {
      store.teardown()
    }
  })
})

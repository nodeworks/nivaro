import { describe, expect, it } from 'vitest'
import {
  BURST_POINTS,
  installMouseTail,
  TAIL_MAX_POINTS,
  TAIL_MS,
  type TailPoint,
  tailRuns
} from './mouse-tail'

const pt = (x: number, at: number): TailPoint => ({ x, y: x, at })

// jsdom has no iframe sandbox token list; rrweb's rebuild checks it (as in live.test.ts).
if (!('sandbox' in HTMLIFrameElement.prototype)) {
  Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return (this.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean)
    }
  })
}

describe('tailRuns', () => {
  it('joins positions that fire a frame or so apart', () => {
    const points = [pt(1, 0), pt(2, 16), pt(3, 33), pt(4, 50)]
    expect(tailRuns(points, 60)).toEqual([points])
  })

  it('joins a few positions per frame (fast playback)', () => {
    const points = [pt(1, 0), pt(2, 0.5), pt(3, 16), pt(4, 16.5)]
    expect(tailRuns(points, 20)).toEqual([points])
  })

  it('never strokes a burst of positions fired together (catch-up)', () => {
    const burst = Array.from({ length: 300 }, (_, i) => pt(i, 100 + i * 0.01))
    expect(tailRuns(burst, 110)).toEqual([])
  })

  it('carries on from where the burst left the cursor', () => {
    const burst = Array.from({ length: BURST_POINTS + 1 }, (_, i) => pt(i, 100 + i * 0.01))
    const after = [pt(50, 116), pt(51, 132)]
    const last = burst[burst.length - 1]
    expect(tailRuns([pt(-1, 84), ...burst, ...after], 140)).toEqual([[last, ...after]])
  })

  it('drops points older than the trail', () => {
    expect(tailRuns([pt(1, 0), pt(2, 16), pt(3, 32)], 16 + TAIL_MS)).toEqual([])
  })
})

function fakeCanvas() {
  const calls: string[] = []
  const ctx = {
    clearRect: () => calls.push('clear'),
    beginPath: () => calls.push('begin'),
    moveTo: () => calls.push('move'),
    lineTo: () => calls.push('line'),
    stroke: () => calls.push('stroke'),
    lineWidth: 0,
    lineCap: '',
    strokeStyle: ''
  }
  const canvas = { width: 800, height: 600, getContext: () => ctx } as unknown as HTMLCanvasElement
  return { canvas, calls }
}

function harness() {
  const { canvas, calls } = fakeCanvas()
  const host = { mouseTail: canvas, drawMouseTail: (_p: { x: number; y: number }) => {} }
  let t = 0
  const frames: Array<() => void> = []
  const stop = installMouseTail(host, {
    strokeStyle: '#00ceff',
    now: () => t,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {}
  })
  const flush = () => {
    for (const cb of frames.splice(0)) cb()
  }
  return {
    host,
    calls,
    stop,
    flush,
    at: (ms: number) => {
      t = ms
    }
  }
}

describe('installMouseTail', () => {
  it('draws a burst of rrweb calls once, with no line through it', () => {
    const h = harness()
    for (let i = 0; i < 2_000; i++) h.host.drawMouseTail({ x: i, y: i })
    h.flush()
    expect(h.calls).toEqual(['clear'])
  })

  it('strokes ordinary motion', () => {
    const h = harness()
    for (const ms of [0, 16, 33]) {
      h.at(ms)
      h.host.drawMouseTail({ x: ms, y: ms })
      h.flush()
    }
    expect(h.calls.slice(-6)).toEqual(['clear', 'begin', 'move', 'line', 'line', 'stroke'])
  })

  it('receives the cursor positions a real rrweb Replayer plays', async () => {
    const { Replayer } = await import('rrweb')
    const node = (id: number, tagName: string, childNodes: unknown[] = []) => ({
      type: 2,
      id,
      tagName,
      attributes: {},
      childNodes
    })
    const T0 = 1_700_000_000_000
    const events = [
      { type: 4, data: { href: 'http://x/', width: 800, height: 600 }, timestamp: T0 },
      {
        type: 2,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [node(2, 'html', [node(3, 'head'), node(4, 'body')])]
          },
          initialOffset: { top: 0, left: 0 }
        },
        timestamp: T0 + 10
      }
    ]
    const root = document.createElement('div')
    document.body.appendChild(root)
    const rep = new Replayer(events as never[], { root, mouseTail: { strokeStyle: '#00ceff' } })
    try {
      rep.pause(100)
      const seen: Array<{ x: number; y: number }> = []
      const stop = installMouseTail(rep, {
        strokeStyle: '#00ceff',
        requestFrame: () => 1,
        cancelFrame: () => {}
      })
      const host = rep as unknown as {
        drawMouseTail: (p: { x: number; y: number }) => void
        moveAndHover: (x: number, y: number, id: number, isSync: boolean, d: unknown) => void
      }
      const ours = host.drawMouseTail
      host.drawMouseTail = (p) => {
        seen.push(p)
        ours(p)
      }
      host.moveAndHover(10, 20, 4, false, {})
      host.moveAndHover(30, 40, 4, true, {})
      expect(seen).toHaveLength(1)
      stop()
    } finally {
      rep.destroy()
      root.remove()
    }
  })

  it('clears the canvas once the trail has expired', () => {
    const h = harness()
    h.at(0)
    h.host.drawMouseTail({ x: 1, y: 1 })
    h.at(16)
    h.host.drawMouseTail({ x: 2, y: 2 })
    h.flush()
    h.calls.length = 0
    h.at(16 + TAIL_MS)
    h.host.drawMouseTail({ x: 3, y: 3 })
    h.flush()
    expect(h.calls).toEqual(['clear'])
  })

  it('keeps a bounded number of points', () => {
    const h = harness()
    for (let i = 0; i < TAIL_MAX_POINTS * 3; i++) {
      h.at(i * 5)
      h.host.drawMouseTail({ x: i, y: i })
    }
    h.flush()
    expect(h.calls.filter((c) => c === 'line').length).toBeLessThan(TAIL_MAX_POINTS)
  })

  it('stops drawing once stopped', () => {
    const h = harness()
    h.stop()
    h.host.drawMouseTail({ x: 1, y: 1 })
    h.flush()
    expect(h.calls).toEqual([])
  })
})

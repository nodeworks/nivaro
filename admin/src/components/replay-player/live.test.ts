import { Replayer } from 'rrweb'
import { afterEach, describe, expect, it } from 'vitest'
import { LIVE_LAG_MS, liveStartOffset, REPLAY_FRAME_STYLE_RULES, startLiveFollow } from './live'

describe('liveStartOffset', () => {
  it('starts the lag budget before the newest event', () => {
    const events = [{ timestamp: 1_000 }, { timestamp: 31_000 }, { timestamp: 21_000 }]
    expect(liveStartOffset(events)).toBe(30_000 - LIVE_LAG_MS)
  })

  it('never starts before the recording', () => {
    expect(liveStartOffset([{ timestamp: 5_000 }, { timestamp: 6_000 }])).toBe(0)
  })

  it('ignores rows without a timestamp', () => {
    expect(liveStartOffset([null, { type: 5 }, { timestamp: 0 }, { timestamp: 10_000 }], 0)).toBe(
      10_000
    )
    expect(liveStartOffset([])).toBe(0)
  })
})

// rrweb serialized node types: 0 Document, 1 DocumentType, 2 Element, 3 Text.
const T0 = 1_700_000_000_000
const el = (id: number, tagName: string, childNodes: unknown[] = [], attributes = {}) => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes
})

/**
 * A running recording: the first snapshot holds only the app shell (sidebar);
 * the page outlet mounts two seconds later as a mutation, as a lazy route does.
 */
function runningRecording() {
  return [
    { type: 4, timestamp: T0, data: { href: 'https://app.test/', width: 1280, height: 720 } },
    {
      type: 2,
      timestamp: T0 + 10,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            el(2, 'html', [
              el(3, 'head'),
              el(4, 'body', [el(5, 'nav', [{ type: 3, id: 6, textContent: 'Sidebar' }])])
            ])
          ]
        }
      }
    },
    {
      type: 3,
      timestamp: T0 + 2_000,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [
          // Mutation adds are flat: each node names its parent.
          { parentId: 4, nextId: null, node: el(7, 'main', [], { class: 'page-enter' }) },
          { parentId: 7, nextId: null, node: { type: 3, id: 8, textContent: 'Content' } }
        ]
      }
    },
    // The person keeps working: events up to a minute in, so the outlet is
    // well before the live edge.
    { type: 3, timestamp: T0 + 60_000, data: { source: 1, positions: [] } }
  ]
}

// jsdom has no HTMLIFrameElement.sandbox; rrweb-snapshot reads it to confirm it
// rebuilds into its own sandboxed frame.
if (!('sandbox' in HTMLIFrameElement.prototype)) {
  Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return (this.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean)
    }
  })
}

const replayers: Replayer[] = []
afterEach(() => {
  for (const r of replayers.splice(0)) r.destroy()
  document.body.replaceChildren()
})

function liveReplayer(events: unknown[]) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const rep = new Replayer(events as never[], {
    root,
    liveMode: true,
    mouseTail: false,
    insertStyleRules: REPLAY_FRAME_STYLE_RULES
  })
  replayers.push(rep)
  return rep
}

describe('startLiveFollow (real rrweb)', () => {
  it('joins mid-session with the content view built and the frame playing', async () => {
    const events = runningRecording()
    const rep = liveReplayer(events)
    startLiveFollow(rep, events)
    await new Promise((r) => setTimeout(r, 20))
    const doc = rep.iframe.contentDocument as Document
    expect(doc.querySelector('nav')?.textContent).toBe('Sidebar')
    // The outlet mounted after the first snapshot: it must be there.
    expect(doc.querySelector('main')?.textContent).toBe('Content')
    // Not held paused: rrweb's paused rule would freeze the outlet's entrance animation.
    expect(doc.documentElement.classList.contains('rrweb-paused')).toBe(false)
  })

  it("rrweb's startLive() alone left the outlet out and the frame paused (the bug)", async () => {
    const events = runningRecording()
    const rep = liveReplayer(events)
    rep.startLive(T0 + 60_000 - LIVE_LAG_MS)
    await new Promise((r) => setTimeout(r, 20))
    const doc = rep.iframe.contentDocument as Document
    expect(doc.querySelector('nav')).not.toBeNull()
    expect(doc.querySelector('main')).toBeNull()
    expect(doc.documentElement.classList.contains('rrweb-paused')).toBe(true)
  })

  it('applies streamed events after the live edge', async () => {
    const events = runningRecording()
    const rep = liveReplayer(events)
    startLiveFollow(rep, events, 0)
    rep.addEvent({
      type: 3,
      timestamp: T0 + 60_001,
      data: {
        source: 0,
        texts: [{ id: 8, value: 'Updated' }],
        attributes: [],
        removes: [],
        adds: []
      }
    } as never)
    await new Promise((r) => setTimeout(r, 60))
    expect((rep.iframe.contentDocument as Document).querySelector('main')?.textContent).toBe(
      'Updated'
    )
  })
})

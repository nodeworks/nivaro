import { describe, expect, it } from 'vitest'
import {
  buildReplayPlan,
  renderPlaywrightScript,
  selectorFor
} from '../../../services/session-replay-script.js'

/** A small serialised page, in the shape rrweb records. */
const SNAPSHOT = {
  id: 1,
  type: 0,
  tagName: 'html',
  childNodes: [
    {
      id: 2,
      type: 2,
      tagName: 'body',
      childNodes: [
        { id: 3, type: 2, tagName: 'button', attributes: { id: 'save' } },
        { id: 4, type: 2, tagName: 'input', attributes: { name: 'title' } },
        {
          id: 5,
          type: 2,
          tagName: 'div',
          attributes: { 'data-testid': 'grid' },
          childNodes: [
            { id: 6, type: 2, tagName: 'span' },
            { id: 7, type: 2, tagName: 'span' }
          ]
        },
        { id: 8, type: 2, tagName: 'a', attributes: { 'aria-label': 'Open record' } }
      ]
    }
  ]
}

const meta = (href = 'https://app.example.com/records/1') => ({
  type: 4,
  timestamp: 1000,
  data: { href, width: 1280, height: 800 }
})
const snapshot = { type: 2, timestamp: 1000, data: { node: SNAPSHOT } }
const click = (id: number, timestamp: number, type = 2) => ({
  type: 3,
  timestamp,
  data: { source: 2, type, id }
})

describe('selectorFor', () => {
  const plan = buildReplayPlan([meta(), snapshot])
  // rebuild the index the same way the planner does
  const index = (() => {
    const nodes = new Map<number, unknown>()
    const parents = new Map<number, number>()
    const walk = (n: Record<string, unknown>, p: number | null) => {
      nodes.set(n.id as number, n)
      if (p !== null) parents.set(n.id as number, p)
      for (const c of (n.childNodes as Record<string, unknown>[]) ?? []) walk(c, n.id as number)
    }
    walk(SNAPSHOT as unknown as Record<string, unknown>, null)
    return { nodes, parents } as never
  })()

  it('prefers an id', () => {
    expect(selectorFor(3, index)).toBe('#save')
  })

  it('uses name, then aria-label, before falling back to structure', () => {
    expect(selectorFor(4, index)).toBe('input[name="title"]')
    expect(selectorFor(8, index)).toBe('a[aria-label="Open record"]')
  })

  it('anchors a structural path at the nearest identified ancestor', () => {
    // second span inside [data-testid="grid"]
    expect(selectorFor(7, index)).toBe('[data-testid="grid"] > span:nth-of-type(2)')
  })

  it('returns null for an unknown node rather than inventing a selector', () => {
    expect(selectorFor(999, index)).toBeNull()
    expect(plan.startUrl).toBe('https://app.example.com/records/1')
  })
})

describe('buildReplayPlan', () => {
  it('takes the start url and viewport from the meta event', () => {
    const plan = buildReplayPlan([meta(), snapshot])
    expect(plan.startUrl).toBe('https://app.example.com/records/1')
    expect(plan.viewport).toEqual({ width: 1280, height: 800 })
  })

  it('keeps clicks with the operator’s own pacing', () => {
    const plan = buildReplayPlan([meta(), snapshot, click(3, 2500), click(8, 4000)])
    expect(plan.steps).toEqual([
      { delayMs: 1500, kind: 'click', selector: '#save' },
      { delayMs: 1500, kind: 'click', selector: 'a[aria-label="Open record"]' }
    ])
  })

  it('ignores mouse moves and mutations — those are the page responding, not the user', () => {
    const plan = buildReplayPlan([
      meta(),
      snapshot,
      { type: 3, timestamp: 1200, data: { source: 1, positions: [] } },
      { type: 3, timestamp: 1300, data: { source: 0, adds: [] } },
      click(3, 2000)
    ])
    expect(plan.steps).toHaveLength(1)
  })

  it('resolves a click on content added after the snapshot', () => {
    const plan = buildReplayPlan([
      meta(),
      snapshot,
      {
        type: 3,
        timestamp: 1500,
        data: {
          source: 0,
          adds: [{ parentId: 2, node: { id: 20, type: 2, tagName: 'button', attributes: { id: 'later' } } }]
        }
      },
      click(20, 2000)
    ])
    expect(plan.steps).toEqual([{ delayMs: 1000, kind: 'click', selector: '#later' }])
  })

  it('marks masked input once per field instead of typing asterisks', () => {
    const input = (id: number, timestamp: number) => ({
      type: 3,
      timestamp,
      data: { source: 5, id, text: '********' }
    })
    const plan = buildReplayPlan([meta(), snapshot, input(4, 2000), input(4, 2100), input(4, 2200)])
    expect(plan.maskedInputs).toBe(1)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].kind).toBe('input')
    expect(plan.steps[0].note).toMatch(/masked/i)
  })

  it('counts interactions whose node is unknown rather than emitting a bad selector', () => {
    const plan = buildReplayPlan([meta(), snapshot, click(4242, 2000)])
    expect(plan.unresolved).toBe(1)
    expect(plan.steps).toHaveLength(0)
  })

  it('caps a long idle gap so a replay does not sit for an hour', () => {
    const plan = buildReplayPlan([meta(), snapshot, click(3, 1000 + 60 * 60 * 1000)])
    expect(plan.steps[0].delayMs).toBe(30_000)
  })

  it('records an in-session navigation as a goto', () => {
    const plan = buildReplayPlan([
      meta(),
      snapshot,
      { ...meta('https://app.example.com/queues'), timestamp: 3000 }
    ])
    expect(plan.steps).toEqual([{ delayMs: 2000, kind: 'navigate', url: 'https://app.example.com/queues' }])
  })
})

describe('renderPlaywrightScript', () => {
  const plan = buildReplayPlan([meta(), snapshot, click(3, 2500)])
  const script = renderPlaywrightScript(plan, { id: 'abc', user: 'Robert Lee', startedAt: '2026-08-14' })

  it('targets BASE_URL, not the recorded host', () => {
    expect(script).toContain("const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3057'")
    expect(script).toContain('await page.goto(`${BASE_URL}/records/1`)')
    expect(script).not.toContain('https://app.example.com/records/1`)')
  })

  it('refuses a non-local target unless explicitly confirmed', () => {
    expect(script).toContain("process.env.REPLAY_CONFIRM !== '1'")
    expect(script).toContain('Refusing to replay against')
  })

  it('preserves the pacing and the click', () => {
    expect(script).toContain('await page.waitForTimeout(1500)')
    expect(script).toContain('await page.locator("#save").first().click()')
  })

  it('leaves masked inputs as TODOs, commented out', () => {
    const withInput = renderPlaywrightScript(
      buildReplayPlan([
        meta(),
        snapshot,
        { type: 3, timestamp: 2000, data: { source: 5, id: 4, text: '****' } }
      ]),
      { id: 'abc', user: null, startedAt: null }
    )
    expect(withInput).toContain('// TODO fill:')
    expect(withInput).toContain('// await page.locator("input[name=\\"title\\"]").first().fill(\'\')')
  })
})

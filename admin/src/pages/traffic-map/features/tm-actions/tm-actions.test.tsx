// Traffic Map node actions (#2152 #2274 #2215 #2273 #2223 #2229): the client's pure parts and
// that every piece registers where the map looks for it.
import { describe, expect, it } from 'vitest'
import { nodeBadges, sideBadges } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { pagePanels } from '../../registry/pagePanels'
import { toolbarItems } from '../../registry/toolbarItems'
import './index'
import { activeSummary } from './active-actions'
import { type BlastRadius, dependents } from './blast-radius'
import { draftPatch, knobValid } from './detector-settings'
import { type ExtLens, type ExtLensData, lensBadgeFor } from './ext-lenses'
import { blastNodeOf, cacheTargetOf, debugTargetOf } from './shared'

const UID = 'AAAAAAAA-0000-4000-8000-000000000001'

describe('which nodes get which action', () => {
  it('blast radius: endpoints and partners', () => {
    expect(blastNodeOf({ kind: 'entity', id: 'items/orders' })).toBe('items/orders')
    expect(blastNodeOf({ kind: 'down', id: 'ext:4' })).toBe('ext:4')
    expect(blastNodeOf({ kind: 'down', id: 'db' })).toBeNull()
    expect(blastNodeOf({ kind: 'caller', id: 'k1' })).toBeNull()
  })
  it('debug window: endpoints, API keys and people', () => {
    expect(debugTargetOf({ kind: 'entity', id: 'queries/12' })).toBe('queries/12')
    expect(debugTargetOf({ kind: 'caller', id: 'k12' })).toBe('k12')
    expect(debugTargetOf({ kind: 'caller', id: `u${UID}` })).toBe(`u${UID}`)
    expect(debugTargetOf({ kind: 'caller', id: 'cron:sync' })).toBeNull()
  })
  it('temporary cache: ordinary collections only', () => {
    expect(cacheTargetOf({ kind: 'entity', id: 'items/orders' })).toBe('items/orders')
    expect(cacheTargetOf({ kind: 'entity', id: 'items/nivaro_users' })).toBeNull()
    expect(cacheTargetOf({ kind: 'entity', id: 'system/nivaro_users' })).toBeNull()
    expect(cacheTargetOf({ kind: 'entity', id: 'pages/home' })).toBeNull()
  })
})

describe('pure helpers', () => {
  it('summarises open actions', () => {
    expect(activeSummary(1, 0)).toBe('1 debug window')
    expect(activeSummary(2, 1)).toBe('2 debug windows · 1 cache')
    expect(activeSummary(0, 3)).toBe('3 caches')
  })

  it('counts what depends on a node', () => {
    const b = {
      screens: [{}],
      flows: [{}, {}],
      jobs: [],
      callers: [{}],
      partners: [],
      collections: []
    } as unknown as BlastRadius
    expect(dependents(b)).toBe(4)
  })

  it('sends only changed detector values, and checks ranges', () => {
    expect(
      draftPatch(
        { fanout: { enabled: true, limit: 60 }, duplicates: { enabled: true, window_ms: 500 } },
        { fanout: { enabled: false, limit: 60 }, duplicates: { enabled: true, window_ms: 500 } }
      )
    ).toEqual({ fanout: { enabled: false } })
    const k = { key: 'limit', label: 'L', unit: 'calls', min: 5, max: 10, def: 6 }
    expect(knobValid(k, 7)).toBe(true)
    expect(knobValid(k, 11)).toBe(false)
    expect(knobValid(k, Number.NaN)).toBe(false)
  })

  it('takes a node badge from the first lens that is on and badges', () => {
    const lens = (key: string, node_badge = true): ExtLens => ({
      key,
      extension: 'wh',
      id: key,
      label: key,
      description: null,
      node_badge,
      panel_title: key
    })
    const data = (node: string, text: string): ExtLensData => ({
      badges: [{ node, text, tone: 'warn' }],
      panels: [],
      summary: null
    })
    const held = new Map([
      ['a', { lens: lens('a', false), data: data('items/orders', 'hidden') }],
      ['b', { lens: lens('b'), data: data('items/orders', '4 late') }]
    ])
    expect(lensBadgeFor(held, 'items/orders')).toEqual({ text: '4 late', tone: 'warn' })
    expect(lensBadgeFor(held, 'items/other')).toBeNull()
  })
})

describe('registrations', () => {
  it('registers every piece in the map’s registries', () => {
    const ids = (list: Array<{ id: string }>) => list.map((x) => x.id)
    expect(ids(inspectorPanels)).toEqual(
      expect.arrayContaining(['blast-radius', 'debug-window', 'temp-cache', 'ext-lenses'])
    )
    expect(ids(toolbarItems)).toEqual(
      expect.arrayContaining(['tm-active-actions', 'detector-settings', 'ext-lenses'])
    )
    expect(ids(pagePanels)).toContain('detector-settings')
    expect(ids(nodeBadges)).toEqual(expect.arrayContaining(['temp-cache', 'ext-lenses']))
    expect(ids(sideBadges)).toContain('ext-lenses')
  })
})

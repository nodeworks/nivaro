// #2229 extension lenses: registration, the shape the map may draw, time limits.
import { createTestContext } from '@nivaro/extension-kit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listExtensionLenses,
  readExtensionLens,
  registerExtensionLens,
  resetExtensionLenses,
  safeHref,
  sanitizeLensData,
  unregisterExtensionLenses
} from './ext-lenses.js'

afterEach(() => resetExtensionLenses())

describe('registerExtensionLens', () => {
  it('keys lenses by extension and refuses malformed ones', () => {
    expect(registerExtensionLens('wh', { id: 'orders', label: 'Orders', read: () => ({}) })).toBe(
      'wh:orders'
    )
    expect(() =>
      registerExtensionLens('wh', { id: 'Bad Id', label: 'x', read: () => ({}) })
    ).toThrow()
    expect(() => registerExtensionLens('wh', { id: 'ok', label: '', read: () => ({}) })).toThrow()
    expect(() => registerExtensionLens('wh', { id: 'ok', label: 'x' } as never)).toThrow()
    expect(listExtensionLenses()).toEqual([
      {
        key: 'wh:orders',
        extension: 'wh',
        id: 'orders',
        label: 'Orders',
        description: null,
        node_badge: true,
        panel_title: 'Orders'
      }
    ])
  })
})

describe('sanitizeLensData', () => {
  it('keeps only what the map draws, capped and with safe links', () => {
    const d = sanitizeLensData({
      badges: [
        { node: 'items/orders', text: 'late 4 and a very long tail of text', tone: 'warn' },
        { node: 'bad node!', text: 'x' },
        { node: 'ext:9', text: '', tone: 'error' },
        { node: 'k7', text: 'ok', tone: 'purple' }
      ],
      panels: [
        {
          node: 'items/orders',
          title: 'Warehouse',
          rows: [
            { label: 'Late', value: 4, tone: 'warn', href: '/collections/orders?late=1' },
            { label: 'Bad link', value: 'x', href: 'javascript:alert(1)' },
            { label: 'Other host', value: 'x', href: '//evil.example' },
            { label: '', value: 'dropped' }
          ]
        },
        { node: 'items/empty', rows: [] }
      ],
      summary: 'Four late orders'
    })
    expect(d.badges).toEqual([
      { node: 'items/orders', text: 'late 4 and a very long t', tone: 'warn' },
      { node: 'k7', text: 'ok', tone: 'info' }
    ])
    expect(d.panels).toHaveLength(1)
    expect(d.panels[0].rows).toEqual([
      { label: 'Late', value: '4', tone: 'warn', href: '/collections/orders?late=1' },
      { label: 'Bad link', value: 'x', tone: null, href: null },
      { label: 'Other host', value: 'x', tone: null, href: null }
    ])
    expect(d.summary).toBe('Four late orders')
  })

  it('in-app paths only', () => {
    expect(safeHref('/a/b')).toBe('/a/b')
    expect(safeHref('https://x')).toBeNull()
    expect(safeHref('/\\evil')).toBeNull()
    expect(safeHref('/a" onmouseover="x')).toBeNull()
  })
})

describe('readExtensionLens', () => {
  it('answers the sanitized data, honours the switches, and times out', async () => {
    registerExtensionLens('wh', {
      id: 'a',
      label: 'A',
      nodeBadge: false,
      read: ({ window }) => ({
        badges: [{ node: 'k1', text: String(window) }],
        panels: [{ node: 'k1', rows: [{ label: 'w', value: window }] }]
      })
    })
    const d = await readExtensionLens('wh:a', 300)
    expect(d.badges).toEqual([])
    expect(d.panels[0].rows[0].value).toBe('300')
    registerExtensionLens('wh', { id: 'slow', label: 'Slow', read: () => new Promise(() => {}) })
    await expect(readExtensionLens('wh:slow', 60, 20)).rejects.toMatchObject({
      code: 'LENS_TIMEOUT'
    })
    registerExtensionLens('wh', {
      id: 'boom',
      label: 'Boom',
      read: () => {
        throw new Error('secret detail')
      }
    })
    await expect(readExtensionLens('wh:boom', 60)).rejects.toMatchObject({
      code: 'LENS_FAILED',
      status: 502
    })
    await expect(readExtensionLens('wh:none', 60)).rejects.toMatchObject({ status: 404 })
  })
})

describe('kit testing stub', () => {
  it('records registerLens', () => {
    const ctx = createTestContext()
    ctx.traffic.registerLens({ id: 'x', label: 'X', read: () => ({}) })
    expect(ctx.registered.trafficLenses.map((l) => l.id)).toEqual(['x'])
  })
})

describe('lifecycle', () => {
  it('joins a read already in flight for the same lens and window', async () => {
    let calls = 0
    const releases: Array<(v: never) => void> = []
    registerExtensionLens('wh', {
      id: 'poll',
      label: 'Poll',
      read: () => {
        calls++
        return new Promise((r) => {
          releases.push(r)
        })
      }
    })
    const a = readExtensionLens('wh:poll', 60)
    const b = readExtensionLens('wh:poll', 60)
    const c = readExtensionLens('wh:poll', 300)
    expect(a).toBe(b)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
    for (const r of releases) r({ summary: 'ok' } as never)
    await expect(a).resolves.toMatchObject({ summary: 'ok' })
    await c
    const d = readExtensionLens('wh:poll', 60)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(3) // settled flights are not reused
    for (const r of releases) r({} as never)
    await d
  })

  it('forgets an extension’s lenses when it is unloaded', () => {
    registerExtensionLens('wh', { id: 'a', label: 'A', read: () => ({}) })
    registerExtensionLens('other', { id: 'b', label: 'B', read: () => ({}) })
    unregisterExtensionLenses('wh')
    expect(listExtensionLenses().map((l) => l.key)).toEqual(['other:b'])
  })
})

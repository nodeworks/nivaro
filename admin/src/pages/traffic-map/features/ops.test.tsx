import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { pageContextHeaders, pagePattern } from '@/lib/page-context'
import { setSparkMarkerSource } from '../registry/sparkMarkers'
import { Sparkline } from '../Sparkline'
import type { Selection } from '../types'
import { breakerTargetOf, untilPhrase } from './breaker'
import { fmtUsd } from './caller-cost'
import { createMarkerSource } from './change-markers'
import { fmtAge } from './inflight'
import { appLabel } from './screens'

describe('page context headers (#1113 / #1116)', () => {
  it('turns a path into a route pattern with no ids', () => {
    expect(pagePattern('/collections/workflows/371367')).toBe('/collections/workflows/:id')
    expect(pagePattern('/records/workflows/CR26-80329/x?y=1')).toBe('/records/workflows/:id/x')
    expect(pagePattern('/users/aaaaaaaa-1111-2222-3333-444444444444')).toBe('/users/:id')
    expect(pagePattern('/')).toBe('/')
  })
  it('keeps one load id per path and rotates it on navigation', () => {
    window.history.pushState({}, '', '/collections/workflows/1')
    const a = pageContextHeaders('admin')
    const b = pageContextHeaders('admin')
    expect(a['x-nivaro-page']).toBe('/collections/workflows/:id')
    expect(a['x-nivaro-app']).toBe('admin')
    expect(a['x-nivaro-load']).toBe(b['x-nivaro-load'])
    window.history.pushState({}, '', '/collections/workflows/2')
    expect(pageContextHeaders('admin')['x-nivaro-load']).not.toBe(a['x-nivaro-load'])
    window.history.pushState({}, '', '/')
  })
})

describe('change markers (#1093)', () => {
  it('fetches once for a range, serves it from cache, widens on a range it does not cover', async () => {
    let t = 1_000_000
    const fetcher = vi.fn(async (from: number, to: number) => [
      { kind: 'deploy' as const, at: from + 10 * 60_000, label: 'Deployed 0.2.9 (was 0.2.8)' },
      { kind: 'config' as const, at: to - 60_000, label: 'Configuration changed' }
    ])
    const src = createMarkerSource(fetcher, () => t)
    const seen: number[] = []
    src.subscribe(() => seen.push(src.version()))
    expect(src.get(t - 60_000, t)).toEqual([])
    expect(src.get(t - 60_000, t)).toEqual([]) // in flight: no second fetch
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(seen.length).toBe(1))
    // the cache covers the asked range padded by 5 min each side
    expect(src.get(t - 60_000, t + 300_000).map((m) => m.kind)).toEqual(['deploy', 'config'])
    expect(src.get(t - 60_000, t)).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(1)
    t += 31_000 // stale → refetch in the background, cached list still served
    src.get(t - 60_000, t)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('a sparkline with a range draws the markers in it', () => {
    setSparkMarkerSource({
      get: () => [
        { kind: 'deploy', at: 1500, label: 'Deployed 0.2.9' },
        { kind: 'maintenance', at: 1200, until: 1400, label: 'Maintenance: db' }
      ],
      subscribe: () => () => {},
      version: () => 1
    })
    const { container } = render(
      <Sparkline data={[1, 2, 3]} range={{ from: 1000, to: 2000 }} className='h-4 w-20' />
    )
    const marks = container.querySelectorAll('[data-tm-marker]')
    expect(marks).toHaveLength(2)
    expect(marks[0].getAttribute('data-tm-marker')).toBe('deploy')
    expect((marks[0] as HTMLElement).style.left).toBe('50%')
    expect(marks[0].getAttribute('aria-label')).toMatch(/Deployed 0.2.9/)
    // no range: the plain spark
    const plain = render(<Sparkline data={[1, 2]} className='h-4' />)
    expect(plain.container.querySelector('[data-tm-marker]')).toBeNull()
    setSparkMarkerSource(null)
  })
})

describe('formatting', () => {
  it('ages, money, app names, breaker windows', () => {
    expect(fmtAge(450)).toBe('450 ms')
    expect(fmtAge(12_300)).toBe('12.3 s')
    expect(fmtAge(125_000)).toBe('2 min 5 s')
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(0.004)).toBe('$0.0040')
    expect(fmtUsd(1.234)).toBe('$1.23')
    expect(appLabel('efp-new')).toBe('EFP portal')
    expect(appLabel(null)).toBe('—')
    const now = Date.parse('2026-10-01T12:00:00Z')
    expect(untilPhrase(now + 15 * 60_000, now)).toMatch(/\(15 min\)/)
  })
  it('breakers target entities and real callers only', () => {
    const s = (kind: Selection['kind'], id: string) => ({ kind, id }) as Selection
    expect(breakerTargetOf(s('entity', 'items/workflows'))).toEqual({
      kind: 'entity',
      target: 'items/workflows'
    })
    expect(breakerTargetOf(s('caller', 'k12'))?.kind).toBe('caller')
    expect(breakerTargetOf(s('caller', 'cron'))).toBeNull()
    expect(breakerTargetOf(s('down', 'db'))).toBeNull()
    expect(breakerTargetOf(s('lane', 'items'))).toBeNull()
  })
})

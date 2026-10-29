// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { DesignTarget } from './design-context'
import {
  PERSONAL_DEFAULT_MARK,
  personalDefaultPlacements,
  usePersonalDefaultMarks
} from './personal-default-marks'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result = { current: undefined as T }
  function Probe() {
    result.current = hook()
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Probe)))
  act(() => root.unmount())
  return { result }
}

const placements = [
  { field: 'ship_to', group_key: 'g1', overrides: { personal_default: true } },
  { field: 'region', group_key: 'g1', overrides: JSON.stringify({ personal_default: true }) },
  { field: 'notes', group_key: 'g1', overrides: { personal_default: false } },
  { field: 'project', group_key: null, overrides: 'not json' }
] as never

const field = (f: string, g: string | null = 'g1'): DesignTarget => ({
  kind: 'field',
  field: f,
  group_key: g
})

describe('personalDefaultPlacements', () => {
  it('reads object and JSON-text overrides, only personal_default === true', () => {
    const set = personalDefaultPlacements({ placements })
    expect(set.size).toBe(2)
  })
})

describe('usePersonalDefaultMarks', () => {
  it('tags only the opted-in placement, keeping the marks before it', () => {
    const before = () => [{ text: 'Rule', tone: 'violet' as const }]
    const { result } = renderHook(() => usePersonalDefaultMarks({ placements }, before))
    const marks = result.current!
    expect(marks(field('ship_to')).map((m) => m.text)).toEqual(['Rule', 'Personal default'])
    expect(marks(field('region'))).toContainEqual(PERSONAL_DEFAULT_MARK)
    expect(marks(field('notes')).map((m) => m.text)).toEqual(['Rule'])
    // The same field placed in another section is a different placement.
    expect(marks(field('ship_to', 'g2')).map((m) => m.text)).toEqual(['Rule'])
    expect(marks({ kind: 'group', key: 'g1' }).map((m) => m.text)).toEqual(['Rule'])
  })

  it('passes the incoming marks through untouched when nothing is opted in', () => {
    const before = () => []
    const { result } = renderHook(() =>
      usePersonalDefaultMarks({ placements: [] as never }, before)
    )
    expect(result.current).toBe(before)
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { PersonalDefaultMark } from './PersonalDefaultControl'
import { type PersonalDefaultsApi, PersonalDefaultsContext } from './usePersonalDefaults'

function api(over: Partial<PersonalDefaultsApi>): PersonalDefaultsApi {
  return {
    allowed: () => true,
    loaded: true,
    failed: false,
    isNew: false,
    defaultFor: () => null,
    isDefault: () => false,
    ...over
  } as PersonalDefaultsApi
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mark(value: PersonalDefaultsApi | null): HTMLElement | null {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() =>
    root.render(
      <PersonalDefaultsContext.Provider value={value}>
        <PersonalDefaultMark field='ship_to' />
      </PersonalDefaultsContext.Provider>
    )
  )
  return host.querySelector('[data-personal-default-mark]')
}

describe('PersonalDefaultMark (Summary mode)', () => {
  it('renders nothing without the context or for a field the layout does not open', () => {
    expect(mark(null)).toBeNull()
    expect(mark(api({ allowed: () => false }))).toBeNull()
  })

  it('says the field takes a personal default when the reader has none', () => {
    const el = mark(api({}))!
    expect(el.getAttribute('data-personal-default-mark')).toBe('allowed')
    expect(el.getAttribute('aria-label')).toMatch(/save your own default/)
  })

  it('accents when this value IS the reader’s default', () => {
    const el = mark(api({ defaultFor: () => ({ value: 'x' }) as never, isDefault: () => true }))!
    expect(el.getAttribute('data-personal-default-mark')).toBe('mine')
    expect(el.className).toContain('text-cyan-700')
  })

  it('tells a saved-but-different default apart, and stays neutral while loading', () => {
    expect(
      mark(api({ defaultFor: () => ({ value: 'y' }) as never }))!.getAttribute(
        'data-personal-default-mark'
      )
    ).toBe('saved')
    expect(
      mark(api({ loaded: false, isDefault: () => true }))!.getAttribute(
        'data-personal-default-mark'
      )
    ).toBe('allowed')
  })
})

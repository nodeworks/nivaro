// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HelpVideoDto } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const registerPage = vi.fn((..._args: unknown[]) => Promise.resolve())
let required: HelpVideoDto[] = []
let forData: { data: HelpVideoDto[]; can_author: boolean; state: null } | undefined

vi.mock('../../../context', () => ({
  useNivaroClient: () => ({}),
  useNavigation: () => ({ navigate: () => {} })
}))
vi.mock('../api', () => ({
  helpVideoApi: () => ({ registerPage }),
  helpVideoKeys: { all: ['help-videos'] },
  useRequiredVideos: () => ({ data: required }),
  useRequiredList: () => ({ data: { data: required, paths: [] } }),
  useHelpVideosFor: () => ({ data: forData })
}))
vi.mock('../recorder/HelpVideoRecordingProvider', () => ({
  RECORDING_BUSY: 'busy',
  useHelpVideoRecording: () => ({ start: () => true, active: false, fallback: null })
}))
vi.mock('./HelpVideoSheet', () => ({
  useHelpVideosPath: () => () => '/help-videos',
  HelpVideoSheet: (p: { open: boolean }) =>
    p.open ? createElement('div', { 'data-sheet': '' }) : null
}))

const { RequiredVideosCard } = await import('./RequiredVideosCard')
const { HelpVideoButton } = await import('./HelpVideoButton')

const vid = (id: string) =>
  ({
    id,
    title: `Video ${id}`,
    required: true,
    my_progress: null,
    duration_ms: 1000,
    published: { playable: true }
  }) as unknown as HelpVideoDto

function mount(node: () => ReturnType<typeof createElement>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  const render = () => act(() => root.render(node()))
  render()
  return { el, render, root }
}

afterEach(() => {
  document.body.replaceChildren()
  registerPage.mockClear()
  required = []
  forData = undefined
})

describe('RequiredVideosCard', () => {
  it('keeps the sheet mounted after the list comes back empty while someone is watching', () => {
    required = [vid('a')]
    const h = mount(() => createElement(RequiredVideosCard))
    act(() => {
      ;(h.el.querySelector('[data-hv-required="a"]') as HTMLElement).click()
    })
    expect(document.querySelector('[data-sheet]')).not.toBeNull()
    // 18 of 20 buckets seen: the server stops listing it.
    required = []
    h.render()
    expect(h.el.querySelector('[data-hv-required-card]')).toBeNull()
    expect(document.querySelector('[data-sheet]')).not.toBeNull()
  })

  it('uses the muted tone when every video is still getting ready', () => {
    const v = vid('a')
    ;(v.published as { playable: boolean }).playable = false
    required = [v]
    const h = mount(() => createElement(RequiredVideosCard))
    const card = h.el.querySelector('[data-hv-required-card]') as HTMLElement
    expect(card.className).not.toContain('rose')
    expect(card.textContent).toContain('getting ready')
  })
})

describe('HelpVideoButton page registration', () => {
  it('never registers a page for a non-author', () => {
    forData = { data: [vid('a')], can_author: false, state: null }
    mount(() => createElement(HelpVideoButton, { page: 'orders', pageLabel: 'Orders' }))
    expect(registerPage).not.toHaveBeenCalled()
  })

  it('registers once for an author, however often it re-renders', () => {
    forData = { data: [], can_author: true, state: null }
    const h = mount(() => createElement(HelpVideoButton, { page: 'orders', pageLabel: 'Orders' }))
    h.render()
    h.render()
    expect(registerPage).toHaveBeenCalledTimes(1)
    expect(registerPage).toHaveBeenCalledWith('orders', 'Orders')
  })
})

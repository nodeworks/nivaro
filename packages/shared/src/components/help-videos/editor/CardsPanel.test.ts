// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setChapterBanners, setIntro } from '../edits'
import type { VideoEdits } from '../types'
import { CardsPanel } from './CardsPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  isAdmin: true,
  logo: null as string | null,
  upload: vi.fn(),
  request: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('../../../context', () => ({
  useItemEditAuth: () => ({ isAdmin: h.isAdmin, userId: 'U1' }),
  useNivaroClient: () => ({ upload: h.upload, request: h.request })
}))
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }))
vi.mock('../api', () => ({
  useCardBrand: () => ({ name: 'Acme', color: '#00ceff', logo: h.logo })
}))

const base: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
  poster_ms: 0,
  chapters: [{ id: 'c1', at_ms: 2000, title: 'One' }],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}

let root: Root
let host: HTMLDivElement
let onChange: ReturnType<typeof vi.fn>

function mount(edits: VideoEdits) {
  onChange = vi.fn()
  const qc = new QueryClient()
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(CardsPanel, {
          edits,
          videoTitle: 'Submit',
          videoDescription: null,
          onChange,
          onShow: () => {}
        })
      )
    )
  })
}
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null

beforeEach(() => {
  h.isAdmin = true
  h.logo = null
  h.upload.mockReset()
  h.request.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('CardsPanel motion controls', () => {
  it('shows a new card as subtle with a fade', () => {
    mount(setIntro(base, {}))
    expect(q('[data-hv-card-animation="intro:subtle"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-hv-card-transition="intro:fade"]')?.getAttribute('aria-pressed')).toBe('true')
  })
  it('stores the transition an author picks', () => {
    mount(setIntro(base, {}))
    act(() => q('[data-hv-card-transition="intro:wipe"]')?.click())
    expect((onChange.mock.calls[0][0] as VideoEdits).intro?.transition).toBe('wipe')
  })
  it('offers banner animation while banners are on', () => {
    mount(setChapterBanners(base, true))
    expect(q('[data-hv-banner-animation="subtle"]')?.getAttribute('aria-pressed')).toBe('true')
    act(() => q('[data-hv-banner-animation="lively"]')?.click())
    expect((onChange.mock.calls[0][0] as VideoEdits).banner_animation).toBe('lively')
  })
})

describe('CardsPanel logo notice', () => {
  it('tells an admin there is no logo and uploads one', async () => {
    h.upload.mockResolvedValue({ id: 'F1' })
    h.request.mockResolvedValue({})
    mount(setIntro(base, {}))
    expect(q('[data-hv-logo-missing]')).not.toBeNull()
    const input = host.querySelector('[data-hv-logo-missing] input[type=file]') as HTMLInputElement
    const file = new File(['x'], 'logo.svg', { type: 'image/svg+xml' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(h.upload).toHaveBeenCalledWith(file)
    expect(h.request).toHaveBeenCalledWith(
      expect.objectContaining({ _method: 'PATCH', _path: '/settings', _body: { brand_logo: 'F1' } })
    )
    expect(h.toastSuccess).toHaveBeenCalled()
  })
  it('points everyone else to Settings', () => {
    h.isAdmin = false
    mount(setIntro(base, {}))
    expect(q('[data-hv-logo-missing]')?.textContent).toMatch(/Settings → Project/)
    expect(q('[data-hv-logo-upload]')).toBeNull()
  })
  it('stays quiet when a logo is set', () => {
    h.logo = '/api/files/F1'
    mount(setIntro(base, {}))
    expect(q('[data-hv-logo-missing]')).toBeNull()
  })
})

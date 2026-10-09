// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelpVideoDto, VideoEdits } from '../types'
import { NO_CHANGES, PublishButton } from './PublishButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request = vi.fn()
vi.mock('../../../context', () => ({ useNivaroClient: () => ({ request }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The client sees a command object; the path says which call it is.
vi.mock('../../../lib/commands', () => ({
  get: (path: string) => ({ method: 'GET', path }),
  post: (path: string, body?: unknown) => ({ method: 'POST', path, body }),
  patch: (path: string, body?: unknown) => ({ method: 'PATCH', path, body }),
  put: (path: string, body?: unknown) => ({ method: 'PUT', path, body }),
  del: (path: string) => ({ method: 'DELETE', path })
}))

const video = {
  id: 'v1',
  title: 'Approve a PO',
  status: 'draft',
  contexts: [{ kind: 'page', key: 'home', state_key: null }],
  draft: { id: 'd1' },
  published: null
} as unknown as HelpVideoDto

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({ data: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.replaceChildren()
})

const reload = vi.fn()

async function publishWith(flush: () => Promise<boolean>, conflict = false) {
  const onPublished = vi.fn()
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(PublishButton, {
          video,
          beforePublish: flush,
          onPublished,
          conflict,
          onReload: reload
        })
      )
    )
  })
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-hv-publish]')?.click()
  })
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-hv-publish-confirm]')?.click()
  })
  return onPublished
}

describe('PublishButton', () => {
  it('publishes and reloads the draft once the save landed', async () => {
    const onPublished = await publishWith(async () => true)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/help-videos/v1/publish' })
    )
    expect(onPublished).toHaveBeenCalledTimes(1)
  })

  it('does not publish when the editor could not save, and says why', async () => {
    const onPublished = await publishWith(async () => false)
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: '/help-videos/v1/publish' })
    )
    expect(onPublished).not.toHaveBeenCalled()
    expect(document.querySelector('[data-hv-publish-note]')?.textContent).toContain(
      "Your latest edits haven't saved yet"
    )
  })

  it('after a conflict it says the draft changed elsewhere and offers Reload', async () => {
    await publishWith(async () => false, true)
    expect(document.querySelector('[data-hv-publish-note]')?.textContent).toContain(
      'changed somewhere else'
    )
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-hv-reload]')?.click()
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('PublishButton with nothing new to publish (I2)', () => {
  const edits = (over: Partial<VideoEdits> = {}): VideoEdits => ({
    v: 1,
    segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
    poster_ms: 0,
    chapters: [],
    annotations: [],
    zooms: [],
    blurs: [],
    captions: [],
    ...over
  })
  const live = (over: Partial<HelpVideoDto> = {}) =>
    ({
      ...video,
      status: 'published',
      published: { render_status: 'ready', rendered_current: true },
      draft: { id: 'd1', edits: edits(), source_duration_ms: 10_000 },
      draft_matches_published: true,
      required_role_ids: [],
      ...over
    }) as unknown as HelpVideoDto

  async function show(v: HelpVideoDto, props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(PublishButton, {
            video: v,
            beforePublish: async () => true,
            onPublished: () => {},
            ...props
          })
        )
      )
    })
    return host.querySelector<HTMLButtonElement>('[data-hv-publish]') as HTMLButtonElement
  }
  const open = async (b: HTMLButtonElement) => {
    await act(async () => b.click())
  }

  it('is disabled with the reason when the draft is what is published', async () => {
    const b = await show(live())
    expect(b.disabled).toBe(true)
    const reason = host.querySelector('[data-hv-publish-reason]')
    expect(reason?.textContent).toBe(NO_CHANGES)
    expect(b.getAttribute('aria-describedby')).toBe(reason?.id)
  })

  it('stays enabled while edits are still saving (the flag may be stale)', async () => {
    const b = await show(live(), { pending: true })
    expect(b.disabled).toBe(false)
    expect(host.querySelector('[data-hv-publish-reason]')).toBeNull()
  })

  it('offers only "ask to watch again" when someone must watch it', async () => {
    const b = await show(live({ required_role_ids: ['R1'] }))
    expect(b.disabled).toBe(false)
    expect(b.textContent).toBe('Ask to watch again')
    await open(b)
    expect(document.querySelector('[data-hv-publish-again-only]')).not.toBeNull()
    expect(document.querySelector('[data-hv-watch-again]')).toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-hv-publish-confirm]')?.click()
    })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/help-videos/v1/publish', body: { watch_again: true } })
    )
  })

  it('says viewers wait for the render when the edits hide or cut something', async () => {
    const blurred = edits({ blurs: [{ id: 'b', start_ms: 0, end_ms: 1000 } as never] })
    const b = await show(live({ draft_matches_published: false }), { edits: blurred })
    await open(b)
    const copy = document.querySelector('[data-hv-publish-copy]')
    expect(copy?.getAttribute('data-hv-publish-copy')).toBe('waits')
    expect(copy?.textContent).toContain('getting ready')
    expect(copy?.textContent).toContain('current version can’t be watched either')
  })

  it('a first publish that waits for the render says nothing about a current version', async () => {
    const trimmed = edits({ segments: [{ start_ms: 2000, end_ms: 10_000, speed: 1 }] })
    const b = await show(
      live({ status: 'draft', published: null, draft_matches_published: false }),
      { edits: trimmed }
    )
    await open(b)
    const copy = document.querySelector('[data-hv-publish-copy]')
    expect(copy?.getAttribute('data-hv-publish-copy')).toBe('waits')
    expect(copy?.textContent).not.toContain('current version')
  })

  it('says viewers get it straight away when nothing is hidden or cut', async () => {
    const b = await show(live({ draft_matches_published: false }))
    await open(b)
    expect(document.querySelector('[data-hv-publish-copy]')?.textContent).toContain('straight away')
  })
})

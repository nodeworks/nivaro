import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TemplateDetail } from './api'
import { DiscardDraftButton } from './DiscardDraftButton'
import { PayloadEditorContext, type PayloadEditorCtx } from './editor-context'

const calls = vi.hoisted(() => ({ order: [] as string[], post: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    post: (url: string, body: unknown) => {
      calls.order.push('post')
      return calls.post(url, body)
    }
  }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const template = {
  key: 'fusion-transfer-order',
  label: 'Fusion transfer order',
  published_version: 3,
  draft_rev: 7
} as TemplateDetail

function ctx(over: Partial<PayloadEditorCtx> = {}): PayloadEditorCtx {
  return {
    saveNow: async () => true,
    discardPending: vi.fn(async () => {
      calls.order.push('discardPending')
    }),
    adoptServerDraft: vi.fn(async () => {
      calls.order.push('adopt')
    }),
    raiseConflict: vi.fn(),
    markPublished: () => {},
    bumpRev: () => {},
    getLoadedVersion: () => 3,
    conflicted: false,
    saveError: null,
    rev: 8,
    getRev: () => 8,
    saving: false,
    recordId: null,
    recordLabel: null,
    pathNames: null,
    ...over
  }
}

function renderButton(c: PayloadEditorCtx) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PayloadEditorContext.Provider value={c}>
        <DiscardDraftButton template={template} />
      </PayloadEditorContext.Provider>
    </QueryClientProvider>
  )
}

describe('DiscardDraftButton', () => {
  it('takes two presses, drops the waiting autosave, sends the held rev, then adopts the server draft', async () => {
    calls.order = []
    calls.post.mockResolvedValue({ data: { rev: 9, unchanged: false } })
    const c = ctx()
    renderButton(c)
    fireEvent.click(screen.getByRole('button', { name: /Throw the draft away/ }))
    expect(calls.post).not.toHaveBeenCalled()
    expect(screen.getByText('Back to v3?')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard the draft and go back/ }))
    })
    expect(calls.post).toHaveBeenCalledWith(
      '/payload-templates/fusion-transfer-order/discard-draft',
      {
        base_rev: 8,
        base_published_version: 3
      }
    )
    expect(calls.order).toEqual(['discardPending', 'post', 'adopt'])
  })

  it('a 409 raises the conflict banner with the current row', async () => {
    calls.order = []
    const current = { ...template, draft_rev: 9 }
    calls.post.mockRejectedValue({ response: { status: 409, data: { current } } })
    const c = ctx()
    renderButton(c)
    fireEvent.click(screen.getByRole('button', { name: /Throw the draft away/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard the draft and go back/ }))
    })
    expect(c.raiseConflict).toHaveBeenCalledWith(expect.objectContaining({ draft_rev: 9 }))
    expect(c.adoptServerDraft).not.toHaveBeenCalled()
  })
})

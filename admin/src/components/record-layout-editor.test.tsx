import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Edit layout mode's admin wrapper: Done closes at once, and the record's
// layout queries are re-read only once the editor's last save has landed.

const h = vi.hoisted(() => ({ release: null as null | (() => void) }))

vi.mock('@/lib/layout-editor-host', () => ({
  AdminLayoutEditorHost: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@nivaro/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nivaro/shared')>()
  return {
    ...actual,
    LayoutEditor: (p: { onBack: (saved: Promise<void>) => void }) => (
      <button
        type='button'
        onClick={() =>
          p.onBack(
            new Promise<void>((r) => {
              h.release = r
            })
          )
        }
      >
        Done
      </button>
    )
  }
})

const { default: RecordLayoutEditor } = await import('./record-layout-editor')

describe('RecordLayoutEditor', () => {
  it('closes at once and re-reads the record layout after the last save', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const onClose = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <RecordLayoutEditor collection='orders' layoutId={7} recordId='5' onClose={onClose} />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // The host gets the save too: its record form stays quiet until it settles.
    expect(onClose.mock.calls[0][0]).toBeInstanceOf(Promise)
    expect(invalidate).not.toHaveBeenCalled()

    await act(async () => {
      h.release?.()
      await Promise.resolve()
    })
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(['active-layout', 'orders']))
    expect(keys).toContain(JSON.stringify(['field-config', 'orders']))
    expect(keys).toContain(JSON.stringify(['layout-meta']))
  })
})

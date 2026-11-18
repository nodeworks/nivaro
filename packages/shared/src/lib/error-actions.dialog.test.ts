import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSupportForError, registerSupportDialog } from './error-actions'
import type { ErrorDescription } from './error-message'

const d: ErrorDescription = {
  kind: 'server',
  title: 'Submission failed',
  hint: 'Try again.'
} as ErrorDescription

describe('openSupportForError with a dialog host', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the dialog in place, filled in, and never opens a tab', () => {
    const opened = vi.fn()
    const open = vi.fn(() => null)
    vi.stubGlobal('window', { open })
    const off = registerSupportDialog(opened)
    openSupportForError(d, { action: 'Auto-submit (MDSi)' })
    off()
    expect(open).not.toHaveBeenCalled()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened.mock.calls[0][0].title).toBe('Submission failed')
    expect(opened.mock.calls[0][0].description).toContain('Action: Auto-submit (MDSi)')
  })

  it('falls back to the Support page in a new tab without a host', () => {
    const open = vi.fn(() => ({ opener: {} }))
    vi.stubGlobal('window', { open })
    openSupportForError(d)
    expect(open).toHaveBeenCalledWith('/support?new=1', '_blank')
  })
})

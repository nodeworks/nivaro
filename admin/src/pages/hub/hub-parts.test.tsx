import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CopyButton } from './hub-parts'

// The Apps hub's one Copy button: copies when the browser can, otherwise shows the text selected
// with a note, and never takes a selection the person made back from them.

const saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const noClipboard = () =>
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

afterEach(() => {
  if (saved) Object.defineProperty(navigator, 'clipboard', saved)
  else Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
})

describe('CopyButton', () => {
  it('writes to the clipboard and says Copied', async () => {
    let written = ''
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (t: string) => {
          written = t
          return Promise.resolve()
        }
      },
      configurable: true
    })
    render(<CopyButton value='abc' label='Copy key' />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }))
    expect(await screen.findByText('Copied')).toBeTruthy()
    expect(written).toBe('abc')
  })

  it('without a clipboard shows the text selected once, and keeps a later selection', async () => {
    noClipboard()
    const { rerender } = render(<CopyButton value='demo_staging' label='Copy Login' compact />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Login' }))
    const box = (await screen.findByRole('textbox', { name: 'Copy Login' })) as HTMLInputElement
    expect(box.value).toBe('demo_staging')
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 12])
    expect(screen.getByText(/Copying is not available here/)).toBeTruthy()
    // The person narrows the selection; a re-render (a refetch) must not select it all again.
    box.setSelectionRange(2, 5)
    rerender(<CopyButton value='demo_staging' label='Copy Login' compact />)
    expect([box.selectionStart, box.selectionEnd]).toEqual([2, 5])
  })

  it('a refused write falls back the same way', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true
    })
    render(<CopyButton value='x' label='Copy ticket' />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy ticket' }))
    expect(await screen.findByRole('textbox', { name: 'Copy ticket' })).toBeTruthy()
  })

  it('compact is an icon button with the label as its name', () => {
    render(<CopyButton value='x' label='Copy Login' compact />)
    const b = screen.getByRole('button', { name: 'Copy Login' })
    expect(b.textContent).toBe('')
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CellCopyLayer, provideCopyText } from './CellCopyLayer'
import { fulfilmentCopyText } from './FulfilmentPill'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const writeText = vi.fn(async (_: string) => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  // jsdom has no layout: innerText and Range rects are missing.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? ''
    }
  })
  Range.prototype.getBoundingClientRect = () => ({ right: 0 }) as DOMRect
})

const roots: ReturnType<typeof createRoot>[] = []

afterEach(async () => {
  // Only the first live layer listens — unmount so the next test's layer owns.
  for (const r of roots.splice(0)) await act(async () => r.unmount())
  document.body.innerHTML = ''
})

async function mountCell(cell: string) {
  const host = document.createElement('div')
  host.innerHTML = `<table data-copy-cells><tbody><tr><td>${cell}</td></tr></tbody></table>`
  document.body.appendChild(host)
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const root = createRoot(mount)
  roots.push(root)
  await act(async () => root.render(<CellCopyLayer />))
  const td = host.querySelector('td') as HTMLTableCellElement
  await act(async () => {
    td.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  return { td, button: () => document.querySelector<HTMLButtonElement>('[data-cell-copy-btn]') }
}

describe('CellCopyLayer', () => {
  it('copies the displayed text of a plain cell', async () => {
    const { button } = await mountCell('<span>12 / 18 · Partial</span>')
    expect(button()?.getAttribute('aria-label')).toBe('Copy cell value')
    await act(async () => button()?.click())
    expect(writeText).toHaveBeenCalledWith('12 / 18 · Partial')
  })

  it('copies what a data-copy-source element provides', async () => {
    const { td, button } = await mountCell(
      '<span data-copy-source data-copy-label="Copy with latest events">1 / 2 · Partial</span>'
    )
    provideCopyText(td.querySelector('[data-copy-source]') as HTMLElement, async () => 'full text')
    expect(button()?.getAttribute('aria-label')).toBe('Copy with latest events')
    await act(async () => button()?.click())
    expect(writeText).toHaveBeenCalledWith('full text')
  })

  it('falls back to the displayed text when the provider fails or nobody answers', async () => {
    const { td, button } = await mountCell('<span data-copy-source>1 / 2 · Partial</span>')
    await act(async () => button()?.click())
    expect(writeText).toHaveBeenLastCalledWith('1 / 2 · Partial')
    provideCopyText(td.querySelector('[data-copy-source]') as HTMLElement, () =>
      Promise.reject(new Error('offline'))
    )
    await act(async () => {
      td.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => button()?.click())
    expect(writeText).toHaveBeenLastCalledWith('1 / 2 · Partial')
  })
})

describe('fulfilmentCopyText', () => {
  it('lists every event in full', () => {
    const long = 'MWF was never told (MWF — order number) — no send was ever attempted'
    const text = fulfilmentCopyText('1 / 2 · Partial', 'MDSi', [
      {
        id: '1',
        source: 'external',
        label: 'via reconcile',
        context: null,
        text: long,
        created_at: '2026-11-02T05:36:00Z'
      },
      {
        id: '2',
        source: 'external',
        label: 'x',
        context: 'Sales order SO000637938',
        text: 'Backorder via FedEx Ground',
        created_at: '2026-10-29T15:25:00Z'
      }
    ])
    const lines = text.split('\n')
    expect(lines[0]).toBe('1 / 2 · Partial')
    expect(lines[2]).toBe('MDSi · Latest events')
    expect(lines[4]).toMatch(/^via reconcile · Nov 2, 2026/)
    expect(lines[5]).toBe(long)
    expect(lines[7]).toMatch(/^Sales order SO000637938 · Oct 29, 2026/)
    expect(lines[8]).toBe('Backorder via FedEx Ground')
  })

  it('says so when there are no events', () => {
    expect(fulfilmentCopyText('Shipped', null, [])).toBe(
      'Shipped\n\nLatest events\nNo events recorded yet.'
    )
  })
})

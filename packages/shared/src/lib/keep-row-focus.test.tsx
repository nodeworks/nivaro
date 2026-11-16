// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useKeepRowCheckboxFocus } from './keep-row-focus'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A list like the browser's: the <tbody> re-keys on every refresh (version). */
function List({ rows, version }: { rows: string[]; version: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepRowCheckboxFocus(ref)
  return (
    <div ref={ref}>
      <table>
        <tbody key={version}>
          {rows.map((id) => (
            <tr key={id} data-row-key={id}>
              <td>
                <input type='checkbox' aria-label={`Select ${id}`} />
              </td>
              <td>
                <button type='button'>Open {id}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

let root: Root | null = null
let host: HTMLElement | null = null
let outside: HTMLButtonElement | null = null

function mount(rows: string[], version: number) {
  host = document.createElement('div')
  document.body.appendChild(host)
  outside = document.createElement('button')
  outside.textContent = 'elsewhere'
  document.body.appendChild(outside)
  root = createRoot(host)
  act(() => root?.render(<List rows={rows} version={version} />))
}
const rerender = (rows: string[], version: number) =>
  act(() => root?.render(<List rows={rows} version={version} />))
const box = (id: string) =>
  host?.querySelector<HTMLInputElement>(`[data-row-key="${id}"] input`) as HTMLInputElement
const flush = () => act(() => new Promise((r) => setTimeout(r, 5)))

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  outside?.remove()
  root = null
})

describe('useKeepRowCheckboxFocus', () => {
  it('puts focus back on the same row when a live update removes another row', async () => {
    mount(['a', 'b', 'c'], 1)
    box('b').focus()
    expect(document.activeElement).toBe(box('b'))
    rerender(['a', 'b'], 2) // c went away; the tbody remounted
    await flush()
    expect(document.activeElement).toBe(box('b'))
    expect(document.activeElement?.closest('tr')?.getAttribute('data-row-key')).toBe('b')
  })

  it('never takes focus when nothing in the list had it', async () => {
    mount(['a', 'b'], 1)
    outside?.focus()
    rerender(['a'], 2)
    await flush()
    expect(document.activeElement).toBe(outside)
  })

  it('lets go once focus moves to another control, or the person blurs it', async () => {
    mount(['a', 'b', 'c'], 1)
    box('a').focus()
    outside?.focus()
    rerender(['a', 'b'], 2)
    await flush()
    expect(document.activeElement).toBe(outside)

    box('a').focus()
    box('a').blur()
    await flush()
    rerender(['a'], 3)
    await flush()
    expect(document.activeElement).toBe(document.body)
  })

  it('does not chase a row that itself left the list', async () => {
    mount(['a', 'b'], 1)
    box('b').focus()
    rerender(['a'], 2)
    await flush()
    expect(document.activeElement).toBe(document.body)
  })
})

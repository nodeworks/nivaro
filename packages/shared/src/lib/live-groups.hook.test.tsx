// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useSteadyGroups } from './live-groups'

type Row = { id: string }
type G = { key: string; count: number; rows: Row[] }

function List({ groups }: { groups: G[] }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const steady = useSteadyGroups(groups, (r) => r.id, ref, { resetKey: 'k' })
  return (
    <div ref={ref} data-testid='list'>
      {steady.groups.map((g) => (
        <section key={g.key} data-group-key={g.key}>
          <h4>
            {g.key} ({g.group?.count ?? 0})
          </h4>
          {g.rows.map((r) => (
            <p
              key={r.id}
              data-row-key={r.id}
              data-moving={steady.movingTo(r.id) ?? undefined}
              data-gone={steady.isGone(r.id) || undefined}
            >
              {r.id}
            </p>
          ))}
        </section>
      ))}
    </div>
  )
}

const rows = (...ids: string[]) => ids.map((id) => ({ id }))
const before: G[] = [
  { key: 'Open', count: 2, rows: rows('1', '2') },
  { key: 'Closed', count: 1, rows: rows('3') }
]
const after: G[] = [
  { key: 'Open', count: 1, rows: rows('2') },
  { key: 'Closed', count: 2, rows: rows('1', '3') }
]

const order = (el: HTMLElement) =>
  [...el.querySelectorAll('section')].map(
    (s) =>
      `${s.getAttribute('data-group-key')}:${[...s.querySelectorAll('[data-row-key]')]
        .map((p) => p.getAttribute('data-row-key'))
        .join(',')}`
  )

let root: Root | null = null
let host: HTMLDivElement | null = null
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function mount(groups: G[]) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(<List groups={groups} />))
  return {
    list: host.querySelector('[data-testid="list"]') as HTMLElement,
    rerender: (g: G[]) => act(() => root?.render(<List groups={g} />))
  }
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

describe('useSteadyGroups', () => {
  it('moves a row to its new group at once when nobody points at the list', () => {
    const { list, rerender } = mount(before)
    rerender(after)
    expect(order(list)).toEqual(['Open:2', 'Closed:1,3'])
  })

  it('holds the arrangement under the pointer, counts live, then moves on leave', () => {
    const { list, rerender } = mount(before)
    act(() => {
      list
        .querySelector('[data-row-key="3"]')
        ?.dispatchEvent(new Event('pointerover', { bubbles: true }))
    })
    rerender(after)
    expect(order(list)).toEqual(['Open:1,2', 'Closed:3'])
    expect(list.querySelector('[data-row-key="1"]')?.getAttribute('data-moving')).toBe('Closed')
    // Counts are the live truth even while rows hold still.
    expect(list.textContent).toContain('Open (1)')
    expect(list.textContent).toContain('Closed (2)')
    act(() => {
      list.dispatchEvent(new Event('pointerleave'))
    })
    expect(order(list)).toEqual(['Open:2', 'Closed:1,3'])
  })
})

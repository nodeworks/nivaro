// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { formSkeletonFromLayout } from '../lib/skeleton-shapes'
import { FormSkeleton, TableSkeletonRows } from './Skeletons'
import { SlowNoticeView } from './SlowNotice'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(node))
  return {
    host,
    done: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

describe('shape-matched skeletons (#3229)', () => {
  it('table rows carry one cell per real column (plus leading cells) at the real padding', () => {
    const { host, done } = mount(
      <table>
        <tbody>
          <TableSkeletonRows
            columns={[
              { key: 'name', shape: 'text' },
              { key: 'amount', shape: 'number' },
              { key: 'due', shape: 'date' }
            ]}
            rows={3}
            leadingCells={1}
            rowClassName='h-8'
            cellClassName='px-3 py-1.5'
          />
        </tbody>
      </table>
    )
    const rows = host.querySelectorAll('tr[data-skeleton-row]')
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.querySelectorAll('td')).toHaveLength(4)
      expect(r.className).toContain('h-8')
    }
    // every cell holds one 20px line box, so a skeleton row is as tall as a text row
    expect(rows[0].querySelectorAll('td > span.h-5')).toHaveLength(3)
    // numbers sit on the right like the real cells
    expect(rows[0].querySelectorAll('td')[2].innerHTML).toContain('justify-end')
    done()
  })

  it('a form placeholder paints the layout’s own section titles and field spans', () => {
    const plan = formSkeletonFromLayout({
      groups: [{ id: 1, key: 'main', label: 'Main details', type: 'section', sort: 1 }],
      assignments: [
        { field: 'a', group_key: 'main', sort: 1, col_span: 6, is_visible: true },
        { field: 'b', group_key: 'main', sort: 2, col_span: 6, is_visible: true }
      ]
    })
    const { host, done } = mount(<FormSkeleton plan={plan} />)
    expect(host.textContent).toContain('Main details')
    const cells = host.querySelectorAll<HTMLElement>('[style*="grid-column"]')
    expect([...cells].map((c) => c.style.gridColumn)).toEqual(['span 6', 'span 6'])
    done()
  })
})

describe('SlowNoticeView (#3231)', () => {
  it('says the reason and the elapsed time, politely', () => {
    const { host, done } = mount(
      <SlowNoticeView
        reason={{
          slow: true,
          elapsedMs: 8200,
          text: 'Waiting for a free slot — busy right now (2 ahead of you)',
          answer: { found: true, kind: 'slot', position: 3, of: 4 }
        }}
        variant='pill'
      />
    )
    const el = host.querySelector('[role="status"]') as HTMLElement
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.dataset.slowNotice).toBe('slot')
    expect(el.textContent).toContain('Waiting for a free slot')
    expect(el.textContent).toContain('8s')
    done()
  })
})

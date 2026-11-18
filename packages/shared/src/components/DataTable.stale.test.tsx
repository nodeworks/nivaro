// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { DataTable } from './DataTable'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(isStale: boolean) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <DataTable
        columns={[{ key: 'name', header: 'Name' }]}
        rows={[{ name: 'Beth' }]}
        total={1}
        page={1}
        isStale={isStale}
        searchValue=''
        onSearchChange={() => {}}
        onPageChange={() => {}}
      />
    )
  )
  const done = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { host, done }
}

describe('DataTable isStale (previous rows while the next page/filter loads)', () => {
  it('dims the rows and marks them busy, never the search box', () => {
    const { host, done } = mount(true)
    const body = host.querySelector('[data-stale]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.className).toContain('opacity-60')
    expect(body.getAttribute('aria-busy')).toBe('true')
    expect(body.textContent).toContain('Beth')
    const search = host.querySelector('input')
    expect(search?.closest('[data-stale]')).toBeNull()
    done()
  })

  it('shows the rows normally once the answer is current', () => {
    const { host, done } = mount(false)
    expect(host.querySelector('[data-stale]')).toBeNull()
    expect(host.querySelector('[aria-busy]')).toBeNull()
    done()
  })
})

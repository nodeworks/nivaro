// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedMemberQuery, usePagedMembers } from './chat-core'
import { MemberLoadMore, MemberSearchBox, memberCountLabel } from './MemberPaging'

// #3082: a very large room pages its members from the server — first page, debounced search,
// true total, load more.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const paths = vi.hoisted(() => [] as string[])
const ALL = Array.from({ length: 120 }, (_, i) => ({
  user: `U${i}`,
  first_name: i === 77 ? 'Zelda' : `Person${i}`,
  last_name: 'Test',
  title: null,
  online: i < 3
}))

vi.mock('../../context', () => ({
  useNivaroClient: () => ({
    request: async (c: { _path?: string }) => {
      const path = c._path ?? ''
      paths.push(path)
      const url = new URL(path, 'http://x')
      const limit = Number(url.searchParams.get('limit'))
      const offset = Number(url.searchParams.get('offset'))
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const hits = ALL.filter((m) => !q || m.first_name.toLowerCase().includes(q))
      const data = hits.slice(offset, offset + limit)
      return { data, total: hits.length, has_more: offset + data.length < hits.length }
    }
  })
}))

function Harness() {
  const [q, setQ] = useState('')
  const debounced = useDebouncedMemberQuery(q, 250)
  const p = usePagedMembers('room', '/chat/channels/1/members', debounced, true)
  return createElement(
    'div',
    null,
    createElement(MemberSearchBox, { value: q, onChange: setQ }),
    createElement('p', { id: 'count' }, memberCountLabel(p.total, !!debounced)),
    createElement('ul', null, ...p.members.map((m) => createElement('li', { key: m.id }, m.name))),
    createElement(MemberLoadMore, {
      hasMore: p.hasMore,
      loading: p.loadingMore,
      onLoad: p.loadMore
    })
  )
}

let host: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  paths.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(Harness)
      )
    )
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('paged member list (#3082)', () => {
  it('shows only the first page and the true total', async () => {
    await flush()
    expect(host.querySelectorAll('li')).toHaveLength(50)
    expect(host.querySelector('#count')?.textContent).toBe('120 members')
    expect(paths[0]).toContain('limit=50')
    expect(paths[0]).toContain('offset=0')
  })

  it('load more appends the next page', async () => {
    await flush()
    const more = host.querySelector<HTMLButtonElement>('[data-chat-member-more]')
    expect(more).not.toBeNull()
    await act(async () => {
      more?.click()
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(host.querySelectorAll('li')).toHaveLength(100)
    expect(paths.at(-1)).toContain('offset=50')
  })

  it('search is debounced and asks the server', async () => {
    await flush()
    const input = host.querySelector<HTMLInputElement>('[data-chat-member-search]')
    expect(input).not.toBeNull()
    const before = paths.length
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'zel')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(paths.length).toBe(before)
    await flush()
    expect(paths.at(-1)).toContain('q=zel')
    await flush()
    expect(host.querySelectorAll('li')).toHaveLength(1)
    expect(host.querySelector('#count')?.textContent).toBe('1 match')
  })

  it('count label formats thousands', () => {
    expect(memberCountLabel(1248, false)).toBe('1,248 members')
    expect(memberCountLabel(1, false)).toBe('1 member')
  })
})

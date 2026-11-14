// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { CommentPanel } from './CommentPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Rob 2026-11-14: a comment written in a View-as tab is David's. The server adds acting_admin
// for administrator readers only, so the author line reads "Rob Lee as David Pry" for them and
// plain "David Pry" for everyone else.
const david = { id: 'U-DAVID', first_name: 'David', last_name: 'Pry', email: 'd@x.test' }

async function authorLine(comment: Record<string, unknown>): Promise<string | null | undefined> {
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path?: string }) => {
      const path = String(cmd?._path ?? '')
      if (path.includes('/comments/related')) return { data: [] }
      if (path.includes('/comments')) return { data: [comment] }
      return { data: [] }
    })
  } as unknown as NivaroClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client}>
          <CommentPanel collection='inventory_request' item='37807' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  // The collapsed header previews the newest note: "<author>: <text>".
  const find = () =>
    [...host.querySelectorAll('span.font-medium')].find((s) => s.textContent?.includes('David Pry'))
  for (let i = 0; i < 30 && !find(); i++)
    await act(async () => new Promise((r) => setTimeout(r, 10)))
  const text = find()?.textContent?.replace(/:$/, '')
  act(() => root.unmount())
  host.remove()
  return text
}

const base = {
  id: 'c1',
  collection: 'inventory_request',
  item: '37807',
  user: david,
  text: 'Please rush this',
  created_at: '2026-11-14T15:00:00Z',
  updated_at: '2026-11-14T15:00:00Z',
  mentions: []
}

describe('CommentPanel — View-as authorship', () => {
  it('an administrator reader sees "Rob Lee as David Pry"', async () => {
    expect(await authorLine({ ...base, acting_admin: { id: 'U-ROB', name: 'Rob Lee' } })).toBe(
      'Rob Lee as David Pry'
    )
  })

  it('everyone else (no acting_admin in the answer) sees David alone', async () => {
    expect(await authorLine(base)).toBe('David Pry')
  })
})

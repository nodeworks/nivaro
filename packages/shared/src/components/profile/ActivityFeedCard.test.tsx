// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { ActivityFeedCard } from './ActivityFeedCard'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Profile Activity feed: access changes to them, and link writes in words. */

const PAT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const at = '2026-11-12T15:00:00.000Z'
const link = (id: number, action: string, collection: string) => ({
  id,
  action,
  user: PAT,
  timestamp: at,
  collection,
  item: String(id),
  comment: null,
  ip: null
})
const feed = [
  {
    id: 501,
    action: 'access-request-grant',
    user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    timestamp: '2026-11-12T16:00:00.000Z',
    collection: 'workflows',
    item: '365984',
    comment: `for user ${PAT} (Add CHI to their Region filter)`,
    ip: null,
    about_them: true,
    summary: 'Access granted to Workflow CM26-365984 by Rob Lee',
    detail: 'Added CHI to their Region filter',
    by: 'Rob Lee'
  },
  link(472600, 'create', 'workflows_divisions'),
  link(472525, 'delete', 'workflows_divisions')
]
const labels = {
  users: { [PAT.toUpperCase()]: 'Pat Kim' },
  records: { 'workflows:79704': 'CM26-79704' },
  collections: { workflows: { singular: 'Workflow', plural: 'Workflows' } },
  junctions: {
    'workflows_divisions:472600': {
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'Division',
      value: 'Zone 2'
    },
    'workflows_divisions:472525': {
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'Division',
      value: 'Zone 1'
    }
  }
}

describe('ActivityFeedCard', () => {
  it('shows a grant made to the person and says a link swap in words', async () => {
    const calls: Array<{ _path: string; _body?: unknown }> = []
    const client = {
      request: vi.fn(async (cmd: { _path: string; _body?: unknown }) => {
        calls.push(cmd)
        if (cmd._path === '/activity/labels') return { data: labels }
        if (cmd._path.endsWith('/summary'))
          return { data: { total: 3, actions: [{ action: 'update', count: 3 }], collections: [] } }
        return { data: feed, total: 3, page: 1, limit: 50 }
      })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <NavigationContext.Provider value={{ navigate: vi.fn() }}>
              <ActivityFeedCard userId={PAT} />
            </NavigationContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
    const rows = [...host.querySelectorAll('[data-activity-row]')].map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('Access granted to Workflow CM26-365984 by Rob Lee')
    expect(rows[0]).toContain('Their access')
    expect(rows[0]).toContain('Added CHI to their Region filter')
    expect(rows[1]).toContain('Changed Division on Workflow CM26-79704: Zone 1 → Zone 2')
    expect(host.textContent).not.toContain('#472525')
    expect(host.textContent).not.toContain('workflows_divisions')
    // The chips speak plain verbs; the about-them row is not sent to the labels read.
    expect(host.textContent).toContain('Edited')
    const body = calls.find((c) => c._path === '/activity/labels')?._body as {
      refs: Array<{ collection: string }>
    }
    expect(body.refs.some((r) => r.collection === 'workflows_divisions')).toBe(true)
    expect(body.refs.some((r) => r.collection === 'workflows')).toBe(false)
    act(() => root.unmount())
    host.remove()
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { WIDGET_FOLLOW_TIMING } from './DashboardEdit'
import { TasksPage } from './Tasks'

const liveRefresh = vi.hoisted(() => vi.fn())
vi.mock('@nivaro/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nivaro/shared')>()),
  useLiveRefresh: liveRefresh
}))

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

describe('A1 — the Tasks page follows task writes', () => {
  it('re-reads its lists on the `team` topic, under the key prefix its queries use', async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data: {
          data:
            url === '/tasks'
              ? [
                  {
                    id: 't1',
                    collection: 'workflows',
                    item: '7',
                    title: 'Check the quote',
                    status: 'open',
                    priority: 'normal',
                    assignee: null,
                    created_by: null,
                    due_date: null,
                    created_at: new Date().toISOString()
                  }
                ]
              : []
        }
      })
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TasksPage />
        </MemoryRouter>
      </QueryClientProvider>
    )
    await screen.findByText('Check the quote')
    expect(liveRefresh).toHaveBeenCalledWith({ topic: 'team', keys: [['tasks', 'admin']] })
    // Every list the page reads sits under that prefix, so the refresh reaches them all.
    const keys = qc
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey)
      .filter((k) => k[0] === 'tasks')
    expect(keys.length).toBeGreaterThanOrEqual(2)
    for (const k of keys) expect(k.slice(0, 2)).toEqual(['tasks', 'admin'])
  })
})

describe('Low admin 2 — widgets that follow their collection', () => {
  it('re-read at most every 5 s, each tab after a random wait', () => {
    expect(WIDGET_FOLLOW_TIMING.minGapMs).toBeGreaterThanOrEqual(5000)
    expect(WIDGET_FOLLOW_TIMING.jitterMs).toBeGreaterThan(0)
  })
})

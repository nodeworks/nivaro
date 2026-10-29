// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { AgentBadge } from '../AgentBadge'
import { ConnectionRollback, type RollbackPlan } from './ConnectionRollback'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const plan: RollbackPlan = {
  conn: 'k7',
  owner: { id: 'u1', name: 'Sam Reed' },
  from: '2026-10-29T09:00:00.000Z',
  to: '2026-10-29T10:00:00.000Z',
  actions: [
    {
      kind: 'restore_values',
      collection: 'work_orders',
      collection_label: 'Work orders',
      item: '2',
      fields: ['status', 'title'],
      writes: 2,
      first_at: '2026-10-29T09:10:00.000Z',
      last_at: '2026-10-29T09:20:00.000Z'
    },
    {
      kind: 'delete_created',
      collection: 'work_orders',
      collection_label: 'Work orders',
      item: '1',
      fields: [],
      writes: 1,
      first_at: '2026-10-29T09:05:00.000Z',
      last_at: '2026-10-29T09:05:00.000Z'
    }
  ],
  skipped: [
    {
      collection: 'work_orders',
      collection_label: 'Work orders',
      item: '3',
      reason: 'Changed since by someone else',
      by: 'Priya N',
      at: '2026-10-29T09:50:00.000Z'
    }
  ],
  system_writes: 0,
  truncated: false,
  plan_hash: 'a'.repeat(32)
}

async function mount(scope: 'mine' | 'admin', onApply: (c: Cmd) => unknown) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.endsWith('/rollback/preview')) return { data: plan }
      return onApply(cmd)
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ConnectionRollback conn='k7' name='Claude' scope={scope} onClose={() => {}} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return calls
}

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined

describe('ConnectionRollback (#3219)', () => {
  it('previews, lists what is undone and left alone, and applies the previewed plan', async () => {
    const calls = await mount('mine', () => ({
      data: { done: 2, failed: [], skipped: 1, acted_as: 'owner' }
    }))
    await act(async () => button('Preview')?.click())
    await settle(() => host.textContent?.includes('Will be undone') ?? false)
    expect(calls[0]._path).toBe('/mcp-connections/mine/k7/rollback/preview')
    expect(typeof calls[0]._body?.from).toBe('string')
    const text = host.textContent ?? ''
    expect(text).toContain('Put back 2 fields')
    expect(text).toContain('Delete the record it created')
    expect(text).toContain('Changed since by someone else (Priya N')
    expect(text).toContain('status')
    // Two clicks: arm, then confirm.
    await act(async () => button('Roll back 2 changes')?.click())
    await act(async () => button('Undo 2 now?')?.click())
    await settle(() => host.textContent?.includes('Rolled back 2 changes') ?? false)
    const applied = calls.find((c) => c._path === '/mcp-connections/mine/k7/rollback')
    expect(applied?._body).toEqual({ from: plan.from, to: plan.to, plan_hash: plan.plan_hash })
  })

  it('shows the fresh plan when records changed since the preview', async () => {
    await mount('admin', () => {
      throw Object.assign(new Error('changed'), {
        status: 409,
        response: {
          data: { ...plan, actions: plan.actions.slice(0, 1), plan_hash: 'b'.repeat(32) }
        }
      })
    })
    await act(async () => button('Preview')?.click())
    await settle(() => host.textContent?.includes('Will be undone') ?? false)
    await act(async () => button('Roll back 2 changes')?.click())
    await act(async () => button('Undo 2 now?')?.click())
    await settle(() => host.textContent?.includes('changed since the preview') ?? false)
    expect(host.textContent).toContain('Roll back 1 change')
    expect(host.textContent).toContain('acting for Sam Reed')
  })
})

describe('AgentBadge (#3213)', () => {
  it('renders the server’s label, and nothing without one', async () => {
    await act(async () => {
      root.render(
        <div>
          <AgentBadge label='via Claude' />
          <AgentBadge label={null} />
        </div>
      )
    })
    const badges = host.querySelectorAll('[data-nvr-agent-badge]')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('via Claude')
  })
})

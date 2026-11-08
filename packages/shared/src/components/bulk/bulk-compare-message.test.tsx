// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { BulkCompareButton, compareTargets } from './BulkCompareButton'
import {
  BulkMessageButton,
  MESSAGE_STAKEHOLDERS_MAX,
  MessageStakeholdersForm
} from './MessageStakeholders'

// Army 11 N11: the worklist bar gets the list bar's Compare and Message…, from
// the same shared components and with the same limits.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }))

type Cmd = { _path: string; _body?: Record<string, unknown> }
const calls: Cmd[] = []
const client = {
  url: 'http://test',
  getToken: () => null,
  request: vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    if (cmd._path === '/notifications/message-stakeholders') return { count: 2, users: [] }
    return { data: [] }
  })
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  calls.length = 0
  document.body.replaceChildren()
})

async function render(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  )
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

const t = (id: number, collection = 'workflows') => ({ collection, id })

describe('compareTargets', () => {
  it('2–3 records of one collection only (the list bar’s rule)', () => {
    expect(compareTargets([t(1)])).toBeNull()
    expect(compareTargets([t(1), t(2)])).toEqual({ collection: 'workflows', ids: [1, 2] })
    expect(compareTargets([t(1), t(2), t(3)])?.ids).toHaveLength(3)
    expect(compareTargets([t(1), t(2), t(3), t(4)])).toBeNull()
    expect(compareTargets([t(1), t(2, 'inventory_request')])).toBeNull()
  })
})

describe('BulkCompareButton', () => {
  it('renders nothing outside 2–3 records, a button inside', async () => {
    await render(<BulkCompareButton targets={[t(1)]} renderValue={() => null} />)
    expect(document.querySelector('[data-bulk-compare]')).toBeNull()
    act(() => root?.unmount())
    await render(<BulkCompareButton targets={[t(1), t(2)]} renderValue={() => null} />)
    expect(document.querySelector('[data-bulk-compare]')).not.toBeNull()
  })
})

describe('Message stakeholders', () => {
  it('sends at most the server’s 200 records and says so', async () => {
    const ids = Array.from({ length: MESSAGE_STAKEHOLDERS_MAX + 5 }, (_, i) => i + 1)
    await render(
      <MessageStakeholdersForm
        collection='workflows'
        selectedIds={ids}
        layout='stacked'
        onDone={() => {}}
        onCancel={() => {}}
      />
    )
    const preview = calls.find((c) => c._path === '/notifications/message-stakeholders')
    expect((preview?._body?.ids as unknown[]).length).toBe(MESSAGE_STAKEHOLDERS_MAX)
    expect(document.body.textContent).toContain('first 200 of 205 records')
    expect(document.body.textContent).toContain('2 recipients')
  })

  it('a mixed selection gets a disabled button that says why', async () => {
    await render(<BulkMessageButton targets={[t(1), t(2, 'inventory_request')]} />)
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => x.textContent === 'Message…'
    )
    expect(b?.disabled).toBe(true)
    expect(b?.getAttribute('data-tip')).toContain('one kind')
  })
})

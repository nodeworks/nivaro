// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { OutboxPick, RecordOutboxEntry } from '../../lib/record-outbox'
import { OutboxClashRow, OutboxReviewTray } from './OutboxReviewTray'

// Realtime round 8, item 3: an offline save that clashes with someone else's change waits in a
// corner card — "Beth changed Amount while you were offline" — until the person decides.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const client = { request: vi.fn(async () => ({ data: [] })) }
function render(node: React.ReactNode) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  )
}

const entry = (over: Partial<RecordOutboxEntry> = {}): RecordOutboxEntry => ({
  id: 'h|u1|projects|7',
  owner: 'h|u1',
  collection: 'projects',
  item: '7',
  payload: { amount: 1500 },
  before: { amount: 1000 },
  base_revision: 41,
  change_reason: null,
  created_at: '2026-11-15T09:00:00Z',
  updated_at: '2026-11-15T09:05:00Z',
  status: 'conflict',
  error: 'Someone else changed this record',
  conflicts: [{ field: 'amount', current_value: 1200, by: 'Beth Ray', at: null }],
  latest_revision: 44,
  sent_fields: ['name'],
  ...over
})

describe('offline clash review', () => {
  it('says who changed which field, shows theirs and yours, and decides on a press', () => {
    const picks: OutboxPick[] = []
    const e = entry()
    render(
      <ul>
        <OutboxClashRow
          entry={e}
          clash={e.conflicts![0]}
          field={null}
          label='Amount'
          relatedCollection={null}
          onPick={(p) => picks.push(p)}
        />
      </ul>
    )
    expect(host.textContent).toContain('Beth Ray changed Amount while you were offline')
    expect(host.textContent).toContain('Theirs1,200')
    expect(host.textContent).toContain('Yours1,500')
    // Numbers have no merge — keep or take only.
    expect(host.querySelector('[data-outbox-merge]')).toBeNull()
    act(() => (host.querySelector('[data-outbox-keep-mine]') as HTMLElement).click())
    expect(picks).toEqual(['mine'])
  })

  it('a field the viewer may no longer read shows only that it changed', () => {
    const e = entry({
      conflicts: [{ field: 'amount', current_value: null, hidden: true }]
    })
    render(
      <ul>
        <OutboxClashRow
          entry={e}
          clash={e.conflicts![0]}
          field={null}
          label='Amount'
          relatedCollection={null}
          onPick={() => {}}
        />
      </ul>
    )
    expect(host.textContent).toContain('Someone changed Amount')
    expect(host.textContent).not.toContain('Theirs')
  })

  it('stays a one-line pill until clicked, then lists what waits', () => {
    render(<OutboxReviewTray entries={[entry(), entry({ id: 'x', status: 'queued' })]} />)
    expect(document.querySelector('[data-outbox-review-open]')?.textContent).toContain(
      '1 offline change needs a look'
    )
    expect(document.querySelector('[data-outbox-entry]')).toBeNull()
    act(() => (document.querySelector('[data-outbox-review-open]') as HTMLElement).click())
    const tray = document.querySelector('[data-outbox-review]')
    expect(tray?.textContent).toContain('Changed while you were offline')
    expect(tray?.textContent).toContain('1 other change was saved.')
    expect(document.querySelectorAll('[data-outbox-entry]')).toHaveLength(1)
    act(() => (tray?.querySelector('[aria-label="Fold this away"]') as HTMLElement).click())
    expect(document.querySelector('[data-outbox-entry]')).toBeNull()
  })
})

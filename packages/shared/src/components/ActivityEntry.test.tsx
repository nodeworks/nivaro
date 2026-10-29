// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntryInput, ActivityLabels } from '../lib/activity-sentence'
import { ActivityEntry, ActivityFeed } from './ActivityEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const labels: ActivityLabels = {
  records: { 'invoices:1': 'INV-1', 'invoices:2': 'INV-2' },
  collections: { invoices: { singular: 'Invoice', plural: 'Invoices' } }
}

const flowRow = (id: number, item: string): ActivityEntryInput => ({
  id,
  action: 'delete',
  collection: 'invoices',
  item,
  group_key: 'flow_run:r1',
  actor: { kind: 'flow', id: 'f1', name: 'Clean up' },
  timestamp: '2026-10-29T12:00:00Z'
})

describe('ActivityEntry', () => {
  it('renders the sentence, the why and the actions slot', () => {
    const onOpen = vi.fn()
    act(() =>
      root.render(
        <ActivityEntry
          entry={{
            id: 7,
            action: 'pipeline-transition',
            collection: 'invoices',
            item: '1',
            comment: 'Draft → Approved via Approve — "checked"',
            actor: { kind: 'cron', id: 'sweep', name: 'sweep' }
          }}
          labels={labels}
          onOpen={onOpen}
          actions={<button type='button'>Undo</button>}
        />
      )
    )
    expect(host.querySelector('[data-activity-sentence]')?.textContent).toBe(
      'Scheduled job “sweep” moved Invoice INV-1 from Draft to Approved'
    )
    expect(host.querySelector('[data-activity-why="note"]')?.textContent).toBe('“checked”')
    expect(host.textContent).toContain('Undo')
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('folds a burst into one line that expands', () => {
    act(() =>
      root.render(<ActivityFeed entries={[flowRow(1, '1'), flowRow(2, '2')]} labels={labels} />)
    )
    const sentences = () =>
      [...host.querySelectorAll('[data-activity-sentence]')].map((n) => n.textContent)
    expect(sentences()).toEqual(['Flow “Clean up” deleted 2 invoices'])
    act(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click())
    expect(sentences()).toEqual([
      'Flow “Clean up” deleted 2 invoices',
      'Flow “Clean up” deleted Invoice INV-1',
      'Flow “Clean up” deleted Invoice INV-2'
    ])
  })
})

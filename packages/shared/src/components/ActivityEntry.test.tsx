// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntryInput, ActivityLabels } from '../lib/activity-sentence'
import { ActivityEntry, ActivityFeed, childChangeText, omitRecordPhrases } from './ActivityEntry'

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
    // one actor: the children drop the name and say only what each write did
    expect(sentences()).toEqual(['Flow “Clean up” deleted 2 invoices'])
    expect([...host.querySelectorAll('[data-activity-child]')].map((n) => n.textContent)).toEqual([
      expect.stringContaining('deleted Invoice INV-1'),
      expect.stringContaining('deleted Invoice INV-2')
    ])
  })
})

describe("omitRecordPhrases (a record's own stream leaves its name out)", () => {
  it('cuts "on <record>" and "<record>" from the sentence', () => {
    const p = 'Project RT6 – zz'
    expect(omitRecordPhrases(`Review User changed Objective on ${p}`, [p])).toBe(
      'Review User changed Objective'
    )
    expect(omitRecordPhrases(`Review Admin updated ${p} 12 times: Objective`, [p])).toBe(
      'Review Admin updated 12 times: Objective'
    )
    expect(omitRecordPhrases('Ada moved Workflow 5', [p])).toBe('Ada moved Workflow 5')
    expect(omitRecordPhrases('Ada moved Workflow 5', undefined)).toBe('Ada moved Workflow 5')
  })
})

describe('an expanded one-person burst says what each write changed', () => {
  const write = (id: number, objective: string, sec: number): ActivityEntryInput => ({
    id,
    action: 'update',
    actor: { kind: 'flow', id: 'f1', name: 'Sync' },
    collection: 'invoices',
    item: '1',
    group_key: 'req:1',
    changes: [{ field: 'objective', value: objective }],
    timestamp: `2026-11-15T12:00:${String(sec).padStart(2, '0')}Z`
  })
  const fieldLabels: ActivityLabels = { ...labels, fields: { 'invoices.objective': 'Objective' } }
  const rows = Array.from({ length: 7 }, (_, i) => write(i + 1, `note ${i + 1}`, i * 3))

  it('children drop the avatar and name, show the change, and cap at 5 with a Show more link', () => {
    act(() => root.render(<ActivityEntry entry={rows[0]} group={rows} labels={fieldLabels} />))
    act(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click())
    const kids = [...host.querySelectorAll('[data-activity-child]')]
    expect(kids).toHaveLength(5)
    expect(kids[0].textContent).toContain('Objective')
    expect(kids[0].textContent).toContain('note 1')
    expect(kids[0].textContent).not.toContain('Sync')
    expect(kids[0].querySelector('img, [data-activity-actor]')).toBeNull()
    const more = host.querySelector('[data-activity-show-more]') as HTMLButtonElement
    expect(more.textContent).toBe('Show 2 more')
    act(() => more.click())
    expect(host.querySelectorAll('[data-activity-child]')).toHaveLength(7)
    expect(host.querySelector('[data-activity-show-more]')).toBeNull()
  })

  it('writes in one minute show their time to the second', () => {
    act(() => root.render(<ActivityEntry entry={rows[0]} group={rows} labels={fieldLabels} />))
    act(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click())
    const times = [...host.querySelectorAll('[data-activity-child] span:last-child')].map(
      (e) => e.textContent ?? ''
    )
    expect(new Set(times).size).toBe(times.length) // told apart
    expect(times[0]).toMatch(/\d:\d\d:\d\d/)
  })

  it('childChangeText turns "set X to Y" into "X → Y"', () => {
    expect(childChangeText(rows[0], fieldLabels, ['Invoice INV-1'])).toBe('Objective → note 1')
  })
})

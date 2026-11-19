// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type RecapChanges, recapValueText, splitSystem } from './RecordRecapChanges'
import { RecordRecapStrip } from './RecordRecapStrip'

// 2026-11-18: "2 fields changed" opens a popover beside the strip listing each field, before →
// after, who and when — it was a hover tooltip naming the fields.
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
  document.body.innerHTML = ''
})

const SINCE = '2026-11-17T12:23:00.000Z'

// What the server answers: it already left out every field the viewer may not read.
const changes: RecapChanges = {
  since: SINCE,
  truncated: false,
  fields: {
    install_location: {
      label: 'Install Location',
      system: false,
      type: 'string',
      interface: null,
      options: null
    },
    amount: {
      label: 'Amount',
      system: false,
      type: 'decimal',
      interface: null,
      options: { format: 'currency', currency: 'USD' }
    },
    zone: { label: 'Zone', system: false, type: 'integer', interface: null, options: null },
    date_updated: {
      label: 'Date Updated',
      system: true,
      type: 'timestamp',
      interface: null,
      options: null
    }
  },
  groups: [
    {
      user_id: 'u-nick',
      name: 'Nicholas Desrosiers',
      first_at: '2026-11-18T13:00:00.000Z',
      last_at: '2026-11-18T13:05:00.000Z',
      saves: 2,
      changes: [
        { field: 'install_location', has_before: true, before: 'Building A', after: 'Building B' },
        { field: 'amount', has_before: true, before: 1000, after: 2059.5 },
        {
          field: 'zone',
          has_before: true,
          before: null,
          after: null,
          before_text: 'Zone 1',
          after_text: 'Zone 3'
        },
        {
          field: 'date_updated',
          has_before: true,
          before: '2026-11-17T12:00:00.000Z',
          after: '2026-11-18T13:05:00.000Z'
        }
      ]
    }
  ]
}

const requests: string[] = []
const client = {
  getToken: () => null,
  request: vi.fn(async (cmd: { _path: string; _method?: string }) => {
    requests.push(cmd._path)
    if (cmd._path.endsWith('/touch'))
      return {
        data: {
          since: SINCE,
          field_changes: 4,
          fields: ['Install Location', 'Amount', 'Zone', 'Date Updated'],
          comments: 1,
          transitions: 0,
          editors: ['Nicholas Desrosiers']
        }
      }
    if (cmd._path.endsWith('/changes')) return { data: changes }
    if (cmd._path.endsWith('/dismiss')) return { data: { ok: true } }
    return { data: null }
  })
}

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client as never}>
          <RecordRecapStrip collection='workflows' itemId='7' historyAvailable />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function openPopover() {
  const trigger = document.querySelector<HTMLButtonElement>('[data-recap-trigger]')
  expect(trigger).not.toBeNull()
  expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  await act(async () => {
    trigger?.click()
  })
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  return trigger as HTMLButtonElement
}

describe('recap popover', () => {
  it('is a button that opens a list of each changed field, before → after', async () => {
    await render()
    expect(document.querySelector('[data-record-recap]')?.textContent).toContain('4 fields changed')
    // No more tooltip standing in for the detail.
    expect(document.querySelector('[data-record-recap] [data-tip]')).toBeNull()
    const trigger = await openPopover()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const pop = document.querySelector('[data-recap-popover]')
    expect(pop).not.toBeNull()
    expect(pop?.getAttribute('role')).toBe('dialog')
    const text = pop?.textContent ?? ''
    expect(text).toContain('Nicholas Desrosiers')
    expect(text).toContain('Install Location')
    expect(text).toContain('Building A')
    expect(text).toContain('Building B')
    // Money as money; links by their label (the server named them, never ids).
    expect(text).toContain('$1,000.00')
    expect(text).toContain('$2,059.50')
    expect(text).toContain('Zone 1')
    expect(text).toContain('Zone 3')
    expect(text).toContain('Also 1 new comment')
    expect(requests.some((p) => p === '/record-views/workflows/7/changes')).toBe(true)
  })

  it('keeps bookkeeping fields secondary: one muted line, folded until asked', async () => {
    await render()
    await openPopover()
    const toggle = document.querySelector<HTMLButtonElement>('[data-recap-system-toggle]')
    expect(toggle?.textContent).toContain('and 1 system field')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    const row = document.querySelector('[data-recap-change="date_updated"]')
    expect(row).not.toBeNull()
    expect(row?.closest('ul')?.hidden).toBe(true)
    await act(async () => toggle?.click())
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(row?.closest('ul')?.hidden).toBe(false)
  })

  it('Mark as seen dismisses the strip on the server', async () => {
    await render()
    await openPopover()
    const btn = document.querySelector<HTMLButtonElement>('[data-recap-mark-seen]')
    expect(btn).not.toBeNull()
    await act(async () => btn?.click())
    expect(requests).toContain('/record-views/workflows/7/dismiss')
    expect(document.querySelector('[data-record-recap]')).toBeNull()
  })
})

describe('recap helpers', () => {
  it('never shows a field the server did not name', () => {
    // The server list is the whole truth: a field it left out (unreadable) has no row.
    const { main, system } = splitSystem(changes.groups[0].changes, changes.fields)
    expect(main.map((c) => c.field)).toEqual(['install_location', 'amount', 'zone'])
    expect(system.map((c) => c.field)).toEqual(['date_updated'])
  })

  it('reads values as the form shows them', () => {
    expect(recapValueText(null, undefined, undefined)).toBeNull()
    expect(recapValueText('x', 'Zone 3', undefined)).toBe('Zone 3')
    expect(
      recapValueText('hold', undefined, {
        label: 'Status',
        system: false,
        type: 'string',
        interface: 'select-dropdown',
        options: { choices: [{ text: 'On hold', value: 'hold' }] }
      })
    ).toBe('On hold')
    expect(
      recapValueText(true, undefined, {
        label: 'Rush',
        system: false,
        type: 'boolean',
        interface: null,
        options: null
      })
    ).toBe('Yes')
  })
})

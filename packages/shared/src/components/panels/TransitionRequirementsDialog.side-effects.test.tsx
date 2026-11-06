// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { keepValuesPatch, overwrittenBySideEffect } from './requirement-side-effects'
import {
  relatedOptionLabel,
  TransitionRequirementsDialog,
  type TransitionRequirementsPayload
} from './TransitionRequirementsDialog'

// army5 b09 HIGH: Submit's "Every line needs a Category" dialog listed bare
// ids (57 … 245), and picking one silently changed the line's price
// ($2 → $1, line $14 → $7) through the server's cross-record defaults.

type Cmd = {
  _method: string
  _path: string
  _params?: Record<string, unknown>
  _body?: Record<string, unknown>
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.replaceChildren()
})

const payload: TransitionRequirementsPayload = [
  {
    type: 'child_fields',
    collection: 'workflow_line_items',
    fk_field: 'workflow',
    title: 'Every line needs a Category before Submit',
    fields: [
      {
        field: 'category',
        label: 'Category',
        type: 'integer',
        kind: 'm2o',
        related_collection: 'categories'
      }
    ],
    display_fields: [
      { field: 'price', label: 'Price', type: 'decimal', format: 'currency' },
      { field: 'amount', label: 'Amount', type: 'decimal', format: 'currency' }
    ],
    rows: [
      {
        id: 475912,
        label: 'Line 2',
        complete: false,
        values: { category: null },
        display: { price: 2, amount: 14 }
      }
    ]
  }
]

function makeClient(rehearsal: Record<string, unknown>) {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collections/categories')
        return { data: { display_template: '{{core_category.name}} - {{sub_category.name}}' } }
      if (cmd._path === '/items/categories')
        return {
          data: [
            { id: 58, core_category: { name: 'Network' }, sub_category: { name: 'Labor' } },
            { id: 57, core_category: { name: 'Network' }, sub_category: { name: 'Equipment' } }
          ]
        }
      if (cmd._method === 'PATCH' && cmd._params?.dry_run) return rehearsal
      return { data: {} }
    })
  } as unknown as NivaroClient
  return { client, calls }
}

async function settle() {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

async function open(rehearsal: Record<string, unknown>) {
  const { client, calls } = makeClient(rehearsal)
  const onSubmitted = vi.fn()
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client}>
          <TransitionRequirementsDialog
            payload={payload}
            transitionId='T-SUBMIT'
            onSubmitted={onSubmitted}
            onClose={() => undefined}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
  // Open the Category picker and choose by NAME.
  await act(async () => button('Select category…')?.click())
  await settle()
  const option = button('Network - Equipment')
  expect(option).toBeTruthy()
  await act(async () => option?.click())
  await settle()
  return { calls, onSubmitted }
}
const writes = (calls: Cmd[]) => calls.filter((c) => c._method === 'PATCH' && !c._params?.dry_run)

const priceDrop = {
  dry_run: true,
  ok: true,
  changes: [
    { field: 'category', from: null, to: 57 },
    { field: 'oracle_category', from: null, to: 237 },
    { field: 'price', from: 2, to: 1 },
    { field: 'amount', from: 14, to: 7 }
  ]
}

describe('TransitionRequirementsDialog category picks (army5 b09)', () => {
  it('lists categories by their display template, never bare ids', async () => {
    const { calls } = await open({ ok: true, changes: [] })
    expect(document.body.textContent).toContain('Network - Equipment')
    const read = calls.find((c) => c._path === '/items/categories')
    expect(read?._params?.fields).toBe('id,core_category.name,sub_category.name')
  })

  it('names a price the pick would replace and writes nothing until the person chooses', async () => {
    const { calls, onSubmitted } = await open(priceDrop)
    await act(async () => button('Submit')?.click())
    await settle()
    const text = document.querySelector('[data-req-side-effects]')?.textContent ?? ''
    expect(text).toContain('Line 2 · Price: $2.00 →')
    expect(text).toContain('$1.00')
    expect(text).toContain('Line 2 · Amount: $14.00 →')
    // A value filled into an empty field is not asked about.
    expect(text).not.toContain('Oracle')
    expect(writes(calls)).toHaveLength(0)
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('Keep current values: the write carries them, so the price stays', async () => {
    const { calls, onSubmitted } = await open(priceDrop)
    await act(async () => button('Submit')?.click())
    await settle()
    await act(async () => button('Keep current values')?.click())
    await settle()
    const w = writes(calls)
    expect(w).toHaveLength(1)
    expect(w[0]._body).toEqual({ category: '57', price: 2, amount: 14 })
    expect(onSubmitted).toHaveBeenCalled()
  })

  it('Apply all changes: only the pick is sent (the server derives the rest)', async () => {
    const { calls, onSubmitted } = await open(priceDrop)
    await act(async () => button('Submit')?.click())
    await settle()
    await act(async () => button('Apply all changes')?.click())
    await settle()
    const w = writes(calls)
    expect(w).toHaveLength(1)
    expect(w[0]._body).toEqual({ category: '57' })
    expect(onSubmitted).toHaveBeenCalled()
  })

  it('a pick that replaces nothing submits straight away', async () => {
    const { calls, onSubmitted } = await open({
      ok: true,
      changes: [{ field: 'category', from: null, to: 57 }]
    })
    await act(async () => button('Submit')?.click())
    await settle()
    expect(document.querySelector('[data-req-side-effects]')).toBeNull()
    expect(writes(calls)).toHaveLength(1)
    expect(onSubmitted).toHaveBeenCalled()
  })
})

describe('relatedOptionLabel', () => {
  const t = '{{core_category.name}} - {{sub_category.name}}'
  it('renders the template', () => {
    expect(
      relatedOptionLabel(t, { id: 57, core_category: { name: 'A' }, sub_category: { name: 'B' } })
    ).toBe('A - B')
  })
  it('an all-empty template falls back to a name column, then #id', () => {
    expect(relatedOptionLabel(t, { id: 57, name: 'Fifty-seven' })).toBe('Fifty-seven')
    expect(relatedOptionLabel(t, { id: 57 })).toBe('#57')
    expect(relatedOptionLabel(null, { id: 9, short_name: 'SN' })).toBe('SN')
  })
})

describe('overwrittenBySideEffect', () => {
  it('only values the row already had, outside what was sent', () => {
    expect(overwrittenBySideEffect(priceDrop, { category: '57' }).map((c) => c.field)).toEqual([
      'price',
      'amount'
    ])
    expect(overwrittenBySideEffect({ ok: false, changes: priceDrop.changes }, {})).toEqual([])
    expect(overwrittenBySideEffect(null, {})).toEqual([])
    expect(
      overwrittenBySideEffect({ changes: [{ field: 'price', from: '2.00', to: 2 }] }, {})
    ).toEqual([])
  })
  it('keepValuesPatch sends the old values', () => {
    expect(keepValuesPatch([{ field: 'price', from: 2, to: 1 }])).toEqual({ price: 2 })
  })
})

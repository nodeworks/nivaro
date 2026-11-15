// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { overwritesOthers, sameCellValue } from '../../lib/cell-locks'
import { InlineEditCell, type InlineEditController, useInlineEdit } from './InlineEdit'

// rt6 #15 — editing a list with other people: soft cell locks and the overwrite check.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

type Cmd = { _path?: string; _method?: string; _body?: unknown; _params?: unknown }

function makeClient(answer: (cmd: Cmd) => unknown) {
  const calls: Cmd[] = []
  const request = vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    return answer(cmd)
  })
  return { client: { request }, calls }
}

let ctl: InlineEditController | null = null
function Cell({ value = 3 }: { value?: unknown }) {
  const c = useInlineEdit()
  ctl = c
  return (
    <InlineEditCell
      controller={c}
      cellKey='7|qty'
      kind='integer'
      value={value}
      label='Qty'
      collection='orders'
      itemId={7}
      field='qty'
      onCommit={(v) =>
        c.commit({
          cellKey: '7|qty',
          collection: 'orders',
          id: 7,
          field: 'qty',
          kind: 'integer',
          before: value,
          value: v
        })
      }
    >
      <span>{String(value)}</span>
    </InlineEditCell>
  )
}

function render(client: unknown) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client as never}>
          <Cell />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
}
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}
const path = (c: Cmd) => String(c._path ?? '')

describe('cell value comparison', () => {
  it('ids compare case-blind; blanks are the same', () => {
    expect(sameCellValue('m2o', 'abc-1', 'ABC-1')).toBe(true)
    expect(sameCellValue('text', '', null)).toBe(true)
    expect(sameCellValue('number', '1107.4400', 1107.44)).toBe(true)
  })
  it('overwrite only when theirs moved and differs from mine', () => {
    expect(overwritesOthers('integer', 3, 5, 9)).toBe(true)
    expect(overwritesOthers('integer', 3, 3, 9)).toBe(false)
    expect(overwritesOthers('integer', 3, 9, 9)).toBe(false)
  })
})

describe('InlineEditCell with others', () => {
  it('shows who is editing a cell and does not open it', async () => {
    const { client } = makeClient((cmd) =>
      path(cmd) === '/cell-locks/read'
        ? { data: [{ id: '7', field: 'qty', name: 'Beth Lee', since: '', mine: false }] }
        : { data: null }
    )
    render(client)
    await flush()
    const held = host.querySelector('[data-inline-held-by]')
    expect(held?.getAttribute('data-inline-held-by')).toBe('Beth Lee')
    expect(held?.textContent).toContain('Beth editing')
    expect(host.querySelector('[data-inline-editable]')).toBeNull()
  })

  it('takes the cell when opening and lets go when closing', async () => {
    const { client, calls } = makeClient((cmd) =>
      path(cmd) === '/cell-locks/take' ? { ok: true } : { data: [] }
    )
    render(client)
    await flush()
    act(() =>
      ctl?.start('7|qty', { coords: { collection: 'orders', id: 7, field: 'qty' }, value: 3 })
    )
    await flush()
    expect(calls.some((c) => path(c) === '/cell-locks/take')).toBe(true)
    act(() => ctl?.cancel())
    await flush()
    expect(calls.some((c) => path(c) === '/cell-locks/release')).toBe(true)
  })

  it('closes and says who when someone else took the cell first', async () => {
    const { client } = makeClient((cmd) =>
      path(cmd) === '/cell-locks/take'
        ? { ok: false, holder: { name: 'Mark Li', since: '' } }
        : { data: [] }
    )
    render(client)
    await flush()
    act(() =>
      ctl?.start('7|qty', { coords: { collection: 'orders', id: 7, field: 'qty' }, value: 3 })
    )
    await flush()
    expect(ctl?.editing).toBeNull()
    expect(host.querySelector('[data-inline-refused]')?.textContent).toBe(
      'Mark Li started editing this'
    )
  })

  it('asks Keep mine / Take theirs when the value moved, and Keep mine saves', async () => {
    const { client, calls } = makeClient((cmd) => {
      const p = path(cmd)
      if (p === '/cell-locks/take') return { ok: true }
      if (p === '/items/orders/7' && cmd._method !== 'PATCH') return { data: { id: 7, qty: 5 } }
      if (p === '/picker-exclusions/linked-change')
        return { data: { by: 'Beth Lee', at: '2026-11-14T15:42:00Z', fields: [{ field: 'qty' }] } }
      return { data: [] }
    })
    render(client)
    await flush()
    act(() =>
      ctl?.start('7|qty', { coords: { collection: 'orders', id: 7, field: 'qty' }, value: 3 })
    )
    act(() =>
      ctl?.commit({
        cellKey: '7|qty',
        collection: 'orders',
        id: 7,
        field: 'qty',
        kind: 'integer',
        before: 3,
        value: 9
      })
    )
    await flush()
    const bar = host.querySelector('[data-inline-conflict]')
    expect(bar?.textContent).toContain('Beth Lee changed this to')
    expect(bar?.textContent).toContain('“5”')
    expect(calls.some((c) => c._method === 'PATCH')).toBe(false)
    const keep = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep mine')
    act(() => keep?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    const patchCall = calls.find((c) => c._method === 'PATCH')
    expect(patchCall?._body).toEqual({ qty: 9 })
    expect(host.querySelector('[data-inline-conflict]')).toBeNull()
  })

  it('saves straight away when nobody else changed the value', async () => {
    const { client, calls } = makeClient((cmd) => {
      const p = path(cmd)
      if (p === '/cell-locks/take') return { ok: true }
      if (p === '/items/orders/7' && cmd._method !== 'PATCH') return { data: { id: 7, qty: 3 } }
      return { data: [] }
    })
    render(client)
    await flush()
    act(() =>
      ctl?.start('7|qty', { coords: { collection: 'orders', id: 7, field: 'qty' }, value: 3 })
    )
    act(() =>
      ctl?.commit({
        cellKey: '7|qty',
        collection: 'orders',
        id: 7,
        field: 'qty',
        kind: 'integer',
        before: 3,
        value: 9
      })
    )
    await flush()
    expect(calls.find((c) => c._method === 'PATCH')?._body).toEqual({ qty: 9 })
    expect(host.querySelector('[data-inline-conflict]')).toBeNull()
  })
})

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { PICKER_EXCLUDED_ROW_CLASS, usePickerExcludedRows } from './PickerExcludedRows'

// Rows left out of every relation picker read in italics — Rob 2026-10-29.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _path: string; _body?: { collection: string; ids: string[] } }

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function Rows({
  rows,
  enabled
}: {
  rows: Array<{ collection: string; id: string | number }>
  enabled: boolean
}) {
  const isExcluded = usePickerExcludedRows(rows, enabled)
  return (
    <ul>
      {rows.map((r) => (
        <li
          key={`${r.collection}|${r.id}`}
          data-row={`${r.collection}|${r.id}`}
          className={isExcluded(r.collection, r.id) ? PICKER_EXCLUDED_ROW_CLASS : undefined}
        />
      ))}
    </ul>
  )
}

async function render(rows: Array<{ collection: string; id: string | number }>, enabled: boolean) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/picker-exclusions/batch-status') {
        const excluded = cmd._body?.collection === 'divisions' ? ['8'] : ['ABC-1']
        return { data: { excluded } }
      }
      return { data: null }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <Rows rows={rows} enabled={enabled} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  const marked = Array.from(document.querySelectorAll('[data-row]'))
    .filter((li) => li.className === PICKER_EXCLUDED_ROW_CLASS)
    .map((li) => li.getAttribute('data-row'))
  return { calls, marked }
}

describe('picker excluded rows', () => {
  it('asks once per collection and marks only the excluded rows (ids compared case-blind)', async () => {
    const { calls, marked } = await render(
      [
        { collection: 'divisions', id: 8 },
        { collection: 'divisions', id: 9 },
        { collection: 'workflows', id: 'abc-1' }
      ],
      true
    )
    const asked = calls.filter((c) => c._path === '/picker-exclusions/batch-status')
    expect(asked.map((c) => c._body)).toEqual([
      { collection: 'divisions', ids: ['8', '9'] },
      { collection: 'workflows', ids: ['abc-1'] }
    ])
    expect(marked).toEqual(['divisions|8', 'workflows|abc-1'])
  })

  it('asks nothing and marks nothing when off', async () => {
    const { calls, marked } = await render([{ collection: 'divisions', id: 8 }], false)
    expect(calls).toEqual([])
    expect(marked).toEqual([])
  })
})

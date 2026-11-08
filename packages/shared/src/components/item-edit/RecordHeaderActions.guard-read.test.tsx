// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { AvailableBulkAction } from '../bulk/BulkActionButtons'
import { useRecordHeaderActions } from './RecordHeaderActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Cold record page (army 9 b14): Hold's guard field (is_on_hold) is not on the
// layout, so the header read the record a second time just for it — while the
// form already held the whole record. The record's values answer the guard.
const hold: AvailableBulkAction = {
  key: 'hold',
  source: 'db',
  collection: 'workflows',
  label: 'Put On Hold',
  icon: null,
  variant: 'default',
  kind: 'update_fields',
  require_reason: false,
  confirm_text: null,
  summary: 'Put On Hold',
  header: true,
  guard: [{ field: 'is_on_hold', op: 'neq', value: true }]
} as AvailableBulkAction

async function run(
  values: Record<string, unknown> | null,
  opts: { valuesPending?: boolean } = {}
): Promise<{ offered: string[]; paths: string[] }> {
  const paths: string[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (c: { _path: string }) => {
      paths.push(c._path)
      if (c._path.startsWith('/bulk-actions')) return { data: [hold] }
      return { data: { is_on_hold: false } }
    })
  } as unknown as NivaroClient
  let seen: string[] = []
  function Probe() {
    seen = useRecordHeaderActions('workflows', '1', values, opts).map((a) => a.key)
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client}>
          <Probe />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  for (let i = 0; i < 12; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  act(() => root.unmount())
  return { offered: seen, paths }
}

const recordReads = (paths: string[]) => paths.filter((p) => p.startsWith('/items/'))

describe('useRecordHeaderActions guard values', () => {
  it('answers a guard from the record’s own values with no extra read', async () => {
    const { offered, paths } = await run({ id: 1, is_on_hold: false })
    expect(offered).toEqual(['hold'])
    expect(recordReads(paths)).toEqual([])
  })

  it('a held record is not offered Hold', async () => {
    const { offered } = await run({ id: 1, is_on_hold: true })
    expect(offered).toEqual([])
  })

  it('waits for the record instead of reading the guard field on its own', async () => {
    const { paths } = await run({}, { valuesPending: true })
    expect(recordReads(paths)).toEqual([])
  })

  it('still reads a guard field the values lack', async () => {
    const { offered, paths } = await run({ id: 1 })
    expect(recordReads(paths)).toEqual(['/items/workflows/1'])
    expect(offered).toEqual(['hold'])
  })
})

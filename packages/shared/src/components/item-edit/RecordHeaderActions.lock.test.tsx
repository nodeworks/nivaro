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

// army5 b06 a07: Put On Hold was offered on a record whose state edit lock
// leaves no field open (a canceled record for a non-admin).
const action = (key: string, kind: AvailableBulkAction['kind']): AvailableBulkAction => ({
  key,
  source: 'db',
  collection: 'workflows',
  label: key,
  icon: null,
  variant: 'default',
  kind,
  require_reason: false,
  confirm_text: null,
  summary: key,
  header: true
})

async function offered(fieldsLocked: boolean): Promise<string[]> {
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async () => ({
      data: [action('hold', 'update_fields'), action('cancel', 'transition')]
    }))
  } as unknown as NivaroClient
  let seen: string[] = []
  function Probe() {
    seen = useRecordHeaderActions('workflows', '1', {}, { fieldsLocked }).map((a) => a.key)
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
  for (let i = 0; i < 10 && seen.length === 0; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  act(() => root.unmount())
  return seen
}

describe('useRecordHeaderActions under a state edit lock', () => {
  it('offers field-writing actions on an open record', async () => {
    expect(await offered(false)).toEqual(['hold', 'cancel'])
  })
  it('hides them when the lock leaves no field open (moves stay)', async () => {
    expect(await offered(true)).toEqual(['cancel'])
  })
})

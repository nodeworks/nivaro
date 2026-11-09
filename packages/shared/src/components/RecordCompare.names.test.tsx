// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { compareValueText } from '../lib/compare-value'
import { RecordCompareDialog } from './RecordCompare'

// Army 11 staging check (0.3.95): Compare headed each side "#367714" and showed
// "hold_final_10". Sides are named by business id; cells get the field's config.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RECS: Record<string, Record<string, unknown>> = {
  '367714': { id: 367714, workflow_id: 'MM26-81441', nuvolo_payment_status: 'hold_final_10' },
  '367715': { id: 367715, workflow_id: 'MM26-81442', nuvolo_payment_status: 'release_full' }
}
const client = {
  url: 'http://test',
  getToken: () => null,
  request: vi.fn(async (cmd: { _path: string }) => {
    const m = cmd._path.match(/^\/items\/workflows\/(\d+)$/)
    if (m) return { data: RECS[m[1]] }
    if (cmd._path === '/collections/workflows')
      return { data: { friendly_id_field: 'workflow_id' } }
    if (cmd._path === '/field-config/workflows')
      return {
        data: [
          { field: 'workflow_id', label: 'ID' },
          {
            field: 'nuvolo_payment_status',
            label: 'Payment status',
            type: 'string',
            options: {
              choices: [
                { text: 'Hold Final 10%', value: 'hold_final_10' },
                { text: 'Release Full Payment', value: 'release_full' }
              ]
            }
          }
        ]
      }
    return { data: null }
  })
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

describe('RecordCompareDialog names', () => {
  it('heads each side with the business id and reads choices by label', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <RecordCompareDialog
              collection='workflows'
              ids={[367714, 367715]}
              fields={[{ field: 'workflow_id' }, { field: 'nuvolo_payment_status' }]}
              renderValue={(_f, v, m) => compareValueText(v, m)}
              onClose={() => {}}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    const sides = Array.from(document.querySelectorAll('[data-compare-side]')).map(
      (e) => e.textContent
    )
    expect(sides).toEqual(['MM26-81441', 'MM26-81442'])
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('#367714')
    expect(text).toContain('Hold Final 10%')
    expect(text).not.toContain('hold_final_10')
  })
})

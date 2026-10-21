// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { MergePanel } from './MergeForms'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

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

async function settle(until: () => boolean) {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const click = async (sel: string) => {
  const el = host.querySelector(sel) as HTMLElement | null
  expect(el, sel).not.toBeNull()
  await act(async () => {
    el?.click()
  })
}

const PREVIEW = {
  keep: { id: 1, name: 'Goods', rev: 'ka' },
  fold: { id: 2, name: 'Services', rev: 'fa' },
  changes: ['Adds the section “Service” from Services, shown when Type is “Services”'],
  assignment: ['The default form of this collection'],
  retire: [
    'Services is renamed “Services (merged into Goods)” and no form pick chooses it any more'
  ],
  notes: ["1 field is set up differently on the two forms (Amount): Goods's setup is kept."],
  counts: { sections_added: 1, fields_added: 2, fields_moved: 0, rules_added: 1, differing: 1 },
  ops_count: 4,
  references: [{ kind: 'queue', label: 'Queue “Open services”' }],
  records: {
    sampled_newest: 3,
    names: { '1': 'Goods', '2': 'Services', '3': 'Rush' },
    views: [
      {
        label: 'Everyone',
        plain: { before: 1, after: 1 },
        sampled: 3,
        kept: 1,
        carried: 1,
        lost: [{ from: 2, to: 3, count: 1 }],
        gained: []
      }
    ]
  },
  needs_note: 'note'
}

describe('MergePanel', () => {
  it('previews the merge, asks for the note the forms need, applies with the revs and undoes', async () => {
    const calls: Cmd[] = []
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path.endsWith('/overview'))
          return {
            data: {
              rows: [
                { layout_id: 1, name: 'Goods', layout_type: 'grouped', is_default: true },
                { layout_id: 2, name: 'Services', layout_type: 'grouped' },
                { layout_id: 9, name: 'Grid', layout_type: 'table' }
              ],
              warning: null
            }
          }
        if (cmd._path.endsWith('/merge/preview')) return { data: PREVIEW }
        if (cmd._path.endsWith('/merge/apply'))
          return {
            data: {
              keep: { layout_id: 1, name: 'Goods', version_id: 11, rev: 'kb' },
              fold: {
                layout_id: 2,
                name: 'Services (merged into Goods)',
                version_id: 12,
                rev: 'fb'
              }
            }
          }
        return {
          data: {
            forms: [
              { layout_id: 1, status: 'restored', reason: null },
              { layout_id: 2, status: 'restored', reason: null }
            ]
          }
        }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <MergePanel collection='po' keepId={1} foldId={2} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await click('[data-merge-preview]')
    await settle(() => !!host.querySelector('[data-merge-plan]'))
    const text = host.textContent ?? ''
    expect(text).toContain('What Goods gets')
    expect(text).toContain('1 record that opens Services will open the merged form')
    expect(text).toContain('1 record that opens Services will open Rush instead')
    expect(text).toContain('Queue “Open services”')
    expect(host.querySelector('[data-merge-notes]')).not.toBeNull()

    // The forms ask for a reason: Merge waits for one.
    const apply = host.querySelector('[data-merge-apply]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    const input = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'One form for every PO')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(apply.disabled).toBe(false)
    await click('[data-merge-apply]')
    await settle(() => !!host.querySelector('[data-merge-result]'))
    const sent = calls.find((c) => c._path.endsWith('/merge/apply'))
    expect(sent?._body).toMatchObject({
      keep_id: 1,
      fold_id: 2,
      revs: { keep: 'ka', fold: 'fa' },
      reason: 'One form for every PO'
    })

    await click('[data-merge-undo]')
    await settle(() => calls.some((c) => c._path.endsWith('/merge/undo')))
    const undo = calls.find((c) => c._path.endsWith('/merge/undo'))
    expect(undo?._body).toMatchObject({
      keep: { layout_id: 1, version_id: 11, rev: 'kb' },
      fold: { layout_id: 2, version_id: 12, rev: 'fb' }
    })
  })
})

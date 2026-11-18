// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { draftFromOpenWhen, type OpenWhenDraft } from './open-when-draft'
import { OpenWhenSection } from './PipelineEditorView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const states = [
  { id: 's1', key: 'manager_approval', label: 'Manager Approval' },
  { id: 's2', key: 'waiting_on_po', label: 'Waiting on PO' }
] as never

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

function mount(draft: OpenWhenDraft, onChange = vi.fn()) {
  const client = {
    request: vi.fn(async () => ({
      data: {
        fields: [{ field: 'amount', type: 'decimal' }],
        relations: [
          {
            many_collection: 'workflow_purchase_orders_junction',
            many_field: 'workflow',
            one_collection: 'workflows'
          }
        ]
      }
    }))
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <OpenWhenSection
            draft={draft}
            onChange={onChange}
            states={states}
            fieldsCollection='workflows'
            allowCreator={false}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return onChange
}

describe('Anyone can make this move when… (editor)', () => {
  it('shows one choice per collection, labelled by its display name', () => {
    mount(draftFromOpenWhen({ workflows: [] }, ['workflows', 'nivaro_addendums']))
    const blocks = host.querySelectorAll('[data-open-when-collection]')
    expect([...blocks].map((b) => b.getAttribute('data-open-when-collection'))).toEqual([
      'workflows',
      'nivaro_addendums'
    ])
    expect(blocks[0].querySelector('span')?.textContent).toBe('Workflows')
    expect(blocks[1].querySelector('span')?.textContent).toBe('Addendums')
    const pressed = (b: Element) =>
      [...b.querySelectorAll('button[aria-pressed="true"]')].map((x) => x.textContent)
    expect(pressed(blocks[0])).toEqual(['Anyone, always'])
    expect(pressed(blocks[1])).toEqual(['Owner only'])
    expect(blocks[0].textContent).toContain('no conditions')
  })

  it('picking "Anyone, when…" starts a rule to fill in', () => {
    const onChange = mount(draftFromOpenWhen(null, ['workflows']))
    const when = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Anyone, when…'
    ) as HTMLButtonElement
    act(() => when.click())
    expect(onChange).toHaveBeenCalledWith({
      workflows: { mode: 'when', rules: [{ field: '', op: 'eq', value: '' }] }
    })
  })

  it('offers the step, an addendum in approval and linked rows beside record fields', () => {
    mount({
      workflows: {
        mode: 'when',
        rules: [
          { field: '$state', op: 'neq', value: 'waiting_on_po' },
          { field: '$addendum_active', op: 'eq', value: 'false' },
          { field: 'workflow_purchase_orders_junction:workflow', op: 'related_none', value: null }
        ]
      }
    })
    const kinds = [...host.querySelectorAll('[data-open-when-rule]')].map((r) =>
      r.getAttribute('data-open-when-rule')
    )
    expect(kinds).toEqual(['state', 'yesno', 'linked'])
    expect(host.textContent).toContain('Waiting on PO')
    expect(host.textContent).toContain('has none')
  })
})

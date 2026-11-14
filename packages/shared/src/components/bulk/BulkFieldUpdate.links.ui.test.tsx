// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { ColumnHeaderMenu } from '../cbv/ColumnHeaderMenu'
import { BulkFieldUpdate } from './BulkFieldUpdate'

// 2026-11-13: the column header's "Set <column> on N selected rows…" opens the
// bulk bar's Update field on that column; a to-many field offers Add /
// Replace / Remove with a preview asked from the server (dry_run) before Apply.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// cmdk (the field list) and the pickers measure themselves.
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView ??= () => {}

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }
const calls: Cmd[] = []
const client = {
  url: 'http://test',
  getToken: () => null,
  request: vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    if (cmd._path === '/items/locations/bulk-fields')
      return {
        data: {
          readable: 3,
          no_form: 3,
          forms: [],
          fields: {
            name: { records: 3, locked: 0, reason: null },
            additional_expenditure_orgs: {
              records: 3,
              locked: 0,
              reason: null,
              m2m: { related: 'org_codes', junction: 'locations_org_codes_1' }
            }
          }
        }
      }
    if (cmd._path === '/field-config/locations')
      return {
        data: [
          { field: 'name', label: 'Name', type: 'string' },
          {
            field: 'additional_expenditure_orgs',
            label: 'Additional expenditure orgs',
            type: 'alias'
          }
        ]
      }
    if (cmd._path.startsWith('/items/locations/bulk-update?dry_run=1'))
      return {
        data: {
          would_update: 2,
          skipped: 1,
          refused: 0,
          refused_reason: null,
          unreadable: 0,
          links_added: 0,
          links_removed: 5
        }
      }
    return { data: [] }
  })
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  calls.length = 0
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function render(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
}

const click = async (el: Element | null) => {
  expect(el).not.toBeNull()
  await act(async () => (el as HTMLElement).click())
  await settle()
}

describe('bulk Update field on a to-many column, opened from the header', () => {
  it('opens on the column, offers Add / Replace / Remove, previews, and applies the alias value', async () => {
    const onApply = vi.fn()
    await render(
      <BulkFieldUpdate
        collection='locations'
        selectedIds={[1, 2, 3]}
        onApply={onApply}
        pointAt={{ field: 'additional_expenditure_orgs', nonce: 1 }}
      />
    )
    // Straight onto the field (no field list first).
    expect(document.body.textContent).toContain('Set Additional expenditure orgs')
    expect(
      document.querySelector('[data-bulk-links-mode="append"]')?.getAttribute('aria-pressed')
    ).toBe('true')

    // Replace with nothing picked: a clear warning, a preview asked from the server.
    await click(document.querySelector('[data-bulk-links-mode="replace"]'))
    expect(document.querySelector('[data-bulk-links-clear-warning]')?.textContent).toMatch(
      /removes every Additional expenditure orgs link/
    )
    await act(async () => new Promise((r) => setTimeout(r, 350)))
    await settle()
    const ask = calls.find((c) => c._path.startsWith('/items/locations/bulk-update?dry_run=1'))
    expect(ask?._body).toMatchObject({
      ids: [1, 2, 3],
      data: { additional_expenditure_orgs: { set: [] } }
    })
    expect(document.querySelector('[data-bulk-update-preview]')?.textContent).toBe(
      'Removes 5 links across 2 records · 1 record already matches'
    )
    const apply = document.querySelector('[data-bulk-field-apply]') as HTMLButtonElement
    expect(apply.textContent).toBe('Apply to 2 records')
    await click(apply)
    expect(onApply).toHaveBeenCalledWith('additional_expenditure_orgs', { set: [] })
    // The preview wrote nothing: only the dry run reached bulk-update.
    expect(
      calls.filter((c) => c._path.includes('bulk-update') && !c._path.includes('dry_run'))
    ).toEqual([])
  })

  it('Add with nothing picked asks for a pick and cannot apply', async () => {
    await render(
      <BulkFieldUpdate
        collection='locations'
        selectedIds={[1, 2]}
        onApply={vi.fn()}
        pointAt={{ field: 'additional_expenditure_orgs', nonce: 1 }}
      />
    )
    expect(document.querySelector('[data-bulk-field-hint]')?.textContent).toBe(
      'Pick the records to add.'
    )
    expect((document.querySelector('[data-bulk-field-apply]') as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('a column it cannot change says so and shows the field list', async () => {
    await render(
      <BulkFieldUpdate
        collection='locations'
        selectedIds={[1]}
        onApply={vi.fn()}
        pointAt={{ field: 'created', nonce: 1 }}
      />
    )
    expect(document.querySelector('[data-bulk-field-point-missed]')?.textContent).toMatch(
      /created can’t be changed in bulk here/
    )
    expect(document.querySelector('[data-bulk-field-picker]')).not.toBeNull()
  })
})

describe('ColumnHeaderMenu', () => {
  it('sets totals per column and never sorts the header it sits in', async () => {
    const onChange = vi.fn()
    const onSort = vi.fn()
    const onSet = vi.fn()
    await render(
      // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: test host standing in for a sortable header
      <div onClick={onSort}>
        <ColumnHeaderMenu
          label='Amount'
          selectedCount={4}
          onSetSelected={onSet}
          totals={{ fn: null, onChange }}
        />
      </div>
    )
    await click(document.querySelector('[data-cbv-col-menu]'))
    expect(document.querySelector('[data-cbv-col-set]')?.textContent).toContain(
      'Set Amount on 4 selected rows…'
    )
    await click(document.querySelector('[data-cbv-col-total="avg"]'))
    expect(onChange).toHaveBeenCalledWith('avg')
    await click(document.querySelector('[data-cbv-col-menu]'))
    await click(document.querySelector('[data-cbv-col-set]'))
    expect(onSet).toHaveBeenCalled()
    expect(onSort).not.toHaveBeenCalled()
  })

  it('explains why Set is off', async () => {
    await render(
      <ColumnHeaderMenu
        label='Amount'
        selectedCount={0}
        onSetSelected={vi.fn()}
        setUnavailable='Turn on Select, then tick the rows to change.'
      />
    )
    await click(document.querySelector('[data-cbv-col-menu]'))
    const set = document.querySelector('[data-cbv-col-set]') as HTMLButtonElement
    expect(set.disabled).toBe(true)
    expect(set.textContent).toContain('Turn on Select')
  })
})

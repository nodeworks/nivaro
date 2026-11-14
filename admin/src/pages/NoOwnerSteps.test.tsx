import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import { type NoOwnerReport, NoOwnerStepsPage } from './NoOwnerSteps'

const get = api.get as unknown as ReturnType<typeof vi.fn>

const REPORT: NoOwnerReport = {
  computed_at: new Date().toISOString(),
  checked: 520,
  total: 470,
  groups: [
    {
      template_id: 'TPL-IR',
      template_name: 'Inventory Request',
      state_id: 'S-WH',
      state_key: 'warehouse_submission',
      state_label: 'Warehouse Submission',
      collection: 'inventory_request',
      collection_label: 'Inventory Requests',
      count: 468,
      moves: [
        { id: 'M1', label: 'Submit to Warehouse', allow_creator: false, conditional: false },
        { id: 'M2', label: 'Cancel', allow_creator: true, conditional: false }
      ],
      clusters: [
        {
          key: 'c1',
          count: 300,
          dims: [
            { field: 'warehouse', label: 'Warehouse', value: 'FRE' },
            { field: 'division', label: 'Zone', value: 'Zone 1' }
          ],
          uncovered: [{ field: 'warehouse', label: 'Warehouse', value: 'FRE' }],
          reason: 'No owner group covers Warehouse FRE.',
          suggestion: { group_label: 'ATL warehouse team', missing_labels: ['Warehouse ATL'] }
        }
      ],
      ungrouped: 0,
      conditions_unchecked: 0,
      sample: [
        {
          item: '37713',
          label: 'FDX25INV-37713',
          creator: { id: 'U1', name: 'David Pry' },
          stand_in: ['David Pry'],
          since: '2026-11-05T14:00:00.000Z',
          cluster: 'c1'
        }
      ],
      matrix_href: '/pipelines/TPL-IR#owner-matrix'
    },
    {
      template_id: 'TPL-WF',
      template_name: 'Workflow',
      state_id: 'S-AP',
      state_key: 'approval',
      state_label: 'Approval',
      collection: 'workflows',
      collection_label: 'Workflows',
      count: 2,
      moves: [{ id: 'M3', label: 'Approve', allow_creator: false, conditional: true }],
      clusters: [],
      ungrouped: 2,
      conditions_unchecked: 0,
      sample: [],
      matrix_href: '/pipelines/TPL-WF#owner-matrix'
    }
  ]
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NoOwnerStepsPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Coverage › No owner', () => {
  it('lists each step with its count, uncovered values and owner-matrix link', async () => {
    get.mockResolvedValue({ data: { data: REPORT } })
    renderPage()
    const wh = await screen.findByText('Warehouse Submission')
    const card = wh.closest('section') as HTMLElement
    expect(get).toHaveBeenCalledWith('/coverage-gaps/no-owner')
    expect(within(card).getByText('468')).toBeTruthy()
    const why = within(card).getByText('No group covers Warehouse FRE')
    // The full sentence stays one hover away.
    expect(why.getAttribute('data-tip')).toBe('No owner group covers Warehouse FRE.')
    // The value no group names is marked; the covered one is not.
    const marked = card.querySelectorAll('[data-uncovered]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('FRE')
    expect(within(card).getByText(/Closest group: ATL warehouse team/)).toBeTruthy()
    expect(
      within(card)
        .getByRole('link', { name: /Open owner matrix/ })
        .getAttribute('href')
    ).toBe('/pipelines/TPL-IR#owner-matrix')
    // The creator-allowed move is listed and said so.
    expect(within(card).getByText('Submit to Warehouse')).toBeTruthy()
    expect(within(card).getByText(/or creator/)).toBeTruthy()
    // Tiles.
    expect(screen.getByText('470')).toBeTruthy()
    expect(screen.getByText('Steps affected').nextSibling?.textContent).toBe('2')
  })

  it('shows the sample records of the first step, linked to the record', async () => {
    get.mockResolvedValue({ data: { data: REPORT } })
    renderPage()
    const link = await screen.findByRole('link', { name: 'FDX25INV-37713' })
    expect(link.getAttribute('href')).toBe('/collections/inventory_request/37713')
    const row = link.closest('tr') as HTMLElement
    expect(within(row).getAllByText('David Pry')).toHaveLength(2)
    expect(within(row).getByText('FRE · Zone 1')).toBeTruthy()
  })

  it('folds the records of the other steps until asked', async () => {
    get.mockResolvedValue({ data: { data: REPORT } })
    renderPage()
    const ap = await screen.findByText('Approval')
    const card = ap.closest('section') as HTMLElement
    const toggle = within(card).getByRole('button', { name: /Show records/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(card).getByText(/^2 not grouped by value/)).toBeTruthy()
  })

  it('says so when every owner-only step has an owner', async () => {
    get.mockResolvedValue({ data: { data: { ...REPORT, total: 0, groups: [] } } })
    renderPage()
    expect(await screen.findByText(/Every step with owner-only moves has an owner/)).toBeTruthy()
  })

  it('Re-check asks for a fresh answer', async () => {
    get.mockResolvedValue({ data: { data: REPORT } })
    renderPage()
    await screen.findByText('Warehouse Submission')
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(get).toHaveBeenCalledWith('/coverage-gaps/no-owner?fresh=1')
  })
})

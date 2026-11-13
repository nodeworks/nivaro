// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollectionsToolbar } from './CollectionsToolbar'
import { cleanup, click, getByRole, getByText, mount, queryByRole, queryByText } from './test-kit'
import type { PageState } from './types'

afterEach(cleanup)

const base: PageState = {
  view: 'az',
  density: 'comfortable',
  chips: [],
  showHidden: false,
  showLinks: false,
  arranging: false,
  selecting: true
}

function setup(
  over: Partial<PageState> = {},
  isAdmin = true,
  tools: { canArrange?: boolean; canSelect?: boolean; title?: string } = {}
) {
  const onChange = vi.fn()
  mount(
    <>
      <input aria-label='other' />
      <CollectionsToolbar
        state={{ ...base, ...over }}
        onChange={onChange}
        filter=''
        onFilterChange={() => {}}
        counts={{
          total: 10,
          hidden: 3,
          links: 0,
          chip: { has_records: 4, empty: 0, hidden: 3, link: 2 }
        }}
        isAdmin={isAdmin}
        selectedCount={2}
        onMoveSelected={() => {}}
        onClearSelection={() => {}}
        {...tools}
      />
    </>
  )
  return onChange
}

describe('CollectionsToolbar', () => {
  it('hides chips with a zero count and toggles hidden switch by count', () => {
    setup()
    expect(getByRole('button', /Has records/)).toBeTruthy()
    expect(queryByRole('button', /^Empty/)).toBeNull()
    expect(getByText(/Show hidden collections \(3\)/)).toBeTruthy()
    expect(queryByText(/Show link tables/)).toBeNull()
  })

  it('non-admin sees no Arrange, Select or stat chips', () => {
    setup({ selecting: false }, false)
    expect(queryByRole('button', /Arrange/)).toBeNull()
    expect(queryByRole('button', 'Select')).toBeNull()
    expect(queryByRole('button', /Has records/)).toBeNull()
    expect(getByRole('button', /Link tables/)).toBeTruthy()
    expect(queryByRole('radio', 'Most records')).toBeNull()
  })

  it('Arrange forces folders view and clears selecting', () => {
    const onChange = setup()
    click(getByRole('button', 'Arrange'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ arranging: true, selecting: false, view: 'folders' })
    )
  })

  it('a host without folder tools gives admins the views and stats but no Arrange or Select', () => {
    setup({ selecting: false }, true, { canArrange: false, canSelect: false, title: 'All data' })
    expect(document.querySelector('h1')?.textContent).toBe('All data')
    expect(queryByRole('button', /Arrange/)).toBeNull()
    expect(queryByRole('button', 'Select')).toBeNull()
    expect(getByRole('radio', 'Most records')).toBeTruthy()
    expect(getByRole('button', /Has records/)).toBeTruthy()
  })
})

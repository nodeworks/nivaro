import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CollectionsToolbar } from './CollectionsToolbar'
import type { PageState } from './types'

const base: PageState = {
  view: 'az',
  density: 'comfortable',
  chips: [],
  showHidden: false,
  showLinks: false,
  arranging: false,
  selecting: true
}

function setup(over: Partial<PageState> = {}, isAdmin = true) {
  const onChange = vi.fn()
  render(
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
      />
    </>
  )
  return onChange
}

describe('CollectionsToolbar', () => {
  it('hides chips with a zero count and toggles hidden switch by count', () => {
    setup()
    expect(screen.getByRole('button', { name: /Has records/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Empty/ })).toBeNull()
    expect(screen.getByText(/Show hidden \(3\)/)).toBeInTheDocument()
    expect(screen.queryByText(/Show link tables/)).toBeNull()
  })

  it('non-admin sees no Arrange, Select or stat chips', () => {
    setup({ selecting: false }, false)
    expect(screen.queryByRole('button', { name: /Arrange/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Has records/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Link tables/ })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Most records' })).toBeNull()
  })

  it('Arrange forces folders view and clears selecting', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ arranging: true, selecting: false, view: 'folders' })
    )
  })
})

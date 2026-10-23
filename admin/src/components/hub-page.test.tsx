import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { DATABASE_HUB } from '@/lib/hubs'
import { HubPage, HubRedirect } from './hub-page'

// The shared setup stubs react-router's hooks; this file tests real routing.
vi.unmock('react-router')

function Where() {
  const { pathname, search, hash } = useLocation()
  return <output data-testid='where'>{`${pathname}${search}${hash}`}</output>
}

const screens = {
  '': () => <p>overview body</p>,
  tuning: () => <p>tuning body</p>,
  'sql-checks': () => <p>checks body</p>,
  redis: () => <p>redis body</p>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path='database/*'
          element={
            <>
              <HubPage hub={DATABASE_HUB} components={screens} />
              <Where />
            </>
          }
        />
        <Route path='db-tuning' element={<HubRedirect to='/database/tuning' />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('HubPage', () => {
  it('renders the first tab at the hub path and switches tabs by path', () => {
    renderAt('/database')
    expect(screen.getByRole('heading', { name: 'Database' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('overview body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Tuning' }))
    expect(screen.getByTestId('where').textContent).toBe('/database/tuning')
    expect(screen.getByText('tuning body')).toBeInTheDocument()
  })

  it('moves between tabs with the arrow keys', () => {
    renderAt('/database')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getByTestId('where').textContent).toBe('/database/tuning')
    // Focus follows the selection, so the next arrow press keeps working.
    expect(screen.getByRole('tab', { name: 'Tuning' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    expect(screen.getByTestId('where').textContent).toBe('/database/redis')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getByTestId('where').textContent).toBe('/database')
  })

  it('sends an unknown tab back to the hub', () => {
    renderAt('/database/nope')
    expect(screen.getByTestId('where').textContent).toBe('/database')
  })

  it('redirects an old path onto its tab with the query and hash kept', () => {
    renderAt('/db-tuning?proposal=12#evidence')
    expect(screen.getByTestId('where').textContent).toBe('/database/tuning?proposal=12#evidence')
    expect(screen.getByText('tuning body')).toBeInTheDocument()
  })
})

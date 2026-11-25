import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPS_HUB, DATABASE_HUB } from '@/lib/hubs'
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
    expect(screen.getByTestId('where').textContent).toBe('/database/connections')
    // Focus follows the selection, so the next arrow press keeps working.
    expect(screen.getByRole('tab', { name: 'Connections' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    expect(screen.getByTestId('where').textContent).toBe('/database/caches')
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

  it('keeps one strip for a hub without groups', () => {
    renderAt('/database')
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
  })
})

const appScreens = Object.fromEntries(
  APPS_HUB.tabs.map((t) => [t.path, () => <p>{`${t.path || 'apps'} body`}</p>])
)

function renderApps(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path='hub/*'
          element={
            <>
              <HubPage hub={APPS_HUB} components={appScreens} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('HubPage with tab groups (Apps hub)', () => {
  it("shows the groups, then the open group's tabs", () => {
    renderApps('/hub/smoke')
    const [groups, tabs] = screen.getAllByRole('tablist')
    expect(groups).toHaveAccessibleName('Apps sections')
    expect(tabs).toHaveAccessibleName('Deploy views')
    expect(screen.getByRole('tab', { name: 'Deploy' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Smoke checks' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.queryByRole('tab', { name: 'Health' })).toBeNull()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'hub-tab-hub-smoke')
  })

  it('opens a group on its first tab, and a tab of the group by path', () => {
    renderApps('/hub/smoke')
    fireEvent.click(screen.getByRole('tab', { name: 'Watch' }))
    expect(screen.getByTestId('where').textContent).toBe('/hub/fleet')
    expect(screen.getByText('fleet body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Health' }))
    expect(screen.getByTestId('where').textContent).toBe('/hub/health')
  })

  it('shows no second strip for a group of one, and names the panel by the group', () => {
    renderApps('/hub')
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Apps' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'hub-group-hub-apps')
  })

  describe('in the standalone Hub look', () => {
    beforeEach(() => document.documentElement.setAttribute('data-product', 'hub'))
    afterEach(() => document.documentElement.removeAttribute('data-product'))

    it('leaves the tabs its top bar links out of the strip, and lands past them', () => {
      renderApps('/hub/health')
      expect(screen.queryByRole('tab', { name: 'Fleet' })).toBeNull()
      fireEvent.click(screen.getByRole('tab', { name: 'Run' }))
      // Shared deployments is in the top bar: Run opens on Capacity.
      expect(screen.getByTestId('where').textContent).toBe('/hub/capacity')
      fireEvent.click(screen.getByRole('tab', { name: 'People & access' }))
      expect(screen.getByTestId('where').textContent).toBe('/hub/signin')
    })

    it('names the panel by its group on a top-bar tab', () => {
      renderApps('/hub/fleet')
      expect(screen.getByRole('tab', { name: 'Watch' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'hub-group-hub-watch')
    })
  })
})

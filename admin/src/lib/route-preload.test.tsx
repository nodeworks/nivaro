// @vitest-environment jsdom
import { act, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import {
  adminListTarget,
  adminRecordTarget,
  lazy,
  PreloadRoutes,
  preloadRoute
} from './route-preload'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('route preload (#2448)', () => {
  it('loads the chunk(s) a path renders once, through wrappers, and nothing for others', async () => {
    const usersLoader = vi.fn(async () => ({ default: () => <p>users</p> }))
    const layoutLoader = vi.fn(async () => ({
      default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
    }))
    const homeLoader = vi.fn(async () => ({ default: () => <p>home</p> }))
    const Users = lazy(usersLoader)
    const Layout = lazy(layoutLoader)
    const Home = lazy(homeLoader)
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/nowhere']}>
          <PreloadRoutes>
            <Route
              element={
                <Suspense fallback={null}>
                  <Layout />
                </Suspense>
              }
            >
              <Route index element={<Home />} />
              <Route path='users' element={<Users />} />
            </Route>
          </PreloadRoutes>
        </MemoryRouter>
      )
    })
    expect(preloadRoute('/users?tab=x')).toBe(2)
    expect(usersLoader).toHaveBeenCalledTimes(1)
    expect(layoutLoader).toHaveBeenCalledTimes(1)
    expect(homeLoader).not.toHaveBeenCalled()
    // once only
    expect(preloadRoute('/users')).toBe(0)
    expect(usersLoader).toHaveBeenCalledTimes(1)
    expect(preloadRoute('/not-a-route')).toBe(0)
    act(() => root.unmount())
  })

  it('names admin record pages and nothing else', () => {
    expect(adminRecordTarget('/collections/projects/42')).toEqual({
      collection: 'projects',
      id: '42'
    })
    expect(adminRecordTarget('/collections/projects/new')).toBeNull()
    expect(adminRecordTarget('/collections/projects')).toBeNull()
    expect(adminRecordTarget('/collections/projects/s/slug-x')).toBeNull()
    expect(adminRecordTarget('/users/42')).toBeNull()
  })

  it('names admin list pages (#3230)', () => {
    expect(adminListTarget('/collections/projects')).toBe('projects')
    expect(adminListTarget('/collections/projects/42')).toBeNull()
    expect(adminListTarget('/collections')).toBeNull()
  })
})

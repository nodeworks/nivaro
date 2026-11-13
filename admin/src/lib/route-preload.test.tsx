// @vitest-environment jsdom

import { installStaleChunkRecovery, registerUnsavedWork } from '@nivaro/shared'
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

// 2026-11-11: a tab opened before a deploy asked for a screen the new release no longer
// served and the page crashed ("Cannot read properties of undefined (reading
// 'CollectionsPage')"). A screen made with this module's `lazy` recovers instead: one reload
// onto the new build, and the "updated" notice in its place when a reload cannot happen.
describe('a lazy screen whose code is gone after a deploy', () => {
  const chunkGone = () =>
    new TypeError(
      'Failed to fetch dynamically imported module: https://x/assets/Collections-abc.js'
    )
  function memoryStorage() {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v)
    }
  }
  async function show(Screen: React.ComponentType) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const caught: unknown[] = []
    class Boundary extends (await import('react')).Component<{ children: React.ReactNode }> {
      state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(err: unknown) {
        caught.push(err)
      }
      render() {
        return this.state.failed ? <p>crashed</p> : this.props.children
      }
    }
    await act(async () => {
      root.render(
        <Boundary>
          <Suspense fallback={<p>loading</p>}>
            <Screen />
          </Suspense>
        </Boundary>
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    return {
      host,
      caught,
      done: () => {
        act(() => root.unmount())
        host.remove()
      }
    }
  }

  it('reloads once and keeps the page on its loading state, without a crash', async () => {
    const reload = vi.fn()
    const uninstall = installStaleChunkRecovery({
      storage: memoryStorage(),
      reload,
      unsaved: () => []
    })
    const Screen = lazy(() => Promise.reject(chunkGone()))
    const page = await show(Screen)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(page.host.textContent).toBe('loading')
    expect(page.caught).toEqual([])
    page.done()
    uninstall()
  })

  it('says the app was updated when the tab holds unsaved work, and does not reload', async () => {
    const reload = vi.fn()
    // Real unsaved work, as a form reports it: the recovery and the notice both read it.
    const forget = registerUnsavedWork('Purchase order 12', () => true)
    const uninstall = installStaleChunkRecovery({ storage: memoryStorage(), reload })
    const Screen = lazy(() => Promise.reject(chunkGone()))
    const page = await show(Screen)
    expect(reload).not.toHaveBeenCalled()
    expect(page.host.textContent).toMatch(/This app was updated/)
    expect(page.host.textContent).toMatch(/Not saved yet: Purchase order 12/)
    // Never a plain "Reload" over unsaved work: the button says what it costs.
    expect(page.host.querySelector('button')?.textContent).toBe('Reload without saving')
    expect(page.caught).toEqual([])
    page.done()
    uninstall()
    forget()
  })

  it('still crashes on a real error in the screen, so it is reported', async () => {
    const reload = vi.fn()
    const uninstall = installStaleChunkRecovery({
      storage: memoryStorage(),
      reload,
      unsaved: () => []
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Screen = lazy(() => Promise.reject(new TypeError('x is not a function')))
    const page = await show(Screen)
    expect(page.host.textContent).toBe('crashed')
    expect(reload).not.toHaveBeenCalled()
    quiet.mockRestore()
    page.done()
    uninstall()
  })
})

import { guardLazyImport } from '@nivaro/shared'
import {
  type ComponentType,
  isValidElement,
  type LazyExoticComponent,
  type ReactNode,
  lazy as reactLazy,
  useMemo
} from 'react'
import { createRoutesFromChildren, matchRoutes, type RouteObject, Routes } from 'react-router'
import { StaleBuildNotice } from '@/components/stale-build-notice'

/**
 * Nav-hover route preload (#2448). `lazy` here is React's lazy that also remembers its loader,
 * and `PreloadRoutes` is `<Routes>` that also remembers the route tree, so `preloadRoute(path)`
 * can find the lazy screen(s) a path renders and start loading their chunks before the click.
 * Each chunk loads at most once; the loader is the same dynamic import React.lazy runs, so the
 * click reuses the module already in flight. Static assets only — no API call.
 *
 * A screen made here also survives a deploy: when its chunk is gone (this tab runs the
 * previous build) the tab reloads once onto the new one, and where a reload cannot happen
 * (just tried, or unsaved work) the "Nivaro was updated" notice takes the screen's place
 * instead of a crash (guardLazyImport, packages/shared lib/stale-chunk.ts).
 */

type AnyComponent = ComponentType<any>
const loaders = new WeakMap<object, () => Promise<unknown>>()
const started = new WeakSet<object>()

export function lazy<T extends AnyComponent>(
  factory: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  const C = reactLazy(guardLazyImport(factory, StaleBuildNotice as unknown as T))
  loaders.set(C, factory)
  return C
}

let routeTree: RouteObject[] | null = null

/** `<Routes>` that also records its tree for preloadRoute. */
export function PreloadRoutes({ children }: { children: ReactNode }) {
  useMemo(() => {
    try {
      routeTree = createRoutesFromChildren(children)
    } catch {
      routeTree = null
    }
  }, [children])
  return <Routes>{children}</Routes>
}

/** Lazy components inside an element (wrappers like Suspense / guards, a few levels deep). */
export function lazyTypesIn(node: ReactNode, depth = 0, out: object[] = []): object[] {
  if (depth > 5 || node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) lazyTypesIn(n, depth, out)
    return out
  }
  if (!isValidElement(node)) return out
  const type = node.type as unknown
  if (type && typeof type === 'object' && loaders.has(type)) out.push(type)
  lazyTypesIn((node.props as { children?: ReactNode })?.children, depth + 1, out)
  return out
}

/** Start loading the code for the screen `path` opens. Never throws. */
export function preloadRoute(path: string): number {
  if (!routeTree) return 0
  let n = 0
  try {
    const matches = matchRoutes(routeTree, path.split('?')[0]) ?? []
    for (const m of matches) {
      for (const t of lazyTypesIn(m.route.element as ReactNode)) {
        if (started.has(t)) continue
        started.add(t)
        n++
        loaders
          .get(t)?.()
          .catch(() => started.delete(t))
      }
    }
  } catch {
    /* decoration */
  }
  return n
}

/** Admin record pages: /collections/:collection/:id (not /new, not the slug resolver). */
export function adminRecordTarget(path: string): { collection: string; id: string } | null {
  const m = path.match(/^\/collections\/([^/]+)\/([^/]+)$/)
  if (!m || m[2] === 'new') return null
  try {
    return { collection: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** Admin list pages: /collections/:collection (#3230) — a hover warms the list's metadata. */
export function adminListTarget(path: string): string | null {
  const m = path.match(/^\/collections\/([^/]+)$/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

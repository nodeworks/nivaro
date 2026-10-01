import { Component, type ReactNode } from 'react'

/**
 * Shared plumbing for the Traffic Map plug-in registries (one file per registry beside this one).
 * Features push into a registry from their own module; `register` replaces by id so a hot reload
 * never doubles an entry.
 */
export interface Registered {
  id: string
  order?: number
}

/** Add (or replace, by id) an entry. */
export function register<T extends Registered>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) list[i] = item
  else list.push(item)
}

/** Entries in display order: `order` ascending (default 100), then registration order. */
export function byOrder<T extends Registered>(list: readonly T[]): T[] {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.order ?? 100) - (b.x.order ?? 100) || a.i - b.i)
    .map((e) => e.x)
}

/** `applies` that throws counts as not applying. */
export function safeApplies(fn: () => boolean): boolean {
  try {
    return fn()
  } catch {
    return false
  }
}

/**
 * A feature's component that throws renders nothing (and warns once) instead of taking the
 * page down; `resetKey` changing (e.g. a new selection) gives it another try.
 */
export class FeatureBoundary extends Component<
  { id: string; resetKey?: string; children: ReactNode },
  { failed: boolean; key?: string }
> {
  state: { failed: boolean; key?: string } = { failed: false, key: this.props.resetKey }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; key?: string }
  ): { failed: boolean; key?: string } | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }
  componentDidCatch(err: unknown): void {
    // biome-ignore lint/suspicious/noConsole: one line per failing feature, the page keeps going
    console.warn(`[traffic-map] feature "${this.props.id}" failed to render`, err)
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

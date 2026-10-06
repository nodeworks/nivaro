/**
 * Deprecated context members (#1303).
 *
 * A `@deprecated` JSDoc tag is invisible at runtime, so the kit keeps the
 * same facts as data: which `ctx` member is on its way out, what replaces it
 * and the kit version it leaves in. The loader wraps every listed member on
 * the context it hands `register()`; the first use per extension per boot is
 * logged, listed on the Extensions registry sheet and counted by a readiness
 * check. Add an entry here in the same commit that marks the member
 * `@deprecated` in context.ts.
 */

export interface KitDeprecation {
  /** Dotted path under the extension context, e.g. `storage.setActive`. */
  member: string
  /** What an extension should use instead, in the same dotted form or prose. */
  replacement: string
  /** The kit version the member is removed in. */
  removedIn: string
  /** One sentence on why, shown beside the warning. */
  note?: string
}

/** Every deprecated context member. Empty today: nothing is on its way out. */
export const KIT_DEPRECATIONS: readonly KitDeprecation[] = []

/** The sentence a warning carries — one wording for the log, the sheet and
 *  the readiness check. */
export function deprecationMessage(extId: string, d: KitDeprecation): string {
  const why = d.note ? ` ${d.note}` : ''
  return `${extId} uses ctx.${d.member}, which is deprecated — use ${d.replacement}; it leaves the kit in ${d.removedIn}.${why}`
}

type Node = { here: KitDeprecation | null; children: Map<string, Node> }

function buildTree(deprecations: readonly KitDeprecation[]): Node {
  const root: Node = { here: null, children: new Map() }
  for (const d of deprecations) {
    const parts = d.member.split('.').filter(Boolean)
    if (parts.length === 0) continue
    let node = root
    for (const p of parts) {
      let next = node.children.get(p)
      if (!next) {
        next = { here: null, children: new Map() }
        node.children.set(p, next)
      }
      node = next
    }
    node.here = d
  }
  return root
}

/**
 * Returns `ctx` with every listed member watched: reading the member calls
 * `onUse(deprecation)` and then answers exactly what the member held, so the
 * extension keeps working. Parents are wrapped in a Proxy rather than copied —
 * shared objects (the knex instance, the app) are never mutated and keep their
 * prototype. A member that does not exist on this context is skipped.
 */
export function watchDeprecatedMembers<T extends object>(
  ctx: T,
  deprecations: readonly KitDeprecation[],
  onUse: (d: KitDeprecation) => void
): T {
  if (deprecations.length === 0) return ctx
  const wrap = <V>(target: V, node: Node): V => {
    if ((typeof target !== 'object' && typeof target !== 'function') || target === null)
      return target
    if (node.children.size === 0) return target
    const cache = new Map<string, unknown>()
    return new Proxy(target as object, {
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver)
        if (typeof key !== 'string') return value
        const child = node.children.get(key)
        if (!child) return value
        if (child.here) onUse(child.here)
        if (child.children.size === 0) return value
        if (!cache.has(key)) cache.set(key, wrap(value, child))
        return cache.get(key)
      }
    }) as V
  }
  return wrap(ctx, buildTree(deprecations))
}

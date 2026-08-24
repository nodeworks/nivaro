/**
 * Extension layout slots (#425): extensions render whole custom SECTIONS
 * inside record layouts — the section-level sibling of the field-interface
 * registry (#17). Same framework-free DOM contract:
 *
 *   window.__nvrRegisterLayoutSlot({
 *     key: 'shipment-tracker',
 *     mount(el, props) {
 *       // build DOM inside el; props carries {collection, itemId, draft}
 *       return { update(props) { … }, destroy() { … } }
 *     }
 *   })
 *
 * Authoring: a layout assignment whose field is `__ext_<key>__` renders the
 * registered slot; an unregistered key renders an honest placeholder naming
 * it, so a missing bundle is visible instead of a silent blank.
 */

export interface LayoutSlotProps {
  collection: string
  itemId: string | null
  draft: Record<string, unknown>
}

export interface LayoutSlotHandle {
  update?: (props: LayoutSlotProps) => void
  destroy?: () => void
}

export interface LayoutSlotPlugin {
  key: string
  mount: (el: HTMLElement, props: LayoutSlotProps) => LayoutSlotHandle | void
}

const registry = new Map<string, LayoutSlotPlugin>()

export function registerLayoutSlot(plugin: LayoutSlotPlugin): void {
  if (!plugin?.key || typeof plugin.mount !== 'function') return
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(plugin.key)) return
  registry.set(plugin.key, plugin)
}

export function getLayoutSlot(key: string | null | undefined): LayoutSlotPlugin | null {
  if (!key) return null
  return registry.get(key) ?? null
}

/** Extract the slot key from an assignment field name, or null. */
export function extSlotKey(field: string): string | null {
  const m = field.match(/^__ext_([a-z][a-z0-9-]{1,60})__$/)
  return m ? m[1] : null
}

declare global {
  interface Window {
    __nvrRegisterLayoutSlot?: (plugin: LayoutSlotPlugin) => void
  }
}

if (typeof window !== 'undefined') {
  window.__nvrRegisterLayoutSlot = registerLayoutSlot
}

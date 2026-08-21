/**
 * Pluggable field interfaces (#17): extensions register custom field
 * renderers (map picker, signature pad…) usable in any layout. The contract
 * is framework-free — a DOM mount function — so extension UI bundles need
 * nothing beyond the browser:
 *
 *   window.__nvrRegisterFieldInterface({
 *     interface: 'map-picker',
 *     mount(el, props) {
 *       // build DOM inside el; call props.onChange(next) on edits
 *       return { update(next) { … }, destroy() { … } }
 *     }
 *   })
 *
 * FieldRenderer consults the registry before its built-in dispatch, so a
 * field whose `interface` matches a registered name renders through the
 * plugin; unknown interfaces keep falling through to the default renderer.
 */

export interface FieldInterfaceProps {
  value: unknown
  onChange: (next: unknown) => void
  field: { field: string; label?: string | null; options?: unknown }
  readOnly: boolean
  collection: string
  itemId: string | null
}

export interface FieldInterfaceHandle {
  update?: (props: FieldInterfaceProps) => void
  destroy?: () => void
}

export interface FieldInterfacePlugin {
  interface: string
  mount: (el: HTMLElement, props: FieldInterfaceProps) => FieldInterfaceHandle | void
}

const registry = new Map<string, FieldInterfacePlugin>()
const listeners = new Set<() => void>()

export function registerFieldInterface(plugin: FieldInterfacePlugin): void {
  if (!plugin?.interface || typeof plugin.mount !== 'function') return
  registry.set(plugin.interface, plugin)
  for (const l of listeners) l()
}

export function getFieldInterface(name: string | null | undefined): FieldInterfacePlugin | null {
  if (!name) return null
  return registry.get(name) ?? null
}

export function listFieldInterfaces(): string[] {
  return [...registry.keys()]
}

/** Re-render hook support: components subscribe so a late-loading extension
 *  bundle upgrades already-mounted fields. */
export function onFieldInterfacesChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Global registration point for extension UI bundles (they cannot import
// this module — they run as standalone scripts).
declare global {
  interface Window {
    __nvrRegisterFieldInterface?: (plugin: FieldInterfacePlugin) => void
  }
}
if (typeof window !== 'undefined') {
  window.__nvrRegisterFieldInterface = registerFieldInterface
}

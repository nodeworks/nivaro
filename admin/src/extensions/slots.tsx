import type React from 'react'
import { useExtensionPlugins } from './store'
import type { ExternalApiForSlot, PluginSlots } from './types'

// Explicit per-slot context types — avoids conditional-type inference failures on
// slots that don't have a `filter` property (NavSidebarSlot, SettingsTabSlot).
type SlotContextMap = {
  'external-api-detail': { api: ExternalApiForSlot }
  'item-detail-sidebar': { collection: string; item: Record<string, unknown> }
  'nav-sidebar': Record<string, never>
  'settings-tab': Record<string, never>
  'collection-toolbar': { collection: string }
  'list-row-action': { collection: string }
}

type SlotCtx<K extends keyof PluginSlots> = K extends keyof SlotContextMap
  ? SlotContextMap[K]
  : Record<string, never>

export function usePluginSlot<K extends keyof PluginSlots>(
  slotName: K,
  ctx: SlotCtx<K>
): PluginSlots[K][] {
  const plugins = useExtensionPlugins()
  return plugins
    .flatMap((p) => {
      const slot = p.slots?.[slotName] as PluginSlots[K] | undefined
      return slot ? [slot] : []
    })
    .filter((slot) => {
      const filter = (slot as { filter?: (c: unknown) => boolean }).filter
      return !filter || filter(ctx)
    })
}

export function PluginSlot<K extends keyof PluginSlots>({
  name,
  ctx
}: {
  name: K
  ctx: SlotCtx<K>
}) {
  const slots = usePluginSlot(name, ctx)
  if (slots.length === 0) return null
  return (
    <>
      {slots.map((slot, i) => {
        const Component = (slot as { component: React.ComponentType<SlotCtx<K>> }).component
        // biome-ignore lint/suspicious/noArrayIndexKey: plugin slots have no stable key
        return <Component key={i} {...ctx} />
      })}
    </>
  )
}

import { useSyncExternalStore } from 'react'
import type { ExtensionPlugin } from './types'

let plugins: ExtensionPlugin[] = []
const subscribers = new Set<() => void>()

function notify() {
  for (const sub of subscribers) sub()
}

export function registerExtensionPlugin(plugin: ExtensionPlugin): void {
  // Deduplicate by id — re-registration replaces
  plugins = [...plugins.filter((p) => p.id !== plugin.id), plugin]
  notify()
}

export function getExtensionPlugins(): ExtensionPlugin[] {
  return plugins
}

export function useExtensionPlugins(): ExtensionPlugin[] {
  return useSyncExternalStore(
    (callback) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    () => plugins
  )
}

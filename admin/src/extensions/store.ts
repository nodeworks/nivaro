import { useSyncExternalStore } from 'react'
import type { ExtensionPlugin } from './types'

let plugins: ExtensionPlugin[] = []
let cloudPlugins: ExtensionPlugin[] = []
const subscribers = new Set<() => void>()

function notify() {
  for (const sub of subscribers) sub()
}

export function registerExtensionPlugin(plugin: ExtensionPlugin): void {
  // Reject attempts to register with reserved cloud- prefix
  if (plugin.id.startsWith('cloud-')) {
    console.warn(`[Nivaro] Extension id "${plugin.id}" uses reserved prefix "cloud-" and was rejected.`)
    return
  }
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

export function registerCloudPlugin(plugin: ExtensionPlugin): void {
  // Idempotent — re-registration of same id is a no-op (cloud plugins don't change)
  if (cloudPlugins.some((p) => p.id === plugin.id)) return
  cloudPlugins = [...cloudPlugins, plugin]
  notify()
}

export function getCloudPlugins(): ExtensionPlugin[] {
  return cloudPlugins
}

export function useCloudPlugins(): ExtensionPlugin[] {
  return useSyncExternalStore(
    (callback) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    () => cloudPlugins
  )
}

import { useEffect } from 'react'
import { api } from '@/lib/api'
import type { ExtensionManifest } from './types'

const loadedExtensions = new Set<string>()

function injectScript(ext: ExtensionManifest) {
  if (!ext.bundleUrl || loadedExtensions.has(ext.id)) return
  loadedExtensions.add(ext.id)
  const script = document.createElement('script')
  script.src = `/api/extensions/${encodeURIComponent(ext.id)}/ui.js`
  script.async = false // maintain order within each group
  script.onerror = () => {
    loadedExtensions.delete(ext.id)
  }
  document.head.appendChild(script)
}

export function ExtensionPluginLoader() {
  useEffect(() => {
    api
      .get<{ data: ExtensionManifest[] }>('/extensions/manifest')
      .then((res) => {
        const userExts = res.data.data.filter((e) => !e.cloud)
        const cloudExts = res.data.data.filter((e) => e.cloud)
        // User extensions first so cloud registrations always happen last
        // and cannot be overwritten by a later user script
        for (const ext of userExts) injectScript(ext)
        for (const ext of cloudExts) injectScript(ext)
      })
      .catch(() => {
        // Extensions are optional — silently ignore
      })
  }, [])

  return null
}

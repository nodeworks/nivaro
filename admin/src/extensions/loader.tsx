import { useEffect } from 'react'
import { api } from '@/lib/api'
import type { ExtensionManifest } from './types'

const loadedExtensions = new Set<string>()

export function ExtensionPluginLoader() {
  useEffect(() => {
    api
      .get<{ data: ExtensionManifest[] }>('/extensions/manifest')
      .then((res) => {
        for (const ext of res.data.data) {
          if (ext.bundleUrl && !loadedExtensions.has(ext.id)) {
            loadedExtensions.add(ext.id)
            const script = document.createElement('script')
            script.src = `/api/extensions/${encodeURIComponent(ext.id)}/ui.js`
            script.async = true
            script.onerror = () => {
              loadedExtensions.delete(ext.id)
            }
            document.head.appendChild(script)
          }
        }
      })
      .catch(() => {
        // Extensions are optional — silently ignore
      })
  }, [])

  return null
}

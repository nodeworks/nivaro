import { describe, expect, it } from 'vitest'
import { adminAssetCacheControl } from '../../../lib/static-cache.js'

const IMMUTABLE = 'public, max-age=31536000, immutable'

describe('adminAssetCacheControl', () => {
  it('keeps hashed vite assets for a year, compressed twins too', () => {
    expect(adminAssetCacheControl('/app/admin/dist/assets/index-z_iz5a-_.js')).toBe(IMMUTABLE)
    expect(adminAssetCacheControl('/app/admin/dist/assets/index-z_iz5a-_.js.br')).toBe(IMMUTABLE)
    expect(adminAssetCacheControl('/app/admin/dist/assets/react-D3tBxehk.js.gz')).toBe(IMMUTABLE)
    expect(adminAssetCacheControl('/app/admin/dist/assets/index-BcSrXgWc.css')).toBe(IMMUTABLE)
    expect(adminAssetCacheControl('C:\\app\\dist\\assets\\logo-a1B2c3D4.svg')).toBe(IMMUTABLE)
  })

  it('revalidates index.html, the service worker and unhashed files', () => {
    expect(adminAssetCacheControl('/app/admin/dist/index.html')).toBe('no-cache')
    expect(adminAssetCacheControl('/app/admin/dist/index.html.br')).toBe('no-cache')
    expect(adminAssetCacheControl('/app/admin/dist/sw.js')).toBe('no-cache')
    expect(adminAssetCacheControl('/app/admin/dist/favicon.svg')).toBe('no-cache')
    expect(adminAssetCacheControl('/app/admin/dist/assets/manifest.json')).toBe('no-cache')
  })
})

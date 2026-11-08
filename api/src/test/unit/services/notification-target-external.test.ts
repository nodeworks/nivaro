import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn(() => ({ first: async () => undefined })) }))

import { adminPageBase } from '../../../services/app-links.js'
import {
  absoluteTargetUrl,
  normalizeTarget,
  resolveTargetUrl
} from '../../../services/notification-target.js'

describe('an external notification target with an in-app path still opens something', () => {
  it('keeps an http(s) URL as it is', () => {
    expect(absoluteTargetUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1')
  })

  it('makes an admin path absolute on the admin host (it used to be dropped: the notice opened nothing)', async () => {
    const spec = normalizeTarget({ kind: 'external', url: '/data-integrity?tab=people' })
    expect(spec?.url).toBe(`${adminPageBase()}/data-integrity?tab=people`)
    expect(await resolveTargetUrl(spec, { app: 'admin' })).toBe(
      `${adminPageBase()}/data-integrity?tab=people`
    )
  })

  it('refuses protocol-relative, backslash and script URLs', () => {
    expect(absoluteTargetUrl('//evil.example.com/x')).toBeNull()
    expect(absoluteTargetUrl('/\\evil.example.com')).toBeNull()
    expect(absoluteTargetUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeTarget({ kind: 'external', url: 'data:text/html,hi' })?.url).toBeUndefined()
  })
})

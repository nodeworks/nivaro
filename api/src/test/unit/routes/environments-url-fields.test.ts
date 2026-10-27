import { describe, expect, it, vi } from 'vitest'

// Security audit 2026-10-27: an environment component's base_url (rendered as
// a link) and git_url (fetched) must be http(s) URLs.

vi.mock('../../../config.js', () => ({ config: { PUBLIC_URL: 'https://n.test' } }))
vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => '' }) }))
vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: async () => {} }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/environment-self.js', () => ({ partitionSelf: vi.fn() }))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'k' }))

import { urlFieldError } from '../../../routes/environments.js'

describe('urlFieldError', () => {
  it('accepts http(s) URLs and empty values', () => {
    expect(urlFieldError({ base_url: 'https://staging.example.com' })).toBeNull()
    expect(urlFieldError({ base_url: 'http://10.0.0.5:3055', git_url: '' })).toBeNull()
    expect(urlFieldError({ base_url: null, git_url: undefined })).toBeNull()
    expect(urlFieldError({})).toBeNull()
  })

  it('refuses javascript:, data:, scheme-relative and bare hosts', () => {
    for (const v of [
      'javascript:alert(document.cookie)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>1</script>',
      '//evil.example',
      'staging.example.com'
    ]) {
      expect(urlFieldError({ base_url: v }), v).not.toBeNull()
      expect(urlFieldError({ git_url: v }), v).not.toBeNull()
    }
    expect(urlFieldError({ base_url: 42 })).not.toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn() }))
vi.mock('../../../extensions/loader.js', () => ({
  extensionEnvDecls: new Map(),
  describeExtensionEnv: () => []
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'development' }))

import { comparePresence, type PresenceColumn } from '../../../routes/env-presence.js'

const col = (
  name: string,
  set: Record<string, boolean>,
  state: PresenceColumn['state'] = 'ok'
): PresenceColumn => ({
  id: name === 'local' ? 'local' : name.length,
  name,
  environment: name,
  state,
  set,
  extensions: ['efp-ops']
})

describe('comparePresence (#1047)', () => {
  it('says which environment holds a variable and which is missing it', () => {
    const { rows, warnings } = comparePresence(
      [
        col('staging', { 'efp-ops/EFP_NUVOLO_USER': true, 'efp-ops/EFP_OPS_TAKEOVER': true }),
        col('production', { 'efp-ops/EFP_NUVOLO_USER': false, 'efp-ops/EFP_OPS_TAKEOVER': true })
      ],
      [
        { extension: 'efp-ops', name: 'EFP_NUVOLO_USER', required: true, secret: false, set: true },
        {
          extension: 'efp-ops',
          name: 'EFP_OPS_TAKEOVER',
          required: false,
          secret: false,
          set: true
        }
      ]
    )
    expect(rows.find((r) => r.name === 'EFP_NUVOLO_USER')?.differs).toBe(true)
    expect(rows.find((r) => r.name === 'EFP_OPS_TAKEOVER')?.differs).toBe(false)
    expect(warnings).toEqual([
      'EFP_NUVOLO_USER (efp-ops) is set on staging, missing on production — the extension requires it'
    ])
  })

  it('never judges a column that could not answer, or that does not declare the variable', () => {
    const { warnings } = comparePresence(
      [
        col('staging', { 'efp-ops/NEW_VAR': true }),
        col('production', {}, 'unreachable'),
        col('older', { 'efp-ops/OTHER': true })
      ],
      [{ extension: 'efp-ops', name: 'NEW_VAR', required: false, secret: false, set: true }]
    )
    expect(warnings).toEqual([])
  })
})

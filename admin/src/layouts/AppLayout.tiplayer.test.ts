import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `data-tip` tooltips (ConfirmButton, the field ⋯ button, profile and Traffic Map controls)
// need a live TipLayer; the admin shell mounts one for every page.
describe('AppLayout', () => {
  it('mounts one app-wide TipLayer from @nivaro/shared', () => {
    const src = readFileSync(join(__dirname, 'AppLayout.tsx'), 'utf8')
    expect(src).toMatch(/import \{[^}]*\bTipLayer\b[^}]*\} from '@nivaro\/shared'/)
    expect(src.match(/<TipLayer \/>/g)).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import { BUILTIN_KITS } from '../../../services/mcp-kits.js'

const { kitFieldset } = await import('../../../routes/oauth.js')

describe('consent page kit picker (#3214)', () => {
  it('offers everything plus every kit, everything chosen by default', () => {
    const html = kitFieldset({ kits: BUILTIN_KITS, current: null })
    expect(html).toContain('<legend>What it may use</legend>')
    expect(html).toContain('value="" checked')
    for (const k of BUILTIN_KITS) expect(html).toContain(`value="${k.key}"`)
    expect(html).not.toContain('__keep')
  })

  it('keeps an earlier custom limit unless the person picks again', () => {
    const html = kitFieldset({
      kits: BUILTIN_KITS,
      current: { kit: null, custom: true, locked: false }
    })
    expect(html).toContain('value="__keep" checked')
  })

  it('preselects the kit the app already has', () => {
    const html = kitFieldset({
      kits: BUILTIN_KITS,
      current: { kit: 'ops', custom: false, locked: false }
    })
    expect(html).toContain('value="ops" checked')
  })

  it('shows, and never offers, a locked limit', () => {
    const html = kitFieldset({
      kits: BUILTIN_KITS,
      current: { kit: 'ops', custom: false, locked: true }
    })
    expect(html).toContain('type="hidden" name="kit" value="__keep"')
    expect(html).not.toContain('type="radio"')
  })

  it('escapes kit text', () => {
    const html = kitFieldset({
      kits: [{ ...BUILTIN_KITS[0], key: 'x', label: '<b>x</b>', description: '"q"' }],
      current: null
    })
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('is empty before the migration', () => {
    expect(kitFieldset(null)).toBe('')
  })
})

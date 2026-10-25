// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ghostText } from './FieldAffordances'

describe('ghostText (remote-change ghost)', () => {
  it('shows rich text as plain text, entities decoded', () => {
    expect(ghostText('<p>tab2 &lt;b&gt;value&lt;/b&gt; &amp; more <b>BOLD</b></p>')).toBe(
      'tab2 <b>value</b> & more BOLD'
    )
    expect(ghostText('a&nbsp;b')).toBe('a b')
  })

  it('keeps plain values as they are', () => {
    expect(ghostText('plain')).toBe('plain')
    expect(ghostText('')).toBe('empty')
    expect(ghostText(true)).toBe('Yes')
    expect(ghostText('x'.repeat(90))).toBe(`${'x'.repeat(80)}…`)
  })
})

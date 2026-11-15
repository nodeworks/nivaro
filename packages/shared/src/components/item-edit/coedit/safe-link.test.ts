import { describe, expect, it } from 'vitest'
import { isSafeLinkHref } from './safe-link'

describe('rich-text link hrefs (review 2026-11-14 L7)', () => {
  it('never renders a script, data or file href, however it is spelled', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd'
    ])
      expect(isSafeLinkHref(href)).toBe(false)
    expect(isSafeLinkHref({ href: 'x' })).toBe(false)
  })
  it('keeps ordinary, mail, record and relative links', () => {
    for (const href of [
      'https://a.test/x?y=1',
      'mailto:a@b.c',
      'record://orders/7',
      '/x',
      '#top',
      ''
    ])
      expect(isSafeLinkHref(href)).toBe(true)
    expect(isSafeLinkHref(null)).toBe(true)
  })
})

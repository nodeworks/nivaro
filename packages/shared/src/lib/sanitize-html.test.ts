// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from './sanitize-html'

describe('sanitizeHtml', () => {
  it('keeps formatting, drops executables', () => {
    const out = sanitizeHtml(
      '<p>hi <b>there</b><script>alert(1)</script><svg onload=alert(1)></svg><img src=x onerror=alert(1)></p>'
    )
    expect(out).toBe('<p>hi <b>there</b></p>')
  })
  it('blocks scheme bypasses', () => {
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).not.toContain('href')
    expect(sanitizeHtml('<a href="data:text/html,x">x</a>')).not.toContain('href')
    expect(sanitizeHtml('<a href="https://a.b/c">x</a>')).toContain('href="https://a.b/c"')
    expect(sanitizeHtml('<a href="/rel">x</a>')).toContain('href="/rel"')
  })
  it('strips handlers and unknown attrs, unwraps unknown tags', () => {
    expect(sanitizeHtml('<p onclick="x" style="color:red" data-x="1">t</p>')).toBe('<p>t</p>')
    expect(sanitizeHtml('<font color="red">t</font>')).toBe('t')
  })
})

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { htmlToText, sanitizeHtml } from './sanitize-html'

describe('htmlToText', () => {
  it('returns the words without running anything in the markup', () => {
    const w = window as unknown as { __xssProbe?: number }
    w.__xssProbe = 0
    const created: string[] = []
    const real = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string, o?: any) => {
      created.push(tag)
      return real(tag, o)
    })
    const out = htmlToText(
      '<p>Vendor <b>Acme</b></p><img src=x onerror="window.__xssProbe=1"><script>window.__xssProbe=2</script>'
    )
    spy.mockRestore()
    expect(out.trim()).toBe('Vendor Acme')
    expect(created).toEqual([])
    expect(w.__xssProbe).toBe(0)
  })
  it('collapses whitespace', () => {
    expect(htmlToText('<p>a</p>\n\n<p>b&nbsp; c</p>')).toBe('a b c')
  })
})

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

import { isValidElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { inAppHref, isSafeAppPath, renderInline } from './AiMarkdown'

describe('links in Ask AI answers (#1503)', () => {
  it('a path becomes an in-app link, an absolute URL a new-tab link', () => {
    const out = renderInline(
      'See [Watch 0:42 of Submit](/help-videos?watch=abc&t=42) or [docs](https://example.com/x)'
    )
    const links = out.filter(isValidElement) as ReactElement<Record<string, unknown>>[]
    expect(links).toHaveLength(2)
    expect(links[0].props.href).toBe('/help-videos?watch=abc&t=42')
    expect(links[0].props.label).toBe('Watch 0:42 of Submit')
    expect(links[1].props.target).toBe('_blank')
  })

  it('never treats a protocol-relative or script URL as a link', () => {
    const out = renderInline('[x](//evil.example/a) [y](javascript:alert(1))')
    expect(out.filter(isValidElement)).toHaveLength(0)
  })

  it('maps /help-videos onto the host library path', () => {
    expect(inAppHref('/help-videos?watch=a&t=3', '/help')).toBe('/help?watch=a&t=3')
    expect(inAppHref('/help-videos?watch=a', undefined)).toBe('/help-videos?watch=a')
    expect(inAppHref('/help-videos-old', '/help')).toBe('/help-videos-old')
    expect(inAppHref('/collections/x/1', '/help')).toBe('/collections/x/1')
  })
  it('never treats a path that leaves the origin as in-app', () => {
    expect(isSafeAppPath('/help-videos?watch=a&t=3')).toBe(true)
    expect(isSafeAppPath('//evil.example')).toBe(false)
    expect(isSafeAppPath('/\\evil.example')).toBe(false)
    expect(isSafeAppPath('/\t/evil.example')).toBe(false)
    expect(isSafeAppPath('/a\\b')).toBe(false)
    expect(isSafeAppPath('/a b')).toBe(false)
  })
})

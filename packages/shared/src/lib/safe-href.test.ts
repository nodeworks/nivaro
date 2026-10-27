import { describe, expect, it } from 'vitest'
import { isInAppPath, safeLinkKind } from './safe-href'

describe('safeLinkKind', () => {
  it('in-app paths are internal', () => {
    for (const h of ['/', '/collections/projects/12', '/my-work?tab=tasks#x'])
      expect(safeLinkKind(h), h).toBe('internal')
  })

  it('http(s) links are external', () => {
    expect(safeLinkKind('https://example.com/a')).toBe('external')
    expect(safeLinkKind('HTTP://example.com')).toBe('external')
  })

  it('scheme-relative and script links are refused', () => {
    for (const h of [
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      'javascript:alert(1)',
      'data:text/html,x',
      ' /x',
      'evil.example'
    ])
      expect(safeLinkKind(h), h).toBeNull()
    expect(isInAppPath('//evil.example')).toBe(false)
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecordPopout, openRecordPopout, recordPopoutHref } from './record-popout'

describe('recordPopoutHref', () => {
  it('adds popout=1 once, keeping the query and hash', () => {
    expect(recordPopoutHref('/collections/projects/7')).toBe('/collections/projects/7?popout=1')
    expect(recordPopoutHref('/collections/projects/7?layout=pub#notes')).toBe(
      '/collections/projects/7?layout=pub&popout=1#notes'
    )
    expect(recordPopoutHref('/x?popout=1')).toBe('/x?popout=1')
  })
})

describe('openRecordPopout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens one named window per record, with no token in the URL', () => {
    const focus = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue({ focus } as unknown as Window)
    expect(openRecordPopout('/collections/projects/7', 'projects', '7')).toBe(true)
    const [url, name, features] = open.mock.calls[0]
    expect(url).toBe('/collections/projects/7?popout=1')
    expect(name).toBe('nvr-record:projects:7')
    expect(String(features)).toContain('popup=yes')
    expect(String(features)).not.toContain('noopener')
    expect(focus).toHaveBeenCalled()
  })

  it('reports a blocked window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openRecordPopout('/collections/projects/7', 'projects', '7')).toBe(false)
  })

  it('knows a pop-out window by its query or its name', () => {
    expect(isRecordPopout()).toBe(false)
    window.name = 'nvr-record:projects:7'
    expect(isRecordPopout()).toBe(true)
    window.name = ''
  })
})

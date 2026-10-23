import { beforeEach, describe, expect, it } from 'vitest'
import {
  addPresenceSocket,
  isPresenceRefreshOwner,
  removePresenceSocket,
  resetPresenceSockets
} from '../../../services/presence-sockets.js'

beforeEach(() => resetPresenceSockets())

describe('presence sockets', () => {
  it('a second tab keeps the person online when the first disconnects', () => {
    addPresenceSocket('u-1', 'a')
    addPresenceSocket('u-1', 'b')
    expect(removePresenceSocket('u-1', 'a')).toBe(false)
    expect(removePresenceSocket('u-1', 'b')).toBe(true)
  })

  it('matches user ids case-insensitively', () => {
    addPresenceSocket('abc-DEF', 'a')
    addPresenceSocket('ABC-def', 'b')
    expect(removePresenceSocket('abc-def', 'a')).toBe(false)
    expect(removePresenceSocket('ABC-DEF', 'b')).toBe(true)
  })

  it('an unknown or already-removed socket never reports the person gone', () => {
    expect(removePresenceSocket('u-1', 'a')).toBe(false)
    addPresenceSocket('u-1', 'a')
    expect(removePresenceSocket('u-1', 'a')).toBe(true)
    expect(removePresenceSocket('u-1', 'a')).toBe(false)
  })

  it('one socket per person owns the refresh, and it passes on when that socket goes', () => {
    addPresenceSocket('u-1', 'a')
    addPresenceSocket('u-1', 'b')
    expect(isPresenceRefreshOwner('u-1', 'a')).toBe(true)
    expect(isPresenceRefreshOwner('u-1', 'b')).toBe(false)
    removePresenceSocket('u-1', 'a')
    expect(isPresenceRefreshOwner('u-1', 'b')).toBe(true)
    removePresenceSocket('u-1', 'b')
    expect(isPresenceRefreshOwner('u-1', 'b')).toBe(false)
  })
})

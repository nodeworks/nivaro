import { describe, expect, it } from 'vitest'
import {
  barGeometry,
  canRewindTo,
  looksLikeCredential,
  pageHasFocus,
  searchKey,
  windowText
} from './logic'

describe('looksLikeCredential', () => {
  it('keeps keys and long opaque tokens on the client; uuids and ids go through', () => {
    expect(looksLikeCredential('nvk_abc123')).toBe(true)
    expect(looksLikeCredential(' NVM_x ')).toBe(true)
    expect(looksLikeCredential('Bearer x')).toBe(true)
    expect(looksLikeCredential('ab12'.repeat(16))).toBe(true)
    expect(looksLikeCredential('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(false)
    expect(looksLikeCredential('CR26-80329')).toBe(false)
    expect(looksLikeCredential('')).toBe(false)
  })
})

describe('barGeometry', () => {
  it('places bars by offset and duration, keeping zero-length calls visible', () => {
    expect(barGeometry(0, 50, 100)).toEqual({ left: 0, width: 50 })
    expect(barGeometry(50, 0, 100)).toEqual({ left: 50, width: 0.6 })
    expect(barGeometry(90, 50, 100)).toEqual({ left: 90, width: 10 })
    expect(barGeometry(0, 10, 0)).toEqual({ left: 0, width: 100 })
  })
})

describe('window and rewind', () => {
  it('words a window', () => {
    expect(windowText(300)).toBe('±5 min')
    expect(windowText(45)).toBe('±45 s')
    expect(windowText(3600)).toBe('±60 min')
    expect(windowText(7200)).toBe('±2 h')
  })
  it('rewinds only inside the map’s 15-minute ring', () => {
    const now = 1_000_000_000
    expect(canRewindTo(now - 60_000, now)).toBe(true)
    expect(canRewindTo(now - 16 * 60_000, now)).toBe(false)
    expect(canRewindTo(null, now)).toBe(false)
  })
})

describe('page-scoped search keys', () => {
  it('/ only when not typing; ⌘K / Ctrl-K always', () => {
    const input = document.createElement('input')
    expect(
      searchKey({ key: '/', metaKey: false, ctrlKey: false, altKey: false, target: document.body })
    ).toBe('slash')
    expect(
      searchKey({ key: '/', metaKey: false, ctrlKey: false, altKey: false, target: input })
    ).toBeNull()
    expect(
      searchKey({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, target: input })
    ).toBe('mod-k')
    expect(
      searchKey({ key: 'K', metaKey: false, ctrlKey: true, altKey: false, target: document.body })
    ).toBe('mod-k')
    expect(
      searchKey({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, target: document.body })
    ).toBeNull()
  })
  it('the page has focus when focus is inside it, or nothing is focused after a click inside', () => {
    const page = document.createElement('div')
    page.className = 'traffic-map'
    const btn = document.createElement('button')
    page.appendChild(btn)
    const outside = document.createElement('button')
    document.body.append(page, outside)
    expect(pageHasFocus(btn, false)).toBe(true)
    expect(pageHasFocus(outside, true)).toBe(false)
    expect(pageHasFocus(document.body, true)).toBe(true)
    expect(pageHasFocus(document.body, false)).toBe(false)
    page.remove()
    outside.remove()
  })
})

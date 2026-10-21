import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./instance-key.js', () => ({ instanceKey: () => 'test' }))

import {
  HUDDLE_DEFAULTS,
  HUDDLE_MASK,
  iceServersFrom,
  maskHuddleSettings,
  mergeHuddlePatch,
  normalizeHuddleSettings,
  turnRestCredential
} from './huddle-settings.js'

describe('normalizeHuddleSettings', () => {
  it('defaults when nothing is stored', () => {
    expect(normalizeHuddleSettings(undefined)).toEqual(HUDDLE_DEFAULTS)
    expect(normalizeHuddleSettings('garbage')).toEqual(HUDDLE_DEFAULTS)
  })

  it('keeps only stun/turn urls of the right scheme, from a list or a text block', () => {
    const s = normalizeHuddleSettings({
      stun_urls: 'stun:a.example:3478, http://nope, turn:wrong-list',
      turn_urls: ['turn:t.example:3478?transport=udp', 'turns:t.example:5349', 'stun:x', '']
    })
    expect(s.stun_urls).toEqual(['stun:a.example:3478'])
    expect(s.turn_urls).toEqual(['turn:t.example:3478?transport=udp', 'turns:t.example:5349'])
  })

  it('clamps ttl and participant cap', () => {
    expect(normalizeHuddleSettings({ turn_ttl_s: 5, max_participants: 99 })).toMatchObject({
      turn_ttl_s: 60,
      max_participants: 16
    })
    expect(normalizeHuddleSettings({ max_participants: 1 }).max_participants).toBe(2)
    expect(normalizeHuddleSettings({ turn_ttl_s: 'x' }).turn_ttl_s).toBe(3600)
  })
})

describe('mask + merge', () => {
  const stored = normalizeHuddleSettings({
    turn_urls: ['turn:t:3478'],
    turn_username: 'u',
    turn_credential: 'p',
    turn_secret: 's3cret'
  })

  it('masks both secrets and names the default STUN', () => {
    const m = maskHuddleSettings(stored)
    expect(m.turn_credential).toBe(HUDDLE_MASK)
    expect(m.turn_secret).toBe(HUDDLE_MASK)
    expect(m.turn_username).toBe('u')
    expect(m.stun_default[0]).toMatch(/^stun:/)
  })

  it('a masked secret re-submitted keeps the stored value; blank clears it', () => {
    const kept = mergeHuddlePatch(stored, {
      turn_secret: HUDDLE_MASK,
      turn_credential: HUDDLE_MASK
    })
    expect(kept.turn_secret).toBe('s3cret')
    expect(kept.turn_credential).toBe('p')
    const cleared = mergeHuddlePatch(stored, { turn_secret: '', enabled: false })
    expect(cleared.turn_secret).toBeNull()
    expect(cleared.enabled).toBe(false)
    expect(cleared.turn_credential).toBe('p')
  })

  it('ignores unknown keys', () => {
    const next = mergeHuddlePatch(stored, { evil: 1 } as unknown)
    expect((next as unknown as Record<string, unknown>).evil).toBeUndefined()
  })
})

describe('ICE servers', () => {
  it('falls back to the public STUN when none is set and adds no TURN without urls', () => {
    const ice = iceServersFrom(HUDDLE_DEFAULTS, 'U1')
    expect(ice).toHaveLength(1)
    expect(ice[0].urls[0]).toMatch(/^stun:/)
  })

  it('mints a coturn REST credential per person; the secret never appears', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:t:3478'],
      turn_secret: 'shh',
      turn_ttl_s: 600
    })
    const now = 1_700_000_000_000
    const ice = iceServersFrom(s, 'USER-1', now)
    const turn = ice[1]
    expect(turn.username).toBe(`${1_700_000_000 + 600}:USER-1`)
    expect(turn.credential).toBe(
      createHmac('sha1', 'shh')
        .update(turn.username as string)
        .digest('base64')
    )
    expect(JSON.stringify(ice)).not.toContain('shh')
    expect(turnRestCredential('shh', 'USER-1', 600, now)).toEqual({
      username: turn.username,
      credential: turn.credential
    })
  })

  it('hands out a static credential pair when there is no shared secret', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:t:3478'],
      turn_username: 'u',
      turn_credential: 'p'
    })
    expect(iceServersFrom(s, 'X')[1]).toEqual({
      urls: ['turn:t:3478'],
      username: 'u',
      credential: 'p'
    })
  })
})

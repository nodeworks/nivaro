import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./instance-key.js', () => ({ instanceKey: () => 'test' }))

import {
  HUDDLE_DEFAULTS,
  HUDDLE_MASK,
  iceResponseFor,
  iceServersFrom,
  maskHuddleSettings,
  mergeHuddlePatch,
  normalizeHuddleSettings,
  sfuConfigured,
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

describe('large huddles (#2859) settings', () => {
  const sfu = {
    livekit_url: 'wss://media.example.com',
    livekit_api_key: 'APIkey',
    livekit_api_secret: 'lk-secret'
  }

  it('defaults: no SFU, switch at 5; a bad url is dropped', () => {
    expect(HUDDLE_DEFAULTS).toMatchObject({
      livekit_url: null,
      livekit_api_key: null,
      livekit_api_secret: null,
      switch_at: 5
    })
    expect(sfuConfigured(HUDDLE_DEFAULTS)).toBe(false)
    expect(normalizeHuddleSettings({ livekit_url: 'https://nope' }).livekit_url).toBeNull()
    expect(normalizeHuddleSettings({ livekit_url: 'ws://localhost:7880' }).livekit_url).toBe(
      'ws://localhost:7880'
    )
    expect(normalizeHuddleSettings({ switch_at: 0 }).switch_at).toBe(5)
    expect(normalizeHuddleSettings({ switch_at: 1 }).switch_at).toBe(2)
  })

  it('the participant cap follows the media path: mesh 8/16, SFU 25/100', () => {
    const mesh = normalizeHuddleSettings({ max_participants: 40 })
    expect(mesh.max_participants).toBe(16)
    const s = normalizeHuddleSettings(sfu)
    expect(sfuConfigured(s)).toBe(true)
    expect(s.max_participants).toBe(25)
    expect(normalizeHuddleSettings({ ...sfu, max_participants: 40 }).max_participants).toBe(40)
    expect(normalizeHuddleSettings({ ...sfu, max_participants: 500 }).max_participants).toBe(100)
    // Only a url + key + secret together make an SFU.
    expect(sfuConfigured(normalizeHuddleSettings({ ...sfu, livekit_api_secret: '' }))).toBe(false)
  })

  it('masked secret round trip: the mask keeps the stored secret, blank clears it', () => {
    const stored = normalizeHuddleSettings(sfu)
    const masked = maskHuddleSettings(stored)
    expect(masked.livekit_api_secret).toBe(HUDDLE_MASK)
    expect(masked.livekit_api_key).toBe('APIkey')
    expect(JSON.stringify(masked)).not.toContain('lk-secret')
    // The Settings page sends back exactly what it was shown.
    const kept = mergeHuddlePatch(stored, { ...masked, switch_at: 8 })
    expect(kept.livekit_api_secret).toBe('lk-secret')
    expect(kept.switch_at).toBe(8)
    const cleared = mergeHuddlePatch(stored, { livekit_api_secret: '' })
    expect(cleared.livekit_api_secret).toBeNull()
    expect(sfuConfigured(cleared)).toBe(false)
    expect(cleared.max_participants).toBe(16)
  })

  it('configuring the SFU lets an untouched mesh cap re-default to 25', () => {
    const mesh = normalizeHuddleSettings({})
    expect(mergeHuddlePatch(mesh, sfu).max_participants).toBe(25)
    // An explicit cap is a choice and stays.
    expect(
      mergeHuddlePatch(normalizeHuddleSettings({ max_participants: 6 }), sfu).max_participants
    ).toBe(6)
    expect(mergeHuddlePatch(mesh, { ...sfu, max_participants: 12 }).max_participants).toBe(12)
  })
})

describe('ICE servers', () => {
  it('names no server at all when none is configured (never a third party by default)', () => {
    expect(iceServersFrom(HUDDLE_DEFAULTS, 'U1')).toEqual([])
    const stun = normalizeHuddleSettings({ stun_urls: ['stun:s.example:3478'] })
    expect(iceServersFrom(stun, 'U1')).toEqual([{ urls: ['stun:s.example:3478'] }])
  })

  it('mints a coturn REST credential per person; the secret never appears', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:t:3478'],
      turn_secret: 'shh',
      turn_ttl_s: 600
    })
    const now = 1_700_000_000_000
    const ice = iceServersFrom(s, 'USER-1', now)
    const turn = ice[0]
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

  it('a lookup without turn: true gets STUN at most', () => {
    const s = normalizeHuddleSettings({
      stun_urls: ['stun:s:3478'],
      turn_urls: ['turn:t:3478'],
      turn_secret: 'shh'
    })
    expect(iceServersFrom(s, 'U', Date.now(), false)).toEqual([{ urls: ['stun:s:3478'] }])
  })

  it('hands out a static credential pair when there is no shared secret', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:t:3478'],
      turn_username: 'u',
      turn_credential: 'p'
    })
    expect(iceServersFrom(s, 'X')[0]).toEqual({
      urls: ['turn:t:3478'],
      username: 'u',
      credential: 'p'
    })
  })
})

describe('iceResponseFor (the /ice answer)', () => {
  const s = normalizeHuddleSettings({
    stun_urls: ['stun:s:3478'],
    turn_urls: ['turn:t:3478'],
    turn_secret: 'shh'
  })
  const seeOnly = (ok: string) => async (room: string) => room === ok

  it('gives nothing at all while huddles are off — not even STUN', async () => {
    const off = normalizeHuddleSettings({ ...s, enabled: false })
    const r = await iceResponseFor(off, 'U', 'ch:ops', seeOnly('ch:ops'))
    expect(r).toMatchObject({ enabled: false, iceServers: [] })
  })

  it('without a room: STUN only, no TURN credential', async () => {
    const r = await iceResponseFor(s, 'U', null, seeOnly('ch:ops'))
    expect(r.iceServers).toEqual([{ urls: ['stun:s:3478'] }])
  })

  it('a room the person cannot see: STUN only', async () => {
    const r = await iceResponseFor(s, 'U', 'ch:secret', seeOnly('ch:ops'))
    expect(r.iceServers).toEqual([{ urls: ['stun:s:3478'] }])
    expect(JSON.stringify(r)).not.toContain('turn:')
  })

  it('a room the person can see: TURN credential minted for them', async () => {
    const r = await iceResponseFor(s, 'U', 'ch:ops', seeOnly('ch:ops'))
    expect(r.iceServers).toHaveLength(2)
    expect(r.iceServers[1].urls).toEqual(['turn:t:3478'])
    expect(r.iceServers[1].username).toMatch(/^\d+:U$/)
    expect(JSON.stringify(r)).not.toContain('shh')
  })
})

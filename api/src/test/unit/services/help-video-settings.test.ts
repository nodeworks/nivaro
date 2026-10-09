import { beforeEach, describe, expect, it, vi } from 'vitest'

// The settings row and whether migration 410 has run, as the mocked db sees it.
const h = vi.hoisted(() => ({
  column: true,
  row: { id: 1, help_video_settings: null as string | null } as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>
}))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (_t: string, c: string) => c === 'help_video_settings' && h.column
}))
vi.mock('../../../db/index.js', () => ({
  db: () => {
    const b = {
      where: () => b,
      first: async () => ({ ...h.row }),
      update: async (patch: Record<string, unknown>) => {
        h.updates.push(patch)
        Object.assign(h.row, patch)
        return 1
      }
    }
    return b
  }
}))

const s = await import('../../../services/help-video-settings.js')

beforeEach(() => {
  h.column = true
  h.row = { id: 1, help_video_settings: null }
  h.updates = []
  s.bustHelpVideoSettings()
})

describe('effectiveEncoder', () => {
  it("defaults to today's encode", () => {
    const { encoder, sources } = s.effectiveEncoder({}, {})
    expect(encoder).toEqual({
      preset: 'veryfast',
      crf: 23,
      two_pass_over_minutes: 0,
      hardware: 'off'
    })
    expect(sources.crf).toBe('default')
  })
  it('takes the environment for keys the settings leave unset', () => {
    const { encoder, sources } = s.effectiveEncoder(
      { crf: 20 },
      {
        HELP_VIDEO_ENCODER_PRESET: 'medium',
        HELP_VIDEO_ENCODER_CRF: '28',
        HELP_VIDEO_HARDWARE_ENCODER: 'auto'
      }
    )
    expect(encoder).toMatchObject({ preset: 'medium', crf: 20, hardware: 'auto' })
    expect(sources).toMatchObject({ preset: 'env', crf: 'setting', hardware: 'env' })
  })
  it('ignores a bad environment value', () => {
    expect(s.effectiveEncoder({}, { HELP_VIDEO_ENCODER_CRF: '99' }).encoder.crf).toBe(23)
  })
})

describe('validateEncoderPatch', () => {
  it('names every bad key', () => {
    expect(() =>
      s.validateEncoderPatch({ preset: 'warp', crf: 12, hardware: 'gpu', colour: 'blue' })
    ).toThrow(/preset.*crf.*hardware.*colour|colour/)
    try {
      s.validateEncoderPatch({ preset: 'warp', crf: 12 })
    } catch (e) {
      expect((e as Error).message).toContain('encoder.preset must be one of')
      expect((e as Error).message).toContain('encoder.crf must be a whole number from 16 to 32')
    }
  })
  it('accepts good values and null as "unset"', () => {
    expect(
      s.validateEncoderPatch({
        preset: 'Medium',
        crf: '20',
        two_pass_over_minutes: 5,
        hardware: null
      })
    ).toEqual({
      preset: 'medium',
      crf: 20,
      two_pass_over_minutes: 5,
      hardware: null
    })
  })
})

describe('serializeSettings', () => {
  it('keeps keys it does not own exactly as stored', () => {
    const stored = JSON.stringify({ house_style: { intro: true, colours: ['#fff'] }, future: 1 })
    const out = s.serializeSettings(stored, { encoder: { crf: 20 } })
    expect(JSON.parse(String(out))).toEqual({
      house_style: { intro: true, colours: ['#fff'] },
      future: 1,
      encoder: { crf: 20 }
    })
  })
  it('merges into the stored encoder and unsets with null', () => {
    const stored = JSON.stringify({ encoder: { crf: 20, preset: 'fast' } })
    expect(
      JSON.parse(
        String(s.serializeSettings(stored, { encoder: { preset: null, hardware: 'auto' } }))
      )
    ).toEqual({
      encoder: { crf: 20, hardware: 'auto' }
    })
  })
  it('stores NULL when nothing is left', () => {
    expect(
      s.serializeSettings(JSON.stringify({ encoder: { crf: 20 } }), { encoder: { crf: null } })
    ).toBeNull()
  })
  it('treats unreadable stored JSON as empty', () => {
    expect(s.serializeSettings('{nope', { encoder: { crf: 30 } })).toBe('{"encoder":{"crf":30}}')
  })
})

describe('load + save', () => {
  it('answers the defaults and migrated:false without the column', async () => {
    h.column = false
    expect(await s.loadHelpVideoSettings()).toEqual({ migrated: false, stored: {} })
    expect(await s.renderEncoderSettings()).toEqual(s.ENCODER_DEFAULTS)
  })
  it('refuses a save without the column (409)', async () => {
    h.column = false
    await expect(s.saveHelpVideoSettings({ encoder: { crf: 20 } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
    })
    expect(h.updates).toEqual([])
  })
  it('saves only the encoder and keeps a house_style written meanwhile', async () => {
    h.row.help_video_settings = JSON.stringify({ house_style: { audio: true } })
    await s.saveHelpVideoSettings({ encoder: { hardware: 'auto', crf: 21 } })
    expect(JSON.parse(String(h.row.help_video_settings))).toEqual({
      house_style: { audio: true },
      encoder: { hardware: 'auto', crf: 21 }
    })
    expect(await s.renderEncoderSettings()).toMatchObject({
      hardware: 'auto',
      crf: 21,
      preset: 'veryfast'
    })
  })
  it('refuses a bad value without writing (400)', async () => {
    await expect(s.saveHelpVideoSettings({ encoder: { crf: 50 } })).rejects.toMatchObject({
      statusCode: 400
    })
    expect(h.updates).toEqual([])
  })
})

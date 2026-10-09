import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1551 — the house style: normalizing, a new video's first edits, saving it
// beside the encoder settings without touching them.

const h = vi.hoisted(() => ({
  column: true,
  row: { id: 1, help_video_settings: null as string | null } as Record<string, unknown>
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
        Object.assign(h.row, patch)
        return 1
      }
    }
    return b
  }
}))

const hs = await import('../../../services/help-video-house-style.js')
const ed = await import('../../../services/help-video-edits.js')
const settings = await import('../../../services/help-video-settings.js')

beforeEach(() => {
  h.column = true
  h.row = { id: 1, help_video_settings: null }
  settings.bustHelpVideoSettings()
})

describe('normalizeHouseStyle', () => {
  it('answers the defaults for nothing stored', () => {
    expect(hs.normalizeHouseStyle(null)).toEqual(hs.HOUSE_STYLE_DEFAULTS)
    expect(hs.isDefaultHouseStyle(hs.normalizeHouseStyle(undefined))).toBe(true)
  })

  it('keeps valid choices and drops bad ones to the default', () => {
    const s = hs.normalizeHouseStyle({
      callout_tone: 'warning',
      callout_text: 'huge',
      caption_style: { size: 'l', background: 'purple' },
      step_style: { shape: 'square' },
      intro: { enabled: true, duration_ms: 4000, show_chapters: true, transition: 'wipe' },
      outro: { enabled: true, duration_ms: 99_000, text: '  Ask   the desk  ' },
      improve_audio: true
    })
    expect(s.callout_tone).toBe('warning')
    expect(s.callout_text).toBe('medium')
    expect(s.caption_style).toEqual({ size: 'l', background: 'shaded', position: 'bottom' })
    expect(s.step_style).toEqual({ shape: 'square', size: 'medium' })
    expect(s.intro).toEqual({
      enabled: true,
      duration_ms: 4000,
      show_chapters: true,
      animation: 'subtle',
      transition: 'wipe'
    })
    expect(s.outro.duration_ms).toBe(3000)
    expect(s.outro.text).toBe('Ask the desk')
    expect(s.improve_audio).toBe(true)
  })

  it('names every bad key', () => {
    const { errors } = hs.readHouseStyle({ callout_text: 'huge', nope: 1, intro: 'x' })
    expect(errors).toHaveLength(3)
    expect(errors.join(' ')).toContain('callout_text')
    expect(errors.join(' ')).toContain('nope is not a house style setting')
    expect(errors.join(' ')).toContain('intro must be an object')
  })
})

describe('applyHouseStyleToNew', () => {
  const blank = () => ed.emptyEdits(60_000)

  it('changes nothing when the house style is the defaults', () => {
    const e = blank()
    const out = hs.applyHouseStyleToNew(e, hs.HOUSE_STYLE_DEFAULTS)
    expect(out).toEqual(e)
    expect(ed.hashEdits(out)).toBe(ed.hashEdits(e))
  })

  it('stores each choice the way the edits normalizer would', () => {
    const style = hs.normalizeHouseStyle({
      callout_tone: 'neutral',
      callout_text: 'large',
      caption_style: { size: 'xl', position: 'top' },
      step_style: { shape: 'square', size: 'large' },
      intro: { enabled: true, duration_ms: 4000, show_chapters: true, animation: 'none' },
      outro: { enabled: true, text: 'Call the desk', transition: 'cut' },
      improve_audio: true
    })
    const out = hs.applyHouseStyleToNew(blank(), style)
    expect(out.callout_text).toBe('large')
    expect(out.caption_style).toEqual({ size: 'xl', position: 'top' })
    expect(out.step_style).toEqual({ shape: 'square', size: 'large' })
    expect(out.audio).toEqual({ improve: true })
    expect(out.intro).toEqual({
      enabled: true,
      duration_ms: 4000,
      show_chapters: true,
      title: '',
      subtitle: '',
      transition: 'fade'
    })
    expect(out.outro).toEqual({
      enabled: true,
      duration_ms: 3000,
      text: 'Call the desk',
      animation: 'subtle'
    })
    // The tone is the editor's default for new callouts, never stored.
    expect(JSON.stringify(out)).not.toContain('neutral')
    // Round-trips through the server's own normalizer unchanged.
    expect(ed.normalizeEdits(out, 60_000)).toEqual(out)
  })
})

describe('normalizeEdits: the two keys the house style added', () => {
  it('stores callout_text and caption_style only when not the default', () => {
    const base = ed.emptyEdits(10_000)
    const plain = ed.normalizeEdits(
      { ...base, callout_text: 'medium', caption_style: { size: 'm', background: 'shaded' } },
      10_000
    )
    expect(plain).toEqual(base)
    const styled = ed.normalizeEdits(
      { ...base, callout_text: 'small', caption_style: { size: 'l', position: 'nope' } },
      10_000
    )
    expect(styled.callout_text).toBe('small')
    expect(styled.caption_style).toEqual({ size: 'l' })
  })
})

describe('saveHouseStyle', () => {
  it('refuses before migration 410', async () => {
    h.column = false
    await expect(hs.saveHouseStyle({ improve_audio: true })).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
    })
  })

  it('keeps the encoder and any unknown key', async () => {
    h.row.help_video_settings = JSON.stringify({ encoder: { crf: 20 }, later: { x: 1 } })
    await hs.saveHouseStyle({ improve_audio: true, step_style: { shape: 'square' } })
    const stored = JSON.parse(String(h.row.help_video_settings))
    expect(stored.encoder).toEqual({ crf: 20 })
    expect(stored.later).toEqual({ x: 1 })
    expect(stored.house_style.improve_audio).toBe(true)
    expect(stored.house_style.step_style).toEqual({ shape: 'square', size: 'medium' })
  })

  it('merges a partial save over the stored style, null goes back to the defaults', async () => {
    await hs.saveHouseStyle({ improve_audio: true })
    await hs.saveHouseStyle({ callout_tone: 'warning' })
    let stored = JSON.parse(String(h.row.help_video_settings))
    expect(stored.house_style.improve_audio).toBe(true)
    expect(stored.house_style.callout_tone).toBe('warning')
    await hs.saveHouseStyle(null)
    expect(h.row.help_video_settings).toBeNull()
    h.row.help_video_settings = JSON.stringify({ encoder: { crf: 20 } })
    await hs.saveHouseStyle(null)
    stored = JSON.parse(String(h.row.help_video_settings))
    expect(stored).toEqual({ encoder: { crf: 20 } })
  })

  it('refuses a bad value and names it', async () => {
    await expect(hs.saveHouseStyle({ callout_text: 'huge' })).rejects.toMatchObject({
      statusCode: 400
    })
  })

  it('reads back through currentHouseStyle', async () => {
    await hs.saveHouseStyle({ callout_text: 'small' })
    const { migrated, style } = await hs.currentHouseStyle()
    expect(migrated).toBe(true)
    expect(style.callout_text).toBe('small')
  })
})

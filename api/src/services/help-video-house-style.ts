import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import {
  CALLOUT_TEXT_SIZES,
  CAPTION_LOOK_CHOICES,
  CAPTION_LOOK_DEFAULTS,
  CARD_ANIMATIONS,
  CARD_TRANSITIONS,
  type CalloutText,
  type CaptionLook,
  EDIT_LIMITS,
  normalizeCaptionLook,
  normalizeIntro,
  normalizeOutro,
  normalizeStepStyle,
  STEP_SHAPES,
  STEP_SIZES,
  STEP_STYLE_DEFAULTS,
  type StepStyle,
  type Tone,
  type VideoEdits
} from './help-video-edits.js'
import {
  bustHelpVideoSettings,
  HELP_VIDEO_SETTINGS_COLUMN,
  HelpVideoSettingsError,
  loadHelpVideoSettings,
  parseStoredSettings
} from './help-video-settings.js'

// The house style (#1551): instance defaults for how a help video looks and
// sounds. Kept under `house_style` in nivaro_settings.help_video_settings
// (migration 410). A new video starts from it (applyHouseStyleToNew, at
// create); an existing video keeps its own choices until an author presses
// "Apply house style" in the editor (the client twin,
// packages/shared/src/components/help-videos/houseStyle.ts). Nothing here
// ever rewrites a stored video.

export const TONES = ['accent', 'warning', 'neutral'] as const
export type CardAnimationChoice = 'none' | (typeof CARD_ANIMATIONS)[number]
export type CardTransitionChoice = 'cut' | (typeof CARD_TRANSITIONS)[number]

export interface HouseCard {
  enabled: boolean
  duration_ms: number
  animation: CardAnimationChoice
  transition: CardTransitionChoice
}
export interface HouseStyle {
  /** The colour new callouts, steps, boxes and arrows start in. */
  callout_tone: Tone
  /** Text size in callouts, boxes and steps. */
  callout_text: CalloutText
  /** How captions look to viewers who have not chosen their own. */
  caption_style: CaptionLook
  step_style: StepStyle
  /** A title card before the recording (its text is the video's title). */
  intro: HouseCard & { show_chapters: boolean }
  /** An end card after it. Blank text = the standard end-card line. */
  outro: HouseCard & { text: string }
  /** Narration cleanup (#1519) on. */
  improve_audio: boolean
}

/** Today's look: what every video got before there was a house style. */
export const HOUSE_STYLE_DEFAULTS: HouseStyle = {
  callout_tone: 'accent',
  callout_text: 'medium',
  caption_style: { ...CAPTION_LOOK_DEFAULTS },
  step_style: { ...STEP_STYLE_DEFAULTS },
  intro: {
    enabled: false,
    duration_ms: EDIT_LIMITS.cardDefaultMs,
    show_chapters: false,
    animation: 'subtle',
    transition: 'fade'
  },
  outro: {
    enabled: false,
    duration_ms: EDIT_LIMITS.cardDefaultMs,
    text: '',
    animation: 'subtle',
    transition: 'fade'
  },
  improve_audio: false
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
const oneOf = <T>(list: readonly T[], v: unknown): T | undefined =>
  (list as readonly unknown[]).includes(v) ? (v as T) : undefined
const ANIMATIONS: readonly CardAnimationChoice[] = ['none', ...CARD_ANIMATIONS]
const TRANSITIONS: readonly CardTransitionChoice[] = ['cut', ...CARD_TRANSITIONS]

function cardMs(v: unknown): number | undefined {
  const n = Number(v)
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return undefined
  if (n < EDIT_LIMITS.cardMinMs || n > EDIT_LIMITS.cardMaxMs) return undefined
  return Math.round(n / 100) * 100
}

/**
 * The house style from anything stored or sent. Lenient: every key that is
 * missing or not a valid choice takes the default; `errors` names each one
 * that was present but wrong (the PATCH route refuses when there are any).
 */
export function readHouseStyle(v: unknown): { style: HouseStyle; errors: string[] } {
  const r = obj(v) ?? {}
  const d = HOUSE_STYLE_DEFAULTS
  const errors: string[] = []
  function pick<T>(path: string, raw: unknown, list: readonly T[], fallback: T): T {
    if (raw === undefined) return fallback
    const ok = oneOf(list, raw)
    if (ok === undefined) {
      errors.push(`${path} must be one of ${list.join(', ')}`)
      return fallback
    }
    return ok
  }
  function bool(path: string, raw: unknown, fallback: boolean): boolean {
    if (raw === undefined) return fallback
    if (typeof raw !== 'boolean') {
      errors.push(`${path} must be true or false`)
      return fallback
    }
    return raw
  }
  function ms(path: string, raw: unknown, fallback: number): number {
    if (raw === undefined) return fallback
    const ok = cardMs(raw)
    if (ok === undefined) {
      errors.push(
        `${path} must be from ${EDIT_LIMITS.cardMinMs / 1000} to ${EDIT_LIMITS.cardMaxMs / 1000} seconds`
      )
      return fallback
    }
    return ok
  }
  function section(key: string): Raw {
    const raw = r[key]
    if (raw === undefined) return {}
    const o = obj(raw)
    if (!o) errors.push(`${key} must be an object`)
    return o ?? {}
  }
  const caption = section('caption_style')
  const step = section('step_style')
  const intro = section('intro')
  const outro = section('outro')
  let outroText = d.outro.text
  if (outro.text !== undefined) {
    if (typeof outro.text !== 'string') errors.push('outro.text must be text')
    else outroText = outro.text.replace(/\s+/g, ' ').trim().slice(0, EDIT_LIMITS.outroText)
  }
  const style: HouseStyle = {
    callout_tone: pick('callout_tone', r.callout_tone, TONES, d.callout_tone),
    callout_text: pick('callout_text', r.callout_text, CALLOUT_TEXT_SIZES, d.callout_text),
    caption_style: {
      size: pick(
        'caption_style.size',
        caption.size,
        CAPTION_LOOK_CHOICES.size,
        d.caption_style.size
      ),
      background: pick(
        'caption_style.background',
        caption.background,
        CAPTION_LOOK_CHOICES.background,
        d.caption_style.background
      ),
      position: pick(
        'caption_style.position',
        caption.position,
        CAPTION_LOOK_CHOICES.position,
        d.caption_style.position
      )
    },
    step_style: {
      shape: pick('step_style.shape', step.shape, STEP_SHAPES, d.step_style.shape),
      size: pick('step_style.size', step.size, STEP_SIZES, d.step_style.size)
    },
    intro: {
      enabled: bool('intro.enabled', intro.enabled, d.intro.enabled),
      duration_ms: ms('intro.duration_ms', intro.duration_ms, d.intro.duration_ms),
      show_chapters: bool('intro.show_chapters', intro.show_chapters, d.intro.show_chapters),
      animation: pick('intro.animation', intro.animation, ANIMATIONS, d.intro.animation),
      transition: pick('intro.transition', intro.transition, TRANSITIONS, d.intro.transition)
    },
    outro: {
      enabled: bool('outro.enabled', outro.enabled, d.outro.enabled),
      duration_ms: ms('outro.duration_ms', outro.duration_ms, d.outro.duration_ms),
      text: outroText,
      animation: pick('outro.animation', outro.animation, ANIMATIONS, d.outro.animation),
      transition: pick('outro.transition', outro.transition, TRANSITIONS, d.outro.transition)
    },
    improve_audio: bool('improve_audio', r.improve_audio, d.improve_audio)
  }
  const known = new Set(Object.keys(d))
  for (const k of Object.keys(r))
    if (!known.has(k)) errors.push(`${k} is not a house style setting`)
  return { style, errors }
}

export function normalizeHouseStyle(v: unknown): HouseStyle {
  return readHouseStyle(v).style
}

export function isDefaultHouseStyle(s: HouseStyle): boolean {
  return JSON.stringify(s) === JSON.stringify(HOUSE_STYLE_DEFAULTS)
}

/** The card a house card puts on a new video, through the edits' own rules. */
function cardMotion(c: HouseCard): Raw {
  const out: Raw = {}
  if (c.animation !== 'none') out.animation = c.animation
  if (c.transition !== 'cut') out.transition = c.transition
  return out
}

/**
 * A NEW video's first edits with the house style in them. Every key goes
 * through the same rule the edits normalizer uses (stored only when on or
 * not the default), so a house style equal to the defaults returns the edits
 * unchanged. The callout tone is not stored on the video: it is what the
 * editor gives callouts made later.
 */
export function applyHouseStyleToNew(edits: VideoEdits, s: HouseStyle): VideoEdits {
  const out: VideoEdits = { ...edits }
  const step = normalizeStepStyle(s.step_style)
  if (step) out.step_style = step
  else delete out.step_style
  if (s.improve_audio) out.audio = { improve: true }
  else delete out.audio
  if (s.callout_text !== 'medium') out.callout_text = s.callout_text
  else delete out.callout_text
  const caption = normalizeCaptionLook(s.caption_style)
  if (caption) out.caption_style = caption
  else delete out.caption_style
  const intro = s.intro.enabled
    ? normalizeIntro({
        enabled: true,
        duration_ms: s.intro.duration_ms,
        show_chapters: s.intro.show_chapters,
        title: '',
        subtitle: '',
        ...cardMotion(s.intro)
      })
    : null
  if (intro) out.intro = intro
  const outro = s.outro.enabled
    ? normalizeOutro({
        enabled: true,
        duration_ms: s.outro.duration_ms,
        text: s.outro.text,
        ...cardMotion(s.outro)
      })
    : null
  if (outro) out.outro = outro
  return out
}

// ── storage (under help_video_settings.house_style) ────────────────────────

/** The house style in effect now (defaults before migration 410 or on any
 *  failed read). Never throws. */
export async function currentHouseStyle(): Promise<{ migrated: boolean; style: HouseStyle }> {
  try {
    const { migrated, stored } = await loadHelpVideoSettings()
    return { migrated, style: normalizeHouseStyle(stored.house_style) }
  } catch {
    return { migrated: false, style: normalizeHouseStyle(null) }
  }
}

/**
 * Save the house style. `input` null = back to the defaults; an object is
 * merged over the stored style (keys left out keep their value) and checked
 * strictly. Only `house_style` changes in the stored JSON; `encoder` and any
 * key a newer image wrote stay exactly as they are.
 */
export async function saveHouseStyle(input: unknown): Promise<HouseStyle> {
  let colOk = false
  try {
    colOk = await hasColumn('nivaro_settings', HELP_VIDEO_SETTINGS_COLUMN)
  } catch {
    colOk = false
  }
  if (!colOk) {
    throw new HelpVideoSettingsError(
      'The house style needs migration 410, which this database has not run yet.',
      409,
      'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
    )
  }
  if (input !== null && !obj(input))
    throw new HelpVideoSettingsError('house_style must be an object')
  const row = (await db('nivaro_settings').where({ id: 1 }).first(HELP_VIDEO_SETTINGS_COLUMN)) as
    | Raw
    | undefined
  if (!row) throw new HelpVideoSettingsError('The settings row is missing', 500, 'SETTINGS_MISSING')
  const stored = parseStoredSettings(row[HELP_VIDEO_SETTINGS_COLUMN])
  let style = HOUSE_STYLE_DEFAULTS
  if (input !== null) {
    const { errors } = readHouseStyle(input)
    if (errors.length) throw new HelpVideoSettingsError(errors.join('; '))
    style = normalizeHouseStyle(mergeDeep(normalizeHouseStyle(stored.house_style), input as Raw))
  }
  const next = serializeHouseStyle(stored, style)
  await db('nivaro_settings')
    .where({ id: 1 })
    .update({ [HELP_VIDEO_SETTINGS_COLUMN]: next })
  bustHelpVideoSettings()
  return style
}

/** The stored JSON with `house_style` set (or removed when it is the
 *  defaults). Every other key is kept as it was. */
export function serializeHouseStyle(stored: Raw, style: HouseStyle): string | null {
  const next = { ...stored }
  if (isDefaultHouseStyle(style)) delete next.house_style
  else next.house_style = style
  return Object.keys(next).length ? JSON.stringify(next) : null
}

function mergeDeep(base: object, patch: Raw): Raw {
  const out: Raw = { ...(base as Raw) }
  for (const [k, v] of Object.entries(patch)) {
    const cur = obj(out[k])
    const p = obj(v)
    out[k] = cur && p ? { ...cur, ...p } : v
  }
  return out
}

import type { CardAnimation, CardTransition } from './cardDesign'
import {
  CAPTION_LOOK_DEFAULTS,
  type CalloutText,
  calloutTextOf,
  captionLookOf,
  EDIT_LIMITS,
  OUTRO_DEFAULT_TEXT,
  STEP_STYLE_DEFAULTS,
  setCalloutText,
  setCaptionLook,
  setImproveAudio,
  setIntro,
  setOutro,
  setStepStyle,
  stepStyleOf
} from './edits'
import type { Annotation, CaptionStyle, StepStyle, Tone, VideoEdits } from './types'

// The house style (#1551): instance defaults for how a help video looks and
// sounds. The server (api/src/services/help-video-house-style.ts) owns the
// stored shape and gives every NEW video its first edits from it; this file
// is what the editor does with it: the tone a new callout starts in, and
// "Apply house style", which rewrites an existing video's own choices.

export interface HouseCard {
  enabled: boolean
  duration_ms: number
  animation: CardAnimation
  transition: CardTransition
}
export interface HouseStyle {
  callout_tone: Tone
  callout_text: CalloutText
  caption_style: CaptionStyle
  step_style: StepStyle
  intro: HouseCard & { show_chapters: boolean }
  outro: HouseCard & { text: string }
  improve_audio: boolean
}

/** The server's HOUSE_STYLE_DEFAULTS: today's look. */
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

/** Annotation types whose colour is their tone (a spotlight has none). */
const TONED: ReadonlyArray<Annotation['type']> = ['callout', 'step', 'box', 'arrow', 'ripple']

export const TONE_NAMES: Record<Tone, string> = {
  accent: 'Blue',
  warning: 'Red',
  neutral: 'Dark'
}
export const CALLOUT_TEXT_NAMES: Record<CalloutText, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
}
const CAPTION_SIZE_NAMES: Record<CaptionStyle['size'], string> = {
  s: 'small',
  m: 'medium',
  l: 'large',
  xl: 'largest'
}

/**
 * The video with the house style applied, as ONE change (one undo step):
 * step badges, callout text size, caption look and narration cleanup take
 * the house values; every callout, step, box, arrow and ripple takes the
 * house tone; a house intro / end card is switched on with the house length
 * and motion, keeping the card text the video already has. A card the house
 * style leaves off is left as the video has it (applying never deletes
 * anything an author wrote).
 */
export function applyHouseStyle(e: VideoEdits, s: HouseStyle): VideoEdits {
  let out = setStepStyle(e, s.step_style)
  out = setImproveAudio(out, s.improve_audio)
  out = setCalloutText(out, s.callout_text)
  const { caption_style: _drop, ...noCaption } = out
  out = setCaptionLook(noCaption as VideoEdits, s.caption_style)
  if (s.intro.enabled) {
    out = setIntro(out, {
      duration_ms: s.intro.duration_ms,
      show_chapters: s.intro.show_chapters,
      animation: s.intro.animation,
      transition: s.intro.transition
    })
  }
  if (s.outro.enabled) {
    out = setOutro(out, {
      duration_ms: s.outro.duration_ms,
      text: e.outro ? e.outro.text : s.outro.text,
      animation: s.outro.animation,
      transition: s.outro.transition
    })
  }
  if (out.annotations.some((a) => TONED.includes(a.type) && a.tone !== s.callout_tone)) {
    out = {
      ...out,
      annotations: out.annotations.map((a) =>
        TONED.includes(a.type) && a.tone !== s.callout_tone ? { ...a, tone: s.callout_tone } : a
      )
    }
  }
  return out
}

const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`

function cardLine(
  label: string,
  before: { duration_ms: number; animation?: string; transition?: string } | undefined,
  after: { duration_ms: number; animation?: string; transition?: string } | undefined
): string | null {
  if (!after) return null
  const motion = `${after.animation ?? 'no'} motion, ${after.transition ?? 'cut'} transition`
  if (!before) return `${label} turns on: ${secs(after.duration_ms)}, ${motion}`
  if (
    before.duration_ms === after.duration_ms &&
    before.animation === after.animation &&
    before.transition === after.transition
  )
    return null
  return `${label}: ${secs(after.duration_ms)}, ${motion}`
}

/**
 * What "Apply house style" would change on this video, one plain sentence
 * each. Empty = the video already follows the house style.
 */
export function houseStyleChanges(e: VideoEdits, s: HouseStyle): string[] {
  const after = applyHouseStyle(e, s)
  const out: string[] = []
  const toned = e.annotations.filter((a) => TONED.includes(a.type) && a.tone !== s.callout_tone)
  if (toned.length)
    out.push(
      `${toned.length} ${toned.length === 1 ? 'callout, step, box or arrow turns' : 'callouts, steps, boxes and arrows turn'} ${TONE_NAMES[s.callout_tone].toLowerCase()}`
    )
  if (calloutTextOf(e) !== calloutTextOf(after))
    out.push(`Callout text: ${CALLOUT_TEXT_NAMES[calloutTextOf(after)].toLowerCase()}`)
  const sb = stepStyleOf(e)
  const sa = stepStyleOf(after)
  if (sb.shape !== sa.shape || sb.size !== sa.size) out.push(`Step badges: ${sa.shape}, ${sa.size}`)
  const cb = captionLookOf(e)
  const ca = captionLookOf(after)
  if (cb.size !== ca.size || cb.background !== ca.background || cb.position !== ca.position)
    out.push(
      `Captions: ${CAPTION_SIZE_NAMES[ca.size]}, ${ca.background} background, at the ${ca.position}`
    )
  if (!!e.audio?.improve !== !!after.audio?.improve)
    out.push(after.audio?.improve ? 'Improve audio turns on' : 'Improve audio turns off')
  const intro = cardLine('Intro card', e.intro, after.intro)
  if (intro) out.push(intro)
  const outro = cardLine('End card', e.outro, after.outro)
  if (outro) {
    const text = after.outro?.text || OUTRO_DEFAULT_TEXT
    out.push(e.outro ? outro : `${outro}, saying “${text}”`)
  }
  return out
}

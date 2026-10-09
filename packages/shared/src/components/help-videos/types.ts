// Client mirror of the help-video shapes. The edit types are copied from
// api/src/services/help-video-edits.ts and the DTOs from
// api/src/services/help-videos.ts (serializeVideo / serializeVersion) — keep
// them in step. All edit times are SOURCE time; rects are frame fractions.

export type Rect = { x: number; y: number; w: number; h: number }
export type Point = { x: number; y: number }
export type Speed = 1 | 1.5 | 2 | 4
export type AnnotationType = 'callout' | 'arrow' | 'box' | 'ripple'
export type Tone = 'accent' | 'warning' | 'neutral'
export interface Segment {
  start_ms: number
  end_ms: number
  speed: Speed
}
export interface Chapter {
  id: string
  at_ms: number
  title: string
}
export interface Annotation {
  id: string
  type: AnnotationType
  start_ms: number
  end_ms: number
  rect: Rect
  to: Point | null
  text: string
  tone: Tone
}
export interface Zoom {
  id: string
  start_ms: number
  end_ms: number
  rect: Rect
  ease_ms: number
}
export interface Blur {
  id: string
  start_ms: number
  end_ms: number
  rect: Rect
  strength: number
}
export interface Caption {
  id: string
  start_ms: number
  end_ms: number
  text: string
}
/** A title card before the recording (real extra edited time). Blank
 *  `title` / `subtitle` mean the video's title and the first line of its
 *  description. */
export interface IntroCard {
  enabled: true
  duration_ms: number
  show_chapters: boolean
  title: string
  subtitle: string
}
/** An end card after the recording. Blank `text` means OUTRO_DEFAULT_TEXT. */
export interface OutroCard {
  enabled: true
  duration_ms: number
  text: string
}
export interface VideoEdits {
  v: 1
  segments: Segment[]
  poster_ms: number
  chapters: Chapter[]
  annotations: Annotation[]
  zooms: Zoom[]
  blurs: Blur[]
  captions: Caption[]
  /** Stored only while switched on (absent = off). */
  intro?: IntroCard
  outro?: OutroCard
  chapter_banners?: true
}

export type Visibility = { mode: 'everyone' | 'roles'; role_ids: string[] }
export type HelpVideoContext = {
  kind: 'collection' | 'page'
  key: string
  state_key: string | null
}
export type RenderStatus = 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'unavailable'

export interface VersionDto {
  id: string
  version: number
  edits: VideoEdits
  edits_hash: string
  source_duration_ms: number | null
  width: number | null
  height: number | null
  render_status: RenderStatus
  render_progress: number | null
  render_error: string | null
  rendered_current: boolean
  /** Published version only: false when a non-author would get the 409
   *  HELP_VIDEO_PROCESSING ("still being prepared") from the stream. */
  playable?: boolean
  note: string | null
  created_at: string
  /** Draft, re-record and restore results only (recorder data). */
  /** Clicks on the recorded tab: `t_ms` source time, `x`/`y` frame fractions (0–1);
   *  recorded since #1486, also what was clicked (see RecordedClick). */
  clicks?: RecordedClick[] | null
  /** Microphone loudness 0–1, one value per 100 ms of source time. */
  levels?: number[] | null
  /** Draft load only: 'upload' when the source is a video file someone picked
   *  (it has no clicks and no microphone levels), else 'recording'. */
  source_kind?: 'recording' | 'upload'
}

/**
 * One click on the recorded tab: recording time and frame fractions (0–1).
 * When the recorder captured its own tab, also what was clicked: accessible
 * name (≤ 80 chars, never an input's value), role, nearest data-* hook
 * (`data-name` or `data-name=value`), the screen's page key, path and origin.
 * Inside `.nvr-no-record` only the position is kept.
 */
export type RecordedClick = {
  t_ms: number
  x: number
  y: number
  label?: string
  role?: string
  hook?: string
  page_key?: string
  path?: string
  origin?: string
}

/** One step of "Show me on this page" (GET /help-videos/:id/walk). */
export interface WalkStep {
  label: string
  role: string | null
  hook: string | null
  page_key: string | null
  path: string | null
  origin: string | null
  /** Where the step happens in the finished video (edited time). */
  edited_ms: number
  /** The callout or box text shown around the click, else null. */
  text: string | null
}

export interface HelpVideoProgress {
  position_ms: number
  completed: boolean
  percent: number
}

export interface HelpVideoDto {
  id: string
  title: string
  description: string | null
  category: string | null
  status: 'draft' | 'published' | 'archived'
  duration_ms: number | null
  /** Ticketed URLs (`?st=`, relative to the API origin): use them as given,
   *  never rebuild them. Tickets expire after 3–6 hours. */
  poster_url: string | null
  stream_url: string | null
  captions_url: string | null
  contexts: HelpVideoContext[]
  /** Required for THIS viewer's role (not for the video in general). */
  required: boolean
  published: VersionDto | null
  // Authors only.
  visibility?: Visibility
  required_role_ids?: string[]
  draft?: VersionDto | null
  /** Author-only: the draft is exactly the published version (same recording,
   *  same edits), so publishing it would change nothing. */
  draft_matches_published?: boolean
  /** The draft's original recording (already carries `source=1`). */
  draft_stream_url?: string | null
  draft_captions_url?: string | null
  created_by_name?: string | null
  updated_at: string
  my_progress: HelpVideoProgress | null
}

/** Error codes the help-video routes answer with (`{ error, code }`). */
export type HelpVideoErrorCode =
  | 'HELP_VIDEO_PROCESSING'
  | 'HELP_VIDEO_EDITS_CONFLICT'
  | 'HELP_VIDEO_EDITS_INVALID'
  | 'HELP_VIDEO_NOT_FOUND'
  | 'HELP_VIDEO_AUTHOR_ONLY'

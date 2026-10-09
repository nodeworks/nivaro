import type { NivaroClient } from '@nivaro/sdk'
import { get, patch, post } from '../../../lib/commands'

// Instance-wide help-video settings (#1561) and the render queue (#1532).
// Administrators only (the server refuses everyone else).

export type EncoderPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
export interface EncoderSettings {
  preset: EncoderPreset
  crf: number
  /** 0 = never two-pass. */
  two_pass_over_minutes: number
  hardware: 'off' | 'auto'
}
export type EncoderSource = 'setting' | 'env' | 'default'

export interface HelpVideoSettingsDto {
  /** false = migration 410 has not run: defaults shown, saving refused. */
  migrated: boolean
  /** What renders use now. */
  encoder: EncoderSettings
  /** What the settings themselves set (unset keys follow the environment). */
  stored: { encoder: Partial<EncoderSettings> }
  sources: Record<keyof EncoderSettings, EncoderSource>
  defaults: EncoderSettings
  env: Record<keyof EncoderSettings, string>
  limits: {
    presets: EncoderPreset[]
    crf_min: number
    crf_max: number
    two_pass_max_minutes: number
  }
  /** What the server answering can use (another replica may differ). */
  hardware: {
    available: Array<'videotoolbox' | 'vaapi'>
    failed: Array<{ kind: string; reason: string }>
    checked_at: string | null
  }
}

export interface RenderQueueItem {
  version_id: string
  video_id: string
  title: string
  version: number
  status: 'rendering' | 'queued'
  position: number | null
  progress: number | null
  source_ms: number | null
  queued_at: string | null
  started_at: string | null
  run_id: number | null
  encoder: string | null
  estimate_ms: number | null
  remaining_ms: number | null
}
export interface RenderQueueDto {
  items: RenderQueueItem[]
  ms_per_source_minute: number | null
  sample: number
}

export const helpVideoSettingsKeys = {
  settings: ['help-video-settings'] as const,
  queue: ['help-video-render-queue'] as const
}

export function helpVideoSettingsApi(client: NivaroClient) {
  const r = client.request.bind(client)
  return {
    settings: (fresh = false) =>
      r(
        get<{ data: HelpVideoSettingsDto }>(`/help-videos/settings${fresh ? '?fresh=1' : ''}`)
      ).then((x) => x.data),
    /** A key set to null goes back to the environment / default. 409
     *  HELP_VIDEO_SETTINGS_MIGRATION_PENDING before migration 410. */
    saveEncoder: (encoder: Partial<Record<keyof EncoderSettings, unknown>>) =>
      r(patch<{ data: HelpVideoSettingsDto }>('/help-videos/settings', { encoder })).then(
        (x) => x.data
      ),
    queue: () => r(get<{ data: RenderQueueDto }>('/help-videos/render-queue')).then((x) => x.data),
    cancel: (versionId: string) =>
      r(post(`/help-videos/render-queue/${encodeURIComponent(versionId)}/cancel`))
  }
}

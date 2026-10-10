import type { NivaroClient } from '@nivaro/sdk'
import { get, patch, post } from '../../../lib/commands'
import type { HouseStyle } from '../houseStyle'

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

/** The house style (#1551). Authors read it; administrators change it. */
export interface HouseStyleDto {
  /** false = migration 410 has not run: the defaults, saving refused. */
  migrated: boolean
  house_style: HouseStyle
  is_default: boolean
  defaults: HouseStyle
}

// ── Storage housekeeping (#1531) ─────────────────────────────────────────────
export type StorageRole = 'source' | 'rendered' | 'captions' | 'poster'
export interface StorageFile {
  role: StorageRole
  id: string
  /** Null when the files row is gone (nothing left to count). */
  bytes: number | null
}
export interface StorageVersion {
  id: string
  version: number
  created_at: string
  is_published: boolean
  is_draft: boolean
  render_status: string
  files_removed_at: string | null
  files: StorageFile[]
  bytes: number
}
export interface StorageVideo {
  id: string
  title: string
  status: string
  poster: StorageFile | null
  versions: StorageVersion[]
  bytes: number
  by_role: Record<StorageRole, number>
}
export interface StorageReportDto {
  /** false = migration 410 has not run: retention cannot be saved. */
  migrated: boolean
  /** null = keep everything. */
  retention_days: number | null
  limits: { retention_min_days: number; retention_max_days: number }
  videos: StorageVideo[]
  totals: {
    bytes: number
    files: number
    videos: number
    versions: number
    by_role: Record<StorageRole, number>
  }
}
export interface StorageRemoval {
  video_id: string
  title: string
  version_id: string
  version: number
  age_days: number
  files: StorageFile[]
  bytes: number
  why: string
}
export interface StoragePlanDto {
  /** false = migration 415 (or 410) has not run: the sweep does nothing. */
  migrated: boolean
  retention_days: number | null
  removals: StorageRemoval[]
  kept: Array<{ video_id: string; version_id: string; version: number; why: string }>
  bytes: number
  files: number
}
export interface StorageSweepDto {
  retention_days: number | null
  versions: number
  files: number
  bytes: number
  failed: number
  summary: string
}

export const helpVideoSettingsKeys = {
  settings: ['help-video-settings'] as const,
  queue: ['help-video-render-queue'] as const,
  houseStyle: ['help-video-house-style'] as const,
  storage: ['help-video-storage'] as const,
  storagePlan: ['help-video-storage', 'plan'] as const
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
    houseStyle: () =>
      r(get<{ data: HouseStyleDto }>('/help-videos/house-style')).then((x) => x.data),
    /** null = back to the defaults; a partial object is merged over the
     *  stored style. 409 HELP_VIDEO_SETTINGS_MIGRATION_PENDING before 410. */
    saveHouseStyle: (house_style: Partial<HouseStyle> | null) =>
      r(patch<{ data: HouseStyleDto }>('/help-videos/house-style', { house_style })).then(
        (x) => x.data
      ),
    queue: () => r(get<{ data: RenderQueueDto }>('/help-videos/render-queue')).then((x) => x.data),
    cancel: (versionId: string) =>
      r(post(`/help-videos/render-queue/${encodeURIComponent(versionId)}/cancel`)),
    /** Sizes per video and version, with the retention rule (#1531). */
    storage: () => r(get<{ data: StorageReportDto }>('/help-videos/storage')).then((x) => x.data),
    /** null = keep everything. 409 HELP_VIDEO_SETTINGS_MIGRATION_PENDING before 410. */
    saveRetention: (retention_days: number | null) =>
      r(
        patch<{ data: { retention_days: number | null; migrated: boolean } }>(
          '/help-videos/storage/retention',
          { retention_days }
        )
      ).then((x) => x.data),
    /** What the next sweep would remove, and why, before it runs. */
    storagePlan: () =>
      r(get<{ data: StoragePlanDto }>('/help-videos/storage/plan')).then((x) => x.data),
    /** Runs the sweep now (a Background Jobs run). */
    sweepStorage: () =>
      r(post<{ data: StorageSweepDto }>('/help-videos/storage/sweep')).then((x) => x.data)
  }
}

import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { hasFfmpeg, runFfmpeg } from './ffmpeg.js'
import { getFile, uploadFileFromPath } from './files.js'
import {
  buildPeaksArgs,
  buildSpriteArgs,
  peaksFromPcm,
  type SpriteGeometry,
  type SpriteSheet,
  spriteGeometry
} from './help-video-extras-plan.js'
import { discardFile, videoWorkDir, withConversionSlot } from './help-video-uploads.js'
import { openStoredObject } from './stored-object-stream.js'

// Server-side thumbnails and waveform (#1560). Once an upload is finalized
// (a recording or a picked file), the server builds in the background:
//   - a thumbnail sprite sheet: one JPEG of small frames taken every
//     `interval_ms` (chosen so the sheet never holds more than SPRITE_MAX_TILES
//     tiles), tiles SPRITE_TILE_W wide, laid out SPRITE_COLS to a row;
//   - audio peaks: the loudest sample in every 100 ms, 0–1, the same shape as
//     the recorder's microphone `levels`, so uploaded videos get a waveform.
// Both land on the upload row (sprite_file + sprite + peaks, migration 412)
// and on every version made from that recording; the editor's timeline reads
// them from the version. Nothing here can fail a finalize: the job runs after
// it, under the same ffmpeg slot and bounds as a file conversion, and a
// failure only means the timeline falls back to what it did before.

export {
  buildPeaksArgs,
  buildSpriteArgs,
  PEAK_PCM_RATE,
  PEAK_WINDOW_MS,
  parsePeaks,
  parseSprite,
  peaksFromPcm,
  SPRITE_COLS,
  SPRITE_MAX_PIXELS,
  SPRITE_MAX_TILES,
  SPRITE_TILE_W,
  type SpriteGeometry,
  type SpriteSheet,
  spriteGeometry
} from './help-video-extras-plan.js'

/** The whole extras job (download, sprite, peaks) may run this long. */
const EXTRAS_TIMEOUT_MS = 15 * 60_000

/** Migration 412 has run (the sprite/peaks columns exist). Probed once per
 *  process and cached on a hit; a database that has not migrated keeps every
 *  write exactly as before. */
export async function extrasMigrated(): Promise<boolean> {
  try {
    return await hasColumn('nivaro_help_video_versions', 'sprite_file')
  } catch {
    return false
  }
}

export interface MediaExtrasInput {
  uploadId: string
  fileId: string
  mime: string
  durationMs: number | null
  width: number | null
  height: number | null
  hasAudio: boolean
}

/** Copies a stored recording's extras onto the versions made from it (a
 *  draft can be created before the background job finishes). */
export async function applyExtrasToVersions(
  fileId: string,
  patch: { sprite_file: string | null; sprite: string | null; peaks: string | null }
): Promise<number> {
  if (!(await extrasMigrated())) return 0
  const n = await db('nivaro_help_video_versions')
    .where({ source_file: fileId })
    .whereNull('sprite_file')
    .whereNull('peaks')
    .update(patch)
  return Number(n)
}

function warn(msg: string): void {
  console.warn(`[help-videos] extras: ${msg}`)
}

/** Builds the sprite sheet and peaks for a finalized upload, in the
 *  background. Never throws; never blocks the caller. */
export function startMediaExtras(user: User, input: MediaExtrasInput): void {
  void buildMediaExtras(user, input).catch((err) =>
    warn(`${input.uploadId}: ${err instanceof Error ? err.message : String(err)}`)
  )
}

/** Exported for tests; production goes through startMediaExtras. */
export async function buildMediaExtras(
  user: User,
  input: MediaExtrasInput
): Promise<{ sprite: SpriteSheet | null; peaks: number[] | null } | null> {
  if (!(await extrasMigrated())) return null
  if (!(await hasFfmpeg())) return null
  const geometry = spriteGeometry(input.durationMs, input.width, input.height)
  const wantPeaks = input.hasAudio
  if (!geometry && !wantPeaks) return null
  const file = await getFile(input.fileId).catch(() => undefined)
  if (!file?.filename_disk) return null
  const dir = join(videoWorkDir(), 'extras', input.uploadId.toLowerCase())
  const ext = input.mime.includes('mp4') ? '.mp4' : '.webm'
  const src = join(dir, `source${ext}`)
  const signal = AbortSignal.timeout(EXTRAS_TIMEOUT_MS)
  let spriteFile: string | null = null
  let sprite: SpriteSheet | null = null
  let peaks: number[] | null = null
  try {
    // One conversion-sized job at a time per process, like a file conversion:
    // the sprite decodes the whole recording.
    await withConversionSlot(
      async () => undefined,
      async () => {
        await mkdir(dir, { recursive: true })
        const opened = await openStoredObject(String(file.filename_disk))
        await pipeline(opened.stream, createWriteStream(src))
        if (geometry) {
          const sheet = join(dir, 'sprite.jpg')
          try {
            await runFfmpeg(
              buildSpriteArgs({ path: src, mime: input.mime }, geometry, sheet),
              undefined,
              signal,
              {
                lowPriority: true
              }
            )
            if ((await stat(sheet)).size > 0) {
              const stored = await uploadFileFromPath(
                user,
                sheet,
                `sprite-${input.uploadId.toLowerCase()}.jpg`,
                'image/jpeg'
              )
              spriteFile = String(stored.id)
              sprite = { file_id: spriteFile.toLowerCase(), ...geometryOf(geometry) }
            }
          } catch (err) {
            warn(`${input.uploadId}: sprite failed: ${(err as Error).message}`)
          }
        }
        if (wantPeaks) {
          const pcm = join(dir, 'peaks.pcm')
          try {
            await runFfmpeg(
              buildPeaksArgs({ path: src, mime: input.mime }, pcm),
              undefined,
              signal,
              {
                lowPriority: true
              }
            )
            peaks = peaksFromPcm(await readFile(pcm))
            if (!peaks.length) peaks = null
          } catch (err) {
            warn(`${input.uploadId}: peaks failed: ${(err as Error).message}`)
          }
        }
      }
    )
    if (!sprite && !peaks) return null
    const patch = {
      sprite_file: spriteFile,
      sprite: sprite ? JSON.stringify(sprite) : null,
      peaks: peaks ? JSON.stringify(peaks) : null
    }
    // The upload row keeps them for as long as the recording (a video created
    // later copies them); versions already made from this recording get them
    // now. A recording discarded meanwhile has no row to take them, and a
    // failed write would leave the sheet unreferenced: the sprite file is
    // dropped again in both cases.
    let n = 0
    let versions = 0
    try {
      n = Number(
        await db('nivaro_help_video_uploads')
          .where({ id: input.uploadId, file_id: input.fileId })
          .whereIn('status', ['finalized', 'used'])
          .update({ ...patch, updated_at: new Date() })
      )
      versions = await applyExtrasToVersions(input.fileId, patch)
    } catch (err) {
      if (spriteFile) await discardFile(user, spriteFile)
      throw err
    }
    if (!n && !versions) {
      if (spriteFile) await discardFile(user, spriteFile)
      return null
    }
    return { sprite, peaks }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => null)
  }
}

function geometryOf(g: SpriteGeometry): Omit<SpriteSheet, 'file_id'> {
  return {
    tile_w: g.tile_w,
    tile_h: g.tile_h,
    cols: g.cols,
    count: g.count,
    interval_ms: g.interval_ms
  }
}

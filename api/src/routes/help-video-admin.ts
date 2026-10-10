import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { detectHardwareEncoders } from '../services/help-video-encoder.js'
import {
  currentHouseStyle,
  HOUSE_STYLE_DEFAULTS,
  isDefaultHouseStyle,
  saveHouseStyle
} from '../services/help-video-house-style.js'
import { cancelRender } from '../services/help-video-render.js'
import { listRenderQueue } from '../services/help-video-render-queue.js'
import {
  CRF_MAX,
  CRF_MIN,
  ENCODER_DEFAULTS,
  ENCODER_ENV,
  ENCODER_PRESETS,
  effectiveEncoder,
  HelpVideoSettingsError,
  loadHelpVideoSettings,
  saveHelpVideoSettings,
  storedEncoder,
  TWO_PASS_MAX_MINUTES
} from '../services/help-video-settings.js'
import {
  runStorageSweep,
  saveRetentionDays,
  storageReport,
  sweepPlan
} from '../services/help-video-storage.js'
import { isAuthor } from '../services/help-videos.js'
import { withJobRun } from '../services/job-runs.js'

// Administrator routes for help videos that are not about one video:
//   GET/PATCH /help-videos/settings           — render encoder (#1561)
//   GET       /help-videos/house-style        — house style (#1551), authors
//   PATCH     /help-videos/house-style        — house style, administrators
//   GET       /help-videos/render-queue       — the queue (#1532)
//   POST      /help-videos/render-queue/:versionId/cancel
//   GET       /help-videos/storage            — sizes per video and version (#1531)
//   PATCH     /help-videos/storage/retention  — {retention_days | null}
//   GET       /help-videos/storage/plan       — what the next sweep removes and why
//   POST      /help-videos/storage/sweep      — run the sweep now
// Registered beside helpVideosRoutes under the same prefix; these static
// paths win over its /:id routes.

async function settingsBody(fresh: boolean) {
  const { migrated, stored } = await loadHelpVideoSettings()
  const own = storedEncoder(stored)
  const { encoder, sources } = effectiveEncoder(own)
  const hardware = await detectHardwareEncoders(fresh).catch(() => null)
  return {
    migrated,
    encoder,
    stored: { encoder: own },
    sources,
    defaults: ENCODER_DEFAULTS,
    env: ENCODER_ENV,
    limits: {
      presets: ENCODER_PRESETS,
      crf_min: CRF_MIN,
      crf_max: CRF_MAX,
      two_pass_max_minutes: TWO_PASS_MAX_MINUTES
    },
    // What THIS process can use; another replica may differ.
    hardware: hardware ?? { available: [], failed: [], checked_at: null }
  }
}

async function houseStyleBody() {
  const { migrated, style } = await currentHouseStyle()
  return {
    migrated,
    house_style: style,
    is_default: isDefaultHouseStyle(style),
    defaults: HOUSE_STYLE_DEFAULTS
  }
}

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof HelpVideoSettingsError) {
    return reply.code(err.statusCode).send({ error: err.message, code: err.code })
  }
  throw err
}

export async function helpVideoAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const fresh = (req.query as { fresh?: string }).fresh === '1'
    return reply.send({ data: await settingsBody(fresh) })
  })

  app.patch('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { encoder?: unknown }
    try {
      await saveHelpVideoSettings(body)
    } catch (err) {
      return refuse(reply, err)
    }
    await logActivity({
      action: 'help-video-settings',
      user: req.user!.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: `encoder: ${JSON.stringify(body.encoder ?? null).slice(0, 400)}`,
      req
    })
    return reply.send({ data: await settingsBody(false) })
  })

  // Authors read it (the editor gives new callouts its tone and offers
  // "Apply house style"); administrators change it.
  app.get('/house-style', { preHandler: authenticate }, async (req, reply) => {
    if (!(await isAuthor(req.user!, !!req.isAdmin))) {
      return reply
        .code(403)
        .send({ error: 'Only video authors can do this', code: 'HELP_VIDEO_AUTHOR_ONLY' })
    }
    return reply.send({ data: await houseStyleBody() })
  })

  app.patch('/house-style', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { house_style?: unknown }
    if (!('house_style' in body)) {
      return reply
        .code(400)
        .send({ error: 'house_style is required', code: 'HELP_VIDEO_SETTINGS_INVALID' })
    }
    try {
      await saveHouseStyle(body.house_style)
    } catch (err) {
      return refuse(reply, err)
    }
    await logActivity({
      action: 'help-video-house-style',
      user: req.user!.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: `house_style: ${JSON.stringify(body.house_style ?? null).slice(0, 400)}`,
      req
    })
    return reply.send({ data: await houseStyleBody() })
  })

  // ── Storage housekeeping (#1531) ─────────────────────────────────────────
  app.get('/storage', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: await storageReport() })
  })
  app.patch('/storage/retention', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { retention_days?: unknown }
    if (!('retention_days' in body)) {
      return reply
        .code(400)
        .send({ error: 'retention_days is required', code: 'HELP_VIDEO_SETTINGS_INVALID' })
    }
    let days: number | null
    try {
      days = await saveRetentionDays(body.retention_days)
    } catch (err) {
      return refuse(reply, err)
    }
    await logActivity({
      action: 'help-video-settings',
      user: req.user!.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: `retention_days: ${days === null ? 'keep everything' : days}`,
      req
    })
    return reply.send({ data: { retention_days: days, migrated: true } })
  })
  app.get('/storage/plan', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: await sweepPlan() })
  })
  app.post('/storage/sweep', { preHandler: requireAdmin }, async (req, reply) => {
    let result: Awaited<ReturnType<typeof runStorageSweep>> | null = null
    await withJobRun(
      'cron',
      'help-video-storage-sweep',
      { label: 'Help videos: storage sweep (run now)', triggeredBy: req.user!.id },
      async () => {
        result = await runStorageSweep({ user: req.user ?? null })
        return result.summary
      }
    )
    return reply.send({ data: result })
  })

  app.get('/render-queue', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: await listRenderQueue() })
  })

  app.post('/render-queue/:versionId/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const { versionId } = req.params as { versionId: string }
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) {
      return reply.code(404).send({ error: 'No such version', code: 'NOT_FOUND' })
    }
    const v = (await db('nivaro_help_video_versions')
      .where({ id: versionId })
      .first('id', 'video_id', 'version')) as Record<string, unknown> | undefined
    if (!v) return reply.code(404).send({ error: 'No such version', code: 'NOT_FOUND' })
    const name = `${req.user?.first_name ?? ''} ${req.user?.last_name ?? ''}`.trim() || null
    const { cancelled, was } = await cancelRender(versionId, name)
    if (!cancelled) {
      return reply.code(409).send({
        error: 'That render is not queued or running any more',
        code: 'HELP_VIDEO_RENDER_NOT_ACTIVE',
        status: was
      })
    }
    await logActivity({
      action: 'help-video-render-cancel',
      user: req.user!.id,
      collection: 'nivaro_help_videos',
      item: String(v.video_id).toLowerCase(),
      comment: `version ${v.version} (${was})`,
      req
    })
    return reply.send({ data: { cancelled: true, was } })
  })
}

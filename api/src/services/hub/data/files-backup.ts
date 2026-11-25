import { type AppChannel, appChannelFor, dataPath } from './app-calls.js'
import { envData } from './env-db.js'
import { DEFAULT_FILES_KEEP_COUNT, openTargetSecret, readPolicy } from './policy.js'
import { type RunnerDeps, startDataRun } from './runner.js'
import { keptArtifacts, patchRun } from './runs.js'
import { DataError, type FilesTarget } from './types.js'

/**
 * Hub data care — files backups. The APP copies every stored file it has (env-local uploads and
 * its saved-settings S3 / Azure objects) into a backup set on the target: a folder on its own
 * host that its HUB_FILES_BACKUP_DIRS allows, or an S3 bucket (the key pair travels in the
 * request body over the bearer link, never logged). The Hub asks, polls the counts, records
 * the set, and asks the app to delete sets past the retention. File content never passes the
 * Hub.
 *
 * App side: routes/hub-link-data.ts + services/hub-data-app/files-backup.ts.
 */

export const FILES_BACKUP_STEPS = [
  { key: 'start', label: 'Ask the app to copy its files' },
  { key: 'copy', label: 'Copy every stored file' },
  { key: 'retention', label: 'Delete backup sets past the retention' }
] as const

const POLL_MS = 5_000
const STALL_MS = 15 * 60_000

export interface FilesBackupStatus {
  state: 'running' | 'done' | 'failed'
  total: number
  copied: number
  failed: number
  too_large: number
  bytes: number
  error: string | null
}

export function parseFilesStatus(v: unknown): FilesBackupStatus | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.state !== 'running' && o.state !== 'done' && o.state !== 'failed') return null
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    state: o.state,
    total: n(o.total),
    copied: n(o.copied),
    failed: n(o.failed),
    too_large: n(o.too_large),
    bytes: n(o.bytes),
    error: typeof o.error === 'string' ? o.error.slice(0, 300) : null
  }
}

/** A backup set's name: lowercase letters, digits and dashes (a folder / key prefix). */
export function setName(app: string, env: string, runId: number): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
  return `nivaro-${clean(app)}-${clean(env)}-${runId}`
}

export interface FilesDeps extends RunnerDeps {
  channel?: (envId: number) => Promise<AppChannel>
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

function targetBody(target: FilesTarget, sealed: string | null) {
  const creds = target.kind === 's3' ? openTargetSecret(sealed) : null
  if (target.kind === 's3' && !creds)
    throw new DataError(
      'FILES_TARGET_MISSING',
      'The S3 key pair of the files target is not stored.'
    )
  return { target, ...(creds ? { credentials: creds } : {}) }
}

export async function startFilesBackup(
  envId: number,
  o: { by: string | null; via?: 'person' | 'schedule' },
  deps: FilesDeps = {}
): Promise<number> {
  const data = await envData(envId)
  const policy = await readPolicy(envId)
  if (!policy.files_target)
    throw new DataError('FILES_TARGET_MISSING', 'Set a files backup target on the policy first.')
  const target = policy.files_target
  const body0 = targetBody(target, policy.target_secret)
  const ch = await (deps.channel ?? appChannelFor)(envId)
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? POLL_MS
  return startDataRun({
    kind: 'files_backup',
    environmentId: envId,
    envIds: [envId],
    steps: FILES_BACKUP_STEPS,
    by: o.by,
    via: o.via,
    deps,
    body: async (ctx) => {
      const set = setName(data.app.key, data.env.key, ctx.id)
      let appRun = ''
      await ctx.step('start', async () => {
        const a = (await ch.call('POST', dataPath(ch, 'files-backup'), { set, ...body0 })) as {
          run_id?: unknown
        } | null
        if (typeof a?.run_id !== 'string')
          throw new DataError('APP_UNREACHABLE', 'The app did not start the copy.')
        appRun = a.run_id
        return `Backup set ${set}.`
      })
      const artifact = {
        set,
        target: target.kind === 's3' ? { ...target } : { ...target },
        app_run: appRun
      }
      await ctx.patch({ artifact })
      let status: FilesBackupStatus | null = null
      await ctx.step('copy', async () => {
        let last = Date.now()
        let lastCopied = -1
        for (;;) {
          await sleep(pollMs)
          const s = parseFilesStatus(
            await ch.call('GET', dataPath(ch, `files-backup/${encodeURIComponent(appRun)}`))
          )
          if (!s)
            throw new DataError(
              'APP_UNREACHABLE',
              'The app answered the copy status with something unreadable.'
            )
          status = s
          await ctx.patch({ result: { ...s } })
          if (s.state === 'done') break
          if (s.state === 'failed')
            throw new DataError('APP_UNREACHABLE', s.error ?? 'The copy failed in the app.')
          if (s.copied !== lastCopied) {
            lastCopied = s.copied
            last = Date.now()
          } else if (Date.now() - last > STALL_MS)
            throw new DataError('APP_UNREACHABLE', 'The copy made no progress for 15 minutes.')
        }
        const st = status as FilesBackupStatus
        return {
          note: `${st.copied} of ${st.total} files copied (${Math.round(st.bytes / 1048576)} MB)${st.failed ? `, ${st.failed} failed` : ''}${st.too_large ? `, ${st.too_large} too large` : ''}.`,
          warn: st.failed > 0 || st.too_large > 0
        }
      })
      await ctx.patch({ artifact: { ...artifact, ...(status ? { counts: status } : {}) } })
      await ctx.step('retention', async () => {
        const keep = policy.files_keep_count ?? DEFAULT_FILES_KEEP_COUNT
        const kept = (await keptArtifacts(envId, 'files_backup')).filter((r) => r.id !== ctx.id)
        // This run's set counts as the newest one kept.
        const drop = kept.slice(0, Math.max(0, kept.length - (keep - 1)))
        let deleted = 0
        let failed = 0
        for (const r of drop) {
          const oldSet = typeof r.artifact?.set === 'string' ? r.artifact.set : null
          const oldTarget = (r.artifact?.target as FilesTarget | undefined) ?? null
          if (!oldSet || !oldTarget) continue
          try {
            await ch.call('POST', dataPath(ch, 'files-backup/delete'), {
              set: oldSet,
              ...targetBody(oldTarget, policy.target_secret)
            })
            deleted++
            await patchRun(r.id, {
              artifact: { ...r.artifact, deleted_at: new Date().toISOString() }
            })
          } catch {
            failed++
          }
        }
        return {
          note:
            deleted || failed
              ? `${deleted} older set(s) deleted${failed ? `, ${failed} could not be` : ''}.`
              : 'Nothing past the retention.',
          warn: failed > 0
        }
      })
      return {
        result: status ? { ...(status as FilesBackupStatus) } : {},
        artifact: { ...artifact, counts: status }
      }
    }
  })
}

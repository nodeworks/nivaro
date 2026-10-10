import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, constants, mkdir, readFile, rm } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import { gatewayBearer, gatewayFromSettings, parseAiModels, settingsRow } from './ai-client.js'
import { recordAiCall } from './ai-log.js'
import { hasFfmpeg, lockedInputArgs, runFfmpeg } from './ffmpeg.js'
import { getFile } from './files.js'
import { type Caption, EDIT_LIMITS } from './help-video-edits.js'
import { MAX_DURATION_MS, videoWorkDir } from './help-video-uploads.js'
import { getApp } from './io-holder.js'
import { startJobRun } from './job-runs.js'
import { openStoredObject } from './stored-object-stream.js'

/**
 * Automatic captions (#1520). "Generate captions" in the editor starts a
 * background job: the draft's source audio is extracted with ffmpeg (mono
 * 16 kHz WAV, never past the 30-minute limit) and transcribed by
 *   - the AI gateway's speech-to-text model, when Settings → AI Features →
 *     Model per feature → Captions names one (the gateway's OpenAI-compatible
 *     /audio/transcriptions with verbose_json + word timestamps), else
 *   - a local Whisper command in the image (HELP_VIDEO_WHISPER_CMD, a
 *     whisper.cpp style invocation writing JSON with token timings).
 * The words are grouped into caption lines (≤ 42 characters, ≤ 5 s, source
 * time) and held as a PENDING SET for 24 hours — in Redis when the server has
 * it, else in this process. Nothing reaches the draft until the author
 * presses "Use these captions", which goes through the normal autosave.
 *
 * One transcription runs at a time per server (a sibling of the render
 * queue); a local run also takes the cron heavy slot, since it is CPU-bound.
 * Each run is a Background Jobs run of kind ai, and each is logged in
 * nivaro_ai_calls as feature help-video-captions: the gateway path with the
 * tokens or seconds it reported, the local path as provider local-whisper
 * with its duration.
 */

export const CAPTION_LINE_MAX_CHARS = 42
export const CAPTION_LINE_MAX_MS = 5000
/** A silence this long between words starts a new line. */
export const CAPTION_LINE_GAP_MS = 1200
export const CAPTION_JOB_TTL_S = 24 * 3600
/** A queued or running job older than this belongs to a process that died. */
const STALE_MS = 3 * 3_600_000
const JOB_PREFIX = 'hv:captions:'
const DEFAULT_WHISPER_MODEL = '/opt/whisper/ggml-base.en.bin'
const DEFAULT_WHISPER_CMD = 'whisper-cli -m {model} -f {input} -ojf -of {output} -l en -t 2 -np'
/** The local model may take a while on a slow box; a run past this is killed. */
const LOCAL_TIMEOUT_MS = 90 * 60_000

export interface TranscriptWord {
  start_ms: number
  end_ms: number
  text: string
}

export type CaptionJobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface CaptionJob {
  version_id: string
  video_id: string
  status: CaptionJobStatus
  requested_by: string | null
  requested_at: string
  started_at?: string
  finished_at?: string
  phase?: 'extracting' | 'transcribing' | 'grouping'
  provider?: 'gateway' | 'local'
  model?: string
  /** The pending suggestion set (done only), in source time. */
  captions?: Caption[]
  words?: number
  audio_ms?: number
  error?: string
  run_id?: number | null
}

export type CaptionProvider =
  | { kind: 'gateway'; model: string }
  | { kind: 'local'; command: string[]; model: string | null }
  | { kind: 'none'; reason: string }

export class CaptionsError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

// ─── pure: words → caption lines ─────────────────────────────────────────────

function lineId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

const ENDS_SENTENCE = /[.!?]["')\]]?$/

/**
 * Group timed words into caption lines: at most 42 characters and 5 seconds
 * each, a new line after a pause of 1.2 s or more, and a sentence end closes
 * a line that is already half full. Lines never overlap (a line ends where
 * the next starts at the latest) and are never shorter than the editor's
 * minimum item length. Times are the words' own clock: SOURCE time.
 */
export function groupWords(
  words: TranscriptWord[],
  sourceMs = Number.POSITIVE_INFINITY,
  opts: { maxChars?: number; maxMs?: number; gapMs?: number } = {}
): Caption[] {
  const maxChars = opts.maxChars ?? CAPTION_LINE_MAX_CHARS
  const maxMs = opts.maxMs ?? CAPTION_LINE_MAX_MS
  const gapMs = opts.gapMs ?? CAPTION_LINE_GAP_MS
  const clean = words
    .map((w) => ({
      start_ms: Math.round(Number(w.start_ms)),
      end_ms: Math.round(Number(w.end_ms)),
      text: String(w.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    }))
    .filter(
      (w) => w.text && Number.isFinite(w.start_ms) && Number.isFinite(w.end_ms) && w.start_ms >= 0
    )
    .sort((a, b) => a.start_ms - b.start_ms)
  const lines: Array<{ start_ms: number; end_ms: number; text: string }> = []
  let cur: { start_ms: number; end_ms: number; text: string } | null = null
  for (const w of clean) {
    if (cur) {
      const joined = `${cur.text} ${w.text}`
      const tooLong = joined.length > maxChars
      const tooSlow = w.end_ms - cur.start_ms > maxMs
      const pause = w.start_ms - cur.end_ms >= gapMs
      const sentence = ENDS_SENTENCE.test(cur.text) && cur.text.length >= maxChars / 2
      if (tooLong || tooSlow || pause || sentence) {
        lines.push(cur)
        cur = null
      } else {
        cur.text = joined
        cur.end_ms = Math.max(cur.end_ms, w.end_ms)
        continue
      }
    }
    cur = { start_ms: w.start_ms, end_ms: Math.max(w.end_ms, w.start_ms), text: w.text }
  }
  if (cur) lines.push(cur)
  const out: Caption[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const next = lines[i + 1]
    let end = Math.max(l.end_ms, l.start_ms + EDIT_LIMITS.minItemMs)
    if (next) end = Math.min(end, Math.max(next.start_ms, l.start_ms + EDIT_LIMITS.minItemMs))
    end = Math.min(end, sourceMs)
    const start = Math.min(l.start_ms, sourceMs)
    if (end - start < EDIT_LIMITS.minItemMs) continue
    out.push({
      id: lineId(),
      start_ms: start,
      end_ms: end,
      text: l.text.slice(0, EDIT_LIMITS.text)
    })
    if (out.length >= EDIT_LIMITS.captions) break
  }
  return out
}

/** A segment with no word timings: its words spread evenly over its span. */
export function spreadSegment(start_ms: number, end_ms: number, text: string): TranscriptWord[] {
  const parts = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return []
  const total = Math.max(0, end_ms - start_ms)
  const chars = parts.reduce((n, p) => n + p.length, 0) || 1
  let at = start_ms
  return parts.map((p) => {
    const span = Math.round((total * p.length) / chars)
    const w = { start_ms: at, end_ms: at + span, text: p }
    at += span
    return w
  })
}

// ─── pure: provider answers → words ──────────────────────────────────────────

/** The gateway's verbose_json: `words[]` ({word, start, end} in seconds),
 *  else `segments[]` spread, else the whole `text` over `duration`. */
export function parseVerboseJson(body: unknown): {
  words: TranscriptWord[]
  duration_ms: number | null
  usage: { input_tokens?: number | null; output_tokens?: number | null; seconds?: number | null }
} {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const secs = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n * 1000) : null
  }
  const duration = secs(o.duration)
  const usageRaw = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<
    string,
    unknown
  >
  const usage = {
    input_tokens: Number.isFinite(Number(usageRaw.input_tokens))
      ? Number(usageRaw.input_tokens)
      : null,
    output_tokens: Number.isFinite(Number(usageRaw.output_tokens))
      ? Number(usageRaw.output_tokens)
      : null,
    seconds: Number.isFinite(Number(usageRaw.seconds))
      ? Number(usageRaw.seconds)
      : duration === null
        ? null
        : duration / 1000
  }
  const words: TranscriptWord[] = []
  if (Array.isArray(o.words)) {
    for (const w of o.words as Array<Record<string, unknown>>) {
      const s = secs(w?.start)
      const e = secs(w?.end)
      const text = String(w?.word ?? w?.text ?? '').trim()
      if (s === null || e === null || !text) continue
      words.push({ start_ms: s, end_ms: Math.max(s, e), text })
    }
  }
  if (!words.length && Array.isArray(o.segments)) {
    for (const seg of o.segments as Array<Record<string, unknown>>) {
      const s = secs(seg?.start)
      const e = secs(seg?.end)
      if (s === null || e === null) continue
      words.push(...spreadSegment(s, Math.max(s, e), String(seg?.text ?? '')))
    }
  }
  if (!words.length && typeof o.text === 'string' && duration)
    words.push(...spreadSegment(0, duration, o.text))
  return { words, duration_ms: duration, usage }
}

/**
 * whisper.cpp's JSON (`-oj` / `-ojf`): `transcription[]` segments with
 * `offsets {from, to}` in ms and, with the full output, `tokens[]` carrying
 * their own offsets. Tokens are byte-pair pieces: one starting with a space
 * starts a word, the rest continue it; bracketed specials are skipped.
 */
export function parseWhisperJson(body: unknown): { words: TranscriptWord[]; duration_ms: number } {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const segs = Array.isArray(o.transcription)
    ? (o.transcription as Array<Record<string, unknown>>)
    : []
  const words: TranscriptWord[] = []
  let end = 0
  const ms = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  for (const seg of segs) {
    const off = (seg?.offsets ?? {}) as Record<string, unknown>
    const s = ms(off.from)
    const e = ms(off.to)
    if (s === null || e === null) continue
    end = Math.max(end, e)
    const tokens = Array.isArray(seg.tokens) ? (seg.tokens as Array<Record<string, unknown>>) : []
    const timed = tokens.filter((t) => {
      const to = (t?.offsets ?? {}) as Record<string, unknown>
      return ms(to.from) !== null && ms(to.to) !== null && typeof t?.text === 'string'
    })
    if (!timed.length) {
      words.push(...spreadSegment(s, Math.max(s, e), String(seg.text ?? '')))
      continue
    }
    for (const t of timed) {
      const text = String(t.text)
      if (/^\s*\[/.test(text) || !text.trim()) continue
      const to = t.offsets as Record<string, unknown>
      const ts = ms(to.from) as number
      const te = Math.max(ts, ms(to.to) as number)
      const last = words[words.length - 1]
      if (last && !/^\s/.test(text) && last.end_ms >= ts - 50) {
        last.text += text.trim()
        last.end_ms = Math.max(last.end_ms, te)
      } else words.push({ start_ms: ts, end_ms: te, text: text.trim() })
    }
  }
  return { words: words.filter((w) => w.text), duration_ms: end }
}

// ─── pure: ffmpeg + the local command ────────────────────────────────────────

/** Mono 16 kHz PCM WAV of the recording's sound, never past the limit. */
export function extractAudioArgs(
  sourcePath: string,
  sourceMime: string,
  wavPath: string,
  maxMs = MAX_DURATION_MS
): string[] {
  return [
    '-nostdin',
    '-y',
    ...lockedInputArgs(sourceMime),
    '-i',
    sourcePath,
    '-t',
    (Math.max(1, maxMs) / 1000).toFixed(3),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    wavPath
  ]
}

/** A command template split into arguments (double or single quotes keep
 *  spaces together); never a shell. */
export function splitCommand(template: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of String(template ?? '').matchAll(re)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** The arguments with {input}, {output} and {model} filled in — after the
 *  split, so a path with spaces stays one argument. */
export function fillCommand(
  args: string[],
  vars: { input: string; output: string; model: string }
): string[] {
  return args.map((a) =>
    a
      .replaceAll('{input}', vars.input)
      .replaceAll('{output}', vars.output)
      .replaceAll('{model}', vars.model)
  )
}

export function whisperCommandTemplate(): string {
  return (process.env.HELP_VIDEO_WHISPER_CMD ?? '').trim() || DEFAULT_WHISPER_CMD
}
export function whisperModelPath(): string {
  return (process.env.HELP_VIDEO_WHISPER_MODEL ?? '').trim() || DEFAULT_WHISPER_MODEL
}

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false)
}

/** Where a command's binary is: as given when it names a path, else on PATH. */
export async function findOnPath(
  bin: string,
  pathEnv = process.env.PATH ?? ''
): Promise<string | null> {
  if (!bin) return null
  if (isAbsolute(bin) || bin.includes('/')) return (await executable(bin)) ? bin : null
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const p = join(dir, bin)
    if (await executable(p)) return p
  }
  return null
}

const localChecked = new Map<string, Promise<{ ok: boolean; reason: string }>>()

/** Whether the local command can run here: its binary exists and, when the
 *  template names {model}, the model file does too. Checked once per
 *  template + model per process. */
export function localWhisperAvailable(): Promise<{ ok: boolean; reason: string }> {
  const template = whisperCommandTemplate()
  const model = whisperModelPath()
  const key = `${template}\n${model}`
  let p = localChecked.get(key)
  if (!p) {
    p = (async () => {
      const args = splitCommand(template)
      if (!args.length) return { ok: false, reason: 'HELP_VIDEO_WHISPER_CMD is empty' }
      if (!(await findOnPath(args[0])))
        return { ok: false, reason: `the command "${args[0]}" is not installed on this server` }
      if (args.some((a) => a.includes('{model}'))) {
        const exists = await access(model, constants.R_OK)
          .then(() => true)
          .catch(() => false)
        if (!exists) return { ok: false, reason: `the Whisper model file ${model} is missing` }
      }
      return { ok: true, reason: '' }
    })()
    localChecked.set(key, p)
  }
  return p
}

/** Tests: forget the cached availability checks. */
export function resetLocalWhisperCheck(): void {
  localChecked.clear()
}

/** Which transcriber this server would use now, else why none. */
export async function captionProvider(): Promise<CaptionProvider> {
  const s = (await settingsRow()) ?? {}
  if (s.ai_provider === 'gateway') {
    const gw = gatewayFromSettings(s)
    const model = parseAiModels(s).transcribe
    if (model && gw.base_url && gw.token_url && gw.client_id && gw.client_secret)
      return { kind: 'gateway', model }
  }
  const local = await localWhisperAvailable()
  if (local.ok) {
    const args = splitCommand(whisperCommandTemplate())
    return {
      kind: 'local',
      command: args,
      model: args.some((a) => a.includes('{model}')) ? whisperModelPath() : null
    }
  }
  const why =
    s.ai_provider === 'gateway'
      ? 'the AI gateway has no Captions model (Settings → AI Features → Model per feature)'
      : 'automatic captions need the AI gateway with a Captions model (Settings → AI Features → Model per feature)'
  return {
    kind: 'none',
    reason: `No transcriber is set up: ${why}, or a local Whisper command on the server (HELP_VIDEO_WHISPER_CMD; ${local.reason}).`
  }
}

// ─── the job store (Redis for 24 h, else this process) ───────────────────────

const memory = new Map<string, { job: CaptionJob; exp: number }>()
const key = (versionId: string) => `${JOB_PREFIX}${String(versionId).toLowerCase()}`

function redis(): {
  get: (k: string) => Promise<string | null>
  set: (k: string, v: string, ex: 'EX', s: number) => Promise<unknown>
  del: (k: string) => Promise<unknown>
} | null {
  const r = getApp()?.redis
  return r && typeof r.get === 'function' ? r : null
}

export async function readCaptionJob(versionId: string): Promise<CaptionJob | null> {
  const k = key(versionId)
  let job: CaptionJob | null = null
  const r = redis()
  if (r) {
    const raw = await r.get(k).catch(() => null)
    if (raw) {
      try {
        job = JSON.parse(raw) as CaptionJob
      } catch {
        job = null
      }
    }
  }
  if (!job) {
    const hit = memory.get(k)
    if (hit && hit.exp > Date.now()) job = hit.job
    else memory.delete(k)
  }
  return job ? markStale(job) : null
}

/** A job the server restarted under reads as failed, with the reason. */
export function markStale(job: CaptionJob, now = Date.now()): CaptionJob {
  if (job.status !== 'queued' && job.status !== 'running') return job
  const since = new Date(job.started_at ?? job.requested_at).getTime()
  if (!Number.isFinite(since) || now - since < STALE_MS) return job
  return {
    ...job,
    status: 'failed',
    error: 'The server restarted before the captions were finished. Generate them again.'
  }
}

export async function writeCaptionJob(job: CaptionJob): Promise<void> {
  const k = key(job.version_id)
  memory.set(k, { job, exp: Date.now() + CAPTION_JOB_TTL_S * 1000 })
  const r = redis()
  if (r) await r.set(k, JSON.stringify(job), 'EX', CAPTION_JOB_TTL_S).catch(() => null)
}

export async function clearCaptionJob(versionId: string): Promise<void> {
  const k = key(versionId)
  memory.delete(k)
  const r = redis()
  if (r) await r.del(k).catch(() => null)
}

// ─── the queue: one transcription at a time per server ───────────────────────

let chain: Promise<void> = Promise.resolve()

/** Queue a draft version's transcription. 409 while one is queued or running. */
export async function startCaptionJob(
  video: { id: string },
  versionId: string,
  user: { id: string } | null,
  deps: CaptionDeps = defaultDeps
): Promise<CaptionJob> {
  const provider = await deps.provider()
  if (provider.kind === 'none')
    throw new CaptionsError(503, 'HELP_VIDEO_CAPTIONS_NOT_CONFIGURED', provider.reason)
  const current = await readCaptionJob(versionId)
  if (current && (current.status === 'queued' || current.status === 'running'))
    throw new CaptionsError(409, 'HELP_VIDEO_CAPTIONS_BUSY', 'Captions are already being generated')
  const job: CaptionJob = {
    version_id: String(versionId).toLowerCase(),
    video_id: String(video.id).toLowerCase(),
    status: 'queued',
    requested_by: user?.id ? String(user.id) : null,
    requested_at: new Date().toISOString(),
    provider: provider.kind,
    model: provider.kind === 'gateway' ? provider.model : (provider.model ?? undefined)
  }
  await writeCaptionJob(job)
  chain = chain
    .then(() => processCaptionJob(job.version_id, deps))
    .then(
      () => undefined,
      () => undefined
    )
  return job
}

/** Resolves once every queued transcription has finished (tests, shutdown). */
export function whenCaptionsIdle(): Promise<void> {
  return chain
}

// ─── the run ─────────────────────────────────────────────────────────────────

export interface CaptionDeps {
  provider: () => Promise<CaptionProvider>
  /** The version row's source: a local copy of the file in `dir`. */
  loadSource: (
    versionId: string,
    dir: string
  ) => Promise<{ path: string; mime: string; source_ms: number | null }>
  extractAudio: (source: string, mime: string, wav: string, signal: AbortSignal) => Promise<void>
  transcribeGateway: (
    model: string,
    wav: string,
    signal: AbortSignal
  ) => Promise<ReturnType<typeof parseVerboseJson>>
  transcribeLocal: (
    command: string[],
    model: string | null,
    wav: string,
    dir: string,
    signal: AbortSignal
  ) => Promise<ReturnType<typeof parseWhisperJson>>
  /** Runs `work` inside the cron heavy slot when the server has one. */
  heavy: (label: string, work: () => Promise<void>) => Promise<void>
  log: typeof recordAiCall
}

/** One job, start to finish: the queued row becomes running, done or failed. */
export async function processCaptionJob(versionId: string, deps: CaptionDeps): Promise<CaptionJob> {
  const job = (await readCaptionJob(versionId)) ?? null
  if (job?.status !== 'queued') return job as CaptionJob
  const provider = await deps.provider()
  const started = Date.now()
  const run = await startJobRun('ai', `help-video-captions:${job.version_id}`, {
    label: 'Generate captions',
    triggeredBy: job.requested_by
  })
  const state: CaptionJob = {
    ...job,
    status: 'running',
    started_at: new Date(started).toISOString(),
    run_id: run.id,
    provider: provider.kind === 'none' ? job.provider : provider.kind,
    model:
      provider.kind === 'gateway'
        ? provider.model
        : provider.kind === 'local'
          ? (provider.model ?? undefined)
          : job.model
  }
  await writeCaptionJob(state)
  const dir = join(videoWorkDir(), 'captions', `${job.version_id}-${randomUUID().slice(0, 8)}`)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), LOCAL_TIMEOUT_MS)
  timer.unref?.()
  const modelName =
    provider.kind === 'gateway'
      ? provider.model
      : provider.kind === 'local'
        ? basename(provider.model ?? provider.command[0] ?? 'whisper')
        : 'none'
  const route = `/help-videos/${job.video_id}/captions/generate`
  let words = 0
  let audioMs: number | null = null
  try {
    if (provider.kind === 'none')
      throw new CaptionsError(503, 'HELP_VIDEO_CAPTIONS_NOT_CONFIGURED', provider.reason)
    await mkdir(dir, { recursive: true })
    const phase = async (p: CaptionJob['phase']) => {
      state.phase = p
      run.progress({ phase: p, provider: provider.kind })
      await writeCaptionJob(state)
    }
    await phase('extracting')
    const source = await deps.loadSource(job.version_id, dir)
    const wav = join(dir, 'audio.wav')
    await deps.extractAudio(source.path, source.mime, wav, abort.signal)
    await rm(source.path, { force: true }).catch(() => null)
    await phase('transcribing')
    let result: { words: TranscriptWord[]; duration_ms: number | null }
    let usage: ReturnType<typeof parseVerboseJson>['usage'] | null = null
    const t0 = Date.now()
    if (provider.kind === 'gateway') {
      const r = await deps.transcribeGateway(provider.model, wav, abort.signal)
      result = r
      usage = r.usage
    } else {
      let r: ReturnType<typeof parseWhisperJson> | null = null
      await deps.heavy('help-video captions', async () => {
        r = await deps.transcribeLocal(provider.command, provider.model, wav, dir, abort.signal)
      })
      result = r as unknown as ReturnType<typeof parseWhisperJson>
    }
    const latency = Date.now() - t0
    await phase('grouping')
    const sourceMs = source.source_ms ?? MAX_DURATION_MS
    const captions = groupWords(result.words, sourceMs)
    words = result.words.length
    audioMs = result.duration_ms
    deps.log({
      feature: 'help-video-captions',
      provider: provider.kind === 'gateway' ? 'gateway-openai' : 'local-whisper',
      model: modelName,
      status: 'ok',
      latency_ms: latency,
      user: job.requested_by,
      route,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      request: {
        version_id: job.version_id,
        audio: 'mono 16 kHz wav',
        source_ms: source.source_ms
      },
      response: {
        words,
        lines: captions.length,
        audio_ms: audioMs,
        seconds: usage?.seconds ?? null
      }
    })
    const done: CaptionJob = {
      ...state,
      status: 'done',
      phase: undefined,
      finished_at: new Date().toISOString(),
      captions,
      words,
      audio_ms: audioMs ?? undefined
    }
    await writeCaptionJob(done)
    await run.complete(
      `${captions.length} caption lines from ${words} words · ${provider.kind === 'gateway' ? provider.model : 'local whisper'}`
    )
    return done
  } catch (err) {
    const message = abort.signal.aborted
      ? 'The transcription took too long and was stopped'
      : friendlyCaptionError(err)
    deps.log({
      feature: 'help-video-captions',
      provider: provider.kind === 'gateway' ? 'gateway-openai' : 'local-whisper',
      model: modelName,
      status: 'error',
      latency_ms: Date.now() - started,
      user: job.requested_by,
      route,
      error: message
    })
    const failed: CaptionJob = {
      ...state,
      status: 'failed',
      phase: undefined,
      finished_at: new Date().toISOString(),
      error: message
    }
    await writeCaptionJob(failed)
    await run.fail(err)
    return failed
  } finally {
    clearTimeout(timer)
    await rm(dir, { recursive: true, force: true }).catch(() => null)
  }
}

export function friendlyCaptionError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/No such file|ENOENT|Stored object not found/i.test(msg))
    return 'The original recording is missing from storage'
  if (/no audio|does not contain any stream|Output file is empty/i.test(msg))
    return 'The recording has no sound to transcribe'
  return `The captions could not be generated: ${msg.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'unknown error'}`
}

// ─── default dependencies ────────────────────────────────────────────────────

async function loadSource(versionId: string, dir: string) {
  const v = await db('nivaro_help_video_versions').where({ id: versionId }).first()
  if (!v) throw new Error('Stored object not found')
  const source = await getFile(String(v.source_file))
  if (!source?.filename_disk) throw new Error('Stored object not found')
  const mime = String(source.type ?? '')
  if (!lockedInputArgs(mime).includes('-f'))
    throw new Error(`Unsupported recording format: ${mime}`)
  const path = join(dir, mime.includes('mp4') ? 'source.mp4' : 'source.webm')
  const opened = await openStoredObject(String(source.filename_disk))
  await pipeline(opened.stream, createWriteStream(path))
  return {
    path,
    mime,
    source_ms: v.source_duration_ms == null ? null : Number(v.source_duration_ms)
  }
}

async function extractAudio(source: string, mime: string, wav: string, signal: AbortSignal) {
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is not installed on this server')
  await runFfmpeg(extractAudioArgs(source, mime, wav), undefined, signal, { lowPriority: true })
}

/** The gateway's OpenAI-compatible speech-to-text: one multipart POST with
 *  the WAV, verbose_json and word timestamps. A 401 refreshes the bearer once. */
async function transcribeGateway(model: string, wav: string, signal: AbortSignal) {
  const s = (await settingsRow()) ?? {}
  const api = gatewayFromSettings(s)
  const url = `${api.base_url}/openai/v1/audio/transcriptions`
  const bytes = await readFile(wav)
  const attempt = async (retryOn401: boolean): Promise<unknown> => {
    const bearer = await gatewayBearer(api)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', model)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: form,
      signal
    })
    if (res.status === 401 && retryOn401) {
      const { bustGatewayBearer } = await import('./ai-client.js')
      bustGatewayBearer()
      return attempt(false)
    }
    const text = await res.text()
    let body: unknown = {}
    try {
      body = JSON.parse(text)
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const e = (body as { error?: { message?: string } | string }).error
      const detail = typeof e === 'string' ? e : e?.message
      throw new Error(`AI gateway ${res.status}: ${detail ?? text.slice(0, 300)}`)
    }
    return body
  }
  return parseVerboseJson(await attempt(true))
}

/** Run the local command (never a shell) at the lowest priority; read the
 *  JSON it wrote at `{output}.json`. */
async function transcribeLocal(
  command: string[],
  model: string | null,
  wav: string,
  dir: string,
  signal: AbortSignal
) {
  const outBase = join(dir, 'transcript')
  const [bin, ...rest] = fillCommand(command, { input: wav, output: outBase, model: model ?? '' })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, rest, {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
      cwd: dir
    })
    if (child.pid) {
      try {
        setPriority(child.pid, 19)
      } catch {
        /* not permitted here */
      }
    }
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    child.on('error', (err) => {
      if (signal.aborted && child.pid !== undefined) return
      reject(err)
    })
    child.on('close', (code) => {
      if (signal.aborted)
        reject(Object.assign(new Error(`${bin} was cancelled`), { name: 'AbortError' }))
      else if (code === 0) resolve()
      else
        reject(
          new Error(
            stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || `${bin} exited with ${code}`
          )
        )
    })
  })
  const raw = await readFile(`${outBase}.json`, 'utf8')
  return parseWhisperJson(JSON.parse(raw))
}

async function heavy(label: string, work: () => Promise<void>): Promise<void> {
  const app = getApp()
  if (app?.cron?.withHeavySlot) await app.cron.withHeavySlot(label, work)
  else await work()
}

export const defaultDeps: CaptionDeps = {
  provider: captionProvider,
  loadSource,
  extractAudio,
  transcribeGateway,
  transcribeLocal,
  heavy,
  log: recordAiCall
}

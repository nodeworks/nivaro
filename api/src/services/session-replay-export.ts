/**
 * Export a session recording (#1375).
 *
 *  - html: one self-contained file — rrweb's replayer (its UMD build, read
 *    from the rrweb package at runtime) and the recording's events inlined
 *    exactly as stored, so masked inputs stay masked. Opens offline in any
 *    browser; rrweb rebuilds the page in a sandboxed iframe, so nothing the
 *    recorded page contained runs.
 *  - webm: a background job that opens that same file in headless Chromium
 *    (the PDF service's browser), plays it, and captures it with puppeteer's
 *    screencast (which pipes frames to ffmpeg). The video is stored as a file
 *    owned by the requester, who is notified when it is ready (or why not).
 *    A process without ffmpeg and Chromium (the slim image) hands the job to
 *    the media worker (media-handoff.ts), which makes it the same way.
 *
 * The browser and ffmpeg sit behind `WebmDeps` so the job is tested with fakes.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { db } from '../db/index.js'
import { cutReplayWindow, loadRecordingEvents, type RrwebEvent } from './session-replay-events.js'

export const EXPORT_FORMATS = ['html', 'webm'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
/** A WebM is captured in real time, so its window is capped. */
export const WEBM_MAX_MS = 30 * 60_000
/** Frame size cap: a 4K recording is captured at most this wide. */
const WEBM_MAX_WIDTH = 1920

// ── HTML ────────────────────────────────────────────────────────────────────

let assets: { js: string; css: string } | null = null

/** rrweb's UMD bundle and stylesheet, read once from the installed package. */
export function rrwebAssets(): { js: string; css: string } {
  if (assets) return assets
  const require = createRequire(import.meta.url)
  // The package's "require" entry is dist/rrweb.cjs; the UMD build sits beside it.
  const dist = dirname(require.resolve('rrweb'))
  const js = readFileSync(join(dist, 'rrweb.umd.min.cjs'), 'utf8').replace(
    /\n\/\/# sourceMappingURL=\S*\s*$/,
    ''
  )
  const css = readFileSync(join(dist, 'style.min.css'), 'utf8')
  assets = { js, css }
  return assets
}

const escHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

/**
 * JSON that is safe inside a <script> element: no `<` at all (so no
 * `</script>` or `<!--`), and the two line separators JS once choked on.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Inline JS / CSS must not close its own element early. */
const inlineJs = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1')
const inlineCss = (s: string) => s.replace(/<\/(style)/gi, '<\\/$1')

export interface ExportHtmlOptions {
  title: string
  /** Shown under the player: who, when, which window. */
  caption: string
  events: RrwebEvent[]
  startOffsetMs: number
  endOffsetMs: number
  /** The WebM job's page: no controls, 1:1 scale, waits for start_playback(). */
  capture?: boolean
}

/** The self-contained replay page. Exported for tests. */
export function buildExportHtml(o: ExportHtmlOptions): string {
  const { js, css } = rrwebAssets()
  const config = { start: o.startOffsetMs, end: o.endOffsetMs, capture: !!o.capture }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="nivaro session replay export">
<title>${escHtml(o.title)}</title>
<style>${inlineCss(css)}</style>
<style>
  html, body { margin: 0; background: #0f172a; color: #e2e8f0; font: 13px/1.4 system-ui, sans-serif; }
  #nvr-stage { position: relative; overflow: hidden; margin: 12px auto 0; background: #fff; }
  #nvr-stage iframe { border: 0; background: #fff; }
  #nvr-bar { display: flex; gap: 10px; align-items: center; max-width: 1200px; margin: 8px auto; padding: 0 12px; }
  #nvr-bar input[type=range] { flex: 1; accent-color: #00ceff; }
  #nvr-bar button, #nvr-bar select { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 3px 10px; }
  #nvr-time { font-variant-numeric: tabular-nums; min-width: 92px; text-align: right; }
  #nvr-caption { max-width: 1200px; margin: 0 auto 12px; padding: 0 12px; color: #94a3b8; font-size: 12px; }
  .nvr-capture #nvr-bar, .nvr-capture #nvr-caption { display: none; }
  .nvr-capture #nvr-stage { margin: 0; }
</style>
</head>
<body>
<div id="nvr-stage"></div>
<div id="nvr-bar">
  <button id="nvr-play" type="button">Pause</button>
  <input id="nvr-seek" type="range" min="0" max="1" value="0" aria-label="Replay position">
  <span id="nvr-time">0:00 / 0:00</span>
  <select id="nvr-speed" aria-label="Speed"><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option></select>
</div>
<p id="nvr-caption">${escHtml(o.caption)}</p>
<script>${inlineJs(js)}</script>
<script type="application/json" id="nvr-events">${scriptSafeJson(o.events)}</script>
<script type="application/json" id="nvr-config">${scriptSafeJson(config)}</script>
<script>
(function () {
  var events = JSON.parse(document.getElementById('nvr-events').textContent);
  var cfg = JSON.parse(document.getElementById('nvr-config').textContent);
  var capture = !!cfg.capture;
  if (capture) document.documentElement.className = 'nvr-capture';
  var stage = document.getElementById('nvr-stage');
  var replayer = new rrweb.Replayer(events, {
    root: stage,
    skipInactive: true,
    showWarning: false,
    mouseTail: capture ? false : { strokeStyle: '#00ceff' }
  });
  var total = replayer.getMetaData().totalTime;
  var end = Math.min(cfg.end || total, total);
  var playing = false;
  var state = { replayer: replayer, start: cfg.start, end: end, finished: false, error: null };
  window.__nvrReplay = state;
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function fit() {
    var iframe = replayer.iframe;
    var w = iframe.offsetWidth || 1280, h = iframe.offsetHeight || 720;
    var scale = capture ? Math.min(1, window.innerWidth / w) : Math.min((window.innerWidth - 24) / w, (window.innerHeight - 90) / h);
    replayer.wrapper.style.transform = 'scale(' + scale + ')';
    replayer.wrapper.style.transformOrigin = 'top left';
    stage.style.width = Math.ceil(w * scale) + 'px';
    stage.style.height = Math.ceil(h * scale) + 'px';
  }
  replayer.on('fullsnapshot-rebuilded', fit);
  replayer.on('resize', fit);
  window.addEventListener('resize', fit);
  var seek = document.getElementById('nvr-seek');
  var time = document.getElementById('nvr-time');
  var btn = document.getElementById('nvr-play');
  seek.min = String(cfg.start);
  seek.max = String(Math.max(cfg.start + 1, end));
  function finish() {
    replayer.pause();
    playing = false;
    state.finished = true;
    btn.textContent = 'Replay';
  }
  replayer.on('finish', finish);
  function play(at) {
    state.finished = false;
    replayer.play(at);
    playing = true;
    btn.textContent = 'Pause';
  }
  btn.onclick = function () {
    if (playing) { replayer.pause(); playing = false; btn.textContent = 'Play'; }
    else play(state.finished ? cfg.start : replayer.getCurrentTime());
  };
  seek.oninput = function () {
    var at = Number(seek.value);
    if (playing) replayer.play(at); else replayer.pause(at);
  };
  document.getElementById('nvr-speed').onchange = function (e) {
    replayer.setConfig({ speed: Number(e.target.value) });
  };
  (function tick() {
    var now = replayer.getCurrentTime();
    if (playing && now >= end) finish();
    seek.value = String(Math.min(now, end));
    time.textContent = clock(now - cfg.start) + ' / ' + clock(end - cfg.start);
    requestAnimationFrame(tick);
  })();
  // The WebM job starts playback itself once the recorder is running.
  state.start_playback = function () { play(cfg.start); };
  if (capture) replayer.pause(cfg.start);
  else play(cfg.start);
  setTimeout(fit, 50);
})();
</script>
</body>
</html>
`
}

export interface RecordingHeader {
  id: string
  user_name: string | null
  started_at: Date | string | null
}

/** The recording's id, owner name and start, or null when it is gone. */
export async function loadRecordingHeader(id: string): Promise<RecordingHeader | null> {
  const r = (await db('nivaro_session_recordings')
    .where({ id })
    .first('id', 'user', 'started_at')) as Record<string, unknown> | undefined
  if (!r) return null
  const u = r.user
    ? ((await db('nivaro_users').where({ id: r.user }).first('first_name', 'last_name', 'email')) as
        | Record<string, unknown>
        | undefined)
    : undefined
  const name = u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '') : ''
  return { id: String(r.id), user_name: name || null, started_at: (r.started_at as Date) ?? null }
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function exportCaption(rec: RecordingHeader, win: { fromMs: number; toMs: number }): string {
  const who = rec.user_name || 'Unknown user'
  const when = rec.started_at ? new Date(rec.started_at).toISOString() : 'unknown time'
  return `Session recording ${rec.id} — ${who}, started ${when}. Window ${fmtClock(win.fromMs)}–${fmtClock(win.toMs)}. Inputs were masked when recorded.`
}

export function exportFileName(recordingId: string, ext: ExportFormat): string {
  return `replay-${recordingId.slice(0, 8).toLowerCase()}.${ext}`
}

// ── WebM job ────────────────────────────────────────────────────────────────

export interface WebmJob {
  recordingId: string
  fromMs: number | null
  toMs: number | null
  /** The admin who asked: owns the file and gets the notification. */
  userId: string
}

/** Everything the job touches outside this module — fakes in tests. */
export interface WebmDeps {
  loadEvents: (recordingId: string) => Promise<RrwebEvent[]>
  loadHeader: (recordingId: string) => Promise<RecordingHeader | null>
  /** Open `html` in a headless browser at `viewport`, play it, write a WebM to `outPath`. */
  capture: (opts: {
    html: string
    viewport: { width: number; height: number }
    durationMs: number
    outPath: string
    signal: AbortSignal
  }) => Promise<void>
  hasFfmpeg: () => Promise<boolean>
  storeFile: (
    userId: string,
    path: string,
    name: string
  ) => Promise<{ id: string; filesize?: number | null }>
  notify: (
    userId: string,
    n: { ok: boolean; subject: string; message: string; fileId?: string; recordingId: string }
  ) => Promise<void>
  logActivity: (row: {
    action: string
    user: string
    collection: string
    item: string
    comment: string
  }) => Promise<unknown>
  jobRun: (label: string, jobId: string, userId: string) => Promise<JobRunLike>
  workDir: () => string
  /** Runs `work` in the cron heavy slot when the app has one. */
  heavySlot: (label: string, work: () => Promise<void>) => Promise<void>
}

export interface JobRunLike {
  progress(blob: Record<string, unknown>): void
  complete(outcome?: string): Promise<void>
  fail(err: unknown): Promise<void>
}

/** The recording's viewport (from the window's Meta event), capped in width. */
export function captureViewport(events: RrwebEvent[]): { width: number; height: number } {
  const meta = events.find((e) => e.type === 4)
  let width = Number(meta?.data?.width) || 1280
  let height = Number(meta?.data?.height) || 720
  if (width > WEBM_MAX_WIDTH) {
    height = Math.round((height * WEBM_MAX_WIDTH) / width)
    width = WEBM_MAX_WIDTH
  }
  // Encoders want even dimensions.
  return { width: Math.max(2, width - (width % 2)), height: Math.max(2, height - (height % 2)) }
}

/** What the notification says when it fails: a plain reason, details stay in the job run. */
export function friendlyExportError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ffmpeg/i.test(msg)) return 'ffmpeg is not available on this server'
  if (/no full snapshot|nothing to replay/i.test(msg))
    return 'that part of the recording cannot be replayed'
  if (/timed? ?out|timeout|aborted|cancel/i.test(msg)) return 'capturing the replay took too long'
  if (/gone|not found/i.test(msg)) return 'the recording is gone'
  return 'the video could not be made'
}

const EXPORT_TIMEOUT_EXTRA_MS = 2 * 60_000

/** Render one WebM export. Exported for tests; production calls go through enqueueWebmExport. */
export async function runWebmExport(
  job: WebmJob,
  deps: WebmDeps
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const key = job.recordingId.toLowerCase()
  const run = await deps.jobRun(
    'Export a session recording as WebM',
    `session-replay-webm:${key}`,
    job.userId
  )
  const dir = join(
    deps.workDir(),
    'replay-exports',
    `${key.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  )
  const abort = new AbortController()
  let timer: NodeJS.Timeout | null = null
  try {
    const header = await deps.loadHeader(job.recordingId)
    if (!header) throw new Error('The recording is gone')
    if (!(await deps.hasFfmpeg()))
      throw new Error(
        'Exporting a recording as video needs ffmpeg and Chromium on this server (the slim image has neither)'
      )
    const win = cutReplayWindow(await deps.loadEvents(job.recordingId), job.fromMs, job.toMs)
    if (!win) throw new Error('The recording has no full snapshot: nothing to replay')
    const durationMs = Math.min(WEBM_MAX_MS, win.endOffsetMs - win.startOffsetMs)
    run.progress({ phase: 'capturing', duration_ms: durationMs })
    timer = setTimeout(() => abort.abort(), durationMs + EXPORT_TIMEOUT_EXTRA_MS)
    timer.unref?.()
    await mkdir(dir, { recursive: true })
    const outPath = join(dir, 'replay.webm')
    const html = buildExportHtml({
      title: `Replay ${key.slice(0, 8)}`,
      caption: exportCaption(header, win),
      events: win.events,
      startOffsetMs: win.startOffsetMs,
      endOffsetMs: win.startOffsetMs + durationMs,
      capture: true
    })
    await deps.capture({
      html,
      viewport: captureViewport(win.events),
      durationMs,
      outPath,
      signal: abort.signal
    })
    const bytes = (await stat(outPath)).size
    if (!bytes) throw new Error('The capture wrote nothing')
    const file = await deps.storeFile(job.userId, outPath, exportFileName(key, 'webm'))
    const span = `${fmtClock(win.fromMs)}–${fmtClock(win.fromMs + durationMs)}`
    await deps.logActivity({
      action: 'session-recording-export',
      user: job.userId,
      collection: 'nivaro_session_recordings',
      item: job.recordingId,
      comment: `webm ready: ${span}, ${Math.round(bytes / 1024)} KB (file ${file.id})`
    })
    await deps.notify(job.userId, {
      ok: true,
      subject: 'Recording export ready',
      message: `The WebM of ${header.user_name ? `${header.user_name}'s` : 'the'} session (${span}) is ready to download.`,
      fileId: String(file.id),
      recordingId: job.recordingId
    })
    await run.complete(`webm · ${span} · ${Math.round(bytes / 1024)} KB`)
    return { ok: true, fileId: String(file.id) }
  } catch (err) {
    const reason = friendlyExportError(err)
    await run.fail(err)
    await deps
      .notify(job.userId, {
        ok: false,
        subject: 'Recording export failed',
        message: `The WebM export could not be made: ${reason}.`,
        recordingId: job.recordingId
      })
      .catch(() => null)
    return { ok: false, error: reason }
  } finally {
    if (timer) clearTimeout(timer)
    await rm(dir, { recursive: true, force: true }).catch(() => null)
  }
}

// ── The production wiring ───────────────────────────────────────────────────

/** Headless Chromium from the PDF service's pool, screencast through ffmpeg. Exported for a manual end-to-end check. */
export async function captureWithPuppeteer(
  opts: Parameters<WebmDeps['capture']>[0]
): Promise<void> {
  const { getBrowser } = await import('./pdf-layout.js')
  const browser = await getBrowser()
  const page = await browser.newPage()
  const onAbort = () => void page.close().catch(() => null)
  opts.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await page.setViewport({ ...opts.viewport, deviceScaleFactor: 1 })
    // Not 'load': the replay iframe rrweb builds can keep the document loading.
    await page.setContent(opts.html, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction('window.__nvrReplay && window.__nvrReplay.replayer', {
      timeout: 30_000
    })
    const recorder = await page.screencast({
      path: opts.outPath as `${string}.webm`,
      ffmpegPath: process.env.FFMPEG_PATH || undefined
    })
    try {
      await page.evaluate('window.__nvrReplay.start_playback()')
      await page.waitForFunction('window.__nvrReplay.finished === true', {
        timeout: opts.durationMs + 60_000,
        polling: 250
      })
    } finally {
      await recorder.stop()
    }
  } finally {
    opts.signal.removeEventListener('abort', onAbort)
    await page.close().catch(() => null)
  }
  if (opts.signal.aborted) throw new Error('The capture was cancelled (timeout)')
}

async function productionDeps(): Promise<WebmDeps> {
  const { getApp } = await import('./io-holder.js')
  const { startJobRun } = await import('./job-runs.js')
  return {
    loadEvents: loadRecordingEvents,
    loadHeader: loadRecordingHeader,
    capture: captureWithPuppeteer,
    // ffmpeg AND Chromium (the screencast needs both): only where the job may run.
    hasFfmpeg: async () => (await import('./media-handoff.js')).canRunHere('replay-webm'),
    storeFile: async (userId, path, name) => {
      const { uploadFileFromPath } = await import('./files.js')
      const f = await uploadFileFromPath({ id: userId } as never, path, name, 'video/webm')
      return { id: String(f.id), filesize: f.filesize ?? null }
    },
    notify: async (userId, n) => {
      const app = getApp()
      if (!app) return
      const { notifyUser } = await import('./notification-channels.js')
      const { adminBaseUrl } = await import('../admin-base.js')
      const base = (adminBaseUrl() ?? '').replace(/\/$/, '')
      const url = n.fileId
        ? `${base}/api/files/${n.fileId}?download=1`
        : `${base}/session-replays?recording=${n.recordingId.toLowerCase()}`
      await notifyUser(app, userId, {
        subject: n.subject,
        message: n.message,
        category: 'system',
        why: 'You asked for this export.',
        target: base ? { kind: 'external', url } : { kind: 'home', action: 'open' },
        source: { kind: 'session-replay-export', label: 'Session replay export', id: n.recordingId }
      })
    },
    logActivity: async (row) => (await import('./activity.js')).logActivity(row),
    jobRun: (label, jobId, userId) => startJobRun('export', jobId, { label, triggeredBy: userId }),
    // The help-video scratch root (VIDEO_WORK_DIR), so one setting places all video work.
    workDir: () => process.env.VIDEO_WORK_DIR || join(tmpdir(), 'nivaro-video'),
    heavySlot: async (label, work) => {
      const app = getApp()
      if (app?.cron?.withHeavySlot) await app.cron.withHeavySlot(label, work)
      else await work()
    }
  }
}

// Exports of this process, one after another, each inside the heavy slot.
let chain: Promise<unknown> = Promise.resolve()
let depsOverride: WebmDeps | null = null

/** Tests swap the outside world for fakes. */
export function setWebmDepsForTests(deps: WebmDeps | null): void {
  depsOverride = deps
}

/** Where a WebM export started on this process is made: here (ffmpeg and
 *  Chromium are installed), or on the media worker (the slim image). Throws
 *  the readable 503 (RENDER_UNAVAILABLE) when neither can. */
export async function webmExportPlacement(): Promise<'here' | 'worker'> {
  if (depsOverride) return 'here'
  const { mediaPlacement } = await import('./media-handoff.js')
  return mediaPlacement('replay-webm')
}

/** Queue a WebM export; answers at once. The requester is notified when it
 *  is done, by whichever process makes it. */
export async function enqueueWebmExport(job: WebmJob): Promise<'here' | 'worker'> {
  const placement = await webmExportPlacement()
  if (placement === 'worker') {
    const { handOff } = await import('./media-handoff.js')
    await handOff('replay-webm', { ...job })
    return placement
  }
  void runWebmExportHere(job)
  return placement
}

/** Makes one export through this process's queue (the media worker's runner,
 *  media-handoff.ts, waits for it). */
export function runWebmExportHere(job: WebmJob): Promise<unknown> {
  const run = async () => {
    const deps = depsOverride ?? (await productionDeps())
    // runWebmExport settles every failure itself (job run + notification).
    await deps.heavySlot('session replay export', async () => {
      await runWebmExport(job, deps).catch(() => null)
    })
  }
  chain = chain.then(run, run)
  return chain
}

/** Resolves once every queued export of this process is done (tests). */
export function whenExportsIdle(): Promise<unknown> {
  return chain
}

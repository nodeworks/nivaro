import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyReply } from 'fastify'
import { exportLimit } from './export-limits.js'

/**
 * Streaming export files (2026-11-18).
 *
 * Every server-built export (items export, export presets, content export, the audit CSV) used
 * to hold ALL its rows in a JS array and then build the whole CSV / XLSX / JSON buffer in
 * memory, so export row limits had to stay finite. Builders now read page by page (they already
 * did) and write each page to a temp file as they go:
 *
 *  - CSV / JSON: `ExportTextWriter` appends text with backpressure;
 *  - XLSX: `XlsxStreamWriter` over exceljs's streaming WorkbookWriter (inline strings, no shared
 *    string table, so memory stays flat), a sheet holds at most XLSX_MAX_ROWS rows including its
 *    header and continues on `<name> 2`, `<name> 3`, … with the header repeated;
 *  - a column set that is only known once every row was read (the union of the rows' keys)
 *    goes through an `NdjsonSpool`: pass one writes each row's finished cells to a temp file,
 *    pass two writes the real file from it.
 *
 * Temp files live under EXPORT_WORK_DIR (default <tmpdir>/nivaro-exports) and are always
 * removed: a builder removes its own on error, whoever takes the finished file (the response,
 * the background job's upload) removes it when done — `sendExportFile` / `removeExportTemp`.
 *
 * Disk guards (fix round 1): one export's file (and each of its spools) stops at the
 * `max_file_mb` export limit with ExportFileTooBig (the temp is removed); a new export is refused
 * with ExportDiskBusy while the work dir holds more than EXPORT_WORK_DIR_MAX_MB (default 10 GB);
 * stale temps are swept at boot and every hour (`startExportTempSweeper`).
 */

/** An export stopped because its file passed the `max_file_mb` limit. */
export class ExportFileTooBig extends Error {
  readonly statusCode = 413
  readonly code = 'EXPORT_TOO_BIG'
  constructor(maxMb: number) {
    super(
      `The export file passed ${maxMb.toLocaleString('en-US')} MB, the most one export may write — narrow the filter or pick fewer columns`
    )
    this.name = 'ExportFileTooBig'
  }
}

/** A new export refused while the export work dir is over its quota. */
export class ExportDiskBusy extends Error {
  readonly statusCode = 409
  readonly code = 'EXPORT_DISK_BUSY'
  constructor() {
    super('The server’s export space is full right now — try again shortly')
    this.name = 'ExportDiskBusy'
  }
}

/** A synchronous export whose caller left: stop reading. */
export class ExportAborted extends Error {
  readonly statusCode = 499
  readonly code = 'EXPORT_CLIENT_GONE'
  constructor() {
    super('The client closed the request')
    this.name = 'ExportAborted'
  }
}

/** The answer for one of the errors above, or null for any other error. */
export function exportErrorAnswer(
  err: unknown
): { status: number; body: { error: string; code: string } } | null {
  if (
    err instanceof ExportFileTooBig ||
    err instanceof ExportDiskBusy ||
    err instanceof ExportAborted
  )
    return { status: err.statusCode, body: { error: err.message, code: err.code } }
  return null
}

/** Bytes one export file (or spool) may hold. */
export function exportMaxFileBytes(): number {
  return exportLimit('max_file_mb') * 1024 * 1024
}

/** EXPORT_WORK_DIR_MAX_MB (default 10,240): the work dir's total before new exports wait. */
export function exportWorkDirMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EXPORT_WORK_DIR_MAX_MB)
  return (Number.isFinite(n) && n >= 1 ? n : 10_240) * 1024 * 1024
}

let workDirUsage: { at: number; bytes: number; dir: string } | null = null

/** Bytes of the files in `dir` and one level of sub-directories (the per-process dirs). */
async function dirBytes(dir: string, depth = 1): Promise<number> {
  let bytes = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) bytes += info.size
    else if (info?.isDirectory() && depth > 0) bytes += await dirBytes(join(dir, name), depth - 1)
  }
  return bytes
}

/** Bytes in the work dir now, every process's (and, in cloud mode, tenant's) sub-directory
 *  included (cached 5 s). */
export async function exportWorkDirBytes(fresh = false): Promise<number> {
  const dir = exportWorkDir()
  if (!fresh && workDirUsage && workDirUsage.dir === dir && Date.now() - workDirUsage.at < 5_000)
    return workDirUsage.bytes
  const bytes = await dirBytes(dir, 2)
  workDirUsage = { at: Date.now(), bytes, dir }
  return bytes
}

/** EXPORT_TENANT_WORK_DIR_MAX_MB (cloud mode, default 2,048): one tenant's share of this
 *  process's work dir. */
export function exportTenantWorkDirMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EXPORT_TENANT_WORK_DIR_MAX_MB)
  return (Number.isFinite(n) && n >= 1 ? n : 2_048) * 1024 * 1024
}

const isCloud = () => !!process.env.CLOUD_META_DB_URL

/** The current tenant's sub-directory name (cloud mode; '-' when there is none). */
async function tenantDirName(): Promise<string> {
  const { currentTenantKey } = await import('./tenant-rooms.js')
  const key = (currentTenantKey() || '-').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
  return `t-${key}`
}

/**
 * Refuse a new export while the work dir is over its quota (ExportDiskBusy, 409). In cloud mode
 * one tenant may also hold at most EXPORT_TENANT_WORK_DIR_MAX_MB of this process's work dir, so a
 * tenant cannot fill the disk the others share.
 */
export async function assertExportDiskRoom(): Promise<void> {
  if ((await exportWorkDirBytes()) > exportWorkDirMaxBytes()) throw new ExportDiskBusy()
  if (isCloud()) {
    const mine = await dirBytes(join(exportProcessDir(), await tenantDirName()), 0)
    if (mine > exportTenantWorkDirMaxBytes()) throw new ExportDiskBusy()
  }
}

let sweeper: ReturnType<typeof setInterval> | null = null

/** Sweep stale temps (and dead processes' dirs) now and every hour (unref'd). Returns a stop
 *  function. */
export function startExportTempSweeper(
  everyMs = 3_600_000,
  liveIds: () => Promise<ReadonlySet<string> | null> = async () => null
): () => void {
  const sweep = () => {
    void sweepStaleExportTemps().catch(() => 0)
    void liveIds()
      .catch(() => null)
      .then((live) => sweepDeadProcessDirs(live))
      .catch(() => 0)
  }
  sweep()
  if (!sweeper) {
    sweeper = setInterval(sweep, everyMs)
    sweeper.unref?.()
  }
  return () => {
    if (sweeper) clearInterval(sweeper)
    sweeper = null
  }
}

/** Rows one XLSX sheet holds, the header included (Excel's limit). */
export const XLSX_MAX_ROWS = 1_048_576

/** Where export temp files go. */
export function exportWorkDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = (env.EXPORT_WORK_DIR ?? '').trim()
  return own || join(tmpdir(), 'nivaro-exports')
}

/** This process's own id in the work dir (set once; tests may set it). */
let processTag = `p-${randomBytes(4).toString('hex')}`
export function setExportProcessTag(tag: string): void {
  processTag = tag.startsWith('p-') ? tag : `p-${tag}`
}

/**
 * This process's own sub-directory of the work dir (`p-<instance id>`, fix round 2): the files a
 * process leaves behind when it dies sit together and go together (sweepDeadProcessDirs), and
 * one process never sweeps another's live temp files.
 */
export function exportProcessDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(exportWorkDir(env), processTag)
}

/**
 * Remove the sub-directories of processes that are gone: not this process, not in the instance
 * roster (`live`, when one is known), and nothing in them written for `quietMs` (10 minutes with
 * a roster to confirm, else 6 hours). Never throws.
 */
export async function sweepDeadProcessDirs(
  live: ReadonlySet<string> | null = null,
  quietMs = live ? 10 * 60_000 : 6 * 3_600_000
): Promise<number> {
  const base = exportWorkDir()
  let removed = 0
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (!name.startsWith('p-') || name === processTag) continue
    if (live?.has(name.slice(2))) continue
    const dir = join(base, name)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    let newest = info.mtimeMs
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const fi = await stat(join(dir, f)).catch(() => null)
      if (fi && fi.mtimeMs > newest) newest = fi.mtimeMs
    }
    if (Date.now() - newest < quietMs) continue
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    removed++
  }
  return removed
}

/** A fresh temp path in this process's work dir (cloud mode: the tenant's sub-directory of it),
 *  created when missing. */
export async function newExportTempPath(ext = ''): Promise<string> {
  const dir = isCloud() ? join(exportProcessDir(), await tenantDirName()) : exportProcessDir()
  await mkdir(dir, { recursive: true })
  const name = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}${ext}`
  return join(dir, name)
}

/** Remove a temp file; never throws (a missing file is fine). */
export async function removeExportTemp(path: string | null | undefined): Promise<void> {
  if (!path) return
  await rm(path, { force: true }).catch(() => {})
}

/**
 * Remove temp files a process left behind when it stopped mid-export (a deploy, a crash): files
 * in the work dir older than `olderThanMs` (default a day — no export runs that long). Never
 * throws.
 */
export async function sweepStaleExportTemps(olderThanMs = 24 * 3_600_000): Promise<number> {
  let removed = 0
  // Loose files in the work dir (before per-process dirs), this process's own dir and its
  // tenant sub-directories (cloud mode).
  const own = exportProcessDir()
  const tenantDirs = (await readdir(own).catch(() => [] as string[]))
    .filter((n) => n.startsWith('t-'))
    .map((n) => join(own, n))
  for (const dir of [exportWorkDir(), own, ...tenantDirs]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile() || Date.now() - info.mtimeMs < olderThanMs) continue
      await removeExportTemp(path)
      removed++
    }
  }
  return removed
}

/**
 * The bytes one export has on disk across its files (output + spool, fix round 2): together
 * they stay under `max_file_mb`, and every 64 MB the work dir's quota is checked again (an
 * export that started under the quota does not keep writing once the disk is full).
 */
export class ExportBudget {
  private readonly parts = new Map<object, number>()
  private lastQuotaCheck = 0
  readonly maxBytes = exportMaxFileBytes()

  get used(): number {
    let n = 0
    for (const v of this.parts.values()) n += v
    return n
  }

  /** Record `part`'s current size; throws ExportFileTooBig past the cap. */
  async set(part: object, bytes: number): Promise<void> {
    this.parts.set(part, bytes)
    const used = this.used
    if (used > this.maxBytes) throw new ExportFileTooBig(Math.round(this.maxBytes / 1048576))
    if (used - this.lastQuotaCheck >= 64 * 1024 * 1024) {
      this.lastQuotaCheck = used
      await assertExportDiskRoom()
    }
  }
}

/** The finished file a builder hands over: it sits on disk until its taker removes it. */
export interface ExportFile {
  /** Temp file holding the export (removed by whoever takes it). */
  path: string
  filename: string
  contentType: string
  rows: number
  /** More rows matched than one export holds. */
  truncated?: boolean
  /** The row limit this build applied (Infinity = none) — what `x-nivaro-export-truncated` names. */
  limit?: number
}

/** Bytes of a finished file (0 when it cannot be read). */
export async function exportFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

// ── Text output ─────────────────────────────────────────────────────────────

/** Appends text to a temp file, waiting for the disk when its buffer is full. */
export class ExportTextWriter {
  private closed = false
  private failure: Error | null = null
  private bytes = 0

  private constructor(
    readonly path: string,
    private readonly out: WriteStream,
    private readonly budget: ExportBudget
  ) {
    out.on('error', (err) => {
      this.failure = err
    })
  }

  /** `budget`: shared with the export's other files (one cap for all of them). */
  static async open(ext: string, budget = new ExportBudget()): Promise<ExportTextWriter> {
    const path = await newExportTempPath(ext)
    return new ExportTextWriter(path, createWriteStream(path, { encoding: 'utf8' }), budget)
  }

  /** Bytes written so far. */
  get size(): number {
    return this.bytes
  }

  async write(text: string): Promise<void> {
    if (this.failure) throw this.failure
    if (!text) return
    this.bytes += Buffer.byteLength(text, 'utf8')
    // One export never fills the disk: past max_file_mb (all its files together) it stops (the
    // builder removes the files).
    await this.budget.set(this, this.bytes)
    if (this.out.write(text)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        this.out.off('error', onError)
        resolve()
      }
      const onError = (err: Error) => {
        this.out.off('drain', onDrain)
        reject(err)
      }
      this.out.once('drain', onDrain)
      this.out.once('error', onError)
    })
  }

  /** Flush and close; the file stays for its taker. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.failure) throw this.failure
    await new Promise<void>((resolve, reject) => {
      this.out.once('error', reject)
      this.out.end(() => resolve())
    })
  }

  /** Stop and remove the file (errors, Cancel). */
  async discard(): Promise<void> {
    this.closed = true
    // Wait for the stream to let go of the file: a stream destroyed before its open finished
    // would otherwise create the file again after it was removed.
    if (!this.out.closed)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000)
        this.out.once('close', () => {
          clearTimeout(t)
          resolve()
        })
        this.out.destroy()
      })
    await removeExportTemp(this.path)
  }
}

// ── Spool: rows whose column set is only known at the end ───────────────────

/**
 * One JSON value per line in a temp file. JSON keeps strings, finite numbers, booleans and
 * nulls exactly; callers spool values that are already what the file will hold (CSV cell text,
 * XLSX cell values), never raw rows (a Date would come back as a string).
 */
export class NdjsonSpool {
  private constructor(private readonly writer: ExportTextWriter) {}

  static async open(budget?: ExportBudget): Promise<NdjsonSpool> {
    return new NdjsonSpool(await ExportTextWriter.open('.ndjson', budget))
  }

  get path(): string {
    return this.writer.path
  }

  write(value: unknown): Promise<void> {
    return this.writer.write(`${JSON.stringify(value, spoolReplacer)}\n`)
  }

  /** Close for writing; then `read()` replays the values in order. */
  finish(): Promise<void> {
    return this.writer.close()
  }

  /** The file stream the last read() opened (tests: it is destroyed when the read ends). */
  lastReader: ReadStream | null = null

  async *read<T = unknown>(): AsyncGenerator<T> {
    // The stream is kept and destroyed in finally (fix round 3): readline's close() alone does
    // not close the file, so a caller that stops early (Cancel, an error) left it open.
    const input = createReadStream(this.writer.path, { encoding: 'utf8' })
    this.lastReader = input
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    try {
      for await (const line of lines) {
        if (line) yield JSON.parse(line) as T
      }
    } finally {
      lines.close()
      input.destroy()
    }
  }

  /** Remove the spool file (always, in a finally). */
  discard(): Promise<void> {
    return this.writer.discard()
  }
}

/** BigInt is not JSON: spool it as its text. */
function spoolReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

// ── XLSX ────────────────────────────────────────────────────────────────────

/** A cell exceljs writes as-is: number, boolean, string (text written as inline strings). */
export type XlsxCell = string | number | boolean | null | undefined

interface ExcelSheet {
  columns: Array<{ width?: number }>
  addRow(values: XlsxCell[]): { commit(): void }
  commit(): void
}

interface ExcelWorkbookWriter {
  addWorksheet(name: string): ExcelSheet
  commit(): Promise<void>
  /** The file stream the zip is piped into. */
  stream?: { writableNeedDrain?: boolean; once(ev: string, fn: (...a: unknown[]) => void): unknown }
}

/** Rows between two backpressure / size checks of the XLSX writer. */
export const XLSX_SETTLE_EVERY = 1000

/**
 * The width sheetjs writes for `{ wch }` (so a streamed file opens with the same column widths
 * the in-memory sheetjs build had): wch + 0.83203125 (sheetjs's character-to-width step at its
 * default max digit width).
 */
export function xlsxWidthFromWch(wch: number): number {
  return wch + 0.83203125
}

/**
 * A streamed XLSX workbook. Sheets are written one after another (exceljs streams each sheet
 * into the zip as rows are committed), so start the next sheet only after the last one is done
 * — `sheet()` closes the open one. Past XLSX_MAX_ROWS a sheet continues on `<name> 2`, … with
 * the header and widths repeated.
 *
 * `row()` is async: every XLSX_SETTLE_EVERY rows it waits until the file stream has drained and
 * the sheet's buffered XML went into the zip (a disk slower than the reads never builds up a
 * backlog in memory), and stops with ExportFileTooBig once the file passed `max_file_mb`.
 */
export class XlsxStreamWriter {
  private open: {
    name: string
    sheet: ExcelSheet
    header: XlsxCell[] | null
    widths: number[] | null
    rows: number
    part: number
  } | null = null
  private sinceSettle = 0
  private committed = false

  private constructor(
    readonly path: string,
    private readonly wb: ExcelWorkbookWriter,
    private readonly maxRows: number,
    private readonly budget: ExportBudget
  ) {}

  static async open(
    opts: { maxRowsPerSheet?: number; budget?: ExportBudget } = {}
  ): Promise<XlsxStreamWriter> {
    const path = await newExportTempPath('.xlsx')
    const ExcelJS = (await import('exceljs')).default as unknown as {
      stream: {
        xlsx: { WorkbookWriter: new (o: Record<string, unknown>) => ExcelWorkbookWriter }
      }
    }
    // Inline strings and no style table: nothing grows with the row count.
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useSharedStrings: false,
      useStyles: false
    })
    const max = Math.max(2, Math.min(XLSX_MAX_ROWS, opts.maxRowsPerSheet ?? XLSX_MAX_ROWS))
    return new XlsxStreamWriter(path, wb, max, opts.budget ?? new ExportBudget())
  }

  /** Start a sheet: `widths` are sheetjs `wch` values (see xlsxWidthFromWch). */
  sheet(name: string, opts: { header?: XlsxCell[]; widths?: number[] } = {}): void {
    this.closeSheet()
    this.startSheet(name, opts.header ?? null, opts.widths ?? null, 1)
  }

  private startSheet(
    name: string,
    header: XlsxCell[] | null,
    widths: number[] | null,
    part: number
  ): void {
    const sheetName = (part === 1 ? name : `${name} ${part}`).slice(0, 31)
    const sheet = this.wb.addWorksheet(sheetName)
    if (widths) sheet.columns = widths.map((w) => ({ width: xlsxWidthFromWch(w) }))
    this.open = { name, sheet, header, widths, rows: 0, part }
    if (header) this.addRaw(header)
  }

  private addRaw(values: XlsxCell[]): void {
    if (!this.open) throw new Error('No sheet is open')
    this.open.sheet.addRow(values).commit()
    this.open.rows++
  }

  /** One data row; a full sheet continues on the next one. */
  async row(values: XlsxCell[]): Promise<void> {
    const cur = this.open
    if (!cur) throw new Error('No sheet is open')
    if (cur.rows >= this.maxRows) {
      cur.sheet.commit()
      this.startSheet(cur.name, cur.header, cur.widths, cur.part + 1)
    }
    this.addRaw(values)
    if (++this.sinceSettle >= XLSX_SETTLE_EVERY) {
      this.sinceSettle = 0
      await this.settle()
    }
  }

  /** Wait for the disk and the zip to catch up, then check the file's size. */
  async settle(): Promise<void> {
    const file = this.wb.stream
    if (file?.writableNeedDrain)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 30_000)
        file.once('drain', () => {
          clearTimeout(t)
          resolve()
        })
        file.once('error', () => {
          clearTimeout(t)
          resolve()
        })
      })
    // The open sheet's own buffer (exceljs StreamBuf, 64 KB chunks) drains as the zip reads it.
    const buffered = () =>
      (this.open?.sheet as unknown as { _stream?: { buffers?: unknown[] } } | undefined)?._stream
        ?.buffers?.length ?? 0
    for (let i = 0; i < 400 && buffered() > 16; i++) await new Promise((r) => setTimeout(r, 5))
    await this.budget.set(this, await exportFileSize(this.path))
  }

  private closeSheet(): void {
    if (this.open) this.open.sheet.commit()
    this.open = null
  }

  /** Finish the workbook; the file stays for its taker. */
  async close(): Promise<void> {
    this.closeSheet()
    this.committed = true
    await this.wb.commit()
    await this.budget.set(this, await exportFileSize(this.path))
  }

  /** Remove the file (errors, Cancel). The writer may still hold the file open: best effort. */
  async discard(): Promise<void> {
    if (!this.committed) {
      this.committed = true
      try {
        this.closeSheet()
        await this.wb.commit()
      } catch {
        /* removing it anyway */
      }
    }
    await removeExportTemp(this.path)
  }
}

// ── Column widths (the sheetjs auto-fit, computed as rows stream past) ───────

/** Longest cell text per column, capped like the in-memory auto-fit (#161). */
export class ColumnWidths {
  private readonly longest: number[]

  constructor(header: unknown[]) {
    this.longest = header.map((h) => String(h).length)
  }

  see(row: unknown[]): void {
    for (let i = 0; i < this.longest.length; i++) {
      const n = String(row[i] ?? '').length
      if (n > this.longest[i]) this.longest[i] = n
    }
  }

  /** `wch` per column: longest + 2, at most `cap`. */
  wch(cap = 60): number[] {
    return this.longest.map((n) => Math.min(cap, n + 2))
  }
}

// ── Handing the file over ───────────────────────────────────────────────────

/**
 * Answer a request with a finished export file, streamed from disk (stream.pipeline into a
 * PassThrough the reply sends — a read error or a client that leaves ends both sides), then
 * remove the temp file whatever happened.
 */
export function sendExportFile(
  reply: FastifyReply,
  file: Pick<ExportFile, 'path' | 'filename' | 'contentType'>,
  opts: { disposition?: string } = {}
): FastifyReply {
  const body = new PassThrough()
  void pipeline(createReadStream(file.path), body)
    .catch(() => {})
    .finally(() => removeExportTemp(file.path))
  // The connection closed (done or the client left before the pipeline noticed): the file goes.
  reply.raw.once?.('close', () => {
    body.destroy()
    void removeExportTemp(file.path)
  })
  return reply
    .header('Content-Type', file.contentType)
    .header('Content-Disposition', opts.disposition ?? `attachment; filename="${file.filename}"`)
    .send(body)
}

import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
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

/** Bytes in the work dir now (cached 5 s). */
export async function exportWorkDirBytes(fresh = false): Promise<number> {
  const dir = exportWorkDir()
  if (!fresh && workDirUsage && workDirUsage.dir === dir && Date.now() - workDirUsage.at < 5_000)
    return workDirUsage.bytes
  let bytes = 0
  try {
    for (const name of await readdir(dir)) {
      const info = await stat(join(dir, name)).catch(() => null)
      if (info?.isFile()) bytes += info.size
    }
  } catch {
    /* no work dir yet */
  }
  workDirUsage = { at: Date.now(), bytes, dir }
  return bytes
}

/** Refuse a new export while the work dir is over its quota (ExportDiskBusy, 409). */
export async function assertExportDiskRoom(): Promise<void> {
  if ((await exportWorkDirBytes()) > exportWorkDirMaxBytes()) throw new ExportDiskBusy()
}

let sweeper: ReturnType<typeof setInterval> | null = null

/** Sweep stale temps now and every hour (unref'd). Returns a stop function. */
export function startExportTempSweeper(everyMs = 3_600_000): () => void {
  void sweepStaleExportTemps().catch(() => 0)
  if (!sweeper) {
    sweeper = setInterval(() => void sweepStaleExportTemps().catch(() => 0), everyMs)
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

/** A fresh temp path in the work dir (the directory is created when missing). */
export async function newExportTempPath(ext = ''): Promise<string> {
  const dir = exportWorkDir()
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
  const dir = exportWorkDir()
  let removed = 0
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile() || Date.now() - info.mtimeMs < olderThanMs) continue
      await removeExportTemp(path)
      removed++
    }
  } catch {
    /* no work dir yet */
  }
  return removed
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
  private readonly maxBytes = exportMaxFileBytes()

  private constructor(
    readonly path: string,
    private readonly out: WriteStream
  ) {
    out.on('error', (err) => {
      this.failure = err
    })
  }

  static async open(ext: string): Promise<ExportTextWriter> {
    const path = await newExportTempPath(ext)
    return new ExportTextWriter(path, createWriteStream(path, { encoding: 'utf8' }))
  }

  /** Bytes written so far. */
  get size(): number {
    return this.bytes
  }

  async write(text: string): Promise<void> {
    if (this.failure) throw this.failure
    if (!text) return
    this.bytes += Buffer.byteLength(text, 'utf8')
    // One export never fills the disk: past max_file_mb it stops (the builder removes the file).
    if (this.bytes > this.maxBytes) throw new ExportFileTooBig(Math.round(this.maxBytes / 1048576))
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

  static async open(): Promise<NdjsonSpool> {
    return new NdjsonSpool(await ExportTextWriter.open('.ndjson'))
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

  async *read<T = unknown>(): AsyncGenerator<T> {
    const lines = createInterface({
      input: createReadStream(this.writer.path, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY
    })
    try {
      for await (const line of lines) {
        if (line) yield JSON.parse(line) as T
      }
    } finally {
      lines.close()
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
  private readonly maxBytes = exportMaxFileBytes()

  private constructor(
    readonly path: string,
    private readonly wb: ExcelWorkbookWriter,
    private readonly maxRows: number
  ) {}

  static async open(opts: { maxRowsPerSheet?: number } = {}): Promise<XlsxStreamWriter> {
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
    return new XlsxStreamWriter(path, wb, max)
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
    if ((await exportFileSize(this.path)) > this.maxBytes)
      throw new ExportFileTooBig(Math.round(this.maxBytes / 1048576))
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
    if ((await exportFileSize(this.path)) > this.maxBytes)
      throw new ExportFileTooBig(Math.round(this.maxBytes / 1048576))
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

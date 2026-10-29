import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { buildZip } from '../zip-writer.js'
import { CANONICAL_COLUMNS, canonicalRow, GENESIS_HASH, isSealVersion } from './canonical.js'
import { MISMATCH_TEXT, type Mismatch, type WalkRow } from './chain.js'
import { ACTIVITY, presentCanonicalColumns, readHead, SEALS, trailReady } from './store.js'
import { anchorOf, type CheckpointRow, checkpointAtOrBefore, walkChain } from './verify.js'

/**
 * Evidence export (#16): GET /api/activity/evidence?from=&to= — a zip an auditor can check
 * without Nivaro:
 *
 *   entries.csv   every activity entry in the window, with seal_seq, prev_hash, seal_hash and
 *                 the exact canonical text the hash covers (sha256(prev_hash + canonical)).
 *   manifest.json the window, the algorithm and canonical column list, the anchor the check
 *                 started from, the chain heads (checkpoints) in and after the window, the
 *                 verification result, and the sha256 of every other file.
 *   summary.html  the same, for people.
 *
 * The chain is re-verified from the nearest good checkpoint at or before the window, so the
 * result is computed now, not copied from the last daily run.
 */
export const EVIDENCE_MAX_ROWS = 100_000
const WALK_BUDGET_MS = 5 * 60_000

export class EvidenceTooLargeError extends Error {
  constructor(readonly rows: number) {
    super(
      `The window holds ${rows} entries — the export takes at most ${EVIDENCE_MAX_ROWS}. Narrow the dates.`
    )
  }
}

const CSV_COLUMNS = [
  'id',
  'timestamp',
  'action',
  'user',
  'collection',
  'item',
  'comment',
  'ip',
  'user_agent',
  'origin',
  'seal_seq',
  'seal_version',
  'prev_hash',
  'seal_hash',
  'canonical'
] as const

/** CSV cell: quoted, and spreadsheet-safe (a leading = + - @ gets a ' — canonical never does). */
export function csvCell(v: unknown): string {
  if (v == null) return ''
  let s = v instanceof Date ? v.toISOString() : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

interface EvidenceRow {
  row: Record<string, unknown>
  seq: number | null
  version: number | null
  hash: string | null
  prev: string | null
}

export interface EvidenceResult {
  zip: Buffer
  filename: string
  manifest: Record<string, unknown>
  manifestSha256: string
}

export async function buildEvidence(opts: {
  from: Date
  to: Date
  generatedBy: { id: string | null; name: string | null }
  instance?: string | null
}): Promise<EvidenceResult> {
  const { from, to } = opts
  const sealedOn = await trailReady()
  const columns = await presentCanonicalColumns()
  const countRow = (await db(ACTIVITY)
    .where('timestamp', '>=', from)
    .where('timestamp', '<=', to)
    .count({ n: '*' })
    .first()) as { n: number | string }
  const total = Number(countRow?.n ?? 0)
  if (total > EVIDENCE_MAX_ROWS) throw new EvidenceTooLargeError(total)

  const rows: EvidenceRow[] = []
  let anchor = anchorOf(null)
  let anchorCheckpoint: number | null = null
  let walk: Awaited<ReturnType<typeof walkChain>> | null = null
  const mismatchesInWindow: Mismatch[] = []
  let span: { first_seq: number; last_seq: number } | null = null

  if (sealedOn) {
    const bounds = (await db(ACTIVITY)
      .where('timestamp', '>=', from)
      .where('timestamp', '<=', to)
      .whereNotNull('seal_seq')
      .min({ lo: 'seal_seq' })
      .max({ hi: 'seal_seq' })
      .first()) as { lo: number | string | null; hi: number | string | null }
    if (bounds?.lo != null && bounds.hi != null) {
      span = { first_seq: Number(bounds.lo), last_seq: Number(bounds.hi) }
      const cp: CheckpointRow | null = await checkpointAtOrBefore(span.first_seq - 1)
      anchor = anchorOf(cp)
      anchorCheckpoint = cp ? Number(cp.id) : null
      const fromMs = from.getTime()
      const toMs = to.getTime()
      walk = await walkChain(anchor, span.last_seq, {
        budgetMs: WALK_BUDGET_MS,
        keepPrev: true,
        onBatch: (batch: WalkRow[], prev) => {
          for (const r of batch) {
            if (r.seq < (span?.first_seq ?? 0)) continue
            const at = new Date(r.at as string | Date).getTime()
            if (!(at >= fromMs && at <= toMs)) continue
            rows.push({
              row: r.row,
              seq: r.seq,
              version: r.version,
              hash: r.hash,
              prev: prev?.get(r.id) ?? null
            })
          }
        }
      })
      for (const m of walk.mismatches) if (m.seq >= span.first_seq) mismatchesInWindow.push(m)
    }
  }

  // Entries not sealed yet (the sealer runs every minute) — listed, marked unsealed.
  const unsealedQ = db(ACTIVITY)
    .where('timestamp', '>=', from)
    .where('timestamp', '<=', to)
    .orderBy('id', 'asc')
    .limit(EVIDENCE_MAX_ROWS)
  if (sealedOn) unsealedQ.whereNull('seal_hash')
  const unsealed = (await unsealedQ.select(columns)) as Record<string, unknown>[]
  for (const r of unsealed) rows.push({ row: r, seq: null, version: null, hash: null, prev: null })

  const lines = [CSV_COLUMNS.join(',')]
  for (const e of rows) {
    const canonical = isSealVersion(e.version) ? canonicalRow(e.row, e.version) : ''
    const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      id: e.row.id,
      timestamp: e.row.timestamp,
      action: e.row.action,
      user: e.row.user,
      collection: e.row.collection,
      item: e.row.item,
      comment: e.row.comment,
      ip: e.row.ip,
      user_agent: e.row.user_agent,
      origin: e.row.origin,
      seal_seq: e.seq,
      seal_version: e.version,
      prev_hash: e.prev,
      seal_hash: e.hash,
      canonical
    }
    lines.push(CSV_COLUMNS.map((c) => csvCell(values[c])).join(','))
  }
  const csv = Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')

  const head = sealedOn ? await readHead() : null
  const checkpoints = sealedOn
    ? ((await db(SEALS)
        .where('verified_at', '>=', from)
        .orderBy('id', 'asc')
        .limit(400)
        .select(
          'id',
          'kind',
          'verified_at',
          'verified_ok',
          'from_seq',
          'last_seq',
          'last_id',
          'last_hash',
          'last_row_at',
          'mismatch_first_id',
          'acknowledged_at'
        )) as Array<Record<string, unknown>>)
    : []

  const sealedRows = rows.filter((r) => r.seq != null)
  const ok = sealedOn && !!walk && walk.mismatches.length === 0 && !walk.partial
  const verification = !sealedOn
    ? { status: 'not_sealed', detail: 'This database has no activity seals (migration 518).' }
    : !span
      ? { status: 'nothing_sealed_in_window' }
      : {
          status: walk?.partial ? 'incomplete' : ok ? 'intact' : 'broken',
          rows_walked: walk?.rows ?? 0,
          bridged_links: walk?.bridged ?? 0,
          mismatches: (walk?.mismatches ?? []).slice(0, 200).map((m) => ({
            id: m.id,
            seq: m.seq,
            reason: MISMATCH_TEXT[m.reason],
            in_window: mismatchesInWindow.includes(m)
          }))
        }
  const manifest: Record<string, unknown> = {
    kind: 'nivaro-activity-evidence',
    format: 1,
    generated_at: new Date().toISOString(),
    generated_by: opts.generatedBy,
    instance: opts.instance ?? null,
    window: { from: from.toISOString(), to: to.toISOString() },
    algorithm: {
      hash: 'sha256',
      link: 'seal_hash = hex(sha256(utf8(prev_hash) + utf8(canonical)))',
      genesis_prev_hash: GENESIS_HASH,
      canonical:
        'JSON object, keys in the listed order; timestamp ISO 8601 UTC; uuids lower-case; missing = null',
      canonical_columns: CANONICAL_COLUMNS,
      bridges:
        'When retention deleted an entry, the next entry is checked against the deleted entry’s hash (its prev_hash column shows it).'
    },
    anchor: {
      checkpoint_id: anchorCheckpoint,
      seq: anchor.seq,
      hash: anchor.hash
    },
    span: span
      ? {
          ...span,
          first_prev_hash: sealedRows[0]?.prev ?? null,
          last_hash: sealedRows[sealedRows.length - 1]?.hash ?? null
        }
      : null,
    rows: {
      in_window: total,
      sealed: sealedRows.length,
      unsealed: rows.length - sealedRows.length
    },
    verification,
    chain_head: head ? { seq: head.seq, id: head.id, hash: head.hash } : null,
    checkpoints,
    files: { 'entries.csv': sha(csv) } as Record<string, string>
  }

  const html = summaryHtml(manifest, total)
  const htmlBuf = Buffer.from(html, 'utf8')
  ;(manifest.files as Record<string, string>)['summary.html'] = sha(htmlBuf)
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  const stamp = `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`
  const zip = buildZip([
    { name: 'manifest.json', data: manifestBuf },
    { name: 'entries.csv', data: csv },
    { name: 'summary.html', data: htmlBuf }
  ])
  return {
    zip,
    filename: `activity-evidence_${stamp}.zip`,
    manifest,
    manifestSha256: sha(manifestBuf)
  }
}

function summaryHtml(m: Record<string, unknown>, total: number): string {
  const v = m.verification as Record<string, unknown>
  const status = String(v.status)
  const label =
    status === 'intact'
      ? 'Intact — every sealed entry in the window links to the one before it'
      : status === 'broken'
        ? 'Broken — at least one entry does not match its seal'
        : status === 'incomplete'
          ? 'Incomplete — the check ran out of time before the end of the window'
          : status === 'nothing_sealed_in_window'
            ? 'No sealed entries in this window yet'
            : 'This instance does not seal its activity log'
  const colour = status === 'intact' ? '#047857' : status === 'broken' ? '#b91c1c' : '#92400e'
  const w = m.window as { from: string; to: string }
  const rows = m.rows as { sealed: number; unsealed: number }
  const anchor = m.anchor as { checkpoint_id: number | null; seq: number; hash: string }
  const mismatches = (v.mismatches as Array<Record<string, unknown>> | undefined) ?? []
  const cps = (m.checkpoints as Array<Record<string, unknown>>) ?? []
  const by = m.generated_by as { name: string | null; id: string | null }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Activity evidence ${esc(w.from)} – ${esc(w.to)}</title>
<style>
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:40px;max-width:900px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.v{padding:12px 16px;border-radius:8px;border:1px solid ${colour};color:${colour};font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #e2e8f0;padding:4px 8px;text-align:left;vertical-align:top}
code{font:12px ui-monospace,Menlo,monospace;word-break:break-all}.muted{color:#64748b}
</style></head><body>
<h1>Activity log evidence</h1>
<p class="muted">${esc(w.from)} to ${esc(w.to)} · generated ${esc(m.generated_at)} by ${esc(by?.name ?? by?.id ?? 'unknown')}${m.instance ? ` · ${esc(m.instance)}` : ''}</p>
<p class="v">${esc(label)}</p>
<h2>What is in this bundle</h2>
<table><tr><th>Entries in the window</th><td>${total}</td></tr>
<tr><th>Sealed</th><td>${rows.sealed}</td></tr><tr><th>Not sealed yet</th><td>${rows.unsealed}</td></tr>
<tr><th>Links checked</th><td>${esc(v.rows_walked ?? '—')}</td></tr>
<tr><th>Links across retention purges</th><td>${esc(v.bridged_links ?? '—')}</td></tr>
<tr><th>Started from</th><td>${anchor.checkpoint_id ? `checkpoint ${anchor.checkpoint_id}` : 'the start of the trail'} · position ${anchor.seq}<br><code>${esc(anchor.hash)}</code></td></tr></table>
<h2>How to check it yourself</h2>
<p>For each row of <code>entries.csv</code> with a seal: <code>seal_hash = sha256(prev_hash + canonical)</code> (hex, UTF-8), and each row's <code>prev_hash</code> is the previous row's <code>seal_hash</code> unless retention removed the entry in between. <code>manifest.json</code> lists the canonical columns and the sha256 of every file.</p>
${
  mismatches.length
    ? `<h2>Entries that do not match</h2><table><tr><th>Entry</th><th>Position</th><th>Problem</th></tr>${mismatches
        .slice(0, 100)
        .map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.seq)}</td><td>${esc(x.reason)}</td></tr>`)
        .join('')}</table>`
    : ''
}
<h2>Chain heads recorded</h2>
${
  cps.length
    ? `<table><tr><th>Checked</th><th>Through position</th><th>Result</th><th>Head hash</th></tr>${cps
        .map(
          (c) =>
            `<tr><td>${esc(c.verified_at instanceof Date ? c.verified_at.toISOString() : c.verified_at)}</td><td>${esc(c.last_seq)}</td><td>${c.verified_ok ? 'intact' : c.acknowledged_at ? 'break acknowledged' : 'broken'}</td><td><code>${esc(String(c.last_hash ?? '').trim())}</code></td></tr>`
        )
        .join('')}</table>`
    : '<p class="muted">No checks were recorded from the start of the window until now.</p>'
}
</body></html>`
}

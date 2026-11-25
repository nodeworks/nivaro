import { db } from '../../../db/index.js'
import { csvRow } from '../../../lib/csv-cell.js'
import { firstLineScrubbed } from '../../ai-explain.js'
import { zipParts } from '../../zip-writer.js'
import { listBreakGlass } from './break-glass.js'
import { EVIDENCE_HEADER, evidenceCsv, hubNames, listReviews, reviewItems } from './reviews.js'
import { type IncidentRow, incidentsOf } from './seams.js'
import { listCerts } from './tls.js'
import { openFindings, pinnedImages, severityCounts } from './vuln.js'

/**
 * Compliance pack per app (Hub enhancement 42): one zip an auditor can be handed.
 *
 *   summary.pdf              one page per section (or summary.html when this Hub has no PDF
 *                            renderer: local Chromium or the render peer)
 *   deploys.csv              every promote / rollback / apply of the app's environments
 *   access-reviews.csv       every account of every access review (the review evidence)
 *   break-glass.csv          temporary admin requests, approvals, grants and revokes
 *   backups.csv              database + files backups and restore drills (data care runs)
 *   secret-rotations.csv     when each of the app's secrets was rotated, how and by whom
 *   incidents.csv            the app's incidents (when the incident feature is in this build)
 *   certificates.csv         certificate expiry + DNS state now
 *   vulnerabilities.csv      open findings of the images the app runs now
 *   README.txt               what each file is
 *
 * The pack NEVER carries a secret: no token, key, password, connection string, sealed value or
 * fingerprint is read — every query names its columns (never `*` on a table that holds one), and
 * a run's plan / artifact / keep set are never read. People are named by their Hub display name.
 * Covered: the last `months` months (1–36, default 12).
 */

const DAY = 86_400_000
/** The most rows one pack carries in all (413 PACK_TOO_BIG past it: ask for fewer months). */
export const PACK_MAX_ROWS = 50_000
/** And the most bytes (before the zip's few headers). */
export const PACK_MAX_BYTES = 48 * 1024 * 1024

export class PackTooBigError extends Error {
  statusCode = 413
  code = 'PACK_TOO_BIG'
}

/**
 * Error text of a deploy or data run, safe for an outside auditor (L4): its first line, secrets
 * masked (Bearer / key=value / long hex), then every URL, email, IP address, file path and host
 * name replaced by a placeholder, cut to 200 characters. Pure.
 */
export function auditorText(v: unknown): string {
  const line = firstLineScrubbed(v, 400)
  return line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>')
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[a-z]{2,}\b/gi, '<email>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
    .replace(/(^|[\s'"(=])(\/|[A-Za-z]:\\|\\\\)[^\s'")]+/g, '$1<path>')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:\d+)?\b/gi, '<host>')
    .slice(0, 200)
}

const iso = (v: unknown): string => {
  if (v == null || v === '') return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}
const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const csv = (header: string[], rows: unknown[][]) =>
  `${[csvRow(header), ...rows.map((r) => csvRow(r))].join('\r\n')}\r\n`

export interface PackDeps {
  now?: () => Date
  /** HTML → PDF (services/pdf-layout.ts htmlToPdf); a throw = no renderer here. */
  pdf?: (html: string) => Promise<Buffer>
}

export interface PackSection {
  title: string
  rows: number
  lines: string[]
}

export async function buildCompliancePack(
  appId: number,
  months: number,
  deps: PackDeps = {}
): Promise<{ filename: string; parts: Iterable<Buffer>; bytes: number; pdf: boolean }> {
  const now = (deps.now ?? (() => new Date()))()
  const since = new Date(now.getTime() - months * 30 * DAY)
  const app = (await db('nivaro_hub_apps').where({ id: appId }).first('id', 'key', 'name')) as
    | { id: number; key: string; name: string }
    | undefined
  if (!app) throw Object.assign(new Error('No such app'), { statusCode: 404, code: 'NOT_FOUND' })
  const envs = (await db('nivaro_hub_environments')
    .where({ app_id: appId })
    .select('id', 'key', 'status')) as Array<{ id: unknown; key: string; status: string }>
  const envIds = envs.map((e) => Number(e.id))
  const envKey = new Map(envs.map((e) => [Number(e.id), String(e.key)]))
  const ek = (id: unknown) => envKey.get(Number(id)) ?? String(id)

  // ─── Deploys ────────────────────────────────────────────────────────────────────────────
  const deploys = envIds.length
    ? ((await db('nivaro_hub_deploys')
        .whereIn('environment_id', envIds)
        .where('started_at', '>=', since)
        .orderBy('id', 'desc')
        .limit(5000)
        .select(
          'id',
          'environment_id',
          'kind',
          'version',
          'from_version',
          'status',
          'started_by',
          'started_at',
          'finished_at',
          'error'
        )) as Array<Record<string, unknown>>)
    : []

  // ─── Access reviews ─────────────────────────────────────────────────────────────────────
  const reviews = (await listReviews({ appIds: [appId], limit: 200 })).filter(
    (r) => !r.started_at || Date.parse(r.started_at) >= since.getTime()
  )
  const reviewCsvParts: string[] = []
  const reviewLines: string[] = []
  let reviewRows = 0
  for (const r of reviews) {
    const items = await reviewItems(r.id)
    reviewRows += items.length
    if (reviewRows > PACK_MAX_ROWS)
      throw new PackTooBigError('The access reviews alone are too many rows; ask for fewer months.')
    const people = await hubNames([r.started_by, r.completed_by, ...items.map((i) => i.decided_by)])
    const body = evidenceCsv(r, app.name || app.key, items, people)
    reviewCsvParts.push(reviewCsvParts.length ? body.slice(body.indexOf('\r\n') + 2) : body)
    const removed = items.filter((i) => i.removal_state === 'done' || i.removal_state === 'already')
    reviewLines.push(
      `Review ${r.id} (${r.status}) started ${iso(r.started_at).slice(0, 10)}: ${items.length} account(s), ${items.filter((i) => i.decision === 'keep').length} kept, ${removed.length} removed${r.completed_at ? `, completed ${iso(r.completed_at).slice(0, 10)} by ${people.get(String(r.completed_by).toUpperCase()) ?? 'an owner'}` : ''}`
    )
  }

  // ─── Break-glass ────────────────────────────────────────────────────────────────────────
  const grants = (await listBreakGlass({ appIds: [appId], limit: 200 })).filter(
    (g) => !g.created_at || Date.parse(g.created_at) >= since.getTime()
  )

  // ─── Backups and restore drills ─────────────────────────────────────────────────────────
  const dataRuns = envIds.length
    ? ((await db('nivaro_hub_data_runs')
        .whereIn('environment_id', envIds)
        .whereIn('kind', ['db_backup', 'backup_seen', 'files_backup', 'restore_drill'])
        .where('started_at', '>=', since)
        .orderBy('id', 'desc')
        .limit(5000)
        .select(
          'id',
          'kind',
          'environment_id',
          'status',
          'started_via',
          'started_by',
          'started_at',
          'finished_at',
          'error'
        )) as Array<Record<string, unknown>>)
    : []

  // ─── Secret rotations (refs + when + how; never a value or fingerprint) ─────────────────
  const refPatterns = [
    ...envIds.flatMap((id) => [`hub_token:${id}`, `app_key:${id}`, `oidc_client_secret:${id}`]),
    `app_oidc_secret:${appId}`
  ]
  const rotations = (await db('nivaro_hub_secret_rotations')
    .where((w) => {
      w.whereIn('ref', refPatterns)
      for (const id of envIds) w.orWhere('ref', 'like', `stack_secret:${id}:%`)
    })
    .where('rotated_at', '>=', since)
    .orderBy('rotated_at', 'desc')
    .limit(5000)
    .select('ref', 'kind', 'via', 'rotated_by', 'rotated_at', 'check_state')) as Array<
    Record<string, unknown>
  >

  // ─── Incidents (seam), certificates, vulnerabilities ────────────────────────────────────
  const incidents: IncidentRow[] = await incidentsOf(appId, since)
  const certs = await listCerts(envIds, now)
  const images = (await pinnedImages()).filter((i) =>
    i.environment_ids.some((e) => envIds.includes(e))
  )
  const findings = await openFindings(images.map((i) => i.digest))
  const envsOfDigest = new Map(images.map((i) => [i.digest, i.environment_ids]))

  const people = await hubNames([
    ...deploys.map((d) => d.started_by as string | null),
    ...dataRuns.map((d) => d.started_by as string | null),
    ...rotations.map((r) => r.rotated_by as string | null),
    ...grants.flatMap((g) => [g.requester_id, g.decided_by, g.revoked_by])
  ])
  const who = (id: unknown) =>
    id == null || id === '' ? '' : (people.get(String(id).toUpperCase()) ?? String(id))

  const totalRows =
    deploys.length +
    dataRuns.length +
    rotations.length +
    grants.length +
    incidents.length +
    certs.length +
    findings.length +
    reviewRows
  if (totalRows > PACK_MAX_ROWS)
    throw new PackTooBigError(
      `This pack would carry ${totalRows} rows (at most ${PACK_MAX_ROWS}); ask for fewer months.`
    )
  const files: Array<{ name: string; data: Buffer }> = []
  const put = (name: string, text: string) => files.push({ name, data: Buffer.from(text, 'utf8') })

  put(
    'deploys.csv',
    csv(
      [
        'id',
        'environment',
        'kind',
        'version',
        'from_version',
        'status',
        'started_by',
        'started_at',
        'finished_at',
        'error'
      ],
      deploys.map((d) => [
        d.id,
        ek(d.environment_id),
        d.kind,
        d.version,
        d.from_version,
        d.status,
        who(d.started_by),
        iso(d.started_at),
        iso(d.finished_at),
        d.error ? auditorText(d.error) : ''
      ])
    )
  )
  put(
    'access-reviews.csv',
    reviewCsvParts.length ? reviewCsvParts.join('') : `${csvRow(EVIDENCE_HEADER)}\r\n`
  )
  put(
    'break-glass.csv',
    csv(
      [
        'id',
        'environment',
        'requester',
        'hours',
        'reason',
        'status',
        'approved_by',
        'approval',
        'incident',
        'decided_at',
        'granted_at',
        'expires_at',
        'revoked_at',
        'ended_by',
        'end_reason'
      ],
      grants.map((g) => [
        g.id,
        ek(g.environment_id),
        who(g.requester_id),
        g.hours,
        g.reason,
        g.status,
        who(g.decided_by),
        g.approval_kind ?? '',
        g.incident_id ?? '',
        g.decided_at ?? '',
        g.granted_at ?? '',
        g.expires_at ?? '',
        g.revoked_at ?? '',
        who(g.revoked_by),
        g.revoke_reason ?? ''
      ])
    )
  )
  put(
    'backups.csv',
    csv(
      [
        'id',
        'kind',
        'environment',
        'status',
        'started_via',
        'started_by',
        'started_at',
        'finished_at',
        'error'
      ],
      dataRuns.map((r) => [
        r.id,
        r.kind,
        ek(r.environment_id),
        r.status,
        r.started_via,
        who(r.started_by),
        iso(r.started_at),
        iso(r.finished_at),
        r.error ? auditorText(r.error) : ''
      ])
    )
  )
  put(
    'secret-rotations.csv',
    csv(
      ['secret', 'kind', 'via', 'rotated_by', 'rotated_at', 'check'],
      rotations.map((r) => [
        r.ref,
        r.kind,
        r.via,
        who(r.rotated_by),
        iso(r.rotated_at),
        r.check_state
      ])
    )
  )
  put(
    'incidents.csv',
    csv(
      ['id', 'environment', 'title', 'severity', 'status', 'opened_at', 'resolved_at'],
      incidents.map((i) => [
        i.id,
        i.environment_id == null ? '' : ek(i.environment_id),
        i.title,
        i.severity,
        i.status,
        i.opened_at ?? '',
        i.resolved_at ?? ''
      ])
    )
  )
  put(
    'certificates.csv',
    csv(
      [
        'environment',
        'hostname',
        'state',
        'expires_at',
        'days_left',
        'issuer',
        'verifies',
        'dns',
        'error',
        'checked_at'
      ],
      certs.map((c) => [
        ek(c.environment_id),
        c.hostname,
        c.state,
        c.expires_at ?? '',
        c.days_left ?? '',
        c.issuer ?? '',
        c.authorized == null ? '' : c.authorized ? 'yes' : 'no',
        c.dns_ok == null ? '' : c.dns_ok ? 'ok' : 'fails',
        c.error_code ?? '',
        c.checked_at ?? ''
      ])
    )
  )
  put(
    'vulnerabilities.csv',
    csv(
      [
        'image',
        'environments',
        'id',
        'severity',
        'package',
        'installed',
        'fixed_in',
        'advisory',
        'first_seen',
        'last_seen'
      ],
      findings.map((f) => [
        f.image,
        (envsOfDigest.get(f.digest) ?? [])
          .filter((e) => envIds.includes(e))
          .map(ek)
          .join(' '),
        f.vuln_id,
        f.severity,
        f.package,
        f.installed ?? '',
        f.fixed_in ?? '',
        f.url ?? '',
        f.first_seen ?? '',
        f.last_seen ?? ''
      ])
    )
  )

  const sev = severityCounts(findings)
  const sections: PackSection[] = [
    {
      title: 'Deploys',
      rows: deploys.length,
      lines: [
        `${deploys.length} deploy(s); ${deploys.filter((d) => d.status === 'success').length} succeeded, ${deploys.filter((d) => d.status === 'failed').length} failed.`
      ]
    },
    {
      title: 'Access reviews',
      rows: reviews.length,
      lines: reviewLines.length ? reviewLines : ['No access review in this period.']
    },
    {
      title: 'Break-glass access',
      rows: grants.length,
      lines: grants.length
        ? grants
            .slice(0, 20)
            .map(
              (g) =>
                `#${g.id} ${ek(g.environment_id)}: ${who(g.requester_id)} asked ${g.hours} h — ${g.status}${g.decided_by ? `, approved by ${who(g.decided_by)}` : ''}`
            )
        : ['No break-glass access in this period.']
    },
    {
      title: 'Backups and restore drills',
      rows: dataRuns.length,
      lines: (['db_backup', 'files_backup', 'restore_drill'] as const).map((k) => {
        const list = dataRuns.filter((r) => r.kind === k)
        const ok = list.filter((r) => r.status === 'done')
        const last = ok[0]?.finished_at ?? ok[0]?.started_at
        const label =
          k === 'db_backup'
            ? 'Database backups'
            : k === 'files_backup'
              ? 'Files backups'
              : 'Restore drills'
        return `${label}: ${list.length} run(s), ${ok.length} done${last ? `, last ${iso(last).slice(0, 10)}` : ''}.`
      })
    },
    {
      title: 'Secret rotations',
      rows: rotations.length,
      lines: [`${rotations.length} rotation(s) recorded.`]
    },
    {
      title: 'Incidents',
      rows: incidents.length,
      lines: incidents.length
        ? incidents.slice(0, 20).map((i) => `#${i.id} ${i.severity} ${i.title} (${i.status})`)
        : ['No incident recorded in this period.']
    },
    {
      title: 'Certificates',
      rows: certs.length,
      lines: certs.length
        ? certs.map(
            (c) =>
              `${c.hostname} (${ek(c.environment_id)}): ${c.state}${c.expires_at ? `, expires ${c.expires_at.slice(0, 10)}` : ''}`
          )
        : ['No certificate checked yet.']
    },
    {
      title: 'Image vulnerabilities',
      rows: findings.length,
      lines: [
        `${images.length} pinned image(s); open findings — critical ${sev.critical}, high ${sev.high}, medium ${sev.medium}, low ${sev.low}, unknown ${sev.unknown}.`
      ]
    }
  ]
  const html = summaryHtml(app.name || app.key, now, since, sections)
  let pdf = false
  try {
    const render =
      deps.pdf ??
      (async (h: string) => (await import('../../pdf-layout.js')).htmlToPdf(h, { format: 'A4' }))
    files.unshift({ name: 'summary.pdf', data: await render(html) })
    pdf = true
  } catch {
    files.unshift({ name: 'summary.html', data: Buffer.from(html, 'utf8') })
  }
  put(
    'README.txt',
    [
      `Compliance pack — ${app.name || app.key}`,
      `Generated ${now.toISOString()} by the Nivaro Hub; covers ${since.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}.`,
      '',
      `${pdf ? 'summary.pdf' : 'summary.html'}  the overview, one section per file below`,
      'deploys.csv  promotes, rollbacks and applies of every environment',
      'access-reviews.csv  every account of every access review, its decision and removal',
      'break-glass.csv  temporary administrator access: who asked, who approved, when it ended',
      'backups.csv  database and files backups, restore drills',
      'secret-rotations.csv  when each secret was rotated and how (names only, never values)',
      'incidents.csv  incidents of the app',
      'certificates.csv  certificate expiry and DNS of every address, as last checked',
      'vulnerabilities.csv  open findings of the images the app runs now',
      '',
      'This pack carries no secret: no token, key, password or connection string.'
    ].join('\r\n')
  )
  const stamp = now.toISOString().slice(0, 10)
  const bytes = files.reduce((n, f) => n + f.data.length, 0)
  if (bytes > PACK_MAX_BYTES)
    throw new PackTooBigError('This pack is too big to build; ask for fewer months.')
  return { filename: `compliance-${app.key}-${stamp}.zip`, parts: zipParts(files), bytes, pdf }
}

/** The summary page (light, A4, every value escaped). Pure. */
export function summaryHtml(app: string, now: Date, since: Date, sections: PackSection[]): string {
  const body = sections
    .map(
      (s) =>
        `<section><h2>${esc(s.title)} <span class="n">${s.rows}</span></h2><ul>${s.lines
          .map((l) => `<li>${esc(l)}</li>`)
          .join('')}</ul></section>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Compliance pack — ${esc(app)}</title><style>
body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;margin:32px;font-size:12px;color-scheme:light}
h1{font-size:20px;margin:0 0 4px}p.meta{color:#475569;margin:0 0 24px}
section{break-inside:avoid;border-top:1px solid #e2e8f0;padding:12px 0}
h2{font-size:14px;margin:0 0 6px}span.n{color:#64748b;font-weight:400;font-size:12px;margin-left:6px}
ul{margin:0;padding-left:18px}li{margin:2px 0}
footer{margin-top:24px;color:#64748b;font-size:11px}
</style></head><body><h1>Compliance pack — ${esc(app)}</h1><p class="meta">Generated ${esc(now.toISOString())} · covers ${esc(since.toISOString().slice(0, 10))} to ${esc(now.toISOString().slice(0, 10))}</p>${body}<footer>Detail in the CSV files of this pack. No secret is included.</footer></body></html>`
}

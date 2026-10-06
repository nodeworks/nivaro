import type { DocSection } from '../types.js'

export const qualityChecksDocs: DocSection = {
  id: 'quality-checks',
  label: 'Staging quality checks',
  content: [
    { type: 'h1', id: 'quality-checks', text: 'Staging quality checks' },
    {
      type: 'p',
      text: 'After a staging database is rebuilt from production, quality checks compare what the conversions produced with what production held. They answer one question: did the conversion change anything it should not have?'
    },
    { type: 'h2', id: 'quality-checks-how', text: 'What the checks compare' },
    {
      type: 'p',
      text: 'Each check returns a list of keyed rows. A row is a stable key, an optional label and a set of values. The same check runs twice: once on the fresh clone, before anything is converted (the baseline), and once after the conversions (the current shape). The two lists are compared key by key.'
    },
    {
      type: 'p',
      text: 'The baseline is a snapshot of the clone. Nothing reads production while the checks run, and the snapshot is stored with the run, so a later run is never compared with a newer production.'
    },
    {
      type: 'ul',
      items: [
        'A key in both lists with equal values matches.',
        'A key in both lists with different values is a mismatch.',
        'A key only in the baseline, or only in the current list, is a mismatch too.',
        'A list check has an empty baseline. Every current row is then a finding.'
      ]
    },
    { type: 'h2', id: 'quality-checks-phases', text: 'The rebuild phases' },
    {
      type: 'p',
      text: 'A staging rebuild runs seven phases. Quality checks take part in three of them.'
    },
    {
      type: 'table',
      head: ['Phase', 'What happens'],
      rows: [
        ['refresh', 'The database is restored from production.'],
        ['capture', 'Every check runs its baseline query on the fresh clone. The rows are stored.'],
        ['migrate', 'Nivaro migrations run.'],
        ['promote', 'Configuration is copied from the development database.'],
        ['schema', 'Business tables, indexes and procedures are brought in line.'],
        ['convert', 'The data conversions run.'],
        ['verify', 'Every check runs its current query and is compared with the baseline.']
      ]
    },
    { type: 'h2', id: 'quality-checks-colours', text: 'Colours' },
    {
      type: 'table',
      head: ['Colour', 'Meaning'],
      rows: [
        ['Green', 'Every compared row is equal.'],
        ['Amber', 'Rows differ, and every difference is expected.'],
        ['Red', 'At least one difference is not expected. Look at it.'],
        ['Error', 'The check could not run or ran out of its time budget. It says why.']
      ]
    },
    {
      type: 'p',
      text: 'The Staging quality checks page lists the checks of the latest run by area. Open a check to see its clusters (mismatches grouped by the dimensions the check declares, such as state or zone) and the mismatch rows. A row links to the record in production when the deployment configures a legacy link.'
    },
    { type: 'h2', id: 'quality-checks-known', text: 'Known differences' },
    {
      type: 'p',
      text: 'Some differences are deliberate. Use Mark as expected on a mismatch row, or on a whole cluster, and give a reason. The difference then reads amber instead of red in every later run.'
    },
    {
      type: 'ul',
      items: [
        "A known difference belongs to one check and matches rows by their key or cluster. A key pattern may use * for any run of characters, up to four times. Mark as expected on a row names that row's key exactly, * included.",
        'The Known differences tab lists them with the reason, who added it and how many rows it matched last time.',
        'A known difference that matches nothing for 3 runs in a row is marked stale. It is kept until someone removes it.',
        'Known differences are configuration. They are copied with the rest of the configuration.'
      ]
    },
    { type: 'h2', id: 'quality-checks-rerun', text: 'Re-run quality checks' },
    {
      type: 'p',
      text: 'Re-run checks starts the read-only check runbook on the host without rebuilding anything. It runs the verify phase again against the current database, using the baseline of the latest run. It skips the dry-run gate that other host runbooks require, because it writes nothing outside the results tables. It refuses to start while a rebuild of the same database is running. The button queues only the runbook the extension that supplies the checks declares for it (`quality_rerun`), and only when that runbook runs on the host and declares `skip_dry_gate`.'
    },
    { type: 'h2', id: 'quality-checks-csv', text: 'CSV export' },
    {
      type: 'p',
      text: 'Each check can be downloaded as CSV: one line per mismatch row, with the key, label, status, whether it is expected, the differing fields, the baseline and current values, and the reason. Cells that begin with a formula character are neutralised so the file is safe to open in a spreadsheet.'
    },
    { type: 'h2', id: 'quality-checks-report-only', text: 'Report-only' },
    {
      type: 'note',
      text: 'Red never fails a rebuild. The checks report. They do not block a phase, stop a chain or change data. A check that fails to run is recorded as an error and the rest continue.'
    },
    { type: 'h2', id: 'quality-checks-storage', text: 'Where results live' },
    {
      type: 'p',
      text: 'Four tables, created by migration 404, in the application database:'
    },
    {
      type: 'ul',
      items: [
        '`nivaro_quality_runs` — one row per capture and verify cycle for a target, with status, times and totals.',
        '`nivaro_quality_rows` — per check and side (baseline, current, diff) the row list, compressed.',
        '`nivaro_quality_results` — per check verdict, counts, clusters and up to 500 sample rows.',
        '`nivaro_quality_known` — the known differences.'
      ]
    },
    {
      type: 'p',
      text: 'Runs, rows and results are per database and are not promoted between environments. Old runs are pruned. The results database must not be the production database or the target itself; the runner refuses both.'
    },
    {
      type: 'h2',
      id: 'quality-checks-authors',
      text: 'For extension authors'
    },
    {
      type: 'p',
      text: 'An extension supplies its own checks. Its default export names a module in `quality_checks`, a path from the API root inside the extension folder. That module exports the checks as `default` or `qualityChecks`, both arrays of `QualityCheck`.'
    },
    {
      type: 'pre',
      code: `// extensions/my-ext/index.ts
export default {
  id: 'my-ext',
  quality_checks: 'extensions/my-ext/quality/checks.ts',
  // Optional: the key of one of its own host runbooks (runs_on 'host',
  // skip_dry_gate) that re-runs the checks; the console's Re-run queues it.
  quality_rerun: 'checks-rerun',
  async register(ctx) {}
}

// extensions/my-ext/quality/checks.ts
import type { QualityCheck } from '@nivaro/extension-kit'

export const qualityChecks: QualityCheck[] = [
  {
    id: 'orders.totals',
    area: 'counts',
    label: 'Order totals per month',
    description: 'Sum of order amounts per month',
    budgetMs: 120_000,
    tolerance: { abs: 0.01 },
    async baseline({ db }) {
      const rows = await db('orders_legacy').select('month').sum({ total: 'amount' }).groupBy('month')
      return rows.map((r) => ({ key: \`month:\${r.month}\`, values: { total: Number(r.total) } }))
    },
    async current({ db }) {
      const rows = await db('orders').select('month').sum({ total: 'amount' }).groupBy('month')
      return rows.map((r) => ({ key: \`month:\${r.month}\`, values: { total: Number(r.total) } }))
    }
  }
]`
    },
    {
      type: 'table',
      head: ['Field', 'Meaning'],
      rows: [
        [
          '`id`',
          'Lower case, starts with a letter, 2 to 81 characters from a-z, 0-9, dot, dash and underscore.'
        ],
        [
          '`area`',
          'Groups the check on the page, for example counts, people, history, states, forecasts, lines, po, owners, budget.'
        ],
        ['`label`, `description`', 'What the check is called and what it measures.'],
        [
          '`baseline(ctx)`',
          'Legacy shape, run on the fresh clone before migrations. Returns `QualityRow[]`. A list check returns `[]`.'
        ],
        ['`current(ctx)`', 'Converted shape, run after the conversions. Returns `QualityRow[]`.'],
        [
          '`budgetMs`',
          'Time budget per side in milliseconds. Default 180000. A check over budget is recorded as an error.'
        ],
        [
          '`tolerance`',
          '`{ abs?, pct? }`. Numbers within it are equal. Without it values compare exactly, after rounding to 4 decimals.'
        ],
        [
          '`expected(base, cur, fields)`',
          'Returns a reason when this mismatch is expected, else null. The row then reads amber.'
        ],
        [
          '`explain(base, cur, fields)`',
          'Returns a plain sentence for an unexpected mismatch, or null.'
        ],
        [
          '`legacyLink(key)`',
          'Returns an absolute URL to the record in the legacy system, or undefined.'
        ]
      ]
    },
    {
      type: 'table',
      head: ['QualityRow field', 'Meaning'],
      rows: [
        [
          '`key`',
          'Stable identity, such as `workflow:371367`. The same record must give the same key on both sides.'
        ],
        ['`label`', 'Optional human label for the key.'],
        [
          '`values`',
          'The compared values: string, number, boolean or null. Null and the empty string are equal.'
        ],
        [
          '`cluster`',
          'Grouping dimensions for mismatch clusters, such as `{ state: "Waiting on PO" }`.'
        ],
        [
          '`context`',
          'Facts carried for `expected()` and `explain()`. Stored with the row. Never compared and never grouped.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'A check receives `ctx.db`, a connection to the database being checked with a long request timeout, `ctx.database` (its name) and `ctx.log(message)`. Keep checks read-only. A check that throws is recorded as an error and does not stop the others.'
    }
  ]
}

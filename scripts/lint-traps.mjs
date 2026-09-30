#!/usr/bin/env node
/**
 * Known-trap lint (#727) + migration dialect lint (#757).
 *
 * Every rule here is a mistake that has already cost a working session on
 * this codebase (see docs/claude/gotchas.md). The check is text-based on
 * purpose: fast, dependency-free, and good enough for shapes this specific.
 *
 *   node scripts/lint-traps.mjs            report + exit 1 on any finding
 *   node scripts/lint-traps.mjs --json     machine-readable findings
 *
 * Silence one line with a `lint-traps-ok: <reason>` comment on that line or
 * the line above it. Migrations that already ran with T-SQL and no dialect
 * guard are listed in MIGRATION_BASELINE (reviewed 2026-09-30) so only new
 * ones fail; see nivaro-cloud CLAUDE.md for what they mean for other dialects.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const JSON_OUT = process.argv.includes('--json')

const CODE_DIRS = ['api/src', 'api/extensions', 'packages/shared/src', 'packages/react/src', 'packages/sdk/src', 'admin/src', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.vite', 'coverage', 'test-results'])
const CODE_EXT = /\.(ts|tsx|mjs|js)$/
const SHELL_FILES = /\.(sh|ya?ml|md)$|package\.json$/

/** Migrations with T-SQL and no dialect guard that already ran everywhere. */
const MIGRATION_BASELINE = new Set([
  '095_assignment_multi_group.ts',
  '142_issue_error_tracking.ts',
  '159_revisions_activity_indexes.ts',
  '181_policy_lookup_index.ts',
  '182_import_queue.ts',
  '227_config_conformance.ts',
  '305_notification_delivery.ts',
  '309_api_log_detail.ts',
  '336_drop_dead_columns.ts',
  '343_integration_obligations.ts',
  '344_integration_obligations_epoch.ts',
  '370_chat_program.ts',
  '376_import_definition_ops.ts'
])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const findings = []
function add(file, line, rule, message) {
  findings.push({ file: relative(ROOT, file), line, rule, message })
}

function suppressed(lines, i) {
  return /lint-traps-ok/.test(lines[i] ?? '') || /lint-traps-ok/.test(lines[i - 1] ?? '')
}
/** True when column `col` of `line` sits inside a // or block-comment line. */
function inComment(line, col) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return true
  const slash = line.indexOf('//')
  return slash >= 0 && slash < col
}
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** True when a `?` sits inside a single-quoted SQL literal ('' is an escaped
 *  quote; `${…}` interpolations are skipped, their text is not SQL). */
function questionInsideSqlString(sql) {
  const src = sql.replace(/\$\{[^}]*\}/g, '')
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "'") {
      if (inStr && src[i + 1] === "'") {
        i++
        continue
      }
      inStr = !inStr
    } else if (c === '?' && inStr && src[i - 1] !== '\\') return true
  }
  return false
}

// ── code rules ────────────────────────────────────────────────────────────────
function checkCode(file, text) {
  const lines = text.split('\n')
  const isSelf = file.endsWith('lint-traps.mjs')
  if (isSelf) return

  // 1. .distinct(x).pluck(x) on mssql returns nested arrays.
  for (const m of text.matchAll(/\.distinct\([^)\s][^)]*\)\s*\.pluck\(/g)) {
    const ln = lineOf(text, m.index)
    if (!inComment(lines[ln - 1], m.index - text.lastIndexOf('\n', m.index) - 1) && !suppressed(lines, ln - 1))
      add(file, ln, 'distinct-pluck', '.distinct(x).pluck(x) returns nested arrays on mssql — map .distinct() rows explicitly')
  }

  // 2. acquireConnection() whose release is not in a finally wrapping it.
  lines.forEach((l, i) => {
    if (!/acquireConnection\(\)/.test(l) || /^\s*(\/\/|\*)/.test(l) || suppressed(lines, i)) return
    // Safe when the next `try {` follows with no await in between (nothing can
    // throw or yield before the try owns the connection) and a finally after
    // it releases the connection.
    const before = lines.slice(Math.max(0, i - 3), i).join('\n')
    const after = lines.slice(i + 1, i + 120).join('\n')
    const tryAt = after.search(/\btry\s*\{/)
    const gapClean = tryAt >= 0 && !/\bawait\b|\bthrow\b/.test(after.slice(0, tryAt))
    const wrappedAbove = /\btry\s*\{\s*$/.test(before)
    const hasFinallyRelease = /finally\s*\{[\s\S]{0,600}releaseConnection/.test(after)
    if (!(gapClean || wrappedAbove) || !hasFinallyRelease)
      add(file, i + 1, 'acquire-release', 'acquireConnection() must sit next to a try whose finally releases it — a skipped branch leaks a pool connection')
  })

  // 3. `const [x] = await ….returning('id')` used without normalising the
  //    object mssql hands back.
  for (const m of text.matchAll(/const\s*\[\s*(\w+)\s*\]\s*=\s*await[\s\S]{0,400}?\.returning\(\s*['"]id['"]\s*\)/g)) {
    const name = m[1]
    const ln = lineOf(text, m.index)
    const endLn = lineOf(text, m.index + m[0].length)
    const follow = lines.slice(ln - 1, endLn + 14).join('\n')
    const normalised = new RegExp(`typeof\\s+${name}\\b|${name}\\??\\.id\\b|normali[sz]e\\w*\\(\\s*${name}`).test(follow)
    if (!normalised && !suppressed(lines, ln - 1))
      add(file, ln, 'returning-id', `.returning('id') yields an object on mssql — read ${name}.id (or check typeof) before using it as an id`)
  }

  // 4. A literal ? inside a quoted SQL string in knex.raw is taken as a binding.
  for (const m of text.matchAll(/\.raw\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
    const sql = m[1].slice(1, -1)
    if (questionInsideSqlString(sql)) {
      const ln = lineOf(text, m.index)
      if (!suppressed(lines, ln - 1))
        add(file, ln, 'raw-literal-question', 'a literal ? inside a quoted string in knex.raw is read as a binding — escape it as \\? or pass the value as a binding')
    }
  }

  // 5. A modal rendered inside <HeaderTools> disappears when the header folds.
  if (/\.tsx$/.test(file)) {
    for (const m of text.matchAll(/<HeaderTools\b[\s\S]*?<\/HeaderTools>/g)) {
      for (const d of m[0].matchAll(/<(\w*(?:Dialog|Sheet|Modal))\b/g)) {
        if (d[1] === 'DialogTrigger' || d[1] === 'SheetTrigger') continue
        const ln = lineOf(text, m.index + d.index)
        if (!suppressed(lines, ln - 1))
          add(file, ln, 'modal-in-headertools', `<${d[1]}> inside <HeaderTools> is unmounted when the header folds into ⋯ — render it after the header block`)
      }
    }
  }
}

// ── shell / docs rule ───────────────────────────────────────────────────────
function checkShell(file, text) {
  const lines = text.split('\n')
  lines.forEach((l, i) => {
    // 6. `tsc | head && echo OK` reports OK on failure (head's exit code wins).
    if (/\btsc\b[^|\n]*\|\s*(head|tail)\b[^\n]*&&/.test(l) && !suppressed(lines, i))
      add(file, i + 1, 'tsc-pipe', "`tsc … | head && …` takes head's exit code — a failing typecheck reads as OK; check tsc's own status")
  })
}

// ── migrations (#757) ─────────────────────────────────────────────────────────
const TSQL = /sys\.(tables|columns|indexes|index_columns|foreign_keys|foreign_key_columns|objects|procedures|sql_modules|default_constraints)\b|runLongSql|NVARCHAR\s*\(\s*MAX\s*\)|GETUTCDATE|GETDATE\s*\(\)|sp_executesql|OBJECT_ID\s*\(|IDENTITY_INSERT|CROSS APPLY|FOR JSON|TRY_CAST|TRY_CONVERT|QUOTENAME|CREATE OR ALTER|sp_rename|sp_getapplock/
const GUARD = /isMssql\(|client\.config\??\.client|dbClient|['"]mssql['"]/

function checkMigrations() {
  const dir = join(ROOT, 'api/src/db/migrations')
  for (const name of readdirSync(dir).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'))) {
    const file = join(dir, name)
    const text = readFileSync(file, 'utf8')
    // #749 — knex.fn.now() is the server's LOCAL clock on SQL Server; new
    // migrations default timestamps with utcNow() from db/dialect.ts.
    const num = Number.parseInt(name, 10)
    const now = text.match(/\bfn\.now\(\)/)
    if (now && num > 378) {
      const ln = lineOf(text, now.index)
      if (!suppressed(text.split('\n'), ln - 1))
        add(file, ln, 'migration-local-now', 'knex.fn.now() defaults to the server LOCAL clock on SQL Server — use utcNow(knex) from db/dialect.ts')
    }
    const m = text.match(TSQL)
    if (!m || GUARD.test(text) || MIGRATION_BASELINE.has(name)) continue
    add(file, lineOf(text, m.index), 'migration-dialect', `T-SQL (${m[0]}) with no dialect guard — wrap it in \`if (isMssql(knex))\` from db/dialect.ts so a Postgres / MySQL tenant does not fail here`)
  }
}

for (const d of CODE_DIRS) {
  for (const f of walk(join(ROOT, d))) {
    if (CODE_EXT.test(f) && !/\.d\.ts$/.test(f)) checkCode(f, readFileSync(f, 'utf8'))
    if (SHELL_FILES.test(f)) checkShell(f, readFileSync(f, 'utf8'))
  }
}
for (const f of ['package.json', 'api/package.json', 'admin/package.json', 'CLAUDE.md', ...walk(join(ROOT, '.github'))])
  try {
    checkShell(join(ROOT, f.startsWith(ROOT) ? relative(ROOT, f) : f), readFileSync(f.startsWith(ROOT) ? f : join(ROOT, f), 'utf8'))
  } catch {}
checkMigrations()

if (JSON_OUT) {
  console.log(JSON.stringify(findings, null, 2))
} else if (findings.length === 0) {
  console.log('lint:traps — no known traps found')
} else {
  const byRule = {}
  for (const f of findings) (byRule[f.rule] ??= []).push(f)
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`\n${rule} (${list.length})`)
    for (const f of list) console.log(`  ${f.file}:${f.line}  ${f.message}`)
  }
  console.log(`\nlint:traps — ${findings.length} finding${findings.length === 1 ? '' : 's'}`)
}
process.exit(findings.length ? 1 : 0)

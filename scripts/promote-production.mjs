#!/usr/bin/env node
/**
 * promote-production — move a version staging already runs to production.
 *
 * The release chain ends at staging. Production is a separate, deliberate
 * step: pick a version staging verified, pin it, push the production branch
 * of the deployment repository, and wait until production answers with it.
 *
 *   node scripts/promote-production.mjs --version 0.2.9          print the plan
 *   node scripts/promote-production.mjs --version 0.2.9 --go     run it
 *   … --events                                                    @@plan / @@event lines
 *
 * Stages: check → push → verify.
 *
 *   check   the image tag exists on the registry; the deployment commit that
 *           took this version to staging exists on the source branch; staging
 *           answered with it (now, or in a finished release run); production
 *           does not already run it.
 *   push    in a throwaway git worktree (the checkout on disk is never
 *           touched): start from origin/<production branch> (or the source
 *           commit when the branch does not exist yet), merge the source
 *           commit, write the version into the pin file, commit, push.
 *   verify  poll every production verify URL until it answers with the
 *           version twice in a row.
 *
 * Configuration: the `production` block of release-chain.config.json —
 *
 *   "production": {
 *     "name": "efp-nivaro (production)",
 *     "path": "~/code/deploy",          same checkout as the staging deployment
 *     "source_branch": "main",          the branch staging deploys from
 *     "branch": "production",           the branch production deploys from
 *     "pin_file": ".docker/nivaro-version",
 *     "verify": [{ "name": "production api", "url": "https://…/api/version", "field": "version" }]
 *   }
 *
 * The production pipeline must read the pin file (NIVARO_VERSION=$(cat …)),
 * or it deploys :latest and the pin means nothing.
 *
 * Ends with `### DONE — promoted <version>` or `### FAILED at <stage>: …`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : d
}
const GO = flag('go')
const EVENTS = flag('events')
const VERSION = opt('version', null)

const emit = (stage, status, detail) => {
  if (!EVENTS) return
  const e = { stage, status, at: new Date().toISOString() }
  if (detail) e.detail = String(detail).slice(0, 500)
  console.log(`@@event ${JSON.stringify(e)}`)
}
const log = (msg) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expand = (p) => resolve(p.startsWith('~') ? p.replace(/^~/, homedir()) : p)

class StageError extends Error {}
let currentStage = 'check'

function sh(cmd, args, { cwd = ROOT, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (res.status !== 0 && !allowFail) {
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
    if (out) console.log(out)
    throw new StageError(`\`${cmd} ${args.join(' ')}\` exited ${res.status}`)
  }
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() }
}
const git = (args, cwd) => sh('git', args, { cwd }).stdout

/** curl, not fetch: node's fetch rejects the corporate-signed certificates. */
function probe(url, field) {
  try {
    const body = JSON.parse(
      execFileSync('curl', ['-sS', '-m', '10', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    )
    return { value: body?.[field ?? 'version'] ?? null, error: null }
  } catch (err) {
    return { value: null, error: String(err?.stderr || err?.message || err).trim().split('\n')[0] }
  }
}

async function imageExists(image, tag) {
  const [ns, name] = image.split('/')
  const res = await fetch(`https://hub.docker.com/v2/repositories/${ns}/${name}/tags/${tag}`, {
    signal: AbortSignal.timeout(15_000)
  }).catch(() => null)
  return res?.status === 200
}

function loadConfig() {
  const path = resolve(ROOT, 'release-chain.config.json')
  if (!existsSync(path)) throw new StageError('no release-chain.config.json')
  const c = JSON.parse(readFileSync(path, 'utf8'))
  if (!c.production) throw new StageError('release-chain.config.json has no "production" block')
  const p = c.production
  return {
    image: c.image ?? null,
    stagingVerify: (c.verify ?? []).filter((v) => !v.expect),
    production: {
      name: p.name ?? 'production',
      path: expand(p.path),
      sourceBranch: p.source_branch ?? 'main',
      branch: p.branch ?? 'production',
      pinFile: p.pin_file ?? '.docker/nivaro-version',
      verify: p.verify ?? []
    }
  }
}

/** Versions a finished release run verified on staging. The card's runs are
 *  on disk: a record (args) + its log (### DONE — nivaro x.y.z). A run that
 *  skipped verify proves nothing about staging. */
function verifiedByRuns() {
  const dir = resolve(ROOT, '.release-runs')
  const out = []
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'current.json')
  } catch {
    return out
  }
  for (const n of names) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), 'utf8'))
      if (rec.mode !== 'go' || (rec.args ?? []).includes('--skip-verify')) continue
      const text = readFileSync(join(dir, n.replace(/\.json$/, '.log')), 'utf8')
      const m = text.match(/^### DONE — nivaro (\S+)/m)
      if (m) out.push(m[1])
    } catch {}
  }
  return [...new Set(out)]
}

const semverCmp = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** The deployment commit that took `version` to staging. */
function sourceCommit(cfg, version) {
  const cwd = cfg.production.path
  sh('git', ['fetch', 'origin'], { cwd, allowFail: true })
  const ref = `origin/${cfg.production.sourceBranch}`
  const escaped = version.replace(/\./g, '\\.')
  const sha = sh(
    'git',
    ['log', ref, '-E', `--grep=nivaro ${escaped}$`, '-1', '--format=%H %s'],
    { cwd, allowFail: true }
  ).stdout
  if (!sha) return null
  const [hash, ...rest] = sha.split(' ')
  return { hash, subject: rest.join(' ') }
}

/** Migrations shipped between two app tags in this repository. */
function migrationsBetween(from, to) {
  if (!from) return []
  const a = `v${String(from).replace(/^v/, '')}`
  const b = `v${String(to).replace(/^v/, '')}`
  const res = sh('git', ['diff', '--name-only', `${a}..${b}`, '--', 'api/src/db/migrations'], { allowFail: true })
  return res.stdout.split('\n').filter((f) => /\d+_.*\.ts$/.test(f))
}

async function main() {
  if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) throw new StageError('--version x.y.z is required')
  const cfg = loadConfig()
  const prod = cfg.production

  // ── plan ────────────────────────────────────────────────────────────────
  const staging = cfg.stagingVerify.map((v) => ({ name: v.name, ...probe(v.url, v.field) }))
  const production = prod.verify.map((v) => ({ name: v.name, ...probe(v.url, v.field) }))
  const prodVersion = production.find((p) => p.value)?.value ?? null
  const verifiedRuns = verifiedByRuns()
  const stagingNow = staging.some((s) => s.value === VERSION)
  const source = sourceCommit(cfg, VERSION)
  const migrations = migrationsBetween(prodVersion, VERSION)
  const image = cfg.image ? await imageExists(cfg.image, VERSION) : null
  const blockers = []
  if (image === false) blockers.push(`${cfg.image}:${VERSION} is not on the registry`)
  if (!source) blockers.push(`no commit on ${prod.sourceBranch} deployed nivaro ${VERSION} to staging`)
  if (!stagingNow && !verifiedRuns.includes(VERSION))
    blockers.push(`staging never answered with ${VERSION} — neither now nor in a finished release run`)
  if (prodVersion === VERSION) blockers.push(`production already runs ${VERSION}`)
  if (prodVersion && semverCmp(VERSION, prodVersion) < 0)
    blockers.push(`${VERSION} is older than production's ${prodVersion} — a rollback, not a promotion`)

  const plan = {
    version: VERSION,
    target: prod.name,
    production_version: prodVersion,
    production_probe: production,
    staging_probe: staging,
    staging_now: stagingNow,
    verified_by_run: verifiedRuns.includes(VERSION),
    source_commit: source,
    image_on_registry: image,
    migrations,
    pin_file: prod.pinFile,
    branch: prod.branch,
    blockers,
    lines: [
      { stage: 'check', text: `image ${cfg.image ?? '(none configured)'}:${VERSION} ${image === false ? 'MISSING' : 'present'}; staging ${stagingNow ? 'runs it now' : verifiedRuns.includes(VERSION) ? 'verified it in a finished release run' : 'never answered with it'}` },
      { stage: 'check', text: source ? `source commit ${source.hash.slice(0, 8)} — ${source.subject}` : `no deploy commit for ${VERSION} on ${prod.sourceBranch}` },
      { stage: 'push', text: `merge it into ${prod.branch}, write ${VERSION} into ${prod.pinFile}, push (in a throwaway worktree)` },
      ...prod.verify.map((v) => ({ stage: 'verify', text: `${v.name}: poll ${v.url} until it answers ${VERSION} twice` })),
      ...(!prodVersion ? [{ stage: 'check', text: 'production did not answer — cannot list the migrations its first boot on this version will run' }] : []),
      ...(migrations.length ? [{ stage: 'check', text: `${migrations.length} migration(s) run on production at boot: ${migrations.map((m) => m.split('/').pop()).join(', ')}` }] : [])
    ]
  }

  console.log(`\npromote-production — ${VERSION} → ${prod.name}${GO ? '' : '   (plan only — pass --go)'}`)
  console.log(`  production runs ${prodVersion ?? '(unreachable)'} · staging ${staging.map((s) => `${s.name}=${s.value ?? s.error ?? '?'}`).join(', ') || '(no verify URL)'}`)
  for (const l of plan.lines) console.log(`  ${l.stage.padEnd(6)} · ${l.text}`)
  for (const b of blockers) console.log(`  BLOCKED · ${b}`)
  console.log('')
  if (EVENTS) console.log(`@@plan ${JSON.stringify(plan)}`)
  if (!GO) return

  try {
    currentStage = 'check'
    emit('check', 'start')
    if (blockers.length) throw new StageError(blockers.join('; '))
    emit('check', 'ok')

    currentStage = 'push'
    emit('push', 'start')
    const cwd = prod.path
    const hasBranch = sh('git', ['rev-parse', '--verify', '--quiet', `origin/${prod.branch}`], { cwd, allowFail: true }).ok
    const tmp = mkdtempSync(join(tmpdir(), 'promote-'))
    try {
      git(['worktree', 'add', '--detach', tmp, hasBranch ? `origin/${prod.branch}` : source.hash], cwd)
      if (hasBranch) {
        log(`merging ${source.hash.slice(0, 8)} into ${prod.branch}`)
        sh('git', ['merge', '--no-edit', '-m', `merge: nivaro ${VERSION} from ${prod.sourceBranch}`, source.hash], { cwd: tmp })
      }
      const pinPath = join(tmp, prod.pinFile)
      writeFileSync(pinPath, `${VERSION}\n`)
      git(['add', prod.pinFile], tmp)
      const staged = sh('git', ['diff', '--cached', '--quiet'], { cwd: tmp, allowFail: true })
      if (!staged.ok) git(['commit', '-q', '-m', `chore: promote nivaro ${VERSION} to production`], tmp)
      else git(['commit', '-q', '--allow-empty', '-m', `chore: promote nivaro ${VERSION} to production`], tmp)
      sh('git', ['push', 'origin', `HEAD:refs/heads/${prod.branch}`], { cwd: tmp })
      log(`pushed ${git(['rev-parse', '--short=8', 'HEAD'], tmp)} to ${prod.branch}`)
    } finally {
      sh('git', ['worktree', 'remove', '--force', tmp], { cwd, allowFail: true })
      rmSync(tmp, { recursive: true, force: true })
    }
    emit('push', 'ok')

    currentStage = 'verify'
    emit('verify', 'start')
    for (const v of prod.verify) {
      let streak = 0
      for (let i = 1; ; i++) {
        const r = probe(v.url, v.field)
        streak = r.value === VERSION ? streak + 1 : 0
        if (streak >= 2) break
        if (i >= 120) throw new StageError(`${v.name} never answered ${VERSION} (last: ${r.value ?? r.error})`)
        emit('verify', 'progress', `${v.name}: ${r.value ?? r.error ?? 'no answer'} (${i}/120)`)
        await sleep(15_000)
      }
    }
    emit('verify', 'ok')
    console.log(`\n### DONE — promoted ${VERSION}\n`)
  } catch (err) {
    emit(currentStage, 'fail', err instanceof Error ? err.message : String(err))
    console.log(`\n### FAILED at ${currentStage}: ${err instanceof Error ? err.message : err}\n`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.log(`\n### FAILED before starting: ${err instanceof Error ? err.message : err}\n`)
  process.exitCode = 1
})


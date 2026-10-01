#!/usr/bin/env node
/**
 * promote-production — move a version staging already runs to production.
 *
 * The release chain ends at staging. Production is a separate, deliberate
 * step: pick a version staging verified, pin it, push the production branches,
 * run the production deploy jobs in order, and judge each by its result.
 *
 *   node scripts/promote-production.mjs --version 0.2.9          print the plan
 *   node scripts/promote-production.mjs --version 0.2.9 --go     run it
 *   … --bootstrap     the FIRST production deploy: the API deploy runs with
 *                     GATE_MODE=bootstrap (no gate account exists before its
 *                     canary has run the migrations)
 *   … --events        @@plan / @@event lines
 *
 * Stages: check → push → deploy → verify.
 *
 *   check   production promotion is switched on (`enabled` in the config — off
 *           until cutover, so a --go can never deploy by accident); the image
 *           tag exists on Docker Hub (its digest is pinned with it); the
 *           deployment commit that took this version to staging exists; staging
 *           answered with it; the portal commit staging serves is on its main
 *           branch; a GitLab token is present.
 *   push    in throwaway worktrees (the checkouts on disk are never touched):
 *           the API deployment repository's production branch gets the source
 *           commit merged and the pin file (version + digest) written; the
 *           portal repository's production branch gets the commit staging
 *           serves merged. Both pushed.
 *   deploy  the production deploy jobs are MANUAL in both pipelines; this plays
 *           them through the GitLab API, in order: the API first (its canary
 *           runs the migrations; its gates check every task and roll back on
 *           failure), then — only once the API job passed — the portal (its
 *           script refuses an API older than the build). A job that fails ends
 *           the promotion; the deploy scripts have already rolled back.
 *   verify  when the stacks own the public hostnames (ROUTE_PRIORITY ≥ 3 in the
 *           deployment repository's production.conf), poll the public URLs
 *           until they answer with this release twice in a row. Before cutover
 *           the legacy apps still serve them, and the deploy jobs' gates are
 *           the verification.
 *
 * Configuration: the `production` block of release-chain.config.json —
 *
 *   "production": {
 *     "name": "EFP production",
 *     "enabled": false,                  the switch: --go refuses until true
 *     "path": "~/code/deploy",           the API deployment repository
 *     "source_branch": "main",           the branch staging deploys from
 *     "branch": "production",            the branch production deploys from
 *     "pin_file": ".docker/nivaro-version",
 *     "route_conf": ".docker/production.conf",
 *     "gitlab": { "api": "https://gitlab…/api/v4", "project": "group/deploy" },
 *     "verify": [{ "name": "production api", "url": "https://…/api/version", "field": "version" }],
 *     "frontend": {                      optional — a separately deployed portal
 *       "name": "portal", "path": "~/code/portal", "source_branch": "main",
 *       "branch": "production", "gitlab_project": "group/portal",
 *       "staging_url": "https://staging…/version.json",
 *       "verify": [{ "name": "production portal", "url": "https://…/version.json", "field": "version" }]
 *     }
 *   }
 *
 * The GitLab token comes from GITLAB_TOKEN in the environment (the release card
 * passes the Environments registry's token); it is handed to curl on stdin,
 * never on a command line.
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
const BOOTSTRAP = flag('bootstrap')
const VERSION = opt('version', null)
const TOKEN = process.env.GITLAB_TOKEN || ''

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

/** The tag's image index digest on Docker Hub — what `docker pull` records. */
async function hubDigest(image, tag) {
  const [ns, name] = image.split('/')
  const res = await fetch(`https://hub.docker.com/v2/repositories/${ns}/${name}/tags/${tag}`, {
    signal: AbortSignal.timeout(15_000)
  }).catch(() => null)
  if (!res || res.status !== 200) return null
  const body = await res.json().catch(() => null)
  return typeof body?.digest === 'string' && body.digest.startsWith('sha256:') ? body.digest : 'present'
}

// ── GitLab (token on curl's stdin, never argv) ──────────────────────────────
function gitlab(cfg, method, path, body) {
  const args = ['-sS', '-m', '30', '-X', method, '-H', '@-', `${cfg.gitlab.api}${path}`]
  let input = `PRIVATE-TOKEN: ${TOKEN}\n`
  if (body !== undefined) {
    args.splice(args.length - 1, 0, '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body))
  }
  const out = execFileSync('curl', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  input = ''
  let json
  try {
    json = JSON.parse(out)
  } catch {
    throw new StageError(`GitLab ${method} ${path} answered something that is not JSON`)
  }
  if (json && !Array.isArray(json) && (json.message || json.error) && json.id === undefined) {
    throw new StageError(`GitLab ${method} ${path}: ${JSON.stringify(json.message ?? json.error)}`)
  }
  return json
}
const enc = (p) => encodeURIComponent(p)

/** The pipeline GitLab created for `sha` on `ref` (waits for it to appear). */
async function pipelineFor(cfg, project, ref, sha, label) {
  for (let i = 1; ; i++) {
    const list = gitlab(cfg, 'GET', `/projects/${enc(project)}/pipelines?ref=${enc(ref)}&sha=${sha}&per_page=5`)
    if (Array.isArray(list) && list.length) return list[0]
    if (i >= 40) throw new StageError(`${label}: GitLab never created a pipeline for ${sha.slice(0, 8)} on ${ref}`)
    emit(currentStage, 'progress', `${label}: waiting for the pipeline (${i}/40)`)
    await sleep(15_000)
  }
}
function jobNamed(cfg, project, pipelineId, name) {
  const jobs = gitlab(cfg, 'GET', `/projects/${enc(project)}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`)
  return (Array.isArray(jobs) ? jobs : []).filter((j) => j.name === name).sort((a, b) => b.id - a.id)[0] ?? null
}
/** Poll a job until it leaves the running states; returns its final status. */
async function waitJob(cfg, project, jobId, label, { minutes }) {
  const deadline = Date.now() + minutes * 60_000
  let last = ''
  for (;;) {
    const j = gitlab(cfg, 'GET', `/projects/${enc(project)}/jobs/${jobId}`)
    if (['success', 'failed', 'canceled', 'skipped', 'manual'].includes(j.status)) return j
    if (j.status !== last) log(`${label}: ${j.status}`)
    last = j.status
    if (Date.now() > deadline) throw new StageError(`${label} still ${j.status} after ${minutes} min (job ${j.web_url})`)
    emit(currentStage, 'progress', `${label}: ${j.status}`)
    await sleep(20_000)
  }
}
/** Wait for `before` to succeed, then play the manual `deploy` job and wait. */
async function runDeploy(cfg, project, ref, sha, label, { before, deploy, variables, minutes }) {
  const p = await pipelineFor(cfg, project, ref, sha, label)
  log(`${label}: pipeline ${p.id} (${p.web_url})`)
  if (before) {
    const b = jobNamed(cfg, project, p.id, before)
    if (!b) throw new StageError(`${label}: pipeline ${p.id} has no ${before} job`)
    const done = await waitJob(cfg, project, b.id, `${label} ${before}`, { minutes: 30 })
    if (done.status !== 'success') throw new StageError(`${label}: ${before} ${done.status} (${done.web_url})`)
  }
  const d = jobNamed(cfg, project, p.id, deploy)
  if (!d) throw new StageError(`${label}: pipeline ${p.id} has no ${deploy} job`)
  if (d.status === 'success') {
    log(`${label}: ${deploy} already succeeded for this commit — not run again`)
    return d
  }
  if (d.status !== 'manual') throw new StageError(`${label}: ${deploy} is ${d.status}, expected a manual job waiting to be played`)
  log(`${label}: playing ${deploy}${variables?.length ? ` with ${variables.map((v) => `${v.key}=${v.value}`).join(' ')}` : ''}`)
  const played = gitlab(cfg, 'POST', `/projects/${enc(project)}/jobs/${d.id}/play`, variables?.length ? { job_variables_attributes: variables } : {})
  const done = await waitJob(cfg, project, played.id ?? d.id, `${label} ${deploy}`, { minutes })
  if (done.status !== 'success') throw new StageError(`${label}: ${deploy} ${done.status} — the deploy script rolled back (${done.web_url})`)
  log(`${label}: ${deploy} passed`)
  return done
}

function loadConfig() {
  const path = resolve(ROOT, 'release-chain.config.json')
  if (!existsSync(path)) throw new StageError('no release-chain.config.json')
  const c = JSON.parse(readFileSync(path, 'utf8'))
  if (!c.production) throw new StageError('release-chain.config.json has no "production" block')
  const p = c.production
  const f = p.frontend
  return {
    image: c.image ?? null,
    stagingVerify: (c.verify ?? []).filter((v) => !v.expect),
    production: {
      name: p.name ?? 'production',
      enabled: p.enabled === true,
      path: expand(p.path),
      sourceBranch: p.source_branch ?? 'main',
      branch: p.branch ?? 'production',
      pinFile: p.pin_file ?? '.docker/nivaro-version',
      routeConf: p.route_conf ?? '.docker/production.conf',
      verify: p.verify ?? []
    },
    gitlab: p.gitlab?.api && p.gitlab?.project ? { api: p.gitlab.api.replace(/\/$/, ''), project: p.gitlab.project } : null,
    frontend: f
      ? {
          name: f.name ?? 'portal',
          path: expand(f.path),
          sourceBranch: f.source_branch ?? 'main',
          branch: f.branch ?? 'production',
          project: f.gitlab_project,
          stagingUrl: f.staging_url ?? null,
          verify: f.verify ?? []
        }
      : null
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

/** The portal commit staging serves, if it is on the portal's main branch. */
function frontendCommit(fe) {
  if (!fe?.stagingUrl) return { short: null, hash: null, why: 'no staging_url configured' }
  const short = probe(fe.stagingUrl, 'version').value
  if (!short) return { short: null, hash: null, why: `staging ${fe.stagingUrl} did not answer` }
  sh('git', ['fetch', 'origin'], { cwd: fe.path, allowFail: true })
  const hash = sh('git', ['rev-parse', '--verify', '--quiet', `${short}^{commit}`], { cwd: fe.path, allowFail: true }).stdout
  if (!hash) return { short, hash: null, why: `staging serves ${short}, which this checkout does not have` }
  const onMain = sh('git', ['merge-base', '--is-ancestor', hash, `origin/${fe.sourceBranch}`], { cwd: fe.path, allowFail: true }).ok
  if (!onMain) return { short, hash: null, why: `staging serves ${short}, which is not on ${fe.sourceBranch}` }
  const prodTip = sh('git', ['rev-parse', '--verify', '--quiet', `origin/${fe.branch}`], { cwd: fe.path, allowFail: true }).stdout
  const subject = git(['log', '-1', '--format=%s', hash], fe.path)
  return { short, hash, subject, alreadyOnBranch: !!prodTip && sh('git', ['merge-base', '--is-ancestor', hash, prodTip], { cwd: fe.path, allowFail: true }).ok, why: null }
}

/** ROUTE_PRIORITY on the deployment repository's production branch. */
function routePriority(cfg) {
  const text = sh('git', ['show', `origin/${cfg.production.branch}:${cfg.production.routeConf}`], { cwd: cfg.production.path, allowFail: true }).stdout
  const m = text.match(/^ROUTE_PRIORITY=(\d+)/m)
  return m ? Number(m[1]) : null
}

/** Migrations shipped between two app tags in this repository. */
function migrationsBetween(from, to) {
  if (!from) return []
  const a = `v${String(from).replace(/^v/, '')}`
  const b = `v${String(to).replace(/^v/, '')}`
  const res = sh('git', ['diff', '--name-only', `${a}..${b}`, '--', 'api/src/db/migrations'], { allowFail: true })
  return res.stdout.split('\n').filter((f) => /\d+_.*\.ts$/.test(f))
}

/** Merge `commit` into origin/<branch> in a throwaway worktree, let `edit`
 *  change files, commit, push. Returns the pushed sha. */
function pushBranch(repo, branch, commit, message, edit) {
  const hasBranch = sh('git', ['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: repo, allowFail: true }).ok
  const tmp = mkdtempSync(join(tmpdir(), 'promote-'))
  try {
    git(['worktree', 'add', '--detach', tmp, hasBranch ? `origin/${branch}` : commit], repo)
    if (hasBranch) sh('git', ['merge', '--no-edit', '-m', message, commit], { cwd: tmp })
    if (edit) {
      const files = edit(tmp)
      git(['add', ...files], tmp)
      const staged = sh('git', ['diff', '--cached', '--quiet'], { cwd: tmp, allowFail: true })
      if (!staged.ok) git(['commit', '-q', '-m', message], tmp)
    }
    sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: tmp })
    return git(['rev-parse', 'HEAD'], tmp)
  } finally {
    sh('git', ['worktree', 'remove', '--force', tmp], { cwd: repo, allowFail: true })
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() {
  if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) throw new StageError('--version x.y.z is required')
  const cfg = loadConfig()
  const prod = cfg.production
  const fe = cfg.frontend

  // ── plan ────────────────────────────────────────────────────────────────
  const staging = cfg.stagingVerify.map((v) => ({ name: v.name, ...probe(v.url, v.field) }))
  const production = prod.verify.map((v) => ({ name: v.name, ...probe(v.url, v.field) }))
  const prodVersion = production.find((p) => p.value)?.value ?? null
  const verifiedRuns = verifiedByRuns()
  const stagingNow = staging.some((s) => s.value === VERSION)
  const source = sourceCommit(cfg, VERSION)
  const migrations = migrationsBetween(prodVersion, VERSION)
  const digest = cfg.image ? await hubDigest(cfg.image, VERSION) : null
  const frontend = fe ? frontendCommit(fe) : null
  const priority = routePriority(cfg)
  const blockers = []
  if (!prod.enabled)
    blockers.push('production promotion is switched off — set "enabled": true in the production block of release-chain.config.json at cutover')
  if (cfg.image && !digest) blockers.push(`${cfg.image}:${VERSION} is not on the registry`)
  if (!source) blockers.push(`no commit on ${prod.sourceBranch} deployed nivaro ${VERSION} to staging`)
  if (!stagingNow && !verifiedRuns.includes(VERSION))
    blockers.push(`staging never answered with ${VERSION} — neither now nor in a finished release run`)
  if (prodVersion === VERSION) blockers.push(`production already runs ${VERSION}`)
  if (prodVersion && semverCmp(VERSION, prodVersion) < 0)
    blockers.push(`${VERSION} is older than production's ${prodVersion} — a rollback, not a promotion`)
  if (!cfg.gitlab) blockers.push('no "gitlab" { api, project } in the production block — the deploy jobs cannot be run')
  if (!TOKEN) blockers.push('no GITLAB_TOKEN in the environment — the deploy jobs cannot be run')
  if (fe && !frontend?.hash) blockers.push(`portal: ${frontend?.why}`)
  if (fe && !fe.project) blockers.push('portal: no gitlab_project configured')

  const pinText = `${VERSION}\n${digest && digest !== 'present' ? `${digest}\n` : ''}`
  const plan = {
    version: VERSION,
    target: prod.name,
    enabled: prod.enabled,
    bootstrap: BOOTSTRAP,
    production_version: prodVersion,
    production_probe: production,
    staging_probe: staging,
    staging_now: stagingNow,
    verified_by_run: verifiedRuns.includes(VERSION),
    source_commit: source,
    image_digest: digest,
    frontend_commit: frontend?.hash ? { hash: frontend.hash, short: frontend.short, subject: frontend.subject } : null,
    route_priority: priority,
    migrations,
    pin_file: prod.pinFile,
    branch: prod.branch,
    blockers,
    lines: [
      { stage: 'check', text: prod.enabled ? 'production promotion is switched on' : 'production promotion is SWITCHED OFF (release-chain.config.json) — nothing will be pushed or deployed' },
      { stage: 'check', text: `image ${cfg.image ?? '(none configured)'}:${VERSION} ${digest ? (digest === 'present' ? 'present' : `→ ${digest.slice(0, 19)}…`) : 'MISSING'}; staging ${stagingNow ? 'runs it now' : verifiedRuns.includes(VERSION) ? 'verified it in a finished release run' : 'never answered with it'}` },
      { stage: 'check', text: source ? `API: source commit ${source.hash.slice(0, 8)} — ${source.subject}` : `API: no deploy commit for ${VERSION} on ${prod.sourceBranch}` },
      ...(fe ? [{ stage: 'check', text: frontend?.hash ? `${fe.name}: staging serves ${frontend.short} — ${frontend.subject}` : `${fe.name}: ${frontend?.why}` }] : []),
      { stage: 'push', text: `API: merge into ${prod.branch}, pin ${VERSION}${digest && digest !== 'present' ? ' + digest' : ''} in ${prod.pinFile}, push (throwaway worktree)` },
      ...(fe ? [{ stage: 'push', text: frontend?.alreadyOnBranch ? `${fe.name}: ${fe.branch} already holds ${frontend.short}` : `${fe.name}: merge ${frontend?.short ?? '?'} into ${fe.branch}, push (its pipeline builds the image)` }] : []),
      { stage: 'deploy', text: `API: wait for build_extension, play deploy_production${BOOTSTRAP ? ' with GATE_MODE=bootstrap (first deploy)' : ''}, wait for it (canary + migrations + gated roll)` },
      ...(fe ? [{ stage: 'deploy', text: `${fe.name}: after the API passed — wait for build_production, play deploy_production, wait for it` }] : []),
      priority !== null && priority >= 3
        ? { stage: 'verify', text: `route priority ${priority}: poll the public URLs until they answer this release twice` }
        : { stage: 'verify', text: `route priority ${priority ?? '?'}: the legacy apps still own the public hostnames — the deploy jobs' gates are the verification` },
      ...(!prodVersion ? [{ stage: 'check', text: 'production did not answer with a Nivaro version (pre-cutover, the public hostname is legacy) — cannot list the migrations this deploy runs' }] : []),
      ...(migrations.length ? [{ stage: 'check', text: `${migrations.length} migration(s) run on production at boot: ${migrations.map((m) => m.split('/').pop()).join(', ')}` }] : [])
    ]
  }

  console.log(`\npromote-production — ${VERSION} → ${prod.name}${GO ? '' : '   (plan only — pass --go)'}`)
  console.log(`  production runs ${prodVersion ?? '(no Nivaro answer)'} · staging ${staging.map((s) => `${s.name}=${s.value ?? s.error ?? '?'}`).join(', ') || '(no verify URL)'}`)
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
    const apiSha = pushBranch(prod.path, prod.branch, source.hash, `chore: promote nivaro ${VERSION} to production`, (dir) => {
      writeFileSync(join(dir, prod.pinFile), pinText)
      return [prod.pinFile]
    })
    log(`API: pushed ${apiSha.slice(0, 8)} to ${prod.branch}`)
    let feSha = null
    if (fe) {
      if (frontend.alreadyOnBranch) {
        feSha = git(['rev-parse', `origin/${fe.branch}`], fe.path)
        log(`${fe.name}: ${fe.branch} already holds ${frontend.short} — not pushed`)
      } else {
        feSha = pushBranch(fe.path, fe.branch, frontend.hash, `merge: ${fe.name} ${frontend.short} for nivaro ${VERSION}`)
        log(`${fe.name}: pushed ${feSha.slice(0, 8)} to ${fe.branch}`)
      }
    }
    emit('push', 'ok')

    currentStage = 'deploy'
    emit('deploy', 'start')
    await runDeploy(cfg, cfg.gitlab.project, prod.branch, apiSha, 'API', {
      before: 'build_extension',
      deploy: 'deploy_production',
      variables: BOOTSTRAP ? [{ key: 'GATE_MODE', value: 'bootstrap' }] : [],
      minutes: 60
    })
    if (fe) {
      await runDeploy(cfg, fe.project, fe.branch, feSha, fe.name, {
        before: 'build_production',
        deploy: 'deploy_production',
        minutes: 20
      })
    }
    emit('deploy', 'ok')

    currentStage = 'verify'
    emit('verify', 'start')
    if (priority !== null && priority >= 3) {
      const checks = [
        ...prod.verify.map((v) => ({ ...v, want: VERSION })),
        ...(fe ? fe.verify.map((v) => ({ ...v, want: frontend.short })) : [])
      ]
      for (const v of checks) {
        let streak = 0
        for (let i = 1; ; i++) {
          const r = probe(v.url, v.field)
          streak = r.value === v.want ? streak + 1 : 0
          if (streak >= 2) break
          if (i >= 40) throw new StageError(`${v.name} never answered ${v.want} (last: ${r.value ?? r.error})`)
          emit('verify', 'progress', `${v.name}: ${r.value ?? r.error ?? 'no answer'} (${i}/40)`)
          await sleep(15_000)
        }
      }
    } else {
      log(`route priority ${priority ?? '?'} — public hostnames still legacy; verified by the deploy jobs' gates`)
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

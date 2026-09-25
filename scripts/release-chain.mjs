#!/usr/bin/env node
/**
 * release-chain — the whole release, in the order it has to happen.
 *
 * A release here is a graph, not a list:
 *
 *   sdk published ──► react published ──► frontends can pin it
 *   app tagged ──► image built ─────────► deployments can pull it
 *   (a migration in the release makes that last edge non-negotiable)
 *
 * Getting it wrong is quiet until it is not. A frontend pinned to a package
 * version npm has not finished publishing fails its CI on a stale lockfile. A
 * deployment pushed before its image exists pulls the OLD image, which then
 * meets a migration ledger it has never heard of and takes the API down. Both
 * have happened, each time because the order lived in somebody's head.
 *
 *   node scripts/release-chain.mjs                 print the plan, touch nothing
 *   node scripts/release-chain.mjs --go            run it
 *   node scripts/release-chain.mjs --go --from downstream    resume at a stage
 *   … --bump minor          default patch
 *   … --with-sdk / --with-react / --no-react       override change detection
 *   … --skip-verify         stop after the pushes
 *
 * Stages, in order: preflight → release → publish → artifacts → frontends →
 * deployments → verify. Each stage checks the thing the next one depends on
 * instead of trusting that the previous command exited 0.
 *
 * The default is the plan. Pushing is how things get deployed, so nothing is
 * pushed without --go.
 *
 * Downstream repositories are deployment-specific and live in
 * `release-chain.config.json` (gitignored) — see release-chain.config.example.json.
 * Without a config the chain stops after `artifacts`.
 *
 * It always ends with a `### DONE` or `### FAILED at <stage>` line, because it
 * is usually run under nohup and a log that simply stops says nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : d
}
const GO = flag('go')
const BUMP = opt('bump', 'patch')
const FROM = opt('from', null)
const EVENTS = flag('events')
/** One machine-readable line per stage boundary — only with --events. */
const emit = (stage, status, detail) => {
  if (!EVENTS) return
  const e = { stage, status, at: new Date().toISOString() }
  if (detail) e.detail = String(detail).slice(0, 500)
  console.log(`@@event ${JSON.stringify(e)}`)
}
const STAGES = ['preflight', 'release', 'publish', 'artifacts', 'frontends', 'deployments', 'verify']

const expand = (p) => resolve(p.startsWith('~') ? p.replace(/^~/, homedir()) : p)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${msg}`)

/** The stage running right now — read by progress events and the failure line. */
let currentStage = 'preflight'

class StageError extends Error {}

/** Run a command; throw with its output when it fails. */
function sh(cmd, args, { cwd = ROOT, quiet = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (!quiet && out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
  if (res.status !== 0 && !allowFail) {
    // Never swallow this: a build silenced with >/dev/null once killed the
    // chain with no trace of why.
    if (quiet && out.trim()) process.stdout.write(out)
    throw new StageError(`\`${cmd} ${args.join(' ')}\` exited ${res.status}`)
  }
  return { ok: res.status === 0, out: out.trim() }
}

const git = (args, o) => sh('git', args, { quiet: true, ...o }).out
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const version = (rel) => readJson(resolve(ROOT, rel)).version

function loadConfig() {
  const path = resolve(ROOT, 'release-chain.config.json')
  if (!existsSync(path)) return { path: null, mirror: null, image: null, frontends: [], deployments: [], verify: [] }
  const c = readJson(path)
  return {
    path,
    mirror: c.mirror ?? null,
    workflowsRepo: c.workflows_repo ?? null,
    image: c.image ?? null,
    frontends: c.frontends ?? [],
    deployments: c.deployments ?? [],
    verify: c.verify ?? []
  }
}

/** What moved since the last app tag decides which packages need releasing. */
function detectChanges() {
  const last = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'])
  const files = git(['diff', '--name-only', `${last}..HEAD`]).split('\n').filter(Boolean)
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean)
  const has = (re) => files.some((f) => re.test(f))
  return {
    last,
    commits: Number(git(['rev-list', '--count', `${last}..HEAD`])),
    files: files.length,
    dirty,
    sdk: has(/^packages\/sdk\//),
    react: has(/^packages\/(react|shared)\//),
    migrations: files.filter((f) => /^api\/src\/db\/migrations\/\d+_/.test(f)),
    // HEAD already IS a release commit: a previous run got as far as tagging
    // and died. Re-running `release` would mint a version nothing publishes.
    headTag: sh('git', ['describe', '--exact-match', '--tags', '--match', 'v*', 'HEAD'], {
      quiet: true,
      allowFail: true
    }).out
  }
}

function plan(cfg, ch) {
  const wantSdk = flag('with-sdk') || ch.sdk
  const wantReact = !flag('no-react') && (flag('with-react') || ch.react || wantSdk)
  const lines = []
  const add = (stage, text) => lines.push({ stage, text })

  add('preflight', 'on main · `gh` signed in · api, admin and shared typecheck (an untracked probe under api/src breaks the image build)')
  if (ch.headTag.startsWith('v')) add('release', `HEAD is already tagged ${ch.headTag} — reuse it, mint nothing`)
  else {
    if (wantSdk) add('release', `pnpm sdk:release ${BUMP}   (packages/sdk changed — it must publish BEFORE react imports from it)`)
    add('release', `pnpm release ${BUMP}`)
    if (wantReact) add('release', `pnpm react:release ${BUMP}   (packages/shared or packages/react changed)`)
  }
  add('publish', cfg.mirror ? `push origin, then the public mirror ${cfg.mirror} — the mirror is what builds` : 'push origin (no mirror configured)')
  add('artifacts', `wait for the image${wantSdk ? ', @nivaro/sdk' : ''}${wantReact ? ', @nivaro/react' : ''} — and then CHECK they exist, by asking the registry`)
  if (ch.migrations.length > 0) {
    add('artifacts', `${ch.migrations.length} migration(s) ship in this release → no deployment is pushed until the image tag is confirmed`)
  }
  for (const f of cfg.frontends) {
    if (!wantReact && !wantSdk) add('frontends', `${f.name}: nothing to pin — skipped`)
    else add('frontends', `${f.name}: pin the new package version(s), install until the LOCKFILE carries them, build locally, commit, push`)
  }
  for (const d of cfg.deployments) {
    add('deployments', `${d.name}: ${(d.prepare ?? []).join(' && ') || 'no prepare step'}, commit (empty if nothing changed), push`)
  }
  for (const v of cfg.verify) {
    const fe = v.expect?.startsWith('frontend:') ? v.expect.slice('frontend:'.length) : null
    const what = fe ? `the pushed ${fe} commit` : 'the new version'
    add('verify', `${v.name}: poll ${v.url} until it reports ${what} twice in a row`)
  }
  if (!cfg.path) add('frontends', 'no release-chain.config.json — the chain stops after artifacts')
  return { lines, wantSdk, wantReact }
}

async function waitForWorkflow(repo, workflow, accept) {
  await sleep(25_000) // the run does not exist the instant the tag lands
  const id = sh('gh', ['run', 'list', '-R', repo, '--workflow', workflow, '-L1', '--json', 'databaseId', '-q', '.[0].databaseId'], { quiet: true }).out
  log(`watching ${workflow} run ${id}`)
  emit(currentStage, 'progress', `watching ${workflow} run ${id}`)
  const res = sh('gh', ['run', 'watch', '-R', repo, id, '--exit-status'], { quiet: true, allowFail: true })
  if (res.ok) return
  // A registry can accept the package and still fail the run ("cannot publish
  // over previously staged version"). The artifact is the truth, not the run.
  if (accept && (await accept())) {
    log(`${workflow} reported failure but the artifact exists — continuing`)
    return
  }
  throw new StageError(`${workflow} failed (run ${id})`)
}

const npmHas = (pkg, v) => sh('npm', ['view', `${pkg}@${v}`, 'version'], { quiet: true, allowFail: true }).out === v

async function imageExists(image, tag) {
  const [ns, name] = image.split('/')
  const res = await fetch(`https://hub.docker.com/v2/repositories/${ns}/${name}/tags/${tag}`).catch(() => null)
  return res?.status === 200
}

async function until(what, fn, { tries = 30, every = 20_000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    if (await fn()) return
    log(`${what} — not yet (${i}/${tries})`)
    emit(currentStage, 'progress', `${what} — not yet (${i}/${tries})`)
    await sleep(every)
  }
  throw new StageError(`${what} never became true`)
}

async function main() {
  const pushedShas = {}
  const cfg = loadConfig()
  const ch = detectChanges()
  const p = plan(cfg, ch)

  console.log(`\nrelease-chain — ${ch.commits} commit(s), ${ch.files} file(s) since ${ch.last}${GO ? '' : '   (plan only — pass --go)'}`)
  console.log(`  packages/sdk ${ch.sdk ? 'CHANGED' : 'unchanged'} · packages/shared|react ${ch.react ? 'CHANGED' : 'unchanged'} · ${ch.migrations.length} migration(s)`)
  for (const m of ch.migrations) console.log(`    ${m}`)
  if (ch.dirty.length > 0) {
    console.log(`  ${ch.dirty.length} tracked file(s) have uncommitted changes — they are NOT in this release:`)
    for (const d of ch.dirty.slice(0, 8)) console.log(`    ${d}`)
  }
  let stage = ''
  for (const l of p.lines) {
    if (l.stage !== stage) console.log(`\n  ${l.stage}`)
    stage = l.stage
    console.log(`    · ${l.text}`)
  }
  console.log('')
  if (EVENTS) {
    console.log(
      `@@plan ${JSON.stringify({
        commits: ch.commits,
        files: ch.files,
        last_tag: ch.last,
        sdk_changed: ch.sdk,
        react_changed: ch.react,
        migrations: ch.migrations,
        dirty: ch.dirty,
        versions: {
          app: version('package.json'),
          react: version('packages/react/package.json'),
          sdk: version('packages/sdk/package.json')
        },
        head_tag: ch.headTag.startsWith('v') ? ch.headTag : null,
        frontends: p.wantReact || p.wantSdk ? cfg.frontends.map((f) => f.name) : [],
        deployments: cfg.deployments.map((d) => d.name),
        lines: p.lines
      })}`
    )
  }
  if (!GO) return
  if (ch.commits === 0 && !ch.headTag.startsWith('v')) throw new StageError('nothing to release')

  const startAt = FROM ? STAGES.indexOf(FROM) : 0
  if (startAt < 0) throw new StageError(`--from must be one of ${STAGES.join(', ')}`)
  const runs = (s) => STAGES.indexOf(s) >= startAt
  currentStage = 'preflight'
  try {
    if (runs('preflight')) {
      currentStage = 'preflight'
      emit('preflight', 'start')
      if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw new StageError('not on main')
      sh('gh', ['auth', 'status'], { quiet: true })
      for (const dir of ['api', 'admin', 'packages/shared']) {
        log(`typecheck ${dir}`)
        sh('npx', ['tsc', '--noEmit'], { cwd: resolve(ROOT, dir), quiet: true })
      }
      emit('preflight', 'ok')
    } else emit('preflight', 'skip', `resumed from ${FROM}`)

    if (runs('release') && !ch.headTag.startsWith('v')) {
      currentStage = 'release'
      emit('release', 'start')
      if (p.wantSdk) sh('pnpm', ['sdk:release', BUMP])
      sh('pnpm', ['release', BUMP])
      if (p.wantReact) sh('pnpm', ['react:release', BUMP])
      emit('release', 'ok')
    } else if (runs('release')) emit('release', 'skip', `HEAD already tagged ${ch.headTag}`)
    else emit('release', 'skip', `resumed from ${FROM}`)
    const V = version('package.json')
    const RV = version('packages/react/package.json')
    const SV = version('packages/sdk/package.json')
    log(`app ${V} · react ${RV} · sdk ${SV}`)

    if (runs('publish')) {
      currentStage = 'publish'
      emit('publish', 'start')
      sh('git', ['push', 'origin', 'main', '--tags'], { allowFail: true })
      if (cfg.mirror) sh('scripts/publish-github.sh', ['--push', cfg.mirror])
      emit('publish', 'ok')
    } else emit('publish', 'skip', `resumed from ${FROM}`)

    if (runs('artifacts')) {
      currentStage = 'artifacts'
      emit('artifacts', 'start')
      const repo = cfg.workflowsRepo
      if (repo) {
        if (p.wantSdk) await waitForWorkflow(repo, 'publish-sdk.yml', async () => npmHas('@nivaro/sdk', SV))
        await waitForWorkflow(repo, 'docker-hub.yml', async () => (cfg.image ? imageExists(cfg.image, V) : false))
        if (p.wantReact) await waitForWorkflow(repo, 'publish-react.yml', async () => npmHas('@nivaro/react', RV))
      }
      // The gates. A green workflow is a claim; these are the artifacts.
      if (cfg.image) await until(`image ${cfg.image}:${V} on the registry`, () => imageExists(cfg.image, V))
      if (p.wantSdk) await until(`@nivaro/sdk@${SV} on npm`, async () => npmHas('@nivaro/sdk', SV))
      if (p.wantReact) await until(`@nivaro/react@${RV} on npm`, async () => npmHas('@nivaro/react', RV))
      emit('artifacts', 'ok')
    } else emit('artifacts', 'skip', `resumed from ${FROM}`)

    if (runs('frontends') && (p.wantReact || p.wantSdk)) {
      currentStage = 'frontends'
      emit('frontends', 'start')
      for (const f of cfg.frontends) {
        const cwd = expand(f.path)
        const pins = { ...(p.wantReact ? { '@nivaro/react': RV } : {}), ...(p.wantSdk ? { '@nivaro/sdk': SV } : {}) }
        const pkgPath = resolve(cwd, 'package.json')
        const pkg = readJson(pkgPath)
        for (const [name, v] of Object.entries(pins)) {
          if (pkg.dependencies?.[name]) pkg.dependencies[name] = v
        }
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
        // pnpm's registry metadata can lag a minutes-old publish: the install
        // "succeeds" and leaves the lockfile on the OLD version, which a
        // frozen-lockfile CI then rejects. The lockfile is what gets checked.
        await until(`${f.name} lockfile carries ${Object.values(pins).join(' + ')}`, async () => {
          sh('pnpm', ['install', '--no-frozen-lockfile'], { cwd, quiet: true, allowFail: true })
          const lock = readFileSync(resolve(cwd, 'pnpm-lock.yaml'), 'utf8')
          return Object.entries(pins).every(([name, v]) => lock.includes(`${name}@${v}`))
        }, { tries: 8 })
        // tsc passes on a missing package export; only the bundler catches it.
        log(`${f.name}: local build`)
        sh('pnpm', ['run', f.build ?? 'build'], { cwd, quiet: true })
        sh('git', ['add', 'package.json', 'pnpm-lock.yaml'], { cwd, quiet: true })
        sh('git', ['commit', '-q', '-m', `chore: bump ${Object.entries(pins).map(([n, v]) => `${n} to ${v}`).join(', ')}`, '--', 'package.json', 'pnpm-lock.yaml'], { cwd, quiet: true })
        sh('git', ['push', 'origin', f.branch ?? 'main'], { cwd })
        pushedShas[f.name] = git(['rev-parse', '--short=8', 'HEAD'], { cwd })
      }
      emit('frontends', 'ok')
    } else if (runs('frontends')) emit('frontends', 'skip', 'nothing to pin')
    else emit('frontends', 'skip', `resumed from ${FROM}`)

    if (runs('deployments')) {
      currentStage = 'deployments'
      emit('deployments', 'start')
      for (const d of cfg.deployments) {
        // Re-checked HERE, not trusted from above: --from deployments skips
        // the artifacts stage, and this is the push that can take an API down.
        if (cfg.image && !(await imageExists(cfg.image, V))) {
          throw new StageError(`${cfg.image}:${V} is not on the registry — refusing to push ${d.name}, which would deploy the previous image`)
        }
        const cwd = expand(d.path)
        for (const step of d.prepare ?? []) sh('bash', ['-c', step], { cwd })
        const changed = git(['status', '--short', ...(d.commit_paths ?? ['.'])], { cwd })
        if (changed) {
          sh('git', ['add', ...(d.commit_paths ?? ['.'])], { cwd, quiet: true })
          sh('git', ['commit', '-q', '-m', `chore: sync for nivaro ${V}`, '--', ...(d.commit_paths ?? ['.'])], { cwd, quiet: true })
        } else {
          sh('git', ['commit', '-q', '--allow-empty', '-m', `chore: deploy nivaro ${V}`], { cwd, quiet: true })
        }
        sh('git', ['push', 'origin', d.branch ?? 'main'], { cwd })
      }
      emit('deployments', 'ok')
    } else emit('deployments', 'skip', `resumed from ${FROM}`)

    if (runs('verify') && !flag('skip-verify')) {
      currentStage = 'verify'
      emit('verify', 'start')
      for (const v of cfg.verify) {
        // A recreating container answers the new version once and then 502s
        // for a minute. Two consecutive good answers, not one.
        // Probed with curl, not fetch: node's fetch trusts only its bundled
        // CAs and rejects the corporate-signed staging cert
        // (UNABLE_TO_VERIFY_LEAF_SIGNATURE) — 50 polls read "not yet" on
        // 2026-09-21 while curl, which uses the system keychain, answered the
        // new version every time. A probe failure is printed once per
        // distinct reason so a broken probe can never pass for a slow deploy.
        // `expect: "frontend:<name>"` waits for the commit this run pushed to
        // that frontend. When this run pushed nothing there (nothing to pin,
        // or resumed past `frontends`), origin's head is what that frontend's
        // CI deployed — never the local HEAD, which can hold unpushed commits.
        const frontendName = v.expect?.startsWith('frontend:')
          ? v.expect.slice('frontend:'.length)
          : null
        let expected = V
        if (frontendName) {
          const fe = cfg.frontends.find((f) => f.name === frontendName)
          if (!fe) {
            throw new StageError(
              `verify "${v.name}": no frontend named ${frontendName} in release-chain.config.json`
            )
          }
          if (pushedShas[frontendName]) expected = pushedShas[frontendName]
          else {
            const cwd = expand(fe.path)
            const branch = fe.branch ?? 'main'
            sh('git', ['fetch', 'origin', branch], { cwd, quiet: true, allowFail: true })
            expected = git(['rev-parse', '--short=8', `origin/${branch}`], { cwd })
          }
        }
        let streak = 0
        let lastErr = ''
        await until(`${v.name} on ${expected}`, async () => {
          let body = null
          try {
            body = JSON.parse(
              execFileSync('curl', ['-sS', '-m', '10', v.url], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
              })
            )
          } catch (err) {
            const msg = String(err?.stderr || err?.message || err).trim().split('\n')[0]
            if (msg !== lastErr) log(`  probe: ${msg}`)
            lastErr = msg
          }
          streak = body?.[v.field ?? 'version'] === expected ? streak + 1 : 0
          return streak >= 2
          // The GitLab deploy job npm-installs on the host, prunes, pulls the
          // image and runs the gate: 13–15 minutes end to end, which outran
          // the earlier 12.5-minute window. Wait up to 30 minutes.
        }, { tries: 120, every: 15_000 })
      }
      emit('verify', 'ok')
    } else if (flag('skip-verify')) emit('verify', 'skip', '--skip-verify')
    else emit('verify', 'skip', `resumed from ${FROM}`)
    console.log(`\n### DONE — nivaro ${V}\n`)
  } catch (err) {
    emit(currentStage, 'fail', err instanceof Error ? err.message : String(err))
    console.log(`\n### FAILED at ${currentStage}: ${err instanceof Error ? err.message : err}`)
    console.log(`    fix it, then: node scripts/release-chain.mjs --go --from ${currentStage}\n`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.log(`\n### FAILED before starting: ${err instanceof Error ? err.message : err}\n`)
  process.exitCode = 1
})

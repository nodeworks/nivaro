// Load / soak: scripts/realtime-load.mjs (efp-new-shaped presence load: N people, ~1.6 tabs each)
// drives the stack through Traefik while this suite samples, every 15 s:
//   - docker stats per API container (CPU, RSS) → heap/RSS growth and its slope during the hold
//   - sockets per socket-holding process
//   - event-loop responsiveness per socket process: a `time:sync` round trip on a probe socket
//     connected straight to that process (bypassing Traefik)
//   - record-event delivery: a writer creates an rt_items row every second; probe sockets
//     (through Traefik) time write → collection:update
// then checks that sockets and memory come back down after the load leaves (leaks).
//
//   node tests/realtime/run.mjs --suite load --users 250 --ramp-min 5 --hold-min 5
//   node tests/realtime/run.mjs --suite load --users 250 --ramp-min 10 --soak-min 60
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cfg, directUrl, loadSeed, repoRoot, socketNodes, stateDir } from '../lib/config.mjs'
import { fixture } from '../lib/fixture.mjs'
import { pct, Suite, sleep } from '../lib/harness.mjs'
import { LiveSocket } from '../lib/sock.mjs'
import { dockerStats, nodeMetrics, socketCounts } from '../lib/stack.mjs'

export async function run({ only, args }) {
  const suite = new Suite('load', { only })
  const users = Number(args.users ?? 250)
  const rampMin = Number(args['ramp-min'] ?? 5)
  const holdMin = Number(args['soak-min'] ?? args['hold-min'] ?? 5)
  const steps = Number(args.steps ?? 5)
  const soak = args['soak-min'] != null

  // Load users: one static token per person (seeded through the API).
  let seed = loadSeed()
  if ((seed.load?.length ?? 0) < users) {
    console.log(`load: seeding ${users} load users…`)
    await new Promise((res, rej) => {
      const p = spawn(process.execPath, [resolve(repoRoot, 'tests/realtime/seed.mjs'), '--load-users', String(users)], { stdio: 'inherit' })
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`seed exited ${c}`))))
    })
    seed = loadSeed()
  }
  const tokensFile = resolve(stateDir, 'load-tokens.txt')
  writeFileSync(tokensFile, `${seed.load.slice(0, users).map((u) => u.token).join('\n')}\n`)
  const fx = await fixture()

  await suite.case(`${soak ? 'soak' : 'ramp'}: 0 → ${users} people (${rampMin} min ramp, ${holdMin} min hold)`, async (t) => {
    t.cleanup(fx.closeAll)
    const samples = []
    const probeLat = []
    const writeLat = []
    const rtt = Object.fromEntries(socketNodes().map((n) => [n, []]))
    t.metric('machine_load_start', (await import('node:os')).loadavg().map((x) => Math.round(x * 100) / 100))
    let stopped = false

    // Probe sockets: one straight to each socket process (event-loop RTT) and four through
    // Traefik for record-event delivery.
    const direct = {}
    for (const n of socketNodes()) {
      // Signed in through Traefik (a realtime process has no sign-in route); the socket itself
      // goes straight to the process.
      const c = await fx.browser('carol')
      const probe = new LiveSocket(c, { base: directUrl(n), reconnection: false })
      // A stopped process (the one-realtime-task memory run) gets no probe.
      if (await probe.open({ timeoutMs: 5000 }).then(() => true, () => false)) direct[n] = probe
      else probe.close()
    }
    const probes = []
    for (let i = 0; i < 4; i++) probes.push(await fx.sock('carol'))
    for (const p of probes) p.join('collection:join', { collection: 'rt_items' })
    t.cleanup(() => {
      for (const s of Object.values(direct)) s.close()
    })

    const rttLoop = (async () => {
      while (!stopped) {
        for (const [n, s] of Object.entries(direct)) {
          const t0 = performance.now()
          const r = await s.ask('time:sync', { c: Date.now() }, 5000)
          rtt[n].push({ at: Date.now(), ms: r ? performance.now() - t0 : 5000 })
        }
        await sleep(2000)
      }
    })()
    const writeLoopP = (async () => {
      while (!stopped) {
        const t0 = Date.now()
        const marks = probes.map((p) => p.mark())
        const r = await fx.admin.post('/api/items/rt_items', { title: 'load probe', status: 'probe' }).catch(() => null)
        const t1 = Date.now()
        if (r?.ok) {
          writeLat.push(t1 - t0)
          const id = String(r.json.data.id)
          // Delivery is timed from the write's RESPONSE (the event is emitted after it), so a
          // slow web request does not count as slow delivery; the write time is kept apart.
          void Promise.all(probes.map((p, i) => p.next('collection:update', (x) => String(x.item) === id, { from: marks[i], timeoutMs: 15_000 }))).then((got) => {
            for (const g of got) probeLat.push(g ? Math.max(0, g.at - t1) : null)
          })
        }
        await sleep(Math.max(0, 1000 - (Date.now() - t0)))
      }
    })()
    const sampleOnce = async (phase) => {
      const s = { at: Date.now(), phase, docker: dockerStats(), sockets: await socketCounts(), metrics: await nodeMetrics() }
      samples.push(s)
      return s
    }
    const sampler = (async () => {
      while (!stopped) {
        await sampleOnce('load')
        await sleep(15_000)
      }
    })()

    const base = await sampleOnce('baseline')
    const out = resolve(stateDir, `load-${Date.now()}.json`)
    const log = createWriteStream(resolve(stateDir, 'load-run.log'))
    const loadArgs = [
      resolve(repoRoot, 'scripts/realtime-load.mjs'),
      '--target', cfg.base,
      '--tokens-file', tokensFile,
      '--admin-token', cfg.adminToken,
      '--people', String(users),
      '--ramp-minutes', String(rampMin),
      '--steps', String(steps),
      '--hold-minutes', String(holdMin),
      '--out', out,
      // Extra realtime-load.mjs flags, e.g. --load-args="--refetch-debounce-ms 1000"
      ...(typeof args['load-args'] === 'string' ? args['load-args'].split(/\s+/).filter(Boolean) : [])
    ]
    const tLoad = Date.now()
    const code = await new Promise((res) => {
      const p = spawn(process.execPath, loadArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      p.stdout.on('data', (d) => {
        log.write(d)
        process.stdout.write(d)
      })
      p.stderr.on('data', (d) => {
        log.write(d)
        process.stderr.write(d)
      })
      p.on('exit', res)
    })
    const loadEnded = Date.now()
    t.check('realtime-load.mjs exited 0', code === 0, code)
    // After the load leaves: sockets and memory should come back down.
    await sleep(60_000)
    stopped = true
    await Promise.all([rttLoop, writeLoopP, sampler])
    await sleep(2000)
    const after = await sampleOnce('after')

    const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
    const d = report?.totals?.delivery ?? null
    t.metric('load_delivery', d)
    t.metric('machine_load_end', (await import('node:os')).loadavg().map((x) => Math.round(x * 100) / 100))
    t.metric('load_steps', (report?.steps ?? []).map((s) => ({ label: s.label, people: s.people, sockets: s.sockets, rps: s.requests_per_s, p95: s.delivery?.p95_ms, within: s.delivery?.within_target_pct, missed: s.delivery?.missed, server: s.server })))
    t.metric('load_reconnects', report?.totals?.reconnects)
    t.metric('load_routes', (report?.totals?.routes ?? []).slice(0, 8))
    const pl = pct(probeLat.filter((x) => x != null))
    t.metric('probe_delivery_ms', { ...pl, lost: probeLat.filter((x) => x == null).length })
    t.metric('probe_write_ms', pct(writeLat))
    const rttPct = Object.fromEntries(Object.entries(rtt).map(([n, v]) => [n, pct(v.filter((x) => x.at >= tLoad && x.at <= loadEnded).map((x) => x.ms))]))
    t.metric('event_loop_rtt_ms', rttPct)

    // Memory: per API container, baseline / peak / end-of-hold / after; slope during the hold.
    const holdStart = tLoad + rampMin * 60_000
    const mem = {}
    for (const svc of Object.keys(base.docker)) {
      const series = samples.filter((s) => s.docker[svc]).map((s) => ({ at: s.at, mb: s.docker[svc].memMiB, cpu: s.docker[svc].cpu }))
      const hold = series.filter((x) => x.at >= holdStart && x.at <= loadEnded)
      const slope = hold.length >= 3 ? regress(hold.map((x) => [(x.at - holdStart) / 60_000, x.mb])) : null
      mem[svc] = {
        baseline: Math.round(base.docker[svc]?.memMiB ?? 0),
        peak: Math.round(Math.max(...series.map((x) => x.mb))),
        after: Math.round(after.docker[svc]?.memMiB ?? 0),
        hold_slope_mib_per_min: slope == null ? null : Math.round(slope * 100) / 100,
        cpu_peak: Math.round(Math.max(...series.map((x) => x.cpu)))
      }
    }
    t.metric('memory', mem)
    // Per process at its busiest sample: RSS / V8 heap / external (MiB), sockets, lag p99 (ms).
    const atPeak = {}
    for (const n of Object.keys(cfg.nodes)) {
      const rows = samples.map((s) => s.metrics?.[n]).filter(Boolean)
      if (!rows.length) continue
      const peak = rows.reduce((a, b) => ((b.sockets ?? 0) > (a.sockets ?? 0) || ((b.sockets ?? 0) === (a.sockets ?? 0) && b.rss > a.rss) ? b : a))
      atPeak[n] = {
        at_peak_sockets: peak,
        rss_max: Math.max(...rows.map((r) => r.rss ?? 0)),
        heap_max: Math.max(...rows.map((r) => r.heap ?? 0)),
        external_max: Math.max(...rows.map((r) => r.external ?? 0)),
        lag_p99_max: Math.max(...rows.map((r) => r.lagP99 ?? 0)),
        baseline: base.metrics?.[n] ?? null,
        after: after.metrics?.[n] ?? null
      }
    }
    t.metric('process_memory', atPeak)
    t.metric('sockets_peak', samples.reduce((a, s) => {
      for (const [n, v] of Object.entries(s.sockets)) a[n] = Math.max(a[n] ?? 0, v ?? 0)
      return a
    }, {}))
    t.metric('sockets_after', after.sockets)

    t.check('presence delivery p95 under 2 s (load script)', d?.p95_ms != null && d.p95_ms < 2000, d)
    t.check('presence events missed = 0', (d?.missed ?? 1) === 0, d?.missed)
    t.check('record-event delivery p95 under 2 s (probe)', pl.p95 != null && pl.p95 < 2000, pl)
    t.check('no probe event lost', probeLat.filter((x) => x == null).length === 0, probeLat.filter((x) => x == null).length)
    // Server-side event-loop lag (nodejs_eventloop_lag_seconds p99 per scrape) is the verdict;
    // the time:sync round trip also crosses Docker's port forwarding and this generator's own
    // loop, so it is reported only.
    for (const n of socketNodes().filter((x) => atPeak[x]?.at_peak_sockets?.sockets)) {
      const lag = atPeak[n]?.lag_p99_max
      t.check(`${n} event-loop lag p99 (server metric) under 500 ms`, lag != null && lag < 500, { lag_p99_max: lag, rtt: rttPct[n] })
    }
    const leftover = Object.values(after.sockets).reduce((a, b) => a + (b ?? 0), 0)
    t.check('sockets back to the probes only after the load left (no leaked sockets)', leftover <= probes.length + socketNodes().length + 2, after.sockets)
    for (const n of socketNodes()) {
      const m = mem[n]
      if (!m) continue
      if (soak) t.check(`${n} RSS slope during the hold < 1 MiB/min (leak)`, m.hold_slope_mib_per_min != null && m.hold_slope_mib_per_min < 1, m)
      t.check(`${n} RSS after the load within 25% of peak-to-baseline`, m.after <= m.baseline + 0.75 * (m.peak - m.baseline) + 32, m)
    }
    suite.metrics.samples = samples.length
    writeFileSync(resolve(stateDir, `load-samples-${Date.now()}.json`), JSON.stringify({ samples, rtt, probeLat }, null, 0))
  }, { timeoutMs: (rampMin + holdMin + 10) * 60_000 })

  return suite.result()
}

/** Least-squares slope of [x, y] points. */
function regress(pts) {
  const n = pts.length
  const sx = pts.reduce((a, [x]) => a + x, 0)
  const sy = pts.reduce((a, [, y]) => a + y, 0)
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0)
  const sxx = pts.reduce((a, [x]) => a + x * x, 0)
  const d = n * sxx - sx * sx
  return d === 0 ? 0 : (n * sxy - sx * sy) / d
}

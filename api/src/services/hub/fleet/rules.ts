import type { FleetRule } from './settings.js'

/**
 * Version drift: pure rules over what the Hub last saw of every environment. No I/O — the alerts
 * job (alerts.ts) gathers the facts, this file says what fires.
 *
 * Distances are counted in KNOWN releases (releases.ts: the versions the Hub deployed or verified
 * — successful Hub promotions and shared deploys — plus the image's published tags), never in
 * whatever an app reports about itself:
 *
 *  - "newest" = the highest known release (the Hub's own version and apps' self-reported versions
 *    never set it);
 *  - "N behind" = how many known releases lie above an environment's version, up to the newest —
 *    the same count across a minor or major line (0.3.214 → 0.4.0 with 0.4.0 the only newer known
 *    release is 1 behind);
 *  - a version ABOVE the newest known release (a pre-release, a hand-built image, a wrong answer)
 *    is "unverified": it is shown with a flag and never counts for or against a rule.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/
const RELEASE = /^\d+\.\d+\.\d+$/

export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = SEMVER.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** a > b → positive, a < b → negative (x.y.z, numeric). Unparseable versions sort first. */
export function compareVersion(a: string | null, b: string | null): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

/** Known releases: plain x.y.z only, each once, newest first. */
export function knownReleases(versions: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const v of versions) if (typeof v === 'string' && RELEASE.test(v.trim())) out.add(v.trim())
  return [...out].sort((a, b) => compareVersion(b, a))
}

/** The highest known release, or null (nothing known yet). */
export function newestVersion(known: string[]): string | null {
  return known.length ? known[0] : null
}

/** A readable version above every known release (never counted, flagged instead). */
export function isUnverified(version: string | null, known: string[]): boolean {
  const newest = newestVersion(known)
  return !!newest && !!parseVersion(version) && compareVersion(version, newest) > 0
}

/**
 * Known releases above `older`, up to the newest: 0 when it runs the newest, null when the version
 * cannot be read, nothing is known, or it is unverified (above the newest).
 */
export function releasesBehind(older: string | null, known: string[]): number | null {
  const newest = newestVersion(known)
  if (!newest || !parseVersion(older) || isUnverified(older, known)) return null
  return known.filter((k) => compareVersion(k, older) > 0).length
}

/** Known releases between two versions (above the lower, up to the higher); null as above. */
export function releasesApart(a: string | null, b: string | null, known: string[]): number | null {
  if (!newestVersion(known) || !parseVersion(a) || !parseVersion(b)) return null
  if (isUnverified(a, known) || isUnverified(b, known)) return null
  const [lo, hi] = compareVersion(a, b) <= 0 ? [a, b] : [b, a]
  return known.filter((k) => compareVersion(k, lo) > 0 && compareVersion(k, hi) <= 0).length
}

/** One environment as the rules see it. */
export interface DriftFacts {
  app_id: number
  app_key: string
  environment_id: number
  env_key: string
  version: string | null
  /** When this environment was last deployed (Hub deploy success, else the version first seen). */
  deployed_at: string | null
}

export interface DriftFinding {
  rule_id: string
  kind: FleetRule['kind']
  /** Stable per rule: the environment the alert is about (one open alert per rule + environment). */
  subject_key: string
  app_id: number
  environment_id: number
  message: string
}

const DAY_MS = 86_400_000
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Every finding of every enabled rule over known releases `known` (newest first). */
export function evaluateDrift(
  rules: FleetRule[],
  envs: DriftFacts[],
  known: string[],
  now: Date
): DriftFinding[] {
  const out: DriftFinding[] = []
  const newest = newestVersion(known)
  for (const rule of rules) {
    if (!rule.enabled) continue
    const scoped = (e: DriftFacts) => !rule.env_keys.length || rule.env_keys.includes(e.env_key)
    if (rule.kind === 'behind_newest') {
      if (!newest) continue
      for (const e of envs.filter(scoped)) {
        const n = releasesBehind(e.version, known)
        if (n === null || n < rule.n) continue
        out.push({
          rule_id: rule.id,
          kind: rule.kind,
          subject_key: `env:${e.environment_id}`,
          app_id: e.app_id,
          environment_id: e.environment_id,
          message: `${e.app_key}/${e.env_key} runs ${e.version}, ${plural(n, 'release')} behind the newest (${newest}).`
        })
      }
    } else if (rule.kind === 'pair_apart') {
      const byApp = new Map<number, DriftFacts[]>()
      for (const e of envs) byApp.set(e.app_id, [...(byApp.get(e.app_id) ?? []), e])
      for (const list of byApp.values()) {
        const from = list.find((e) => e.env_key === rule.from_key)
        const to = list.find((e) => e.env_key === rule.to_key)
        if (!from || !to) continue
        const n = releasesApart(from.version, to.version, known)
        if (n === null || n <= rule.n) continue
        out.push({
          rule_id: rule.id,
          kind: rule.kind,
          subject_key: `env:${to.environment_id}`,
          app_id: to.app_id,
          environment_id: to.environment_id,
          message: `${from.app_key}: ${from.env_key} runs ${from.version} and ${to.env_key} runs ${to.version} — ${plural(n, 'release')} apart (rule: more than ${rule.n}).`
        })
      }
    } else if (rule.kind === 'stale_deploy') {
      for (const e of envs.filter(scoped)) {
        if (!e.deployed_at) continue
        const at = new Date(e.deployed_at).getTime()
        if (!Number.isFinite(at)) continue
        const days = Math.floor((now.getTime() - at) / DAY_MS)
        if (days < rule.n) continue
        out.push({
          rule_id: rule.id,
          kind: rule.kind,
          subject_key: `env:${e.environment_id}`,
          app_id: e.app_id,
          environment_id: e.environment_id,
          message: `${e.app_key}/${e.env_key} has not been deployed for ${days} days (rule: ${rule.n}).`
        })
      }
    }
  }
  return out
}

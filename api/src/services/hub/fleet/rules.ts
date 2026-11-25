import type { FleetRule } from './settings.js'

/**
 * Version drift: pure rules over what the Hub last saw of every environment. No I/O — the alerts
 * job (alerts.ts) gathers the facts, this file says what fires.
 *
 * "Releases behind" counts patch releases inside one minor line (0.3.200 → 0.3.214 = 14): every
 * Nivaro release moves the patch number. Two different minor (or major) lines are never "a few
 * releases apart" — they count as behind by more than any rule allows (`null` distance).
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/

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

/** The highest parseable version of `versions`, or null. */
export function newestVersion(versions: Array<string | null | undefined>): string | null {
  let best: string | null = null
  for (const v of versions) {
    if (!v || !parseVersion(v)) continue
    if (best === null || compareVersion(v, best) > 0) best = v
  }
  return best
}

/**
 * How many releases `older` is behind `newer`: 0 when it is not behind, the patch distance in
 * one minor line, null when the lines differ (or either cannot be read — then also not 0).
 */
export function releasesBehind(older: string | null, newer: string | null): number | null {
  const a = parseVersion(older)
  const b = parseVersion(newer)
  if (!a || !b) return null
  if (compareVersion(older, newer) >= 0) return 0
  if (a[0] !== b[0] || a[1] !== b[1]) return null
  return b[2] - a[2]
}

/** How many releases two versions are apart either way (null = different lines / unreadable). */
export function releasesApart(a: string | null, b: string | null): number | null {
  return compareVersion(a, b) >= 0 ? releasesBehind(b, a) : releasesBehind(a, b)
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
  /** Stable per rule: what the alert is about (one open alert per rule + subject). */
  subject_key: string
  app_id: number
  environment_id: number | null
  message: string
}

const DAY_MS = 86_400_000

function behindText(n: number | null): string {
  return n === null ? 'a different release line' : `${n} release${n === 1 ? '' : 's'}`
}

/** Every finding of every enabled rule. `newest` = the newest version the fleet (or Hub) runs. */
export function evaluateDrift(
  rules: FleetRule[],
  envs: DriftFacts[],
  newest: string | null,
  now: Date
): DriftFinding[] {
  const out: DriftFinding[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    const scoped = (e: DriftFacts) => !rule.env_keys.length || rule.env_keys.includes(e.env_key)
    if (rule.kind === 'behind_newest') {
      if (!newest) continue
      for (const e of envs.filter(scoped)) {
        if (!e.version || !parseVersion(e.version)) continue
        const n = releasesBehind(e.version, newest)
        if (n === 0 || (n !== null && n < rule.n)) continue
        out.push({
          rule_id: rule.id,
          kind: rule.kind,
          subject_key: `env:${e.environment_id}`,
          app_id: e.app_id,
          environment_id: e.environment_id,
          message: `${e.app_key}/${e.env_key} runs ${e.version}, ${behindText(n)} behind the newest (${newest}).`
        })
      }
    } else if (rule.kind === 'pair_apart') {
      const byApp = new Map<number, DriftFacts[]>()
      for (const e of envs) byApp.set(e.app_id, [...(byApp.get(e.app_id) ?? []), e])
      for (const list of byApp.values()) {
        const from = list.find((e) => e.env_key === rule.from_key)
        const to = list.find((e) => e.env_key === rule.to_key)
        if (!from?.version || !to?.version) continue
        if (!parseVersion(from.version) || !parseVersion(to.version)) continue
        const n = releasesApart(from.version, to.version)
        if (n === 0 || (n !== null && n <= rule.n)) continue
        out.push({
          rule_id: rule.id,
          kind: rule.kind,
          subject_key: `app:${from.app_id}`,
          app_id: from.app_id,
          environment_id: to.environment_id,
          message: `${from.app_key}: ${from.env_key} runs ${from.version} and ${to.env_key} runs ${to.version} — ${behindText(n)} apart (rule: more than ${rule.n}).`
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

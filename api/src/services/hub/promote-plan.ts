import type {
  HubComponent,
  PlanInput,
  PromotionBlocker,
  PromotionBlockerCode,
  PromotionPlan,
  PromotionStep
} from './promote-types.js'

/**
 * Hub promotion planner (phase 2): checks one promotion or rollback and lists its steps. Pure —
 * every fact (status, deploy history, source commits, image digests, driver config) is gathered
 * beforehand into a PlanInput (promote-gather.ts), so the same input always gives the same plan.
 * A promotion deploys nothing unless its plan has zero blockers; the runner re-plans at start.
 *
 * The target's current health is a LINE, never a blocker: an unhealthy target may be exactly what
 * the new version fixes, and the deploy jobs' own canary + gates are the real check. Semantics
 * follow scripts/promote-production.mjs (blockers, three-line pin).
 */

const VERSION_RE = /^\d+\.\d+\.\d+$/

/** Numeric x.y.z order: 0.3.10 > 0.3.9. Missing or non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const realDigest = (d: string | 'present' | null): d is string => !!d && d !== 'present'

/** The pin file: version, image digest, slim digest — one per line (same as promote-production.mjs). */
function pinFor(
  version: string,
  digest: string | 'present' | null,
  slim: string | 'present' | null
): string {
  const d = realDigest(digest) ? `${digest}\n` : ''
  const s = realDigest(digest) && realDigest(slim) ? `${slim}\n` : ''
  return `${version}\n${d}${s}`
}

const STATE_LABEL: Record<string, string> = {
  ok: 'Running',
  degraded: 'Running with warnings',
  unreachable: 'not answering',
  link_refused: 'refusing the Hub link'
}

/** A URL in a plan or log line: origin + path, never the query string. */
export function urlForLog(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    return '(verify URL)'
  }
}

export function buildPromotionPlan(input: PlanInput): PromotionPlan {
  const { target, previous, kind, version } = input
  const blockers: PromotionBlocker[] = []
  const block = (code: PromotionBlockerCode, text: string) => blockers.push({ code, text })
  const versionOk = VERSION_RE.test(version)
  const components = [...input.components].sort((a, b) => a.position - b.position)
  const hasApi = components.some((c) => c.kind === 'api')

  if (!target.hub_managed)
    block(
      'NOT_HUB_MANAGED',
      `${target.key} is not managed by the Hub — turn on Hub-managed for it first`
    )
  if (input.running) block('PROMOTION_RUNNING', `a promotion of ${target.key} is already running`)
  if (!versionOk) block('BAD_VERSION', `"${version}" is not a version (x.y.z)`)
  if (!components.length) block('NO_COMPONENTS', `${target.key} has no components to deploy`)

  if (versionOk) {
    if (kind === 'promote') {
      if (!previous) {
        block(
          'NO_PREVIOUS_ENVIRONMENT',
          `${target.key} is the first environment — there is nothing to promote from`
        )
      } else if (
        input.previousVersion !== version &&
        !input.previousDeployedVersions.includes(version)
      ) {
        block(
          'PREVIOUS_NEVER_RAN',
          `${previous.key} never ran ${version} — neither now nor in a successful deploy`
        )
      }
    } else if (!input.targetDeployedVersions.includes(version)) {
      block(
        'NOT_DEPLOYED_BEFORE',
        `${target.key} never deployed ${version} successfully — nothing to roll back to`
      )
    }
    // Same version again is allowed (promote only) while an api component's source commit is not
    // yet on its target branch: an extension-only change re-stamped on a reused tag.
    const restamp =
      kind === 'promote' &&
      components.some(
        (c) =>
          c.kind === 'api' &&
          !!input.sources[c.position]?.sha &&
          input.sourceOnTarget[c.position] === false
      )
    if (input.targetVersion === version) {
      if (!restamp) block('ALREADY_RUNS', `${target.key} already runs ${version}`)
    } else if (kind === 'promote' && input.targetVersion && VERSION_RE.test(input.targetVersion)) {
      if (compareVersions(version, input.targetVersion) < 0)
        block(
          'OLDER_THAN_CURRENT',
          `${version} is older than ${target.key}'s ${input.targetVersion} — roll back instead`
        )
    }
  }

  const missingDrivers = components.filter((c) => !input.drivers[c.driver_id])
  if (missingDrivers.length)
    block(
      'NO_DRIVER',
      `no deploy driver for ${missingDrivers.map((c) => c.name).join(', ')} — set one on the component`
    )

  if (hasApi) {
    if (!input.digest) block('IMAGE_MISSING', `the image for ${version} is not on the registry`)
    else if (input.digest === 'present')
      block(
        'IMAGE_NO_DIGEST',
        `the registry answered ${version} without a digest — the pin needs one`
      )
  }

  const steps: PromotionStep[] = components.map((c) => stepFor(c, input))
  for (const s of steps) {
    if (s.kind === 'api' && !s.sourceSha)
      block(
        'NO_SOURCE_COMMIT',
        `${s.component}: no commit on ${componentOf(components, s).source_branch} names nivaro ${version}`
      )
    if (s.kind === 'frontend' && !s.sourceSha)
      block(
        'FRONTEND_UNKNOWN',
        `${s.component}: ${previous?.key ?? 'the previous environment'} serves no version this Hub can read`
      )
    else if (s.kind === 'frontend' && input.frontendOnSource[s.position] !== true)
      block(
        'FRONTEND_NOT_ON_SOURCE',
        `${previous?.key ?? 'the previous environment'} serves ${s.sourceSha}, which is not on ${componentOf(components, s).source_branch}`
      )
  }

  return {
    ok: blockers.length === 0,
    blockers,
    lines: linesFor(input, components, steps, blockers.length > 0),
    steps
  }
}

function componentOf(components: HubComponent[], s: PromotionStep): HubComponent {
  return components.find((c) => c.position === s.position) as HubComponent
}

function stepFor(c: HubComponent, input: PlanInput): PromotionStep {
  const driver = input.drivers[c.driver_id]
  const isApi = c.kind === 'api'
  const served = input.frontendServed[c.position] ?? null
  return {
    position: c.position,
    component: c.name,
    kind: c.kind,
    driverId: c.driver_id,
    sourceSha: isApi ? (input.sources[c.position]?.sha ?? null) : served,
    targetBranch: c.target_branch ?? driver?.branch ?? '',
    pinText: isApi ? pinFor(input.version, input.digest, input.slimDigest) : null,
    pinFile: isApi ? (driver?.pin_file ?? null) : null,
    beforeJob: c.before_job,
    deployJob: c.deploy_job ?? driver?.deploy_job ?? '',
    verifyUrl: c.verify_url,
    verifyField: c.verify_field,
    want: isApi ? input.version : (served ?? '')
  }
}

const cap = (name: string) => (name ? name[0].toUpperCase() + name.slice(1) : name)
const shortSha = (sha: string) => sha.slice(0, 7)

/**
 * The plan in plain words. A refused plan (any blocker) lists only the facts — what runs now, what
 * would move, what is missing — because step lines built on missing facts would only print gaps.
 */
function linesFor(
  input: PlanInput,
  components: HubComponent[],
  steps: PromotionStep[],
  refused: boolean
): string[] {
  const { target, previous, version } = input
  const lines: string[] = []
  const state = input.targetState ? STATE_LABEL[input.targetState] : 'not checked yet'
  lines.push(
    `${target.key} is currently ${state}${input.targetVersion ? ` (runs ${input.targetVersion})` : ''}`
  )
  lines.push(
    input.kind === 'promote'
      ? `promote ${version} from ${previous?.key ?? '(none)'} (${previous ? (input.previousVersion ?? 'no answer') : '-'}) to ${target.key}`
      : `roll ${target.key} back from ${input.targetVersion ?? '(unknown)'} to ${version}`
  )
  if (components.some((c) => c.kind === 'api')) {
    const d = input.digest
    lines.push(
      !d
        ? `Image ${version} is missing from Docker Hub`
        : d === 'present'
          ? `Image ${version} is on Docker Hub, but its digest could not be read`
          : `Image ${version} is on Docker Hub${realDigest(input.slimDigest) ? ' (both builds)' : ''}`
    )
  }
  for (const s of steps) {
    const c = componentOf(components, s)
    const name = cap(s.component)
    if (s.kind === 'api') {
      const src = input.sources[s.position]
      lines.push(
        src
          ? `${name}: release commit ${shortSha(src.sha)} (${src.subject})`
          : `${name}: no release commit on ${c.source_branch} names nivaro ${version}`
      )
    } else {
      lines.push(
        s.sourceSha
          ? `${name}: ${previous?.key ?? 'the previous environment'} serves ${shortSha(s.sourceSha)}`
          : `${name}: the served version is unknown`
      )
    }
  }
  if (input.lockUnknown)
    lines.push('Could not check whether a promotion is running — starting checks again')
  if (refused) return lines

  for (const s of steps) {
    const name = cap(s.component)
    lines.push(
      s.kind === 'api'
        ? `${name}: merge it into ${s.targetBranch || 'its target branch'} and record ${version} as the version to run`
        : `${name}: merge ${shortSha(s.sourceSha ?? '')} into ${s.targetBranch || 'its target branch'}`
    )
  }
  steps.forEach((s, i) => {
    const name = cap(s.component)
    const wait = s.beforeJob ? `wait for ${s.beforeJob}, then ` : ''
    lines.push(
      i === 0
        ? `${name}: ${wait}run the ${target.key} deploy job and wait for it`
        : `${name}: after the ${cap(steps[i - 1].component)} deploy passes, ${wait}run its deploy job and wait for it`
    )
  })
  for (const s of steps) {
    const name = cap(s.component)
    lines.push(
      s.verifyUrl
        ? `${name}: check that ${urlForLog(s.verifyUrl)} reports ${s.want} twice in a row`
        : `${name}: no check address is set — the deploy job's own checks are the verification`
    )
  }
  lines.push(
    `The deploy jobs run their own health checks; ${target.key}'s current status does not stop a promotion`
  )
  return lines
}

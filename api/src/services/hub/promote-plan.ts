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

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : '?')

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
  // phase 4: stack components (Docker placements). The first environment of an all-stack app
  // takes any published release (Decision 11) — nothing before it can run one.
  const hasStack = components.some((c) => c.kind === 'stack')
  const firstAllStack = !previous && hasStack && components.every((c) => c.kind === 'stack')

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
        if (!firstAllStack)
          block(
            'NO_PREVIOUS_ENVIRONMENT',
            `${target.key} is the first environment — there is nothing to promote from`
          )
        // phase 4: in place of PREVIOUS_NEVER_RAN (a missing digest says IMAGE_MISSING below).
        else if (input.digest && !(input.registryVersions ?? []).includes(version))
          block('IMAGE_MISSING', `${version} is not a published release of the Nivaro image`)
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

  if (hasApi || hasStack) {
    if (!input.digest) block('IMAGE_MISSING', `the image for ${version} is not on the registry`)
    else if (input.digest === 'present')
      block(
        'IMAGE_NO_DIGEST',
        `the registry answered ${version} without a digest — the pin needs one`
      )
  }

  const steps: PromotionStep[] = components.map((c) =>
    c.kind === 'stack' ? stackStepFor(c, input) : stepFor(c, input)
  )
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

  stackBlockers(input, components, block)

  return {
    ok: blockers.length === 0,
    blockers,
    lines: stackAwareLines(input, components, steps),
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

function linesFor(input: PlanInput, components: HubComponent[], steps: PromotionStep[]): string[] {
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
      `image ${version}: ${!d ? 'MISSING' : d === 'present' ? 'present without a digest' : `${d.slice(0, 19)}…`}${realDigest(d) && realDigest(input.slimDigest) ? ' + slim' : ''}`
    )
  }
  for (const s of steps) {
    const c = componentOf(components, s)
    if (s.kind === 'api') {
      const src = input.sources[s.position]
      lines.push(
        src
          ? `${s.component}: source commit ${short(src.sha)} — ${src.subject}`
          : `${s.component}: no commit on ${c.source_branch} names nivaro ${version}`
      )
    } else {
      lines.push(
        s.sourceSha
          ? `${s.component}: ${previous?.key ?? 'the previous environment'} serves ${s.sourceSha}`
          : `${s.component}: the served version is unknown`
      )
    }
  }
  for (const s of steps) {
    const pin =
      s.kind === 'api'
        ? `, pin ${version}${realDigest(input.digest) ? ' + digest' : ''}${realDigest(input.digest) && realDigest(input.slimDigest) ? ' + slim digest' : ''} in ${s.pinFile ?? '?'}`
        : ''
    lines.push(`${s.component}: merge ${short(s.sourceSha)} into ${s.targetBranch || '?'}${pin}`)
  }
  steps.forEach((s, i) => {
    const after = i > 0 ? `after ${steps[i - 1].component} passed — ` : ''
    const before = s.beforeJob ? `wait for ${s.beforeJob}, ` : ''
    lines.push(`${s.component}: ${after}${before}run ${s.deployJob || '?'}, wait for it`)
  })
  for (const s of steps) {
    lines.push(
      s.verifyUrl
        ? `${s.component}: verify ${urlForLog(s.verifyUrl)} answers ${s.verifyField} = ${s.want || '?'} twice`
        : `${s.component}: no verify URL — the deploy job's gates are the verification`
    )
  }
  if (input.lockUnknown)
    lines.push('Could not check whether a promotion is running — starting checks again')
  lines.push(
    "the deploy jobs' canary and gates are the health check — the target's state above does not block"
  )
  return lines
}

// ---------------------------------------------------------------------------------------------
// phase 4: stack components (Docker placements, deployed through the Hub agent). Kept apart from
// the phase-2 GitLab planning above: a plan with no stack component never reaches this code.

const short12 = (pin: string) => {
  const at = pin.indexOf('@')
  return `${pin.slice(0, at)}@${pin
    .slice(at + 1)
    .replace(/^sha256:/, '')
    .slice(0, 12)}`
}

/** One docker step: no branch, job or pin file — the runner renders the spec and asks the agent. */
function stackStepFor(c: HubComponent, input: PlanInput): PromotionStep {
  const f = input.stacks?.[c.position]
  const base = input.target.base_url.replace(/\/+$/, '')
  return {
    position: c.position,
    component: c.name,
    kind: c.kind,
    driverId: c.driver_id,
    driver: 'docker',
    sourceSha: null,
    targetBranch: '',
    pinText: null,
    pinFile: null,
    beforeJob: null,
    deployJob: '',
    verifyUrl: `${base}/api/version`,
    verifyField: 'version',
    want: input.version,
    stack: {
      name: f?.stackName ?? '',
      image: realDigest(input.digest) && f ? `${f.imageRepo}@${input.digest}` : '',
      size: f?.size ?? 'small',
      extensions: { ...(f?.extensions ?? {}) },
      agentOrigin: f?.agentOrigin ?? ''
    }
  }
}

const listOf = (xs: string[]) => xs.join(', ')

/** Blockers of stack components; also the driver-kind check of every component. */
function stackBlockers(
  input: PlanInput,
  components: HubComponent[],
  block: (code: PromotionBlockerCode, text: string) => void
) {
  const { target, previous, kind, version } = input
  for (const c of components) {
    const d = input.drivers[c.driver_id]
    if (!d) continue
    const docker = d.kind === 'docker'
    if (docker === (c.kind === 'stack')) continue
    block(
      'KIND_DRIVER_MISMATCH',
      c.kind === 'stack'
        ? `${c.name}: a stack deploys through a Docker driver, not a GitLab one`
        : `${c.name}: ${c.kind} components deploy through a GitLab driver, not a Docker one`
    )
  }
  for (const c of components) {
    if (c.kind !== 'stack' || input.drivers[c.driver_id]?.kind !== 'docker') continue
    const f = input.stacks?.[c.position]
    if (!f) {
      block('AGENT_UNREACHABLE', `${c.name}: the Hub agent was not asked about this stack`)
      continue
    }
    const at = `the Hub agent at ${f.agentOrigin ?? '(no address)'}`
    if (!f.stackName)
      block('NO_STACK_NAME', `${c.name}: the placement names no swarm stack — set its stack name`)
    if (f.agent === 'unreachable') block('AGENT_UNREACHABLE', `${at} does not answer`)
    else if (f.agent === 'refused')
      block('AGENT_REFUSED', `${at} refused the Hub — check the driver's agent token`)
    else if (f.agent === 'incompatible')
      block('AGENT_INCOMPATIBLE', `${at} speaks another agent API than this Hub`)
    if (f.agent === 'ok') {
      if (!f.imageAllowed)
        block('IMAGE_NOT_ALLOWED', `${at} does not allow the image ${f.imageRepo}`)
      if (f.disallowedExtensions.length)
        block(
          'EXTENSION_NOT_ALLOWED',
          `${at} does not allow the image of extension ${listOf(f.disallowedExtensions)}`
        )
      if (f.publishPortProblem) block('PUBLISH_PORT_NOT_ALLOWED', f.publishPortProblem)
      if (f.stackState === 'not_hub' || f.stackState === 'other_owner')
        block(
          'STACK_NOT_HUB',
          f.stackState === 'not_hub'
            ? `the swarm already runs a stack named ${f.stackName} that the Hub did not create`
            : `the stack ${f.stackName} belongs to another Hub app or environment`
        )
    }
    if (f.missingExtensions.length)
      block(
        'EXTENSION_UNPINNED',
        kind === 'rollback'
          ? `the ${version} deploy installed no pin for extension ${listOf(f.missingExtensions)}`
          : `${previous?.key ?? target.key} has no pin for extension ${listOf(f.missingExtensions)}`
      )
    if (f.settingsMissing.length)
      block(
        'STACK_SETTINGS_MISSING',
        f.settingsMissing[0] === '(no settings)'
          ? `${target.key} has no stack settings yet`
          : `${target.key}'s stack settings are missing ${listOf(f.settingsMissing)}`
      )
    if (f.hostnameProblems.length) block('HOSTNAME_NOT_ALLOWED', f.hostnameProblems.join(' '))
    if (f.hostnameTaken.length) block('HOSTNAME_TAKEN', f.hostnameTaken.join(' '))
    if (f.renderProblem)
      block(
        f.renderProblem.code === 'TEMPLATE_NONE' ? 'TEMPLATE_NONE' : 'STACK_SETTINGS_INVALID',
        f.renderProblem.text
      )
  }
}

/** The phase-2 lines with each stack step's lines in place of a merge/job/verify for it. */
function stackAwareLines(
  input: PlanInput,
  components: HubComponent[],
  steps: PromotionStep[]
): string[] {
  const docker = steps.filter((s) => s.driver === 'docker')
  if (!docker.length) return linesFor(input, components, steps)
  const gitlab = steps.filter((s) => s.driver !== 'docker')
  const lines = linesFor(
    input,
    components.filter((c) => gitlab.some((s) => s.position === c.position)),
    gitlab
  )
  const tail = lines.pop() as string
  for (const s of docker) lines.push(...stackLines(input, s))
  lines.push(
    gitlab.length
      ? tail
      : "swarm's health checks and the verify above are the health check — the target's state above does not block"
  )
  return lines
}

function stackLines(input: PlanInput, s: PromotionStep): string[] {
  const f = input.stacks?.[s.position]
  const name = s.stack?.name || s.component
  const d = input.digest
  const digest = realDigest(d) ? `${d.slice(0, 19)}…` : !d ? 'image MISSING' : 'no digest'
  const roles = f?.roles?.length
    ? f.roles.map((r) => `${r.role} ×${r.replicas}`).join(', ')
    : 'roles unknown'
  const lines = [
    `stack ${name}: deploy nivaro ${input.version} (${digest}) as ${f?.size ?? '?'}: ${roles} through the agent at ${f?.agentOrigin ?? '?'}`
  ]
  for (const id of Object.keys(s.stack?.extensions ?? {}).sort())
    lines.push(
      `extension ${id}: ${short12((s.stack as { extensions: Record<string, string> }).extensions[id])}`
    )
  if (f?.stackState === 'none')
    lines.push(`stack ${name}: not on the swarm yet — the agent creates it`)
  else if (f?.stackState === 'unknown' && f.agent === 'ok')
    lines.push(`stack ${name}: the agent could not say what runs under this name now`)
  lines.push(
    `stack ${name}: verify ${urlForLog(s.verifyUrl ?? '')} answers version = ${input.version} twice, then the preflight must not fail`
  )
  if (input.drivers[s.driverId]?.dns_mode === 'manual')
    lines.push('the name may not serve yet — the deploy then ends waiting for the name')
  return lines
}

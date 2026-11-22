import { createHash } from 'node:crypto'
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

/**
 * The order a run takes its steps in. A promotion goes by position (the API before the portal);
 * a rollback puts every frontend first, then the API, so people never get the newer portal
 * against the older API while the portal redeploys, and a GitLab refusal of the portal's rerun
 * stops the rollback before the API moved.
 */
export function runOrder<T extends { position: number; kind: 'api' | 'frontend' | 'stack' }>(
  steps: T[],
  kind: 'promote' | 'rollback'
): T[] {
  const rank = (s: T) => (kind === 'rollback' && s.kind === 'frontend' ? 0 : 1)
  return [...steps].sort((a, b) => rank(a) - rank(b) || a.position - b.position)
}

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

  // Apply now (P4-30): the running version again, through the Hub agent only — no promotion
  // checks (it is not a promotion), but every stack check below still applies.
  if (input.apply && components.some((c) => c.kind !== 'stack'))
    block(
      'KIND_DRIVER_MISMATCH',
      `${target.key} has components that do not deploy through a Docker driver — Apply now redeploys stacks only`
    )
  if (versionOk && !input.apply) {
    if (kind === 'promote') {
      if (!previous) {
        if (!firstAllStack)
          block(
            'NO_PREVIOUS_ENVIRONMENT',
            `${target.key} is the first environment — there is nothing to promote from`
          )
        // phase 4: in place of PREVIOUS_NEVER_RAN (a missing digest says IMAGE_MISSING below).
        else if (input.digest && !(input.registryVersions ?? []).includes(version))
          block(
            'IMAGE_MISSING',
            input.registryError
              ? `couldn't read the published releases (${input.registryError}) — ${version} cannot be checked`
              : `${version} is not a published release of the Nivaro image`
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
      if (!restamp && !(kind === 'promote' && unfinished(input, components)))
        block(
          'ALREADY_RUNS',
          hasStack
            ? `${target.key} already runs ${version} — to deploy changed stack settings or extension pins, use Apply now in its stack panel`
            : `${target.key} already runs ${version}`
        )
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

  // A rollback redeploys recorded builds and never pins: the registry does not matter to it
  // (a stack rollback deploys the recorded image digest, P4-29; so does Apply now, P4-30).
  if (kind === 'promote' && !input.apply && (hasApi || hasStack)) {
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
    const onTarget = input.pinOnTarget?.[s.position]
    if (
      s.kind === 'api' &&
      kind === 'promote' &&
      input.targetVersion === version &&
      typeof onTarget === 'string' &&
      s.pinText != null &&
      onTarget !== s.pinText
    )
      block(
        'PIN_CHANGED',
        `${s.component}: the image for ${version} changed since it was deployed — ${target.key} pins ${pinWords(onTarget)}, the registry now has ${pinWords(s.pinText)}. The Hub never rewrites the pin of the version that is running`
      )
    // Read and missing (404): never create a pin for the version that is running.
    if (
      s.kind === 'api' &&
      kind === 'promote' &&
      input.targetVersion === version &&
      onTarget === null &&
      Object.hasOwn(input.pinOnTarget ?? {}, s.position)
    )
      block(
        'PIN_CHANGED',
        `${s.component}: ${target.key} has no recorded pin for ${version} (no ${s.pinFile ?? 'pin file'} on ${s.targetBranch}). The Hub never creates a pin for the version that is running`
      )
    if (s.kind === 'api' && kind === 'rollback') {
      const problem = input.rollbackBuild?.[s.position]?.problem
      if (!s.sourceSha)
        block(
          'ROLLBACK_NOT_RECORDED',
          `${s.component}: the Hub has no record of the build ${target.key} deployed with ${version}`
        )
      else if (problem) block('ROLLBACK_NO_BUILD', `${s.component}: ${problem}`)
      else if (!s.buildPipelineId)
        block(
          'ROLLBACK_NOT_RECORDED',
          `${s.component}: the Hub did not record which pipeline deployed ${version} here, so it cannot redeploy that build`
        )
    } else if (s.kind === 'api' && !s.sourceSha)
      block(
        'NO_SOURCE_COMMIT',
        `${s.component}: no commit on ${componentOf(components, s).source_branch} names nivaro ${version}`
      )
    if (s.kind === 'frontend' && !s.sourceSha)
      kind === 'rollback'
        ? block(
            'ROLLBACK_BUILD_UNKNOWN',
            `${s.component}: the Hub has no record of the build ${target.key} deployed with ${version}`
          )
        : block(
            'FRONTEND_UNKNOWN',
            `${s.component}: ${previous?.key ?? 'the previous environment'} serves no version this Hub can read`
          )
    else if (
      s.kind === 'frontend' &&
      kind === 'promote' &&
      input.frontendHeld?.[s.position] === true &&
      !input.frontendHead?.[s.position]
    )
      block(
        'HEAD_UNKNOWN',
        `${s.component}: ${s.targetBranch} already holds ${s.sourceSha}, but GitLab did not say which commit ${s.targetBranch} points at — the Hub deploys only a head it names in the plan`
      )
    else if (s.kind === 'frontend' && kind === 'rollback') {
      const problem = input.rollbackBuild?.[s.position]?.problem
      if (problem) block('FRONTEND_ROLLBACK_NO_BUILD', `${s.component}: ${problem}`)
    } else if (s.kind === 'frontend' && input.frontendOnSource[s.position] !== true)
      block(
        'FRONTEND_NOT_ON_SOURCE',
        `${previous?.key ?? 'the previous environment'} serves ${s.sourceSha}, which is not on ${componentOf(components, s).source_branch}`
      )
  }

  stackBlockers(input, components, block)

  return {
    ok: blockers.length === 0,
    blockers,
    lines: stackAwareLines(input, components, steps, blockers.length > 0),
    steps,
    plan_hash: planHash(input, steps),
    ...(input.apply ? { apply: true } : {})
  }
}

/**
 * What a confirmation binds to: the kind, the versions, and per step the component, the commits
 * it names (source, expected head, build pipeline), the pin, the branch and the jobs. A start
 * re-plans and refuses (409 PLAN_CHANGED) when this differs from the plan the person saw. The
 * target's health, the log lines and the blockers are not part of it.
 */
export function planHash(input: PlanInput, steps: PromotionStep[]): string {
  const body = {
    kind: input.kind,
    ...(input.apply ? { apply: true } : {}),
    version: input.version,
    from: input.targetVersion,
    steps: [...steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => [
        s.position,
        s.component,
        s.kind,
        // Who deploys it: the driver and the repository it pointed at when planned.
        s.driverId,
        input.drivers[s.driverId]?.identity ?? null,
        s.verifyUrl,
        s.verifyField,
        s.sourceSha,
        s.expectHead ?? null,
        s.buildPipelineId ?? null,
        !!s.noop,
        s.targetBranch,
        s.pinFile,
        s.pinText,
        s.beforeJob,
        s.deployJob,
        s.want,
        // phase 4, docker steps: what the agent is asked to run (a change trips PLAN_CHANGED).
        s.driver ?? 'gitlab',
        s.stack?.name ?? null,
        s.stack?.image ?? null,
        s.stack?.size ?? null,
        s.stack
          ? Object.entries(s.stack.extensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          : null,
        s.stack?.agentOrigin ?? null
      ])
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/**
 * A promotion of the version the target already runs is not finished when a component has no
 * deploy recorded for it here, or a frontend serves something other than the commit it would
 * deploy (and other than what an earlier run of this version deployed): a run stopped between
 * components. Matching is by commit prefix (the served value is a short sha).
 */
function unfinished(input: PlanInput, components: HubComponent[]): boolean {
  const recorded = input.recordedDeploys ?? {}
  const same = (a: string, b: string) =>
    a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))
  for (const c of components) {
    const done = recorded[c.position] ?? []
    if (!done.length) return true
    if (c.kind !== 'frontend') continue
    const served = input.frontendOnTarget?.[c.position]
    const planned = input.frontendServed[c.position]
    if (!served || !planned) continue
    if (!same(served, planned) && !done.some((d) => same(served, d))) return true
  }
  return false
}

/** A pin file in plain words: version, short image digest, short slim digest. */
function pinWords(pin: string): string {
  const [v, d, slim] = pin.split('\n').filter((l) => l.trim())
  const dig = (x: string) => x.replace(/^sha256:/, '').slice(0, 12)
  return `${v ?? '(nothing)'} ${d ? `image ${dig(d)}` : 'with no image digest'}${slim ? `, slim image ${dig(slim)}` : ''}`
}

/** True when an api step has nothing to do: commit held, pin unchanged, version answered. */
function apiNoop(c: HubComponent, input: PlanInput, pinText: string): boolean {
  return (
    input.kind === 'promote' &&
    input.targetVersion === input.version &&
    input.sourceOnTarget[c.position] === true &&
    input.pinOnTarget?.[c.position] === pinText
  )
}

function componentOf(components: HubComponent[], s: PromotionStep): HubComponent {
  return components.find((c) => c.position === s.position) as HubComponent
}

function stepFor(c: HubComponent, input: PlanInput): PromotionStep {
  const driver = input.drivers[c.driver_id]
  const isApi = c.kind === 'api'
  const rollback = input.kind === 'rollback'
  const build = rollback ? input.rollbackBuild?.[c.position] : null
  const served = rollback
    ? (build?.sha ?? (isApi ? null : (input.frontendServed[c.position] ?? null)))
    : (input.frontendServed[c.position] ?? null)
  // A rollback never pins: the recorded build's commit already carries that version's pin.
  const pinText = isApi && !rollback ? pinFor(input.version, input.digest, input.slimDigest) : null
  return {
    position: c.position,
    component: c.name,
    kind: c.kind,
    driverId: c.driver_id,
    ...(driver?.identity ? { driverIdentity: driver.identity } : {}),
    sourceSha: isApi && !rollback ? (input.sources[c.position]?.sha ?? null) : served,
    targetBranch: c.target_branch ?? driver?.branch ?? '',
    pinText,
    pinFile: isApi && !rollback ? (driver?.pin_file ?? null) : null,
    beforeJob: c.before_job,
    deployJob: c.deploy_job ?? driver?.deploy_job ?? '',
    verifyUrl: c.verify_url,
    verifyField: c.verify_field,
    // A rollback's frontend commit is the full sha its deploy ran on; the app answers a short one.
    want: isApi
      ? input.version
      : input.kind === 'rollback'
        ? (served ?? '').slice(0, 8)
        : (served ?? ''),
    ...(isApi && pinText != null && apiNoop(c, input, pinText) ? { noop: true } : {}),
    ...(build?.pipelineId ? { buildPipelineId: build.pipelineId } : {}),
    ...(!isApi && input.kind === 'promote' && input.frontendHeld?.[c.position] === true
      ? { expectHead: input.frontendHead?.[c.position] ?? null }
      : {}),
    ...(isApi && input.kind === 'promote' && input.targetVersion === input.version
      ? { pinMustExist: true }
      : {})
  }
}

/** Names people read as letters, written that way in plan lines. */
const ACRONYMS = new Set(['api', 'ui', 'cms', 'erp', 'sso'])
const cap = (name: string) =>
  !name
    ? name
    : ACRONYMS.has(name.toLowerCase())
      ? name.toUpperCase()
      : name[0].toUpperCase() + name.slice(1)
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
    input.apply
      ? `apply ${target.key}'s saved stack settings and extension pins to the version it runs (${version})`
      : input.kind === 'promote'
        ? `promote ${version} from ${previous?.key ?? '(none)'} (${previous ? (input.previousVersion ?? 'no answer') : '-'}) to ${target.key}`
        : `roll ${target.key} back from ${input.targetVersion ?? '(unknown)'} to ${version}`
  )
  if (input.kind === 'promote' && components.some((c) => c.kind === 'api')) {
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
    if (input.kind === 'rollback') {
      lines.push(
        s.sourceSha
          ? `${name}: ${target.key} deployed build ${shortSha(s.sourceSha)} with ${version}`
          : `${name}: the Hub has no record of the build ${target.key} deployed with ${version}`
      )
    } else if (s.kind === 'api') {
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

  const order = runOrder(steps, input.kind)
  for (const s of order) lines.push(pushLine(input, s))
  const deploying = order.filter((s) => !s.noop)
  deploying.forEach((s, i) => {
    const name = cap(s.component)
    const wait = s.beforeJob ? `wait for ${s.beforeJob}, then ` : ''
    const redo = input.kind === 'rollback'
    const run = redo ? 'rerun the deploy job of that build' : `run the ${target.key} deploy job`
    lines.push(
      i === 0
        ? `${name}: ${redo ? '' : wait}${run} and wait for it`
        : `${name}: after the ${cap(deploying[i - 1].component)} deploy passes, ${redo ? '' : wait}${redo ? run : 'run its deploy job'} and wait for it`
    )
  })
  for (const s of order) {
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
      // A rollback deploys the image the Hub recorded for that version here (P4-29); a promote
      // the registry's digest for the tag, read at plan time.
      image:
        input.kind === 'rollback' || input.apply
          ? (f?.deployedImage ?? '')
          : realDigest(input.digest) && f
            ? `${f.imageRepo}@${input.digest}`
            : '',
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
  const versionOk = VERSION_RE.test(version)
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
      // A bad version is not gathered (BAD_VERSION says why); otherwise it should have been.
      if (versionOk)
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
    if ((kind === 'rollback' || input.apply) && f.recordedImageProblem)
      block(f.recordedImageProblem.code, f.recordedImageProblem.text)
    if (f.extensionsUnreadable) block('EXTENSION_UNPINNED', f.extensionsUnreadable)
    else if (f.missingExtensions.length)
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
  steps: PromotionStep[],
  refused: boolean
): string[] {
  const docker = steps.filter((s) => s.driver === 'docker')
  if (!docker.length) return linesFor(input, components, steps, refused)
  const gitlab = steps.filter((s) => s.driver !== 'docker')
  const lines = linesFor(
    input,
    components.filter((c) => gitlab.some((s) => s.position === c.position)),
    gitlab,
    refused
  )
  // A refused plan lists only facts: linesFor then ends without its closing line.
  const tail = refused ? null : (lines.pop() as string)
  for (const s of docker) lines.push(...stackLines(input, s))
  if (tail === null) return lines
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
  const recorded = input.kind === 'rollback' || input.apply ? s.stack?.image || null : null
  const digest =
    input.kind === 'rollback' || input.apply
      ? recorded
        ? `the recorded image ${short12(recorded)}`
        : 'no recorded image'
      : realDigest(d)
        ? `${d.slice(0, 19)}…`
        : !d
          ? 'image MISSING'
          : 'no digest'
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
    lines.push(
      `stack ${name}: the agent could not say what runs under this name now — the deploy may be refused`
    )
  lines.push(
    `stack ${name}: verify ${urlForLog(s.verifyUrl ?? '')} answers version = ${input.version} twice, then the preflight must not fail`
  )
  if (input.drivers[s.driverId]?.dns_mode === 'manual')
    lines.push('the name may not serve yet — the deploy then ends waiting for the name')
  return lines
}

/** What the push of one step does, in plain words. */
function pushLine(input: PlanInput, s: PromotionStep): string {
  const name = cap(s.component)
  const branch = s.targetBranch || 'its target branch'
  const { version } = input
  const held = input.sourceOnTarget[s.position] === true
  if (input.kind === 'rollback')
    return `${name}: redeploy ${s.component}'s build ${shortSha(s.sourceSha ?? '')}`
  if (s.kind === 'api') {
    if (s.noop)
      return `${name}: ${branch} already holds the release commit and pins ${version} — nothing to do`
    if (held)
      return `${name}: ${branch} already holds the release commit — record ${version} as the version to run`
    return `${name}: merge it into ${branch} and record ${version} as the version to run`
  }
  const sha = shortSha(s.sourceSha ?? '')
  if (input.frontendHeld?.[s.position] === true)
    return `${name}: ${branch} already holds ${sha} — deploy ${branch}'s current head${s.expectHead ? ` ${shortSha(s.expectHead)}` : ''}`
  return `${name}: merge ${sha} into ${branch}`
}

import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'

/**
 * Runbook declarations (#720) as an extension's default export carries them,
 * normalized: anything unsafe is dropped, never repaired. Kept out of
 * loader.ts so the host agent (scripts/runbook-agent.ts) can read the
 * declarations without loading the whole extension machinery.
 */

const RUNBOOK_KEY = /^[a-z0-9][a-z0-9-]{0,60}$/
const ARG = /^[A-Za-z0-9_.,:=@/-]{1,200}$/
const PHASE_KEY = /^[a-z0-9][a-z0-9_-]{0,40}$/
/** What a `command` may start with — a shell or node, never an arbitrary binary. */
const COMMAND_HEADS = new Set(['bash', 'sh', 'node', 'npx', 'tsx'])

/** A path inside the extension's own folder, with a script-like extension. */
function inExtension(extId: string, path: string, exts: RegExp): boolean {
  return path.startsWith(`extensions/${extId}/`) && !path.includes('..') && exts.test(path)
}

/** A `command` argv: allowed head, safe args, and one file inside the extension. */
export function normalizeRunbookCommand(extId: string, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 30) return undefined
  if (!raw.every((a) => typeof a === 'string' && ARG.test(a))) return undefined
  const cmd = raw as string[]
  if (!COMMAND_HEADS.has(cmd[0])) return undefined
  const names = cmd.slice(1).some((a) => inExtension(extId, a, /\.(ts|mjs|js|sh)$/))
  return names ? cmd : undefined
}

function normalizePhases(raw: unknown): Array<{ key: string; label: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ key: string; label: string }> = []
  for (const p of raw.slice(0, 30)) {
    const key = typeof p?.key === 'string' ? p.key : ''
    if (!PHASE_KEY.test(key) || out.some((x) => x.key === key)) continue
    out.push({ key, label: typeof p.label === 'string' && p.label ? p.label.slice(0, 80) : key })
  }
  return out
}

/** History directories: relative to the repository root, plain segments only. */
function normalizeHistoryDirs(raw: unknown): Array<{ path: string; mode: 'dry' | 'go' }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ path: string; mode: 'dry' | 'go' }> = []
  for (const d of raw.slice(0, 5)) {
    const path = typeof d?.path === 'string' ? d.path : ''
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split('/').includes('..'))
      continue
    out.push({ path, mode: d.mode === 'dry' ? 'dry' : 'go' })
  }
  return out
}

/** Runbook declarations that name a script (or command) inside the extension's own folder. */
export function normalizeRunbooks(extId: string, raw: unknown): ExtensionRunbookDecl[] {
  if (!Array.isArray(raw)) return []
  const out: ExtensionRunbookDecl[] = []
  const args = (a: unknown) =>
    Array.isArray(a) ? a.filter((x) => typeof x === 'string' && ARG.test(x)) : []
  for (const r of raw.slice(0, 20)) {
    const key = typeof r?.key === 'string' ? r.key : ''
    if (!RUNBOOK_KEY.test(key)) continue
    const rawScript = typeof r?.script === 'string' ? r.script : ''
    const script = rawScript && inExtension(extId, rawScript, /\.(ts|mjs|js)$/) ? rawScript : ''
    const command = r?.command === undefined ? undefined : normalizeRunbookCommand(extId, r.command)
    // A declared but unsafe script or command drops the runbook entirely.
    if (rawScript && !script) continue
    if (r?.command !== undefined && !command) continue
    if (!script && !command) continue
    const phases = normalizePhases(r.phases)
    const history = normalizeHistoryDirs(r.history_dirs)
    out.push({
      key,
      label: typeof r.label === 'string' ? r.label.slice(0, 120) : key,
      description: typeof r.description === 'string' ? r.description.slice(0, 600) : undefined,
      ...(script ? { script } : {}),
      ...(command ? { command } : {}),
      runs_on: r.runs_on === 'host' ? 'host' : 'local',
      ...(phases.length ? { phases } : {}),
      ...(history.length ? { history_dirs: history } : {}),
      dry_args: args(r.dry_args),
      go_args: args(r.go_args),
      resume_flag:
        typeof r.resume_flag === 'string' && /^--[a-z-]{1,30}$/.test(r.resume_flag)
          ? r.resume_flag
          : undefined,
      target_env:
        typeof r.target_env === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(r.target_env)
          ? r.target_env
          : undefined,
      refuse_targets: Array.isArray(r.refuse_targets)
        ? r.refuse_targets.filter((t: unknown) => typeof t === 'string').slice(0, 20)
        : undefined,
      ...(r.skip_dry_gate === true ? { skip_dry_gate: true } : {})
    })
  }
  return out
}

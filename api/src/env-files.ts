import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Secrets from files (#1084). Runs before config.ts parses the environment,
 * so credentials can leave `.env` and the process environment of a stack file.
 *
 * Two sources, both landing in the environment variable they name:
 *
 *   X_FILE=/path   the variable X is read from that file (the Docker image
 *                  convention). Set X or X_FILE, not both.
 *   /run/secrets   every file whose name is an environment-variable name
 *                  (A-Z, 0-9, _) becomes that variable — Docker Swarm mounts a
 *                  secret there under its `target` name. Override the folder
 *                  with NIVARO_SECRETS_DIR; `off` turns it off.
 *
 * A secret file wins over a value already in the environment (a `.env` line
 * left behind should never shadow the mounted secret) and says so in the log,
 * naming the variable but never the value. One trailing newline is dropped,
 * since `echo value > file` adds one. A file that cannot be read stops the
 * process: starting without a credential it was told to use is worse.
 */

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const DEFAULT_DIR = '/run/secrets'

export interface EnvFileResult {
  /** Variables set from a file, with where each came from. */
  loaded: { name: string; source: string }[]
  /** Variables whose existing non-empty value a file replaced. */
  replaced: string[]
  /** Problems that should stop the process. */
  errors: string[]
}

function readSecret(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '')
}

export function loadEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  opts: { secretsDir?: string | null } = {}
): EnvFileResult {
  const out: EnvFileResult = { loaded: [], replaced: [], errors: [] }
  const set = (name: string, value: string, source: string) => {
    const before = env[name]
    if (before && before !== value) out.replaced.push(name)
    env[name] = value
    out.loaded.push({ name, source })
  }

  // 1. The secrets folder.
  const dirSetting = opts.secretsDir !== undefined ? opts.secretsDir : env.NIVARO_SECRETS_DIR
  const dir = dirSetting === 'off' || dirSetting === null ? null : dirSetting || DEFAULT_DIR
  if (dir && existsSync(dir)) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch (err) {
      out.errors.push(`Cannot list ${dir}: ${(err as Error).message}`)
    }
    for (const name of names.sort()) {
      if (!ENV_NAME.test(name)) continue
      const path = join(dir, name)
      try {
        if (!statSync(path).isFile()) continue
        set(name, readSecret(path), path)
      } catch (err) {
        out.errors.push(`Cannot read secret ${path}: ${(err as Error).message}`)
      }
    }
  }

  // 2. X_FILE variables — explicit, so they win over the folder.
  for (const key of Object.keys(env).sort()) {
    if (!key.endsWith('_FILE')) continue
    const name = key.slice(0, -'_FILE'.length)
    const path = env[key]
    if (!ENV_NAME.test(name) || !path) continue
    const fromDir = out.loaded.some((l) => l.name === name)
    if (env[name] && !fromDir) {
      out.errors.push(`Both ${name} and ${key} are set — set one of them`)
      continue
    }
    try {
      set(name, readSecret(path), key)
    } catch (err) {
      out.errors.push(`Cannot read ${key} (${path}): ${(err as Error).message}`)
    }
  }
  return out
}

/** Load secret files into process.env; exit on an unreadable one. */
export function applyEnvFiles(): void {
  const r = loadEnvFiles(process.env)
  for (const name of r.replaced) {
    console.warn(`[config] ${name} was set in the environment; the secret file replaces it`)
  }
  if (r.loaded.length) {
    console.log(`[config] secrets from files: ${r.loaded.map((l) => l.name).join(', ')}`)
  }
  if (r.errors.length) {
    console.error('Invalid environment configuration:')
    for (const e of r.errors) console.error(`  ${e}`)
    process.exit(1)
  }
}

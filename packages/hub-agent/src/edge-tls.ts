/**
 * Edge TLS (agent 0.2.5): a certificate the Hub hands a stack (an ACME certificate's `fullchain`
 * and `private_key`, bound to the stack secrets EDGE_TLS_CERT / EDGE_TLS_KEY) served by Traefik.
 *
 * How it reaches Traefik, with no restart of anything:
 * - The agent writes ONE file per stack, `nvh-<stack>.yml`, into HUB_AGENT_TRAEFIK_DYNAMIC_DIR, the
 *   folder Traefik's file provider watches (`providers.file.directory` + `watch: true`). The file
 *   lists the certificate and key INLINE (Traefik's `certFile` / `keyFile` take a path or the PEM
 *   itself), so one atomic rename swaps both at once: Traefik never reads a new certificate beside
 *   an old key. A renewal rewrites the file; Traefik reloads its certificate store on the file
 *   event. No service, Traefik's included, is updated for it.
 * - The stack's routers then carry `tls=true` and no certresolver (render.ts): Traefik picks the
 *   certificate from its store by the name the client asks for (SNI).
 * - Swarm secrets or configs were not used: Traefik would have to mount them, and changing a
 *   service's mounts restarts it — every app behind that Traefik would drop for the restart.
 *
 * The key is never logged, never echoed in an answer and never part of the stack hash text (the
 * hash takes a keyed digest of it, names.ts). Pure validation + a small file seam (EdgeTlsFs) the
 * tests replace; nothing here talks to Docker.
 */
import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { StackError } from './errors.js'

export type EdgeTls = { cert: string; key: string }

/** Each of `cert` / `key` (the agent's secret cap). */
export const EDGE_TLS_MAX_BYTES = 65536
/** Certificates in one chain (leaf + intermediates). */
export const EDGE_TLS_MAX_CERTS = 10
/** File mode of the per-stack file: it holds a private key. */
export const EDGE_TLS_FILE_MODE = 0o600

export type EdgeTlsCode =
  | 'UNKNOWN_FIELD'
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'TLS_BAD'
  | 'TLS_KEY_MISMATCH'
  | 'TLS_NAME_NOT_COVERED'
  | 'TLS_NAME_OUTSIDE_STACK'

export type EdgeTlsCheck =
  | { ok: true; tls: EdgeTls }
  | { ok: false; fields: Array<{ field: string; code: EdgeTlsCode }> }

const KEY_LABELS = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY']

type Block = { label: string; body: string }

/**
 * The text as PEM blocks, nothing else (whitespace between blocks only): every body line is
 * base64 (so the YAML file can hold it verbatim, and no Traefik template marker can ride in),
 * no headers (an encrypted legacy key has some, and Traefik could not use it anyway). null =
 * anything else.
 */
export function pemBlocks(text: string): Block[] | null {
  const s = text.replace(/\r\n/g, '\n').trim()
  const re =
    /-----BEGIN ([A-Z0-9]+(?: [A-Z0-9]+)*)-----\n((?:[A-Za-z0-9+/]{1,76}={0,2}\n)+)-----END \1-----/y
  const out: Block[] = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    re.lastIndex = i
    const m = re.exec(s)
    if (!m) return null
    out.push({ label: m[1], body: m[2] })
    i = re.lastIndex
  }
  return out
}

const pem = (b: Block) => `-----BEGIN ${b.label}-----\n${b.body}-----END ${b.label}-----\n`

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A DNS name compared as Traefik's store does: case-insensitive, a trailing dot the same name. */
export const normName = (n: string): string => n.toLowerCase().replace(/\.$/, '')

const SAN_DNS_RE = /^[A-Za-z0-9*_-]+(?:\.[A-Za-z0-9*_-]+)*\.?$/

/**
 * The names a leaf answers for: its DNS SANs, or its CN when it has no SAN at all (what a TLS
 * client falls back to). null = a SAN entry that is not a plain DNS name (an IP address, a URI, an
 * email, a quoted value Node escaped): such a leaf is never served from the shared store.
 */
export function leafNames(leaf: X509Certificate): string[] | null {
  const san = leaf.subjectAltName
  if (san !== undefined && san !== '') {
    const out: string[] = []
    for (const part of san.split(', ')) {
      if (!part.startsWith('DNS:')) return null
      const name = part.slice(4)
      if (!SAN_DNS_RE.test(name)) return null
      out.push(normName(name))
    }
    return out
  }
  const cns = (leaf.subject ?? '')
    .split('\n')
    .filter((l) => l.startsWith('CN='))
    .map((l) => l.slice(3))
  if (cns.some((n) => !SAN_DNS_RE.test(n))) return null
  return cns.map(normName)
}

function underSuffix(h: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => {
    const suffix = s.startsWith('.') ? s.toLowerCase() : `.${s.toLowerCase()}`
    return suffix.length > 1 && h.length > suffix.length && h.endsWith(suffix)
  })
}

/**
 * A spec's `edge_tls`, checked and normalised (only the PEM blocks, LF line ends): the chain is
 * 1–10 CERTIFICATE blocks, the key exactly one unencrypted private key (an `EC PARAMETERS` block
 * beside it is dropped), the key belongs to the leaf certificate, and the leaf covers every name
 * the stack routes (a wildcard covers one label).
 *
 * And the reverse (security review 2026-11-27): Traefik's file-provider certificate store is
 * ONE store for every router and picks by SNI, so a leaf that also names another stack's host (or
 * a wildcard over it) would take over TLS for that stack. Every name the leaf answers for (DNS
 * SANs, else the CN) must be one of THIS stack's hostnames, compared case-insensitively with a
 * trailing dot ignored; a wildcard only when that exact wildcard is a stack hostname (the
 * validator never lets one be, so in practice never); no IP or other SAN kinds; and, with host
 * suffixes, every name under one of them. Else TLS_NAME_OUTSIDE_STACK. Codes only, never a name.
 */
export function checkEdgeTls(
  v: unknown,
  hostnames: readonly string[],
  opts: { hostSuffixes?: readonly string[] } = {}
): EdgeTlsCheck {
  const fields: Array<{ field: string; code: EdgeTlsCode }> = []
  if (!isPlainObject(v)) return { ok: false, fields: [{ field: 'edge_tls', code: 'REQUIRED' }] }
  for (const k of Object.keys(v))
    if (k !== 'cert' && k !== 'key')
      fields.push({ field: `edge_tls.${k.slice(0, 64)}`, code: 'UNKNOWN_FIELD' })
  const text = (k: 'cert' | 'key'): string | null => {
    const s = v[k]
    if (typeof s !== 'string' || s === '') {
      fields.push({ field: `edge_tls.${k}`, code: 'REQUIRED' })
      return null
    }
    if (Buffer.byteLength(s, 'utf8') > EDGE_TLS_MAX_BYTES) {
      fields.push({ field: `edge_tls.${k}`, code: 'TOO_LONG' })
      return null
    }
    return s
  }
  const certText = text('cert')
  const keyText = text('key')

  let cert: string | null = null
  if (certText !== null) {
    const blocks = pemBlocks(certText)
    if (
      !blocks ||
      blocks.length === 0 ||
      blocks.length > EDGE_TLS_MAX_CERTS ||
      blocks.some((b) => b.label !== 'CERTIFICATE')
    )
      fields.push({ field: 'edge_tls.cert', code: 'TLS_BAD' })
    else cert = blocks.map(pem).join('')
  }
  let key: string | null = null
  if (keyText !== null) {
    const blocks = pemBlocks(keyText)
    const keys = (blocks ?? []).filter((b) => KEY_LABELS.includes(b.label))
    const other = (blocks ?? []).filter(
      (b) => !KEY_LABELS.includes(b.label) && b.label !== 'EC PARAMETERS'
    )
    if (!blocks || keys.length !== 1 || other.length > 0)
      fields.push({ field: 'edge_tls.key', code: 'TLS_BAD' })
    else key = pem(keys[0])
  }
  if (fields.length > 0 || cert === null || key === null) return { ok: false, fields }

  let leaf: X509Certificate
  try {
    leaf = new X509Certificate(cert)
  } catch {
    return { ok: false, fields: [{ field: 'edge_tls.cert', code: 'TLS_BAD' }] }
  }
  let keyObject: ReturnType<typeof createPrivateKey>
  try {
    keyObject = createPrivateKey(key)
  } catch {
    return { ok: false, fields: [{ field: 'edge_tls.key', code: 'TLS_BAD' }] }
  }
  if (!leaf.checkPrivateKey(keyObject))
    return { ok: false, fields: [{ field: 'edge_tls.key', code: 'TLS_KEY_MISMATCH' }] }
  hostnames.forEach((h, i) => {
    if (leaf.checkHost(normName(h)) === undefined)
      fields.push({ field: `hostnames[${i}]`, code: 'TLS_NAME_NOT_COVERED' })
  })
  const own = new Set(hostnames.map(normName))
  const names = leafNames(leaf)
  const suffixes = opts.hostSuffixes ?? []
  const outside =
    names === null ||
    names.length === 0 ||
    names.some(
      (n) =>
        !own.has(n) || (suffixes.length > 0 && !underSuffix(n.replace(/^\*\./, 'x.'), suffixes))
    )
  if (outside) fields.push({ field: 'edge_tls.cert', code: 'TLS_NAME_OUTSIDE_STACK' })
  if (fields.length > 0) return { ok: false, fields }
  return { ok: true, tls: { cert, key } }
}

/** sha256 hex of the chain (public): what the file header and the logs may name. */
export function certFingerprint(cert: string): string {
  return createHash('sha256').update(cert).digest('hex')
}

// ── the Traefik dynamic file ─────────────────────────────────────────────

/** `nvh-<stack>.yml`: a stack name holds only a–z, 0–9 and `-`, so it is a plain file name. */
export const edgeTlsFileName = (stack: string) => `nvh-${stack}.yml`

const indent = (text: string, n: number) =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => `${' '.repeat(n)}${l}`)
    .join('\n')

/**
 * The file Traefik's file provider reads (v2 and v3 read it alike): one certificate in the
 * default store, PEM inline as YAML block scalars. Only validated PEM lines go in.
 */
export function edgeTlsFileText(stack: string, tls: EdgeTls): string {
  return [
    `# Written by the Nivaro Hub agent for stack ${stack}. Replaced on every apply; do not edit.`,
    `# certificate sha256: ${certFingerprint(tls.cert)}`,
    'tls:',
    '  certificates:',
    '    - certFile: |',
    indent(tls.cert, 8),
    '      keyFile: |',
    indent(tls.key, 8),
    ''
  ].join('\n')
}

/** File access to the dynamic folder; tests pass a fake. */
export type EdgeTlsFs = {
  /** The file's text (O_NOFOLLOW), or null when there is none (a link reads as different). */
  read(path: string): Promise<string | null>
  /** A new file next to `path` (O_CREAT|O_EXCL|O_NOFOLLOW, 0600), then renamed over `path`. */
  writeAtomic(path: string, text: string): Promise<void>
  /** true = removed, false = there was none. */
  remove(path: string): Promise<boolean>
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export const defaultEdgeTlsFs: EdgeTlsFs = {
  async read(path) {
    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      fh = await open(path, constants.O_RDONLY | NOFOLLOW)
      return await fh.readFile('utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      // A link (ELOOP) or anything unreadable: write it fresh (rename replaces the entry itself).
      if (code === 'ELOOP') return '\0'
      throw err
    } finally {
      await fh?.close().catch(() => {})
    }
  },
  async writeAtomic(path, text) {
    // `.tmp`: Traefik's file provider reads only .yml / .yaml / .toml files of the folder.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW
    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      fh = await open(tmp, flags, EDGE_TLS_FILE_MODE)
      await fh.writeFile(text, 'utf8')
      await fh.sync()
      await fh.close()
      fh = null
      await rename(tmp, path)
    } catch (err) {
      await fh?.close().catch(() => {})
      await unlink(tmp).catch(() => {})
      throw err
    }
  },
  async remove(path) {
    try {
      await unlink(path)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }
}

const writeFailed = () =>
  new StackError(
    500,
    'EDGE_TLS_WRITE_FAILED',
    'The agent could not write the certificate file Traefik reads (HUB_AGENT_TRAEFIK_DYNAMIC_DIR)'
  )

/** Writes the stack's file when its text differs; never logs or answers the text. */
export async function ensureEdgeTlsFile(
  dir: string,
  stack: string,
  tls: EdgeTls,
  fs: EdgeTlsFs = defaultEdgeTlsFs
): Promise<'written' | 'unchanged'> {
  const path = join(dir, edgeTlsFileName(stack))
  const text = edgeTlsFileText(stack, tls)
  try {
    if ((await fs.read(path)) === text) return 'unchanged'
    await fs.writeAtomic(path, text)
    return 'written'
  } catch {
    throw writeFailed()
  }
}

/** Removes the stack's file (its routers went back to the cert resolver, or it was removed). */
export async function removeEdgeTlsFile(
  dir: string,
  stack: string,
  fs: EdgeTlsFs = defaultEdgeTlsFs
): Promise<boolean> {
  try {
    return await fs.remove(join(dir, edgeTlsFileName(stack)))
  } catch {
    throw writeFailed()
  }
}

// One deploy key per created app (phase 3, ruling P3-16): an ed25519 key pair the Hub makes when
// it creates the deploy repository. The private half goes to GitLab once, as the app project's
// masked + protected variable DEPLOY_SSH_KEY (base64 of the OpenSSH key text, as deploy.sh
// reads it); the Hub never stores it, logs it or answers it. The public half and its
// fingerprint (keyid=) are what the operator installs on the swarm manager, as the template
// README says: one authorized_keys line per app (forced command, restrict) and one
// /etc/nivaro-hub-deploy/keys/<app>.conf with the app's exact stack= and host= lines.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'

export interface DeployKeyPair {
  /** `ssh-ed25519 <base64> <comment>` */
  publicKey: string
  /** OpenSSH private key text (unencrypted). Never stored, never logged. */
  privateKey: string
  /** `SHA256:<base64, no padding>` — what `ssh-keygen -lf` prints. */
  keyid: string
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const sshString = (v: Buffer | string) => {
  const b = typeof v === 'string' ? Buffer.from(v) : v
  return Buffer.concat([u32(b.length), b])
}

const COMMENT = /^[a-z0-9][a-z0-9.-]{0,80}$/

/** A new ed25519 key pair in OpenSSH format. `comment` is a short plain name. */
export function generateDeployKey(comment: string): DeployKeyPair {
  if (!COMMENT.test(comment)) throw new Error('A deploy key comment is a short plain name.')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url')
  const seed = Buffer.from(String(privateKey.export({ format: 'jwk' }).d), 'base64url')
  if (pub.length !== 32 || seed.length !== 32) throw new Error('Unexpected ed25519 key size.')

  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomBytes(4)
  let section = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment)
  ])
  const pad: number[] = []
  for (let i = 1; (section.length + pad.length) % 8 !== 0; i++) pad.push(i)
  section = Buffer.concat([section, Buffer.from(pad)])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(blob),
    sshString(section)
  ])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return {
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    keyid: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
  }
}

const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2} [a-z0-9][a-z0-9.-]{0,80}$/
const KEYID = /^SHA256:[A-Za-z0-9+/]{43}$/

/**
 * What the operator installs on the swarm manager for one app (template README, "Per app"):
 * the authorized_keys line (forced command with the app and keyid=) and the key configuration
 * with the app's exact stack= and host= lines. Names only; the public key is not a secret.
 */
export function managerLines(o: {
  appKey: string
  publicKey: string
  keyid: string
  stacks: string[]
  hosts: string[]
  network: string
  image: string
}): { authorized_keys: string; key_conf: string; key_conf_path: string } {
  if (!PUBLIC_KEY.test(o.publicKey) || !KEYID.test(o.keyid))
    throw new Error('Not a Hub deploy key.')
  const authorized_keys = `command="/usr/local/bin/nivaro-hub-deploy ${o.appKey} keyid=${o.keyid}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict ${o.publicKey}`
  const conf = [
    ...[...new Set(o.stacks)].map((s) => `stack=${s}`),
    ...[...new Set(o.hosts)].map((h) => `host=${h}`),
    `network=${o.network}`,
    `image=${o.image}`
  ]
  return {
    authorized_keys,
    key_conf: `${conf.join('\n')}\n`,
    key_conf_path: `/etc/nivaro-hub-deploy/keys/${o.appKey}.conf`
  }
}

// Image digests for pin files — twin of hubDigest/pinText in scripts/promote-production.mjs.
import { fetchJson } from '../gitlab-client.js'

export function hubImage(): string {
  return process.env.HUB_IMAGE || 'nodeworks/nivaro'
}

/** The tag's image index digest on Docker Hub: sha256:…, 'present' (no digest given), null (missing). */
export async function imageDigest(image: string, tag: string): Promise<string | 'present' | null> {
  const [ns, name] = image.split('/')
  try {
    const res = await fetchJson(
      `https://hub.docker.com/v2/repositories/${ns}/${name}/tags/${encodeURIComponent(tag)}`,
      {},
      15_000
    )
    if (res.status !== 200) return null
    const digest = (res.body as { digest?: unknown } | null)?.digest
    return typeof digest === 'string' && digest.startsWith('sha256:') ? digest : 'present'
  } catch {
    return null
  }
}

/** Pin file text: "<version>\n[<digest>\n][<slim>\n]"; slim only when both digests are real. */
export function pinText(version: string, digest: string | null, slimDigest: string | null): string {
  const real = Boolean(digest && digest !== 'present')
  const slimPinned = real && Boolean(slimDigest && slimDigest !== 'present')
  return `${version}\n${real ? `${digest}\n` : ''}${slimPinned ? `${slimDigest}\n` : ''}`
}

import { type ChipTone, ToneChip } from '../hub-parts'

/** The security tabs' small status chip (tone + words; never colour alone): the hub ToneChip. */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'live'
const TONE: Record<Tone, ChipTone> = {
  neutral: 'neutral',
  good: 'ok',
  warn: 'warn',
  bad: 'down',
  live: 'live'
}

export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <ToneChip tone={TONE[tone]}>{children}</ToneChip>
}

/** "in 3 h 10 min" / "in 2 days" for a time ahead; "now" once it has passed. Pure. */
export function untilWords(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'now'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  return `in ${Math.round(h / 24)} days`
}

/** What an app or a name check answered, in words (the code itself stays in the tooltip). */
const CODE_WORDS: Record<string, string> = {
  LINK_MISSING: 'it has no security link (Nivaro before 0.3.215, or no hub token there)',
  LINK_REFUSED: 'it refused the Hub’s token',
  LINK_UNREACHABLE: 'it could not be reached',
  TIMEOUT: 'it did not answer in time',
  LINK_BAD_ANSWER: 'its answer could not be read',
  ENOTFOUND: 'No DNS record',
  EAI_AGAIN: 'DNS did not answer',
  DNS_TIMEOUT: 'DNS did not answer in time',
  TLS_TIMEOUT: 'No answer on the TLS port',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection dropped',
  ERR_TLS_CERT_ALTNAME_INVALID: 'Certificate is for another name',
  CERT_HAS_EXPIRED: 'Certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'Issued by a private CA',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Issuer not trusted',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Issuer not trusted',
  NO_CERTIFICATE: 'No certificate presented'
}

export const codeWords = (code: string | null | undefined, fallback = 'error'): string =>
  code ? (CODE_WORDS[code] ?? fallback) : fallback

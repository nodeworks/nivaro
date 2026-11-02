/**
 * Is this sign-in a person signed in as themselves, like a browser session? A session, or a
 * first-party phone app's token (`device`, nvd_) — the phone is a session everywhere except
 * minting credentials (middleware/authenticate.ts credentialMintRefusal).
 */
export const SESSION_LIKE_AUTH = ['session', 'device'] as const

export function isSessionLike(authMethod: string | null | undefined): boolean {
  return (SESSION_LIKE_AUTH as readonly string[]).includes(authMethod ?? '')
}

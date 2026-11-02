/**
 * Is this sign-in a person signed in as themselves, like a browser session? A session, or a
 * first-party phone app's token (`device`, nvd_) — the phone is a session everywhere except
 * minting credentials (middleware/authenticate.ts credentialMintRefusal).
 */
export function isSessionLike(authMethod: string | null | undefined): boolean {
  return authMethod === 'session' || authMethod === 'device'
}

import sodium from 'libsodium-wrappers'

/**
 * GitHub Actions secrets are written as a libsodium sealed box (crypto_box_seal) of the value
 * under the repository's (or environment's) public key. Never hand-rolled: libsodium only.
 */
export async function sealSecretValue(plain: string, publicKeyBase64: string): Promise<string> {
  await sodium.ready
  const variant = sodium.base64_variants.ORIGINAL
  const key = sodium.from_base64(publicKeyBase64, variant)
  const sealed = sodium.crypto_box_seal(sodium.from_string(plain), key)
  return sodium.to_base64(sealed, variant)
}

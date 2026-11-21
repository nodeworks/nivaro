import { decryptValue, encryptValue, isEncrypted } from '../encryption.js'

export const HUB_MASK = '••••••'

export class HubSecretError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HubSecretError'
    this.code = code
  }
}

/** Encrypts a hub token. Never returns plaintext: no valid ENCRYPTION_KEY = HubSecretError. */
export function sealSecret(plain: string): string {
  let sealed: string
  try {
    sealed = encryptValue(plain)
  } catch {
    throw new HubSecretError(
      'HUB_NEEDS_ENCRYPTION_KEY',
      'Set ENCRYPTION_KEY (64 hex characters) before saving a hub token.'
    )
  }
  if (!isEncrypted(sealed)) {
    throw new HubSecretError('HUB_NEEDS_ENCRYPTION_KEY', 'Hub token could not be encrypted.')
  }
  return sealed
}

export function openSecret(stored: string | null): string | null {
  if (stored === null || stored === undefined || stored === '') return null
  return decryptValue(stored)
}

export function maskSecret(stored: string | null): string | null {
  return stored ? HUB_MASK : null
}

/** Value to store after an edit: the mask keeps the stored one, empty clears, anything else is sealed. */
export function nextSecret(incoming: unknown, stored: string | null): string | null {
  if (incoming === HUB_MASK) return stored
  if (incoming === null || incoming === undefined || incoming === '') return null
  if (typeof incoming !== 'string') return stored
  return sealSecret(incoming)
}

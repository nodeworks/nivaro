import { config } from '../config.js'

/** The key cursors are signed with (records and queue worklists alike). */
export function keysetSecret(): string {
  return config.SESSION_SECRET || process.env.ENCRYPTION_KEY || 'nivaro-keyset'
}

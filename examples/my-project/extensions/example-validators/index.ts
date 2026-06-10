/**
 * Registers custom field validators.
 * These operators become available in Data Model → Field → Validation Rules.
 */
import type { Extension } from '@nivaro/api/extensions/loader'

const extension: Extension = {
  id: 'example-validators',

  register({ validators }) {
    // ── Phone number (E.164) ──────────────────────────────────────────────────
    validators.register({
      operator: 'phone_e164',
      label: 'Phone (E.164)',
      validate(value) {
        if (value == null || value === '') return null // not_null handles empty check
        return /^\+[1-9]\d{7,14}$/.test(String(value))
          ? null
          : 'Must be a valid E.164 phone number (e.g. +12125550100)'
      }
    })

    // ── IBAN ──────────────────────────────────────────────────────────────────
    validators.register({
      operator: 'iban',
      label: 'IBAN',
      validate(value) {
        if (value == null || value === '') return null
        const iban = String(value).replace(/\s/g, '').toUpperCase()
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{4,}$/.test(iban)) return 'Must be a valid IBAN'
        // Mod-97 check
        const rearranged = iban.slice(4) + iban.slice(0, 4)
        const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
        let remainder = 0
        for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97
        return remainder === 1 ? null : 'IBAN checksum invalid'
      }
    })

    // ── URL ───────────────────────────────────────────────────────────────────
    validators.register({
      operator: 'url',
      label: 'URL',
      validate(value) {
        if (value == null || value === '') return null
        try {
          new URL(String(value))
          return null
        } catch {
          return 'Must be a valid URL'
        }
      }
    })

    // ── JSON ──────────────────────────────────────────────────────────────────
    validators.register({
      operator: 'valid_json',
      label: 'Valid JSON',
      validate(value) {
        if (value == null || value === '') return null
        try {
          JSON.parse(String(value))
          return null
        } catch {
          return 'Must be valid JSON'
        }
      }
    })
  }
}

export default extension

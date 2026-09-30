import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { bulkUnavailableReason } from '../../../services/staged-imports.js'

// #803 — the bulk loader falls back to batched inserts only when the HOST
// cannot bulk load. A problem with the file itself must still fail the run.
describe('bulkUnavailableReason', () => {
  it('falls back when the share is not configured', () => {
    const err = new Error('The bulk loader needs SAMBA_USER, SAMBA_PASS and SAMBA_IP (or set …)')
    assert.match(String(bulkUnavailableReason(err)), /not configured/)
  })
  it('falls back when smbclient is missing or the share is unreachable', () => {
    assert.ok(
      bulkUnavailableReason(
        new Error('smbclient upload failed: smbclient is not installed on this host')
      )
    )
    assert.ok(
      bulkUnavailableReason(new Error('smbclient upload failed: NT_STATUS_HOST_UNREACHABLE'))
    )
  })
  it('falls back on a BULK INSERT permission or file-access error', () => {
    const inner = Object.assign(new Error('BULK INSERT x - '), {
      errors: [new Error('You do not have permission to use the bulk load statement.')]
    })
    assert.match(String(bulkUnavailableReason(inner)), /BULK INSERT/)
    assert.ok(
      bulkUnavailableReason(
        new Error('Cannot bulk load because the file "T:\\x.txt" could not be opened.')
      )
    )
  })
  it('does not fall back on a file problem', () => {
    assert.equal(
      bulkUnavailableReason(
        new Error('staging_x has no column for Foo — the file’s columns must exist')
      ),
      null
    )
    assert.equal(
      bulkUnavailableReason(new Error('Bulk load data conversion error (type mismatch)')),
      null
    )
  })
})

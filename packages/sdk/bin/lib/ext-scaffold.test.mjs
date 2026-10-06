import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { scaffoldFiles, validateExtensionId, writeScaffold } from './ext-scaffold.mjs'

describe('ext init (#1302)', () => {
  it('accepts kebab-case ids and names what is wrong with the rest', () => {
    assert.equal(validateExtensionId('acme-orders'), null)
    assert.equal(validateExtensionId('a1'), null)
    assert.match(validateExtensionId('AcmeOrders'), /not kebab-case/)
    assert.match(validateExtensionId('acme_orders'), /not kebab-case/)
    assert.match(validateExtensionId('acme--orders'), /not kebab-case/)
    assert.match(validateExtensionId('-acme'), /not kebab-case/)
    assert.match(validateExtensionId('../x'), /not kebab-case/)
    assert.match(validateExtensionId('a'), /2–64/)
    assert.match(validateExtensionId(undefined), /required/)
  })

  it('writes a gated route, a hook, a described cron and one setting', () => {
    const files = scaffoldFiles('acme-orders')
    assert.deepEqual(Object.keys(files).sort(), ['README.md', 'index.test.ts', 'index.ts'])
    const index = files['index.ts']
    assert.match(index, /defineExtension\(\{\n {2}id: 'acme-orders'/)
    assert.match(index, /preHandler: auth\.requireAuth/)
    assert.match(index, /hooks\.after\('\*', 'create'/)
    assert.match(index, /cron\.schedule\(\n\s+'daily-summary'/)
    assert.match(index, /description: 'One activity line/)
    assert.match(index, /key: 'greeting'/)
    assert.match(index, /const acmeOrdersCreates = new Map/)
    assert.match(files['index.test.ts'], /createTestContext/)
    assert.match(files['README.md'], /ctx\.hooks\.after/)
  })

  it('never writes a hostile id into source or outside --dir', () => {
    const hostile = [
      "x'); process.exit(1); ('",
      'x`${process.exit(1)}`',
      '../escape',
      'a/../../b',
      '..',
      'x\0y',
      'x\nconst y = 1',
      '/etc/passwd',
      'acme\\orders'
    ]
    for (const id of hostile) {
      assert.ok(validateExtensionId(id), `rejected: ${JSON.stringify(id)}`)
      assert.throws(() => scaffoldFiles(id), /kebab-case|2–64/)
    }
    const dir = mkdtempSync(join(tmpdir(), 'nivaro-ext-h-'))
    try {
      for (const id of hostile) assert.throws(() => writeScaffold(id, join(dir, 'exts')))
      assert.equal(existsSync(join(dir, 'exts')), false, 'nothing written for a refused id')
      assert.equal(existsSync(join(dir, 'escape')), false)
      assert.throws(() => writeScaffold('acme', ''), /--dir/)
      assert.throws(() => writeScaffold('acme', 'a\0b'), /--dir/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an existing directory and a bad id, writes a new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nivaro-ext-'))
    try {
      const { target, written } = writeScaffold('acme-orders', dir)
      assert.equal(written.length, 3)
      assert.ok(existsSync(join(target, 'index.ts')))
      assert.match(readFileSync(join(target, 'index.ts'), 'utf8'), /acme-orders/)
      assert.throws(() => writeScaffold('acme-orders', dir), /already exists/)
      assert.throws(() => writeScaffold('Bad_Id', dir), /not kebab-case/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

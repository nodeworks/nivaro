import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import knex, { type Knex } from 'knex'
import { afterAll, describe, expect, it } from 'vitest'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'
import {
  adoptedSqliteFile,
  adoptStagedSqliteFile,
  fileSum,
  installSqliteFile,
  receiveSqliteFile,
  snapshotSqliteDatabase,
  sqliteDatabaseSum,
  sqliteFileFrozen,
  stageSqliteFile,
  thawSqliteFile,
  verifySqliteFile
} from '../../../db/sqlite-transfer.js'

// Hub gap sqlite (0.3.215): moving a SQLite database file — freeze + checkpoint + snapshot at the
// source, a write refused on the frozen source, streamed receive with checksum and size checks,
// the read-only check, install, and a dedicated app's staged copy adopted at boot.

sqliteCompat()
const dir = mkdtempSync(join(tmpdir(), 'nvr-sqlite-transfer-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const open = (file: string): Knex =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: { min: 1, max: 2, afterCreate: sqliteAfterCreate }
  })

/** A database with a ledger and rows, some still in its WAL. */
async function appDb(name: string): Promise<{ k: Knex; file: string }> {
  const file = join(dir, name)
  const k = open(file)
  await k.schema.createTable('nivaro_migrations', (t) => {
    t.increments('id')
    t.string('name')
  })
  await k('nivaro_migrations').insert([{ name: '001_a.ts' }, { name: '002_b.ts' }])
  await k.schema.createTable('items', (t) => {
    t.increments('id')
    t.string('v', 40)
  })
  for (let i = 0; i < 50; i++) await k('items').insert({ v: `row ${i}` })
  return { k, file }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('source: freeze, checkpoint, snapshot', () => {
  it('the snapshot holds every row (the WAL emptied first) and hashes to what it reports', async () => {
    const { k, file } = await appDb('snap.sqlite')
    try {
      const snap = await snapshotSqliteDatabase(k, file, 'move 1')
      expect(snap.sha256).toBe(sha(readFileSync(snap.path)))
      expect(snap.bytes).toBe(readFileSync(snap.path).length)
      const v = verifySqliteFile(snap.path)
      expect(v).toEqual({ integrity: 'ok', migrations: 2, latest: '002_b.ts' })
      const copy = open(snap.path)
      expect((await copy('items').count({ n: '*' }))[0].n).toBe(50)
      await copy.destroy()
      // The source checksum now is the snapshot's (frozen since).
      expect((await sqliteDatabaseSum(k, file)).sha256).toBe(snap.sha256)
      rmSync(snap.path)
    } finally {
      thawSqliteFile(file)
      await k.destroy()
    }
  })

  it('a write attempt on the frozen source is refused (SQLITE_FROZEN); reads go on; thaw lets it write', async () => {
    const { k, file } = await appDb('frozen.sqlite')
    try {
      const snap = await snapshotSqliteDatabase(k, file, 'move 2')
      expect(sqliteFileFrozen(file)).toBe(true)
      await expect(k('items').insert({ v: 'late' })).rejects.toMatchObject({
        code: 'SQLITE_FROZEN'
      })
      await expect(k.transaction(async (trx) => trx('items').del())).rejects.toMatchObject({
        code: 'SQLITE_FROZEN'
      })
      expect((await k('items').count({ n: '*' }))[0].n).toBe(50)
      // Nothing written: the checksum is still the snapshot's.
      expect((await sqliteDatabaseSum(k, file)).sha256).toBe(snap.sha256)
      rmSync(snap.path)
      thawSqliteFile(file)
      expect(sqliteFileFrozen(file)).toBe(false)
      await k('items').insert({ v: 'after' })
      expect((await sqliteDatabaseSum(k, file)).sha256).not.toBe(snap.sha256)
    } finally {
      thawSqliteFile(file)
      await k.destroy()
    }
  })
})

describe('target: receive, check, install', () => {
  it('a copy that matches lands in <file>.incoming; install puts it in place', async () => {
    const { k, file } = await appDb('src-ok.sqlite')
    const snap = await snapshotSqliteDatabase(k, file, 'move 3')
    thawSqliteFile(file)
    await k.destroy()
    const target = join(dir, 'target-ok.sqlite')
    writeFileSync(target, 'an empty install made by the target')
    writeFileSync(`${target}-wal`, 'stale wal')
    const got = await receiveSqliteFile(Readable.from(readFileSync(snap.path)), target, {
      sha256: snap.sha256,
      bytes: snap.bytes
    })
    expect(got.incoming).toBe(`${target}.incoming`)
    expect(verifySqliteFile(got.incoming).migrations).toBe(2)
    await installSqliteFile(got.incoming, target)
    expect(existsSync(`${target}-wal`)).toBe(false)
    expect(existsSync(got.incoming)).toBe(false)
    expect((await fileSum(target)).sha256).toBe(snap.sha256)
  })

  it('a checksum mismatch, a short body, a body past the cap: refused, nothing left behind', async () => {
    const target = join(dir, 'target-bad.sqlite')
    const body = Buffer.from('x'.repeat(100))
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: 'a'.repeat(64), bytes: 100 })
    ).rejects.toMatchObject({ code: 'SQLITE_CHECKSUM_MISMATCH' })
    expect(existsSync(`${target}.incoming`)).toBe(false)
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: sha(body), bytes: 200 })
    ).rejects.toMatchObject({ code: 'SQLITE_SHORT_COPY' })
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: sha(body), bytes: 50 })
    ).rejects.toMatchObject({ code: 'SQLITE_SHORT_COPY' })
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: sha(body), bytes: 100 }, 10)
    ).rejects.toMatchObject({ code: 'SQLITE_TOO_LARGE', message: expect.stringMatching(/100/) })
    expect(existsSync(`${target}.incoming`)).toBe(false)
  })

  it('the read-only check refuses a file that is not SQLite, a damaged one, and one with no ledger', async () => {
    const junk = join(dir, 'junk.sqlite')
    writeFileSync(junk, 'not a database at all, really not')
    expect(() => verifySqliteFile(junk)).toThrow(
      expect.objectContaining({ code: 'SQLITE_NOT_SQLITE' })
    )
    const empty = join(dir, 'noledger.sqlite')
    const k = open(empty)
    await k.schema.createTable('x', (t) => t.increments('id'))
    await k.destroy()
    expect(() => verifySqliteFile(empty)).toThrow(
      expect.objectContaining({ code: 'SQLITE_NO_LEDGER' })
    )
    // Damaged pages: the file header stays, every later page header is overwritten.
    const { k: k2, file } = await appDb('damaged.sqlite')
    const snap = await snapshotSqliteDatabase(k2, file, 'move 4')
    thawSqliteFile(file)
    await k2.destroy()
    const buf = readFileSync(snap.path)
    for (let p = 1; p * 4096 < buf.length; p++) buf.fill(0xab, p * 4096, p * 4096 + 12)
    const bad = join(dir, 'damaged-copy.sqlite')
    writeFileSync(bad, buf)
    expect(() => verifySqliteFile(bad)).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(/SQLITE_NOT_INTACT|SQLITE_NOT_SQLITE/)
      })
    )
  })
})

describe('a dedicated target: staged, adopted at boot', () => {
  it('adopts a staged copy that still checks; leaves the adopted marker', async () => {
    const { k, file } = await appDb('stage-src.sqlite')
    const snap = await snapshotSqliteDatabase(k, file, 'move 5')
    thawSqliteFile(file)
    await k.destroy()
    const target = join(dir, 'stage-target.sqlite')
    writeFileSync(target, 'fresh empty install')
    const got = await receiveSqliteFile(Readable.from(readFileSync(snap.path)), target, snap)
    await stageSqliteFile(target, { sha256: got.sha256, bytes: got.bytes, move_id: 9 })
    expect(adoptStagedSqliteFile(target)).toBe('adopted')
    expect((await fileSum(target)).sha256).toBe(snap.sha256)
    expect(await adoptedSqliteFile(target)).toMatchObject({ sha256: snap.sha256, move_id: 9 })
    expect(adoptStagedSqliteFile(target)).toBe('none')
  })

  it('a staged copy changed since it was checked is refused and removed; the database is untouched', async () => {
    const { k, file } = await appDb('stage-src2.sqlite')
    const snap = await snapshotSqliteDatabase(k, file, 'move 6')
    thawSqliteFile(file)
    await k.destroy()
    const target = join(dir, 'stage-target2.sqlite')
    writeFileSync(target, 'the database as it is')
    const got = await receiveSqliteFile(Readable.from(readFileSync(snap.path)), target, snap)
    await stageSqliteFile(target, { sha256: got.sha256, bytes: got.bytes, move_id: 10 })
    writeFileSync(got.incoming, 'tampered')
    expect(adoptStagedSqliteFile(target)).toBe('refused')
    expect(readFileSync(target, 'utf8')).toBe('the database as it is')
    expect(existsSync(got.incoming)).toBe(false)
  })
})

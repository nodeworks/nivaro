import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
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
  sqliteTransferDeps,
  stageSqliteFile,
  sweepSqliteLeftovers,
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

/** Snapshot / incoming files left beside `file`. */
const leftovers = (file: string) => {
  const base = file.split('/').pop() as string
  return readdirSync(dir).filter(
    (n) => n.startsWith(`${base}.incoming`) || n.startsWith(`${base}.snapshot-`)
  )
}

describe('source: freeze, checkpoint, snapshot', () => {
  it('the snapshot holds every row (the WAL emptied first) and hashes to what it reports', async () => {
    const { k, file } = await appDb('snap.sqlite')
    try {
      const snap = await snapshotSqliteDatabase(k, file, 'move 1')
      expect(snap.sha256).toBe(sha(readFileSync(snap.path)))
      expect(snap.bytes).toBe(readFileSync(snap.path).length)
      const v = await verifySqliteFile(snap.path)
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
  it('a copy that matches lands in <file>.incoming-<id>; install puts it in place', async () => {
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
    expect(got.incoming.startsWith(`${target}.incoming-`)).toBe(true)
    expect((await verifySqliteFile(got.incoming)).migrations).toBe(2)
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
    expect(leftovers(target)).toEqual([])
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: sha(body), bytes: 200 })
    ).rejects.toMatchObject({ code: 'SQLITE_SHORT_COPY' })
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: sha(body), bytes: 50 })
    ).rejects.toMatchObject({ code: 'SQLITE_SHORT_COPY' })
    await expect(
      receiveSqliteFile(Readable.from(body), target, { sha256: sha(body), bytes: 100 }, 10)
    ).rejects.toMatchObject({ code: 'SQLITE_TOO_LARGE', message: expect.stringMatching(/100/) })
    expect(leftovers(target)).toEqual([])
  })

  it('the read-only check refuses a file that is not SQLite, a damaged one, and one with no ledger', async () => {
    const junk = join(dir, 'junk.sqlite')
    writeFileSync(junk, 'not a database at all, really not')
    await expect(verifySqliteFile(junk)).rejects.toMatchObject({ code: 'SQLITE_NOT_SQLITE' })
    const empty = join(dir, 'noledger.sqlite')
    const k = open(empty)
    await k.schema.createTable('x', (t) => t.increments('id'))
    await k.destroy()
    await expect(verifySqliteFile(empty)).rejects.toMatchObject({ code: 'SQLITE_NO_LEDGER' })
    // Damaged pages: the file header stays, every later page header is overwritten.
    const { k: k2, file } = await appDb('damaged.sqlite')
    const snap = await snapshotSqliteDatabase(k2, file, 'move 4')
    thawSqliteFile(file)
    await k2.destroy()
    const buf = readFileSync(snap.path)
    for (let p = 1; p * 4096 < buf.length; p++) buf.fill(0xab, p * 4096, p * 4096 + 12)
    const bad = join(dir, 'damaged-copy.sqlite')
    writeFileSync(bad, buf)
    await expect(verifySqliteFile(bad)).rejects.toMatchObject({
      code: expect.stringMatching(/SQLITE_NOT_INTACT|SQLITE_NOT_SQLITE/)
    })
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
    await stageSqliteFile(target, {
      sha256: got.sha256,
      bytes: got.bytes,
      move_id: 9,
      incoming: got.incoming
    })
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
    await stageSqliteFile(target, {
      sha256: got.sha256,
      bytes: got.bytes,
      move_id: 10,
      incoming: got.incoming
    })
    writeFileSync(got.incoming, 'tampered')
    expect(adoptStagedSqliteFile(target)).toBe('refused')
    expect(readFileSync(target, 'utf8')).toBe('the database as it is')
    expect(existsSync(got.incoming)).toBe(false)
  })
})

describe('review fixes', () => {
  it('no room on the volume: the snapshot and the receive are refused SQLITE_NO_SPACE, naming sizes', async () => {
    const { k, file } = await appDb('nospace.sqlite')
    const real = sqliteTransferDeps.freeBytes
    sqliteTransferDeps.freeBytes = async () => 1024
    try {
      await expect(snapshotSqliteDatabase(k, file, 'move 7')).rejects.toMatchObject({
        code: 'SQLITE_NO_SPACE',
        message: expect.stringMatching(/1024 bytes free/)
      })
      await expect(
        receiveSqliteFile(Readable.from(Buffer.from('abc')), file, {
          sha256: 'a'.repeat(64),
          bytes: 3
        })
      ).rejects.toMatchObject({ code: 'SQLITE_NO_SPACE' })
      expect(leftovers(file)).toEqual([])
    } finally {
      sqliteTransferDeps.freeBytes = real
      thawSqliteFile(file)
      await k.destroy()
    }
  })

  it('one snapshot per file at a time (DATABASE_COPY_RUNNING)', async () => {
    const { k, file } = await appDb('once.sqlite')
    try {
      const a = snapshotSqliteDatabase(k, file, 'move 8')
      await expect(snapshotSqliteDatabase(k, file, 'move 8')).rejects.toMatchObject({
        code: 'DATABASE_COPY_RUNNING'
      })
      rmSync((await a).path)
    } finally {
      thawSqliteFile(file)
      await k.destroy()
    }
  })

  it('the release checksum freezes the file again (a source that restarted is frozen)', async () => {
    const { k, file } = await appDb('refreeze.sqlite')
    try {
      expect(sqliteFileFrozen(file)).toBe(false)
      await sqliteDatabaseSum(k, file)
      expect(sqliteFileFrozen(file)).toBe(true)
      await expect(k('items').insert({ v: 'x' })).rejects.toMatchObject({ code: 'SQLITE_FROZEN' })
    } finally {
      thawSqliteFile(file)
      await k.destroy()
    }
  })

  it('a long reader is waited for: the checkpoint retries inside its window, then gives up', async () => {
    const { k, file } = await appDb('reader.sqlite')
    const was = { ...sqliteTransferDeps }
    sqliteTransferDeps.checkpointWaitMs = 300
    sqliteTransferDeps.checkpointPollMs = 50
    // A reader holding a read transaction open on its own connection keeps the WAL in use.
    const driver = 'better-sqlite3'
    const Database = (await import(driver)).default
    const reader = new Database(file)
    try {
      await k('items').insert({ v: 'in wal' })
      reader.prepare('BEGIN').run()
      reader.prepare('SELECT COUNT(*) FROM items').get()
      await k('items').insert({ v: 'after the reader' })
      await expect(snapshotSqliteDatabase(k, file, 'move 9')).rejects.toMatchObject({
        code: 'SQLITE_CHECKPOINT_BUSY'
      })
    } finally {
      reader.prepare('ROLLBACK').run()
      reader.close()
      Object.assign(sqliteTransferDeps, was)
      thawSqliteFile(file)
      await k.destroy()
    }
  })

  it("a crash's leftovers older than an hour are swept; a copy in flight and a staged one are kept", async () => {
    const file = join(dir, 'sweep.sqlite')
    writeFileSync(file, 'db')
    const old = Date.now() / 1000 - 2 * 3600
    for (const n of ['snapshot-aaa', 'incoming-bbb', 'incoming-staged']) {
      writeFileSync(`${file}.${n}`, 'x')
      utimesSync(`${file}.${n}`, old, old)
    }
    writeFileSync(`${file}.incoming-new`, 'x')
    writeFileSync(
      `${file}.incoming.json`,
      JSON.stringify({
        sha256: 'a'.repeat(64),
        bytes: 1,
        move_id: 1,
        incoming: `${file}.incoming-staged`
      })
    )
    expect(sweepSqliteLeftovers(file)).toBe(2)
    expect(leftovers(file).sort()).toEqual(
      [
        'sweep.sqlite.incoming-new',
        'sweep.sqlite.incoming-staged',
        'sweep.sqlite.incoming.json'
      ].sort()
    )
  })

  it('boot after a crash between the rename and the marker: the copy in place is reported adopted', async () => {
    const { k, file } = await appDb('crash-src.sqlite')
    const snap = await snapshotSqliteDatabase(k, file, 'move 11')
    thawSqliteFile(file)
    await k.destroy()
    const target = join(dir, 'crash-target.sqlite')
    writeFileSync(target, readFileSync(snap.path))
    writeFileSync(
      `${target}.incoming.json`,
      JSON.stringify({
        sha256: snap.sha256,
        bytes: snap.bytes,
        move_id: 11,
        incoming: `${target}.incoming-gone`
      })
    )
    expect(adoptStagedSqliteFile(target)).toBe('adopted')
    expect(await adoptedSqliteFile(target)).toMatchObject({ sha256: snap.sha256, move_id: 11 })
  })
})

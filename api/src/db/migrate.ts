import { db } from './index.js'

// pnpm migrate            apply pending migrations
// pnpm migrate rollback   roll back the last batch
// tsx src/db/migrate.ts list   list pending migrations, apply nothing (dry runs)
const command = process.argv[2]

async function run() {
  if (command === 'list') {
    const [done, pending] = (await db.migrate.list()) as [unknown[], unknown[]]
    const nameOf = (m: unknown) =>
      typeof m === 'string'
        ? m
        : String((m as { name?: string; file?: string }).name ?? (m as { file?: string }).file ?? m)
    console.log(`${done.length} migrations applied; ${pending.length} pending`)
    for (const m of pending) console.log(`  pending: ${nameOf(m)}`)
    if (pending.length === 0) console.log('Already up to date — nothing would run.')
  } else if (command === 'rollback') {
    console.log('Rolling back last migration batch...')
    const [batch, migrations] = await db.migrate.rollback()
    console.log(`Rolled back batch ${batch}: ${migrations.join(', ')}`)
  } else {
    console.log('Running pending migrations...')
    const [batch, migrations] = await db.migrate.latest()
    if (migrations.length === 0) {
      console.log('Already up to date.')
    } else {
      console.log(`Ran batch ${batch}: ${migrations.join(', ')}`)
    }
  }
  await db.destroy()
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})

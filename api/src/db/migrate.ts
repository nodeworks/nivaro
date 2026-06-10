import { db } from './index.js'

const command = process.argv[2]

async function run() {
  if (command === 'rollback') {
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

// tsc-alias incorrectly rewrites 'graphql' (npm package) to '../graphql' (local dir)
// when @graphql/* path alias is present. This script restores the correct import.
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...walk(full))
    } else if (entry.endsWith('.js')) {
      files.push(full)
    }
  }
  return files
}

const dist = new URL('../dist', import.meta.url).pathname
let fixed = 0

for (const file of walk(dist)) {
  const content = readFileSync(file, 'utf8')
  // Any depth: a file three folders down gets '../../../graphql' (services/hub/api/graphql.js,
  // 0.3.215 canary died on it: ERR_UNSUPPORTED_DIR_IMPORT). Only the bare folder name is the
  // package; '../graphql/scalars.js' and the like are real local imports and stay.
  const updated = content
    .replace(/from ['"](?:\.\.?\/)+graphql['"]/g, "from 'graphql'")
    .replace(/import\(['"](?:\.\.?\/)+graphql['"]\)/g, "import('graphql')")
  if (updated !== content) {
    writeFileSync(file, updated)
    fixed++
  }
}

if (fixed > 0) console.log(`Fixed graphql import in ${fixed} file(s)`)

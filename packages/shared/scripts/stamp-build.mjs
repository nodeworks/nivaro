// Stamps dist/build-info.js with the build time (see src/build-info.ts).
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'build-info.js')
writeFileSync(out, `export const SHARED_BUILT_AT = '${new Date().toISOString()}';\n`)

/**
 * Admin source maps are built 'hidden' (no sourceMappingURL) and are never served unless
 * ADMIN_SOURCEMAPS=public (security audit 2026-10-27). The test is made on the DECODED,
 * lower-cased path with trailing junk removed, so `%2Emap`, `.MAP` (case-insensitive file
 * systems) or `.map%00` do not slip past; @fastify/static's allowedPath applies it again to
 * the path it is about to resolve. Leaf module.
 */

export function sourceMapsPublic(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADMIN_SOURCEMAPS === 'public'
}

function decodeFully(path: string): string {
  let out = path
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(out)
    } catch {
      break
    }
    if (next === out) break
    out = next
  }
  return out
}

/** Does this request path (raw or decoded) name a source map? */
export function isSourceMapPath(urlOrPath: string): boolean {
  const path = decodeFully(String(urlOrPath ?? '').split(/[?#]/)[0] ?? '')
    .toLowerCase()
    // NULs, whitespace, dots and slashes a file system or router may ignore at the end
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping NUL is the point
    .replace(/[\u0000\s./\\]+$/, '')
  return path.endsWith('.map')
}

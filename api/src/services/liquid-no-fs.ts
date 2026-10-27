import { Liquid, type LiquidOptions } from 'liquidjs'

/**
 * A Liquid engine with NO file system (security audit 2026-10-27, Low). `new Liquid()` roots at
 * the process folder, so a stored template (PDF templates, layout PDF themes) could
 * `{% include %}` / `{% render %}` / `{% layout %}` any readable file under it — uploads, built
 * code, a mounted secret. These engines render the template text only; every file lookup fails
 * with a plain "not available" error.
 */
const refuse = (): never => {
  throw new Error('include, render and layout are not available in this template')
}

const NO_FS = {
  exists: async () => false,
  existsSync: () => false,
  readFile: async (): Promise<string> => refuse(),
  readFileSync: (): string => refuse(),
  resolve: (_dir: string, file: string) => file,
  contains: async () => false,
  containsSync: () => false,
  dirname: () => '',
  sep: '/'
}

export function liquidWithoutFiles(opts: LiquidOptions = {}): Liquid {
  return new Liquid({
    ...opts,
    fs: NO_FS,
    root: [],
    partials: [],
    layouts: [],
    relativeReference: false
  })
}

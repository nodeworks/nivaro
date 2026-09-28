import type { ImportParserDef } from '@nivaro/extension-kit'

export type { ImportParserDef, ParsedRow } from '@nivaro/extension-kit'

class ImportParserRegistry {
  private parsers: ImportParserDef[] = []

  register(def: ImportParserDef): void {
    this.parsers.push(def)
  }

  /** Find parser for a given MIME type or file extension. */
  find(mimeOrExt: string): ImportParserDef | undefined {
    const lower = mimeOrExt.toLowerCase()
    return this.parsers.find(
      (p) =>
        p.mimeTypes.some((m) => m.toLowerCase() === lower) ||
        p.extensions.some((e) => lower.endsWith(`.${e}`) || e === lower)
    )
  }

  list(): Omit<ImportParserDef, 'parse'>[] {
    return this.parsers.map(({ parse: _p, ...rest }) => rest)
  }
}

export const importParserRegistry = new ImportParserRegistry()

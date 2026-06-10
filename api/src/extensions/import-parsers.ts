export interface ParsedRow {
  [column: string]: string
}

export interface ImportParserDef {
  /** MIME type(s) this parser handles. */
  mimeTypes: string[]
  /** File extension(s), e.g. ['xlsx', 'xls']. Used for display + file filtering. */
  extensions: string[]
  label: string
  /** Parse raw file content (Buffer or string) into column-named rows. */
  parse(content: Buffer | string): Promise<ParsedRow[]> | ParsedRow[]
}

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

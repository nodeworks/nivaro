// The part of tar-stream@2.2.0 the agent uses (the package ships no types).
declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream'

  export type EntryType =
    | 'file'
    | 'link'
    | 'symlink'
    | 'character-device'
    | 'block-device'
    | 'directory'
    | 'fifo'
    | 'contiguous-file'
    | 'pax-header'
    | 'pax-global-header'
    | 'gnu-long-link-path'
    | 'gnu-long-path'

  export interface Headers {
    name: string
    mode?: number
    uid?: number
    gid?: number
    size?: number
    mtime?: Date
    type?: EntryType | null
    linkname?: string | null
    uname?: string
    gname?: string
    devmajor?: number
    devminor?: number
  }

  export interface Extract extends Writable {
    on(
      event: 'entry',
      listener: (headers: Headers, stream: Readable, next: (err?: unknown) => void) => void
    ): this
    on(event: string, listener: (...args: any[]) => void): this
    destroy(err?: Error): this
  }

  export interface Pack extends Readable {
    entry(headers: Headers, buffer?: string | Buffer, callback?: (err?: Error) => void): Writable
    finalize(): void
  }

  export function extract(opts?: { filenameEncoding?: string; allowUnknownFormat?: boolean }): Extract
  export function pack(opts?: object): Pack
}

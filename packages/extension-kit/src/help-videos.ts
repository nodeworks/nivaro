/** Help videos an extension ships and the screens it names (#1514). */

/** A page key the Videos button uses (the help-video page registry), with the
 *  label authors see when they choose where a video shows. Keys are
 *  `[A-Za-z0-9_.:-]{1,100}`; use the same key the host passes to the button. */
export interface HelpVideoPageDecl {
  key: string
  label: string
  /** Which app the page belongs to (e.g. 'admin'); free text, optional. */
  app?: string | null
}

/** A screen a video shows on: a collection (optionally one pipeline state) or a page. */
export interface HelpVideoContextDecl {
  kind: 'collection' | 'page'
  key: string
  /** Collection contexts only: the pipeline state key. */
  state_key?: string | null
}

/** A help-video package (the tar an admin exports from Content Promotion →
 *  Help videos) shipped inside the extension folder. Each video in it is
 *  imported ONCE per database as a DRAFT: never published, authors only,
 *  never required viewing. A video id that already exists here — or that was
 *  imported before and deleted since — is left alone. */
export interface HelpVideoStarterDef {
  /** Path of the package file, relative to the extension folder. */
  package: string
  /** Only these video ids from the package (default: every video in it). */
  ids?: string[]
  /** Screens every starter video in this package shows on, beside the ones
   *  the package carries. Unknown collections and states are skipped. */
  contexts?: HelpVideoContextDecl[]
}

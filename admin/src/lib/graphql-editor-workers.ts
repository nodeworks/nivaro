// The GraphQL explorer's editors are Monaco. Monaco needs its workers (the editor's own, JSON
// for the variables and headers panes, GraphQL for the query pane) handed to it; without them
// it runs the worker code on the page and fails loading the language services with
// "Cannot read properties of undefined (reading 'toUrl')": no validation, no completion, and
// an error on every visit (issue log, /graphql, 2026-11-10 to 11-12).
//
// graphiql ships the Vite setup as a side-effect module. It imports the workers with Vite's
// `?worker` suffix, which the dev server's dependency pre-bundler cannot read, so
// vite.config.ts keeps `graphiql/setup-workers` and `@graphiql/react/setup-workers` out of
// pre-bundling. Imported only by the explorer page, so the workers load with it and nowhere
// else.
import 'graphiql/setup-workers/vite'

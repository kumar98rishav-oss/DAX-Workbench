// Bundle the MCP server into one runnable file. The server imports the app's
// own validate.ts (→ dependencies.ts → functions.ts) so the reference-checker
// is the SAME code the desktop UI uses — no duplication, no drift. Those files
// use the `@/` path alias, so we map it to the app's src/ for esbuild. The MCP
// SDK and zod stay external and load from node_modules at runtime.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcAlias = resolve(here, '../../src')

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node' },
  alias: { '@': srcAlias },
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'zod'],
  logLevel: 'info',
})

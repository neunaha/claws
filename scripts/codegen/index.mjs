#!/usr/bin/env node
// Codegen pipeline orchestrator.
// Run via: npm run schemas (from extension/)
// Usage:   node ../scripts/codegen/index.mjs
//
// Bundles event-schemas.ts → CJS, then calls each generator in sequence.
// Outputs land in schemas/ at the repo root (committed to git).

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot   = join(__dirname, '../..');
const extRoot    = join(repoRoot, 'extension');
const bundlePath = join(extRoot, 'dist', 'event-schemas.bundle.cjs');

// Ensure output dirs exist
mkdirSync(join(repoRoot, 'schemas', 'json'),   { recursive: true });
mkdirSync(join(repoRoot, 'schemas', 'types'), { recursive: true });

// 1. Bundle event-schemas.ts so generators can require() it (zod included).
const esbuildBin = join(extRoot, 'node_modules', '.bin', 'esbuild');
const srcPath    = join(extRoot, 'src', 'event-schemas.ts');
execSync(
  `"${esbuildBin}" "${srcPath}" --bundle --format=cjs --platform=node --outfile="${bundlePath}"`,
  { stdio: 'pipe' },
);

// 2. Run generators in sequence.
const { default: genJsonSchema } = await import('./gen-json-schema.mjs');
const { default: genTypes }      = await import('./gen-types.mjs');
const { default: genDocs }       = await import('./gen-docs.mjs');
const { default: genMcpTools }   = await import('./gen-mcp-tools.mjs');

await genJsonSchema(bundlePath, repoRoot, extRoot);
await genTypes(bundlePath, repoRoot);
await genDocs(repoRoot);
await genMcpTools(bundlePath, repoRoot, extRoot);

console.log('[codegen] schemas generated successfully');

#!/usr/bin/env node
// gen-client-types.mjs — Generate schemas/client-types.d.ts from SCHEMA_BY_NAME.
// Usage: node scripts/gen-client-types.mjs  (from repo root)

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const repoRoot   = join(__dirname, '..');
const extRoot    = join(repoRoot, 'extension');
const bundlePath = join(extRoot, 'dist', 'event-schemas.bundle.cjs');

mkdirSync(join(extRoot, 'dist'), { recursive: true });

const esbuildBin = join(extRoot, 'node_modules', '.bin', 'esbuild');
const srcPath    = join(extRoot, 'src', 'event-schemas.ts');
execSync(
  `"${esbuildBin}" "${srcPath}" --bundle --format=cjs --platform=node --outfile="${bundlePath}"`,
  { stdio: 'pipe' },
);

const require = createRequire(__filename);
const mod = require(bundlePath);
const SCHEMA_BY_NAME = mod.SCHEMA_BY_NAME ?? {};

function zodToTs(schema, depth = 0) {
  const def = schema._def;
  const t = def.typeName ?? 'unknown';
  const pad = '  '.repeat(depth);

  switch (t) {
    case 'ZodObject': {
      const shape = schema.shape;
      const fields = Object.entries(shape).map(([k, v]) => {
        const isOpt = v._def.typeName === 'ZodOptional';
        const inner = isOpt ? v._def.innerType : v;
        return `${pad}  ${k}${isOpt ? '?' : ''}: ${zodToTs(inner, depth + 1)};`;
      }).join('\n');
      return `{\n${fields}\n${pad}}`;
    }
    case 'ZodString':   return 'string';
    case 'ZodNumber':   return 'number';
    case 'ZodBoolean':  return 'boolean';
    case 'ZodUnknown':  return 'unknown';
    case 'ZodNull':     return 'null';
    case 'ZodLiteral':  return JSON.stringify(def.value);
    case 'ZodEnum':     return def.values.map(v => JSON.stringify(v)).join(' | ');
    case 'ZodArray':    return `Array<${zodToTs(def.type, depth)}>`;
    case 'ZodRecord':   return `Record<string, ${zodToTs(def.valueType, depth)}>`;
    case 'ZodNullable': return `${zodToTs(def.innerType, depth)} | null`;
    case 'ZodOptional': return zodToTs(def.innerType, depth);
    case 'ZodUnion':    return def.options.map(o => zodToTs(o, depth)).join(' | ');
    default:            return 'unknown';
  }
}

function toPascal(kebab) {
  return kebab
    .replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, c => c.toUpperCase());
}

const lines = [
  '// @generated — do not edit. Run: node scripts/gen-client-types.mjs',
  '// Source: extension/src/event-schemas.ts — SCHEMA_BY_NAME',
  '',
];

for (const [name, schema] of Object.entries(SCHEMA_BY_NAME)) {
  const iface = toPascal(name);
  lines.push(`export interface ${iface} ${zodToTs(schema)}`);
  lines.push('');
}

const outPath = join(repoRoot, 'schemas', 'client-types.d.ts');
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`[gen-client-types] wrote schemas/client-types.d.ts (${Object.keys(SCHEMA_BY_NAME).length} types)`);

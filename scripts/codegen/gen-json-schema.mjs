// gen-json-schema.mjs — Generate schemas/json/*.json from Zod schemas.
// Called by index.mjs. Default export is the generator function.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// Convert PascalCase schema name to kebab-case filename.
// WorkerBootV1 → worker-boot-v1, EnvelopeV1 → envelope-v1
function toKebab(name) {
  return name
    .replace(/([A-Z])/g, (m, c, i) => (i === 0 ? c : '-' + c))
    .toLowerCase();
}

// Predicate: is this export a top-level event schema (not a helper)?
// Matches names ending in V + digit, excluding ArtifactSchema.
function isEventSchema(name, value) {
  return (
    /[A-Z].+V\d+$/.test(name) &&
    value !== null &&
    typeof value === 'object' &&
    typeof value.safeParse === 'function'
  );
}

export default async function genJsonSchema(bundlePath, repoRoot, extRoot) {
  const require = createRequire(__filename);

  // Load zodToJsonSchema from extension's node_modules.
  const extRequire = createRequire(join(extRoot, 'package.json'));
  const { zodToJsonSchema } = extRequire('zod-to-json-schema');

  // Load the bundled schemas.
  const schemas = require(bundlePath);

  const outDir = join(repoRoot, 'schemas', 'json');
  let count = 0;

  for (const [name, schema] of Object.entries(schemas)) {
    if (!isEventSchema(name, schema)) continue;
    const kebab = toKebab(name);
    const jsonSchema = zodToJsonSchema(schema, {
      name:   kebab,
      $refStrategy: 'none',
    });
    // Annotate with $schema and title.
    const out = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: kebab,
      ...jsonSchema,
    };
    const outPath = join(outDir, `${kebab}.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    count++;
  }

  console.log(`[codegen/gen-json-schema] wrote ${count} JSON Schema files to schemas/json/`);
}

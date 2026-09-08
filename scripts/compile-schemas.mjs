import Ajv from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const ajv = new Ajv({ strict: false, allErrors: true, code: { source: true, esm: true } });
ajv.addSchema(JSON.parse(readFileSync('public/fixture.schema.json', 'utf8')), 'fixture.schema.json');
ajv.addSchema(JSON.parse(readFileSync('public/project.schema.json', 'utf8')), 'project.schema.json');
mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/validators.mjs', standalone(ajv, { check: 'fixture.schema.json', checkProject: 'project.schema.json' }));
writeFileSync('src/generated/validators.d.mts', 'export declare function check(value: unknown): boolean;\nexport declare function checkProject(value: unknown): boolean;\n');

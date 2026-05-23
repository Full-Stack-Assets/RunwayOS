import fs from 'node:fs';
import path from 'node:path';
import { OFFBOARDING_PLATFORM_ENUM, OFFBOARDING_STATUS_ENUM, getEnumValues } from './openapi-contract.mjs';

const root = process.cwd();
const openApiPath = path.join(root, 'docs', 'openapi-expanded.yaml');
const content = fs.readFileSync(openApiPath, 'utf8');

const requiredSnippets = [
  'openapi: 3.0.3',
  'info:',
  'paths:',
  '/api/workspaces/{id}/offboarding/seats:',
  'patch:',
  'requestBody:',
  'employeeEmail:',
  'platformName:',
  'status:',
  "'200':",
  "'401':",
  "'500':"
];

for (const snippet of requiredSnippets) {
  if (!content.includes(snippet)) {
    console.error(`Missing required OpenAPI fragment: ${snippet}`);
    process.exit(1);
  }
}

for (const [label, values] of [
  ['platformName', OFFBOARDING_PLATFORM_ENUM],
  ['status', OFFBOARDING_STATUS_ENUM]
]) {
  const actualValues = getEnumValues(content, label);
  if (!actualValues || JSON.stringify(actualValues) !== JSON.stringify(values)) {
    console.error(`Missing required OpenAPI enum for ${label}: [${values.join(', ')}]`);
    process.exit(1);
  }
}

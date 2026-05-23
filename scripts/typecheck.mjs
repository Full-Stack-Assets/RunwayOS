import fs from 'node:fs';
import path from 'node:path';

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
  "enum: [slack, google_workspace, github, jira, notion, figma]",
  "enum: [active, pending_removal, deactivated]",
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

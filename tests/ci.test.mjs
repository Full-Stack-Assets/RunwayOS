import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OFFBOARDING_PLATFORM_ENUM, OFFBOARDING_STATUS_ENUM } from '../scripts/openapi-contract.mjs';

const root = process.cwd();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getEnumValues(openApi, propertyName) {
  // The OpenAPI document is a small hand-authored YAML contract, so a focused
  // regex keeps the CI check dependency-free while still validating the shape.
  const pattern = new RegExp(`${escapeRegExp(propertyName)}:\\n(?:[ \\t]+.*\\n)*?[ \\t]+enum: \\[(.*?)\\]`, 'm');
  const match = openApi.match(pattern);

  assert.ok(match, `Expected to find enum block for ${propertyName}`);
  return match[1].split(',').map((value) => value.trim());
}

test('package scripts expose the CI gates', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts.lint, 'node scripts/lint.mjs');
  assert.equal(packageJson.scripts.typecheck, 'node scripts/typecheck.mjs');
  assert.equal(packageJson.scripts.test, 'node --test tests/*.mjs');
  assert.equal(packageJson.scripts.audit, 'npm audit --audit-level=high');
});

test('README documents the main repository sections', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  for (const heading of ['## Quick Start', '## Configuration Reference', '## Proof & Current Status']) {
    assert.ok(readme.includes(heading), `Expected README to include ${heading}`);
  }
});

test('OpenAPI contract keeps the offboarding seat update endpoint', () => {
  const openApi = fs.readFileSync(path.join(root, 'docs', 'openapi-expanded.yaml'), 'utf8');

  assert.ok(openApi.includes('/api/workspaces/{id}/offboarding/seats:'));
  assert.deepEqual(getEnumValues(openApi, 'platformName'), OFFBOARDING_PLATFORM_ENUM);
  assert.deepEqual(getEnumValues(openApi, 'status'), OFFBOARDING_STATUS_ENUM);
  assert.ok(openApi.includes("'200':"));
  assert.ok(openApi.includes("'401':"));
  assert.ok(openApi.includes("'500':"));
});

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const expectedName = '@luberserker0v0/agent-orchestrator';
const expectedBin = 'bin/aor.js';

function fail(message) {
  console.error(`Package metadata verification failed: ${message}`);
  process.exitCode = 1;
}

if (packageJson.name !== expectedName) {
  fail(`package.json name must be ${expectedName}`);
}

if (packageLock.name !== packageJson.name || packageLock.packages?.['']?.name !== packageJson.name) {
  fail('package-lock.json name must match package.json');
}

if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  fail('package-lock.json version must match package.json');
}

if (packageJson.bin?.aor !== expectedBin) {
  fail(`the aor executable must use the normalized path ${expectedBin}`);
}

if (packageJson.publishConfig?.access !== 'public') {
  fail('publishConfig.access must be public for the scoped package');
}

const binContents = readFileSync(join(root, expectedBin), 'utf8');
if (!binContents.startsWith('#!/usr/bin/env node')) {
  fail(`${expectedBin} must start with a Node.js shebang`);
}

const releaseRef = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (releaseRef?.startsWith('v') && releaseRef.slice(1) !== packageJson.version) {
  fail(`release tag ${releaseRef} does not match package version ${packageJson.version}`);
}

if (!process.exitCode) {
  console.log(`Verified ${packageJson.name}@${packageJson.version}`);
}

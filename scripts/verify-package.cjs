const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

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

const requiredAssets = [
  'bin/aor.js',
  'dist/index.js',
  'k8s/namespace.yaml',
  'k8s/crd/opencodeinstances.yaml',
  'k8s/crd/conversationroutes.yaml',
  'k8s/orchestrator/deployment.yaml',
  'k8s/operator/deployment.yaml',
  'config/agentorchestrator.k8s.example.json',
];
for (const requiredAsset of requiredAssets) {
  if (!existsSync(join(root, requiredAsset))) fail(`missing packaged Kubernetes asset ${requiredAsset}`);
}

const npmCli = process.env.npm_execpath;
const packed = npmCli
  ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    })
  : spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
    });
if (packed.status !== 0) {
  fail(`npm pack dry run failed: ${String(packed.stderr || packed.stdout || packed.error || 'unknown error').trim()}`);
} else {
  try {
    const report = JSON.parse(packed.stdout)[0];
    const files = new Set((report.files || []).map((entry) => entry.path));
    for (const requiredAsset of requiredAssets) {
      if (!files.has(requiredAsset)) fail(`npm package is missing ${requiredAsset}`);
    }
    for (const forbidden of ['config/agentorchestrator.json', 'config/canonical-opencode.json', '.env']) {
      if (files.has(forbidden)) fail(`npm package must not contain local configuration ${forbidden}`);
    }
  } catch (error) {
    fail(`could not parse npm pack dry-run output: ${error.message}`);
  }
}

const releaseRef = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (releaseRef?.startsWith('v') && releaseRef.slice(1) !== packageJson.version) {
  fail(`release tag ${releaseRef} does not match package version ${packageJson.version}`);
}

if (!process.exitCode) {
  console.log(`Verified ${packageJson.name}@${packageJson.version}`);
}

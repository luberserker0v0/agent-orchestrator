// Renders Dockerfile.template → Dockerfile, extracting OPENCODE_VERSION from config
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

const CONFIG_PATH = join(__dirname, '..', 'config', 'agentorchestrator.json');
const EXAMPLE_PATH = join(__dirname, '..', 'config', 'agentorchestrator.example.json');
const TEMPLATE_PATH = join(__dirname, '..', 'Dockerfile.template');
const OUTPUT_PATH = join(__dirname, '..', 'Dockerfile');

let version = '';

// Try to read version from the first direct runtime in config
for (const configPath of [CONFIG_PATH, EXAMPLE_PATH]) {
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      const runtimes = config?.orchestrator?.runtimes ?? [];
      for (const rt of runtimes) {
        if (rt.type === 'direct' && rt.config?.version) {
          version = rt.config.version;
          break;
        }
        if (rt.type === 'docker' && rt.config?.image?.includes(':')) {
          version = rt.config.image.split(':')[1];
          break;
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  if (version) break;
}

if (!version) {
  console.error('Warning: could not determine OPENCODE_VERSION from config. Using default.');
  version = '';
}

const template = readFileSync(TEMPLATE_PATH, 'utf-8');

// Replace the placeholder (if any) in the template
const rendered = template.replace(/{{OPENCODE_VERSION}}/g, version);
writeFileSync(OUTPUT_PATH, rendered, 'utf-8');

console.log(`Rendered Dockerfile (OPENCODE_VERSION=${version || 'not set'})`);

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR_NAME = 'antigravity-pulse';

function parseTargetDir(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--target=')) {
      return resolve(argv[i].slice('--target='.length));
    }
    if (argv[i] === '--target' && argv[i + 1]) {
      return resolve(argv[i + 1]);
    }
  }
  return join(homedir(), '.gemini', 'config', 'plugins', PLUGIN_DIR_NAME);
}

const targetDir = parseTargetDir(process.argv.slice(2));
mkdirSync(targetDir, { recursive: true });

cpSync(join(__dirname, 'plugin.json'), join(targetDir, 'plugin.json'), { force: true });

for (const dir of ['assets', 'compat', 'sidecars']) {
  const src = join(__dirname, dir);
  const dest = join(targetDir, dir);
  if (!existsSync(src)) {
    throw new Error(`Missing required directory: ${src}`);
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

console.log(`[antigrative-dashboard-1m] Installed to: ${targetDir}`);

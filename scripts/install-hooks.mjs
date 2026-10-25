import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.git') && !process.env.CI) {
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
  }).stdout.trim();
  if (!current || current === '.githooks')
    spawnSync('git', ['config', 'core.hooksPath', '.githooks']);
  else console.warn(`Existing hooksPath=${current}; add npm run check to your pre-commit hook.`);
}

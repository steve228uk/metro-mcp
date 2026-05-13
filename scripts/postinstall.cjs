const { existsSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

// Only run in a development checkout where the Preact build sources are present.
// When installed from npm, scripts/build-apps.ts is not shipped (only dist/ is in "files"),
// so this exits silently and the pre-built dist/ is used as-is.
const buildScript = join(__dirname, 'build-apps.ts');
if (existsSync(buildScript)) {
  execSync('bun run scripts/build-apps.ts', { stdio: 'inherit', cwd: join(__dirname, '..') });
}

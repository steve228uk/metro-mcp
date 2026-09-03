import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/publish-mcp-registry.sh', import.meta.url));
const propagationError = `Error: publish failed: server returned status 400: ${JSON.stringify({
  title: 'Bad Request',
  status: 400,
  detail: 'Failed to publish server',
  errors: [{
    message: "registry validation failed for package 0 (metro-mcp): NPM package 'metro-mcp' exists, but version '0.14.0' was not found (status: 404). A newly published release can take a moment to appear on the registry. Wait and retry, or publish version '0.14.0' before registering it",
  }],
})}`;

function runPublisher(options: { failures?: number; error?: string; exitCode?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'metro-mcp-publish-test-'));
  try {
    writeFileSync(join(directory, 'attempts'), '');
    writeFileSync(join(directory, 'delays'), '');
    writeFileSync(join(directory, 'error'), options.error ?? propagationError);
    writeFileSync(join(directory, 'mcp-publisher'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != publish ]]; then exit 99; fi
printf 'publish\\n' >> attempts
attempts=$(wc -l < attempts)
if ((attempts <= TEST_FAILURES)); then
  cat error >&2
  exit "$TEST_EXIT_CODE"
fi
printf 'Successfully published\\n'
`, { mode: 0o700 });
    // Record the real retry intervals without making the test wait ten minutes.
    writeFileSync(join(directory, 'sleep'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> delays
`, { mode: 0o700 });

    const result = spawnSync('bash', [script], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TEST_FAILURES: String(options.failures ?? 0),
        TEST_EXIT_CODE: String(options.exitCode ?? 1),
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.error) throw result.error;
    return {
      ...result,
      attempts: readFileSync(join(directory, 'attempts'), 'utf8').trim().split('\n'),
      delays: readFileSync(join(directory, 'delays'), 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('MCP Registry publication retries', () => {
  test('publishes once without waiting when the npm version is already visible', () => {
    const result = runPublisher();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Successfully published');
    expect(result.attempts).toEqual(['publish']);
    expect(result.delays).toEqual([]);
  });

  test('retries the actual npm propagation error and stops on success', () => {
    const result = runPublisher({ failures: 2 });
    expect(result.status).toBe(0);
    expect(result.attempts).toEqual(['publish', 'publish', 'publish']);
    expect(result.delays).toEqual(['30', '30']);
    expect(result.stderr).toContain(propagationError);
    expect(result.stdout).toContain('Successfully published');
  });

  test('allows propagation to finish on the final attempt', () => {
    const result = runPublisher({ failures: 20 });
    expect(result.status).toBe(0);
    expect(result.attempts).toHaveLength(21);
    expect(result.delays).toEqual(Array(20).fill('30'));
  });

  test('stops after ten minutes of retry delays and preserves the failing exit code', () => {
    const result = runPublisher({ failures: 100, exitCode: 7 });
    expect(result.status).toBe(7);
    expect(result.attempts).toHaveLength(21);
    expect(result.delays).toEqual(Array(20).fill('30'));
    expect(result.stderr).toContain('still unavailable after 21 registration attempts; giving up.');
  });

  test.each([
    'Error: authentication failed (status: 401)',
    'Error: invalid server.json: missing required field',
    'Error: server version already exists (status: 409)',
    'Error: unrelated resource was not found (status: 404)',
    'Error: registry unavailable (status: 503)',
  ])('does not retry unrelated errors: %s', (error) => {
    const result = runPublisher({ failures: 100, error, exitCode: 2 });
    expect(result.status).toBe(2);
    expect(result.attempts).toEqual(['publish']);
    expect(result.delays).toEqual([]);
    expect(result.stderr).toContain(error);
  });

  test.each(['publish.yml', 'publish-mcp-registry.yml'])('%s uses the bounded helper after authentication', (workflow) => {
    const yaml = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
    expect(yaml).toContain('timeout-minutes: 15');
    expect(yaml).toContain('./mcp-publisher login github-oidc\n          bash scripts/publish-mcp-registry.sh');
    expect(yaml).not.toContain('./mcp-publisher publish');
  });
});

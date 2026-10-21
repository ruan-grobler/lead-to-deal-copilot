import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'ltd-entry-'));

/** A clean environment: no real tokens from the shell can leak into these runs. */
const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  MODE: 'mock',
  HOST: '127.0.0.1',
  PORT: '0',
  DATABASE_PATH: join(dir, 'copilot.db'),
  ...extra,
});

const run = async (args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env: env(extra) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

const waitForLine = async (child: ChildProcessWithoutNullStreams, pattern: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern}. Output so far: ${buffer}`));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split('\n').find((entry) => entry.includes(pattern));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
  });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('entrypoints in mock mode', () => {
  it('npm start serves health and a webhook, then shuts down cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], { cwd: ROOT, env: env({ LOG_LEVEL: 'info' }) });
    try {
      const started = await waitForLine(child, '"server.started"');
      expect(started).toMatchObject({ mode: 'mock', slack: 'mocked, no Socket Mode connection' });
      const url = String(started.url);
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);

      const posted = waitForLine(child, '"mock.slack.message"');
      const response = await fetch(`${url}/webhooks/form`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submissionId: 'entry_1', name: 'Test Person', email: 'test.person@test-company.example.com', message: 'We need managed IT for 20 staff.' }),
      });
      expect(response.status).toBe(202);
      expect(await posted).toMatchObject({ text: expect.stringContaining('Needs review') as unknown });

      const stopped = waitForLine(child, '"server.stopped"');
      child.kill('SIGTERM');
      await stopped;
      const code = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });
      expect(code).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('npm start refuses live mode without tokens', async () => {
    const result = await run(['src/main.ts'], { MODE: 'live' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('MODE=live needs HUBSPOT_ACCESS_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN');
  });

  it('npm run replay lists and replays the dead letter table', async () => {
    const list = await run(['src/cli/replay.ts', '--list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('0 pending dead letters (mock mode');
    const replay = await run(['src/cli/replay.ts']);
    expect(replay.stdout).toContain('Replayed 0: 0 succeeded, 0 failed again.');
    const bad = await run(['src/cli/replay.ts', '--id', 'abc']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--id must be a number');
  });

  it('npm run ingest:eml parses a folder of .eml files', async () => {
    const result = await run(['src/cli/ingest-eml.ts', 'fixtures/email']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Ingesting 7 .eml files from fixtures/email (mock mode)');
    expect(result.stdout).toMatch(/e03-malformed\.eml\s+lead \d+\s+needs_review\s+warnings: invalid_from_address/);
    const usage = await run(['src/cli/ingest-eml.ts']);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('Usage: npm run ingest:eml');
  });
});

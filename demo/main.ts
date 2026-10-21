import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatReport, runDemo } from './run-demo.ts';

/**
 * npm run demo              replay the 25 synthetic leads and print the report
 * npm run demo -- --save    also write it to docs/demo-output.txt and the logs to .data/demo-log.jsonl
 */
const main = async (): Promise<void> => {
  const save = process.argv.includes('--save');
  const result = await runDemo();
  const report = formatReport(result);
  process.stdout.write(report);
  if (save) {
    const root = join(import.meta.dirname, '..');
    writeFileSync(join(root, 'docs', 'demo-output.txt'), report);
    mkdirSync(join(root, '.data'), { recursive: true });
    writeFileSync(join(root, '.data', 'demo-log.jsonl'), `${result.logLines.join('\n')}\n`);
    process.stdout.write('\nSaved docs/demo-output.txt and .data/demo-log.jsonl\n');
  }
  if (result.checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});

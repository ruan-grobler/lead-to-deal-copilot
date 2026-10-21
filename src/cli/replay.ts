import { parseArgs } from 'node:util';
import { replayDeadLetters } from '../pipeline/dead-letter.ts';
import { bootstrapCli, print } from './bootstrap.ts';

/**
 * npm run replay              replay every pending dead letter
 * npm run replay -- --list    show pending dead letters, change nothing
 * npm run replay -- --id 3    replay one entry
 */
const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { list: { type: 'boolean', default: false }, id: { type: 'string' } } });
  const cli = bootstrapCli();
  try {
    const pending = cli.runtime.repo.listDeadLetters({ pendingOnly: true });
    if (values.list) {
      print(`${String(pending.length)} pending dead letter${pending.length === 1 ? '' : 's'} (${cli.runtime.config.mode} mode, ${cli.runtime.config.databasePath})`);
      for (const row of pending) {
        print(`  #${String(row.id)}  lead ${String(row.leadId)}  ${row.source}  ${row.stage}  ${row.httpStatus === null ? '' : `HTTP ${String(row.httpStatus)}  `}${row.createdAt}`);
      }
      return;
    }
    const deadLetterId = values.id === undefined ? undefined : Number(values.id);
    if (deadLetterId !== undefined && !Number.isInteger(deadLetterId)) {
      throw new Error('--id must be a number');
    }
    const summary = await replayDeadLetters(cli.runtime, deadLetterId === undefined ? {} : { deadLetterId });
    await cli.runtime.queue.onIdle();
    print(`Replayed ${String(summary.attempted)}: ${String(summary.succeeded)} succeeded, ${String(summary.failed)} failed again.`);
    for (const item of summary.results) {
      print(`  #${String(item.deadLetter.id)}  lead ${String(item.deadLetter.leadId)}  ${item.result.status}`);
    }
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await cli.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

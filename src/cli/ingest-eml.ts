import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEmailToLead } from '../sources/email.ts';
import { bootstrapCli, print } from './bootstrap.ts';

/**
 * npm run ingest:eml -- <folder>
 * Parses every .eml file in the folder and runs it through the pipeline,
 * the same way POST /webhooks/email does.
 */
const main = async (): Promise<void> => {
  const folder = process.argv[2];
  if (!folder) {
    throw new Error('Usage: npm run ingest:eml -- <folder with .eml files>');
  }
  const files = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith('.eml')).sort();
  const cli = bootstrapCli();
  try {
    print(`Ingesting ${String(files.length)} .eml file${files.length === 1 ? '' : 's'} from ${folder} (${cli.runtime.config.mode} mode)`);
    for (const file of files) {
      const lead = await parseEmailToLead(await readFile(join(folder, file)), cli.runtime.clock.now());
      const outcome = cli.runtime.processor.ingest(lead);
      const result = outcome.duplicate ? null : await cli.runtime.processor.process(outcome.leadId);
      const status = result ? result.status : `duplicate of lead ${String(outcome.leadId)}`;
      const warnings = lead.parseWarnings.length > 0 ? `  warnings: ${lead.parseWarnings.join(', ')}` : '';
      print(`  ${file}  lead ${String(outcome.leadId)}  ${status}${warnings}`);
    }
  } finally {
    await cli.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

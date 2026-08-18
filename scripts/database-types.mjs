import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const outputPath = resolve(projectRoot, 'src/types/database.ts');
const executable = resolve(
  projectRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const result = spawnSync(
  executable,
  ['gen', 'types', 'typescript', '--local', '--schema', 'public'],
  {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  },
);

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.error || result.status !== 0) {
  throw result.error ?? new Error('Supabase type generation failed');
}

const generated = `${result.stdout.trimEnd()}\n`;
if (
  !generated.includes('export type Json =') ||
  !generated.includes('export type Database =')
) {
  throw new Error(
    'Supabase returned incomplete type output; the checked-in file was not changed.',
  );
}

const checking = process.argv.includes('--check');

if (checking) {
  const current = readFileSync(outputPath, 'utf8').replaceAll('\r\n', '\n');
  if (current !== generated) {
    const currentLines = current.split('\n');
    const generatedLines = generated.split('\n');
    const firstMismatch = Array.from(
      { length: Math.max(currentLines.length, generatedLines.length) },
      (_, index) => index,
    ).find((index) => currentLines[index] !== generatedLines[index]);

    console.error(
      'src/types/database.ts is out of date. Start local Supabase and run npm run db:types.',
    );
    if (firstMismatch !== undefined) {
      console.error(`First mismatch at line ${firstMismatch + 1}.`);
      console.error(`Checked in: ${JSON.stringify(currentLines[firstMismatch])}`);
      console.error(
        `Generated:  ${JSON.stringify(generatedLines[firstMismatch])}`,
      );
    }
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, generated);
  console.log('Updated src/types/database.ts from the local Supabase schema.');
}

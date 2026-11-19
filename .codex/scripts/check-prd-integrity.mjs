import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// These source hashes were captured before the Codex setup was created.
const protectedSources = [
  {
    name: 'AI SOP Assistant — Technical Product Req.md',
    sha256: 'd91d6eacc6e390b6f5bf4bb3018d801b2f39b4ae9f4d64f6b1097d0b7a4a2dc1',
  },
  {
    name: 'PRD AI SOP Assistant.pdf',
    sha256: 'a84d9cb74ae572a6b9e2943137277adc732567169f5d5110de29734af0c6ea5e',
  },
];

const repositoryRoot = new URL('../../', import.meta.url);
let failed = false;

for (const source of protectedSources) {
  try {
    const contents = await readFile(new URL(source.name, repositoryRoot));
    const actualHash = createHash('sha256').update(contents).digest('hex');
    if (actualHash !== source.sha256) {
      console.error(`FAIL: protected source changed: ${source.name}`);
      failed = true;
    } else {
      console.log(`PASS: protected source unchanged: ${source.name}`);
    }
  } catch (error) {
    console.error(`FAIL: protected source unavailable: ${source.name} (${error.code ?? 'read error'})`);
    failed = true;
  }
}

if (failed) {
  console.error('Stop and report the mismatch. Do not rewrite protected sources or update the baseline hashes.');
  process.exitCode = 1;
}

// A stand-in for transcribe-worker.py in tests: one JSON line in ({ id, file, lang } or { id, warm }), one JSON line out.
import fs from 'node:fs';
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, file, lang, warm } = JSON.parse(line);
  if (warm) { process.stdout.write(JSON.stringify({ id, text: '' }) + '\n'); continue; }
  const size = fs.statSync(file).size;
  process.stdout.write(JSON.stringify({ id, text: `heard ${size} bytes in ${lang || 'auto'}` }) + '\n');
}

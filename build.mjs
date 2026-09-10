import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
await mkdir('public', { recursive: true });
let b64 = '';
for (let i = 0; i < 5; i++) { b64 += (await readFile('_idx/index.br.b64.' + i, 'utf8')).replace(/\s+/g, ''); }
const buf = brotliDecompressSync(Buffer.from(b64, 'base64'));
const sha = createHash('sha256').update(buf).digest('hex');
if (sha !== 'ab81e9e79c633370422a85de2ad00cf7cab5a4a20de3871738ccf1effc0d25bd') throw new Error('index.html sha mismatch: ' + sha);
await writeFile('public/index.html', buf);
await writeFile('public/regions.js', await readFile('regions.js'));
await writeFile('public/config.js', await readFile('config.js'));
console.log('BUILD_OK index=' + buf.length + ' sha_ok');

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdf } from './export-ride-receipt';
import { htmlToText } from '../shared/receipt-html';

const requests: string[] = [];
const server = createServer((req, res) => { requests.push(req.url || ''); res.end('unexpected'); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const origin = `http://127.0.0.1:${address.port}`;
const dir = mkdtempSync(join(tmpdir(), 'receipt-render-'));
try {
  const html = `<html><head><link rel="stylesheet" href="${origin}/style">
    <style>body { background-image: url('${origin}/css-image') }</style></head>
    <body><p>Total Paid SGD 18.40</p><img src="${origin}/image">
    <iframe src="${origin}/frame"></iframe>
    <script>fetch('${origin}/script');location='${origin}/navigate'</script></body></html>`;
  assert.equal(htmlToText('<p>Total Paid SGD 18.40</p>' + '<'.repeat(100000)), 'Total Paid SGD 18.40');
  const input = join(dir, 'receipt.html');
  const output = join(dir, 'receipt.pdf');
  writeFileSync(input, html);
  await renderPdf(input, output);
  const pdf = readFileSync(output);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1000, 'a printable receipt is produced');
  assert.deepEqual(requests, [], 'HTML resources, frames, scripts and navigation must not reach the host network');
  console.log('Receipt exporter security passed: offline PDF, zero network requests, bounded text extraction');
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

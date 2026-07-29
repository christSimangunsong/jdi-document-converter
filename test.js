const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const config = require('./src/config');
const { cleanText } = require('./src/utils/textCleaner');
const { rebuildDocumentStructure } = require('./src/utils/DocumentStructureRebuilder');
const { withRetry } = require('./src/utils/retry');

let passed = 0;
let failed = 0;
const failedTests = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    failedTests.push({ name, error: e.message });
    console.log(`  \u2717 ${name}: ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    failedTests.push({ name, error: e.message });
    console.log(`  \u2717 ${name}: ${e.message}`);
  }
}

// --- Inline functions from server.js ---
function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extractFileNameFromUrl(url) {
  try {
    const safe = url.replace(/\s/g, '%20');
    const segments = new URL(safe).pathname.split('/').filter(Boolean);
    const last = segments.pop() || 'doc';
    const decoded = decodeURIComponent(last);
    return decoded
      .replace(/\.pdf$/i, '')
      .replace(/[^a-zA-Z0-9 _-]/g, '_')
      .substring(0, 200);
  } catch {
    return 'doc_' + Date.now();
  }
}

// ========================================================================
console.log('\n=== 1. Config ===');
test('outputDir is absolute string', () => {
  assert.strictEqual(typeof config.outputDir, 'string');
  assert.ok(path.isAbsolute(config.outputDir));
});
test('logDir is absolute string', () => {
  assert.strictEqual(typeof config.logDir, 'string');
  assert.ok(path.isAbsolute(config.logDir));
});
test('maxRetries defaults to 3', () => assert.strictEqual(config.maxRetries, 3));
test('retryDelayMs defaults to 2000', () => assert.strictEqual(config.retryDelayMs, 2000));
test('downloadTimeout defaults to 60000', () => assert.strictEqual(config.downloadTimeout, 60000));
test('ocrLang defaults to id', () => assert.strictEqual(config.ocrLang, 'id'));
test('linksPath is absolute', () => assert.ok(path.isAbsolute(config.linksPath)));
test('db config has all keys', () => {
  assert.strictEqual(typeof config.db.host, 'string');
  assert.strictEqual(typeof config.db.user, 'string');
  assert.strictEqual(typeof config.db.name, 'string');
  assert.strictEqual(typeof config.db.port, 'number');
});

// ========================================================================
console.log('\n=== 2. cleanText ===');
test('empty string returns empty', () => assert.strictEqual(cleanText(''), ''));
test('null returns empty', () => assert.strictEqual(cleanText(null), ''));
test('undefined returns empty', () => assert.strictEqual(cleanText(undefined), ''));
test('collapses multiple spaces', () => {
  const result = cleanText('Hello    World');
  assert.ok(result.includes('Hello World'));
  assert.ok(!result.includes('    '));
});
test('collapses multiple newlines to max 2', () => {
  const result = cleanText('a\n\n\n\n\nb');
  assert.strictEqual(result, 'a\n\nb');
});
test('replaces bullet characters with dash', () => {
  assert.strictEqual(cleanText('\u2022 item'), '- item');
  assert.strictEqual(cleanText('\u25CF item'), '- item');
});
test('replaces smart quotes', () => {
  assert.strictEqual(cleanText('\u201Chello\u201D'), '"hello"');
  assert.strictEqual(cleanText('\u2018hello\u2019'), "'hello'");
});
test('replaces em/en dash', () => {
  assert.strictEqual(cleanText('a\u2013b'), 'a-b');
  assert.strictEqual(cleanText('a\u2014b'), 'a-b');
});
test('adds newline before BAB', () => {
  const result = cleanText('text\nBAB I Pendahuluan');
  assert.ok(result.includes('\n\nBAB I'));
});
test('adds newline before Pasal', () => {
  const result = cleanText('text\nPasal 1');
  assert.ok(result.includes('\n\nPasal 1'));
});
test('trims leading/trailing whitespace', () => {
  const result = cleanText('  hello world  ');
  assert.strictEqual(result, 'hello world');
});
test('preserves Latin extended chars', () => {
  const result = cleanText('Pasal \u00E7 \u00E9 \u0103');
  assert.ok(result.includes('\u00E7'));
});
test('preserves Cyrillic chars', () => {
  const input = '\u041F\u0440\u0438\u0432\u0435\u0442';
  const result = cleanText(input);
  assert.ok(result.includes(input));
});
test('removes control chars except newline', () => {
  const result = cleanText('a\x00b\x01c\nd');
  assert.strictEqual(result, 'abc\nd');
});

// ========================================================================
console.log('\n=== 3. DocumentStructureRebuilder ===');
test('empty text returns empty', () => assert.strictEqual(rebuildDocumentStructure(''), ''));
test('simple text returns with trailing newline', () => {
  const result = rebuildDocumentStructure('Hello World');
  assert.ok(result.endsWith('\n'));
  assert.ok(result.includes('Hello World'));
});
test('detects BAB heading', () => {
  const result = rebuildDocumentStructure('BAB I Pendahuluan\nIsi bab');
  assert.ok(result.includes('BAB I Pendahuluan'));
});
test('detects Pasal', () => {
  const result = rebuildDocumentStructure('Pasal 1\nIsi pasal');
  assert.ok(result.includes('Pasal 1'));
});
test('detects Ayat numbering', () => {
  const result = rebuildDocumentStructure('(1) Ayat satu\n(2) Ayat dua');
  assert.ok(result.includes('(1) Ayat satu'));
  assert.ok(result.includes('(2) Ayat dua'));
});
test('detects Bagian header', () => {
  const result = rebuildDocumentStructure('Bagian Kesatu\nIsi');
  assert.ok(result.includes('Bagian Kesatu'));
});
test('detects Paragraf', () => {
  const result = rebuildDocumentStructure('Paragraf 1\nIsi');
  assert.ok(result.includes('Paragraf 1'));
});
test('Ayat children have 2-space indent', () => {
  const result = rebuildDocumentStructure('Pasal 1\n(1) Ayat satu\n(2) Ayat dua');
  const lines = result.split('\n');
  const ayatLine = lines.find((l) => l.includes('Ayat satu'));
  assert.ok(ayatLine, 'Ayat satu should exist');
  assert.ok(ayatLine.startsWith('  '), 'Ayat should be indented with 2 spaces');
});
test('HURUF children have 4-space indent', () => {
  const result = rebuildDocumentStructure('(1) Ayat satu\na. Huruf a\nb. Huruf b');
  const hurufLine = result.split('\n').find((l) => l.includes('Huruf a'));
  assert.ok(hurufLine, 'Huruf a should exist');
  assert.ok(hurufLine.startsWith('    '), 'Huruf should be indented with 4 spaces');
});
test('multiple consecutive newlines collapsed', () => {
  const result = rebuildDocumentStructure('a\n\n\n\nb');
  assert.ok(!result.includes('\n\n\n'), 'should have at most 2 consecutive newlines');
});

// ========================================================================
console.log('\n=== 4. withRetry ===');
testAsync('succeeds on first try', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return 'ok';
    },
    { maxRetries: 3, delayMs: 0 },
  );
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 1);
});
testAsync('succeeds on retry', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('try again');
      return 'ok';
    },
    { maxRetries: 3, delayMs: 0 },
  );
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);
});
testAsync('fails after all retries', async () => {
  try {
    await withRetry(
      async () => {
        throw new Error('always fail');
      },
      { maxRetries: 2, delayMs: 0, label: 'Test' },
    );
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('gagal setelah 2 percobaan'));
    assert.ok(e.message.includes('always fail'));
  }
});
testAsync('uses custom options', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error('retry');
      return 'custom';
    },
    { maxRetries: 5, delayMs: 0, label: 'CustomLabel' },
  );
  assert.strictEqual(result, 'custom');
});

// ========================================================================
console.log('\n=== 5. computeHash ===');
test('SHA256 of empty buffer', () => {
  const hash = computeHash(Buffer.alloc(0));
  assert.strictEqual(hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('SHA256 of known string', () => {
  const hash = computeHash(Buffer.from('hello world', 'utf-8'));
  assert.strictEqual(hash, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});
test('returns 64 char hex string', () => {
  const hash = computeHash(Buffer.from('test'));
  assert.strictEqual(hash.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(hash));
});
test('different buffers produce different hashes', () => {
  const h1 = computeHash(Buffer.from('a'));
  const h2 = computeHash(Buffer.from('b'));
  assert.notStrictEqual(h1, h2);
});

// ========================================================================
console.log('\n=== 6. extractFileNameFromUrl ===');
test('simple PDF URL', () => {
  const name = extractFileNameFromUrl('https://example.com/file.pdf');
  assert.strictEqual(name, 'file');
});
test('URL without .pdf', () => {
  const name = extractFileNameFromUrl('https://example.com/dokumen');
  assert.strictEqual(name, 'dokumen');
});
test('URL with multiple path segments', () => {
  const name = extractFileNameFromUrl('https://example.com/2024/laporan/001.pdf');
  assert.strictEqual(name, '001');
});
test('URL with spaces encoded as %20', () => {
  const name = extractFileNameFromUrl('https://example.com/perbub%20no%206.pdf');
  assert.strictEqual(name, 'perbub no 6');
});
test('URL with literal spaces', () => {
  const name = extractFileNameFromUrl('https://example.com/perbub no 6.pdf');
  assert.strictEqual(name, 'perbub no 6');
});
test('sanitizes special chars to underscore', () => {
  const name = extractFileNameFromUrl('https://example.com/file@!*123.pdf');
  assert.strictEqual(name, 'file___123');
});
test('strips .PDF case-insensitive', () => {
  const name = extractFileNameFromUrl('https://example.com/FILE.PDF');
  assert.strictEqual(name, 'FILE');
});
test('truncates to 200 chars', () => {
  const longName = 'a'.repeat(300) + '.pdf';
  const name = extractFileNameFromUrl(`https://example.com/${longName}`);
  assert.ok(name.length <= 200);
});
test('invalid URL returns fallback', () => {
  const name = extractFileNameFromUrl('not-a-url');
  assert.ok(name.startsWith('doc_'));
});
test('URL with only domain returns "doc" fallback', () => {
  const name = extractFileNameFromUrl('https://example.com/');
  assert.strictEqual(name, 'doc');
});

// ========================================================================
console.log('\n=== 7. Integration: cleanText + rebuildDocumentStructure ===');
test('full pipeline preserves Indonesian legal text', () => {
  const input = 'BAB   I   Pendahuluan\n\n\nPasal  1\n(1) Ayat  satu\n(2)  Ayat dua\na.  Huruf a';
  const cleaned = cleanText(input);
  const structured = rebuildDocumentStructure(cleaned);
  assert.ok(structured.includes('BAB I Pendahuluan'));
  assert.ok(structured.includes('Pasal 1'));
  assert.ok(structured.includes('(1) Ayat satu'));
  assert.ok(structured.includes('(2) Ayat dua'));
  assert.ok(structured.includes('Huruf a'));
});

// ========================================================================
console.log('\n=== 8. tableFormatter ===');
const { formatTableHtmlToText } = require('./src/utils/tableFormatter');
test('empty html returns empty', () => assert.strictEqual(formatTableHtmlToText(''), ''));
test('simple table with header', () => {
  const html = '<table><tr><th>Nama</th><th>Umur</th></tr><tr><td>Ali</td><td>25</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(result.includes('Nama'));
  assert.ok(result.includes('Umur'));
  assert.ok(result.includes('Ali'));
  assert.ok(result.includes('25'));
  assert.ok(result.includes('+'));
  assert.ok(result.includes('|'));
});
test('table with multiline cell', () => {
  const html = '<table><tr><td>Hello World</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(result.includes('Hello World'));
});

// ========================================================================
console.log('\n=== 9. tableGarbageFilter ===');
const { isTableGarbage, filterTableGarbage } = require('./src/utils/textCleaner');
test('clean legal text not garbage', () => {
  assert.strictEqual(isTableGarbage('Bupati adalah Bupati Dairi'), false);
});
test('short line not garbage', () => {
  assert.strictEqual(isTableGarbage('Bupati'), false);
});
test('isolated char soup is garbage', () => {
  assert.strictEqual(isTableGarbage('N M M 1 I I I I 1 I I F 8 m V b a e m m'), true);
});
test('digit line with spaces is garbage', () => {
  assert.strictEqual(isTableGarbage('7 0 0 0 0 1 9 0 1'), true);
});
test('legal text with numbers not garbage', () => {
  assert.strictEqual(isTableGarbage('1. Undang-Undang Nomor 18 Tahun 2008'), false);
});
test('number with description not garbage', () => {
  assert.strictEqual(isTableGarbage('30% (tiga puluh persen) dari angka timbulan'), false);
});
test('filter removes trailing garbage block', () => {
  const clean = 'Pasal 11\nPeraturan Bupati ini mulai berlaku';
  const garbage = '7 0 0 1 1\nN M M 1 I I I F 8';
  const result = filterTableGarbage(clean + '\n' + garbage);
  assert.strictEqual(result.trim(), clean);
  assert.ok(!result.includes('7 0 0'));
});
test('filter keeps clean text unchanged', () => {
  const text = 'BAB I\nPasal 1\n(1) Ayat satu\n(2) Ayat dua';
  assert.strictEqual(filterTableGarbage(text), text);
});
test('real document ending with lampiran garbage', () => {
  const doc = [
    'BAB I KETENTUAN UMUM',
    'Pasal 1',
    'Dalam Peraturan Bupati ini yang dimaksud dengan:',
    '',
    'BAB V KETENTUAN PENUTUP',
    'Pasal 11',
    'Peraturan Bupati ini mulai berlaku pada tanggal diundangkan.',
    'Ditetapkan di Sidikalang pada tanggal 28 Januari 2020',
    'BUPATI DAIRI, ttd. EDDY KELENG ATE BERUTU',
    'BERITA DAERAH KABUPATEN DAIRI TAHUN 2020 NOMOR 2',
  ].join('\n');
  const garbage = [
    'N M M 1 I I I I 1 I I F 8 m V b a e m m',
    '7 0 0 0 0 1',
    'T I I I I A E I I T T I I 3 T Y T P R I N O',
    '1 1 9 1 9 11 D 01 N 10 0 N 1 1 1 1 1 1 1 1 1 1',
  ].join('\n');
  const result = filterTableGarbage(doc + '\n' + garbage);
  assert.strictEqual(result, doc);
  assert.ok(!result.includes('N M M 1'));
  assert.ok(result.includes('Pasal 11'));
  assert.ok(result.includes('BERITA DAERAH'));
});

// ========================================================================
console.log('\n=== 10. Exit code ===');
console.log(`\nHasil: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Test gagal:');
  failedTests.forEach((t) => console.log(`  - ${t.name}: ${t.error}`));
}
process.exit(failed > 0 ? 1 : 0);

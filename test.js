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
test('strips literal None placeholder cells', () => {
  const html =
    '<table><tr><th>PROGRAM</th><th>SATUAN</th></tr>' +
    '<tr><td>None</td><td>Daerah</td></tr>' +
    '<tr><td>None c) DPRD kabupaten</td><td>None</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(!result.includes('None'), `masih ada None: ${result}`);
  assert.ok(result.includes('PROGRAM'));
  assert.ok(result.includes('c) DPRD kabupaten'));
});
test('drops numeric index header row (0|1|2)', () => {
  const html =
    '<table><tr><th>0</th><th>1</th><th>2</th></tr>' +
    '<tr><td>NO</td><td>KEBIJAKAN</td><td>PELAKSANA</td></tr>' +
    '<tr><td>1</td><td>Program</td><td>Dinas</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(!result.includes('| 0 |'), `baris indeks masih ada: ${result}`);
  assert.ok(result.includes('KEBIJAKAN'));
  assert.ok(result.includes('Program'));
});
test('strips border "=" artifact lines in cells', () => {
  const html = '<table><tr><td>=\nNO|KEBIJAKAN</td></tr></table>';
  const result = formatTableHtmlToText(html);
  const contentLines = result
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => l.trim());
  assert.ok(contentLines.length >= 1);
  assert.ok(
    contentLines.some((l) => l.includes('NO|KEBIJAKAN')),
    `konten hilang: ${result}`,
  );
  assert.ok(
    contentLines.every((l) => l !== '|' && !/^\|[-=]+\|$/.test(l.replace(/ /g, ''))),
    `artefak border tersisa: ${result}`,
  );
});
test('drops all-empty rows after cleanup', () => {
  const html =
    '<table><tr><td>Ali</td><td>25</td></tr>' +
    '<tr><td></td><td></td></tr>' +
    '<tr><td>Budi</td><td>30</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(result.includes('Ali'));
  assert.ok(result.includes('Budi'));
  assert.strictEqual((result.match(/^\|/gm) || []).length, 2, 'hanya 2 baris data');
});
test('keeps real data rows that contain only digits', () => {
  const html =
    '<table><tr><th>NO</th><th>TAHUN</th></tr>' +
    '<tr><td>1</td><td>2020</td></tr>' +
    '<tr><td>2</td><td>2021</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(result.includes('2020'));
  assert.ok(result.includes('2021'));
  assert.ok(result.includes('TAHUN'));
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
console.log('\n=== 10. Reconstruction Pipeline ===');

const {
  BBox,
  Document,
  DocumentNode,
  Table,
  Heading,
  Line,
  Block,
} = require('./src/reconstruction/models/documentModel');
const { documentAnalyzer } = require('./src/reconstruction/analyzer/documentAnalyzer');
const { readingOrderResolver } = require('./src/reconstruction/builder/readingOrderResolver');
const { lineMerger } = require('./src/reconstruction/builder/lineMerger');
const { documentTreeBuilder } = require('./src/reconstruction/builder/documentTreeBuilder');
const { legalParser } = require('./src/reconstruction/builder/legalParser');
const { markdownGenerator } = require('./src/reconstruction/output/markdownGenerator');
const { htmlGenerator } = require('./src/reconstruction/output/htmlGenerator');
const { semanticJsonGenerator } = require('./src/reconstruction/output/semanticJsonGenerator');
const { chunkBuilder } = require('./src/reconstruction/output/chunkBuilder');

test('BBox centerX/Y compute', () => {
  const b = new BBox(10, 20, 100, 50);
  assert.strictEqual(b.centerX(), 60);
  assert.strictEqual(b.centerY(), 45);
});

test('BBox overlap detection', () => {
  const a = new BBox(0, 0, 100, 100);
  const b = new BBox(25, 25, 100, 100);
  assert.ok(a.overlaps(b));
});

test('DocumentNode constructor defaults', () => {
  const n = new DocumentNode({ type: 'bab', title: 'BAB I' });
  assert.strictEqual(n.type, 'bab');
  assert.strictEqual(n.title, 'BAB I');
  assert.strictEqual(n.level, 0);
  assert.deepStrictEqual(n.children, []);
});

test('DocumentNode toJSON minimal', () => {
  const n = new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi pasal' });
  const json = n.toJSON();
  assert.strictEqual(json.type, 'pasal');
  assert.strictEqual(json.number, '1');
  assert.strictEqual(json.title, 'Pasal 1');
  assert.strictEqual(json.text, 'Isi pasal');
});

test('DocumentNode flatten single', () => {
  const n = new DocumentNode({ type: 'root' });
  const flat = n.flatten();
  assert.strictEqual(flat.length, 1);
});

test('DocumentNode flatten nested', () => {
  const child = new DocumentNode({ type: 'pasal', title: 'Pasal 1' });
  const root = new DocumentNode({ type: 'root', children: [child] });
  const flat = root.flatten();
  assert.strictEqual(flat.length, 2);
});

test('Table toMarkdown with headers', () => {
  const t = new Table({
    headers: ['No', 'Nama', 'Keterangan'],
    rows: [
      ['1', 'A', 'X'],
      ['2', 'B', 'Y'],
    ],
  });
  const md = t.toMarkdown();
  assert.ok(md.includes('| No | Nama | Keterangan |'));
  assert.ok(md.includes('| 1 | A | X |'));
});

test('Table toMarkdown empty returns empty', () => {
  const t = new Table({ headers: [], rows: [] });
  assert.strictEqual(t.toMarkdown(), '');
});

test('readingOrderResolver sorts by position', () => {
  const blocks = [
    { text: 'B', confidence: 1, bbox: { x: 50, y: 50, w: 100, h: 20 }, page: 1 },
    { text: 'A', confidence: 1, bbox: { x: 10, y: 10, w: 100, h: 20 }, page: 1 },
  ];
  const sorted = readingOrderResolver.resolve(blocks);
  assert.strictEqual(sorted[0].text, 'A');
  assert.strictEqual(sorted[1].text, 'B');
});

test('readingOrderResolver handles empty input', () => {
  assert.deepStrictEqual(readingOrderResolver.resolve([]), []);
});

test('readingOrderResolver preserves order when no bbox', () => {
  const blocks = [
    { text: 'B', confidence: 1, page: 1 },
    { text: 'A', confidence: 1, page: 1 },
  ];
  const sorted = readingOrderResolver.resolve(blocks);
  assert.strictEqual(sorted[0].text, 'B');
});

test('lineMerger merges adjacent lines', () => {
  const blocks = [
    { text: 'Hello', confidence: 1, bbox: { x: 0, y: 0, w: 50, h: 20 }, page: 1 },
    { text: 'World', confidence: 1, bbox: { x: 60, y: 0, w: 50, h: 20 }, page: 1 },
  ];
  const lines = lineMerger.merge(blocks);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, 'Hello World');
});

test('lineMerger separate lines by Y', () => {
  const blocks = [
    { text: 'First', confidence: 1, bbox: { x: 0, y: 0, w: 50, h: 20 }, page: 1 },
    { text: 'Second', confidence: 1, bbox: { x: 0, y: 50, w: 50, h: 20 }, page: 1 },
  ];
  const lines = lineMerger.merge(blocks);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].text, 'First');
  assert.strictEqual(lines[1].text, 'Second');
});

test('documentTreeBuilder builds BAB node', async () => {
  const lines = [
    new Line({ text: 'BAB I KETENTUAN UMUM', order: 0 }),
    new Line({ text: 'Pasal 1', order: 1 }),
    new Line({ text: '(1) Ayat satu', order: 2 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  assert.strictEqual(tree.type, 'root');
  assert.ok(tree.children.length >= 1);
  const bab = tree.children[0];
  assert.strictEqual(bab.type, 'bab');
  assert.strictEqual(bab.number, 'I');
});

test('documentTreeBuilder detects pasal', async () => {
  const lines = [new Line({ text: 'Pasal 1', order: 0 }), new Line({ text: 'Isi Pasal 1', order: 1 })];
  const tree = await documentTreeBuilder.build(lines);
  const pasal = tree.children[0];
  assert.strictEqual(pasal.type, 'pasal');
  assert.strictEqual(pasal.number, '1');
});

test('documentTreeBuilder detects ayat', async () => {
  const lines = [
    new Line({ text: 'Pasal 1', order: 0 }),
    new Line({ text: '(1) Ayat satu', order: 1 }),
    new Line({ text: '(2) Ayat dua', order: 2 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const pasal = tree.children[0];
  assert.strictEqual(pasal.type, 'pasal');
  assert.strictEqual(pasal.children.length, 2);
  assert.strictEqual(pasal.children[0].type, 'ayat');
  assert.strictEqual(pasal.children[0].number, 1);
});

test('documentTreeBuilder returns empty root for empty input', async () => {
  const tree = await documentTreeBuilder.build([]);
  assert.strictEqual(tree.type, 'root');
  assert.deepStrictEqual(tree.children, []);
});

test('documentTreeBuilder nests BAB > BAGIAN > PARAGRAF > PASAL > AYAT', async () => {
  const lines = [
    new Line({ text: 'BAB I KETENTUAN UMUM', page: 0 }),
    new Line({ text: 'Bagian Pertama', page: 0 }),
    new Line({ text: 'Paragraf 1', page: 0 }),
    new Line({ text: 'Pasal 1', page: 0 }),
    new Line({ text: '(1) Dalam peraturan ini yang dimaksud dengan', page: 0 }),
    new Line({ text: 'Pasal 2', page: 0 }),
    new Line({ text: '(1) Ayat dua', page: 0 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const bab = tree.children.find((c) => c.type === 'bab');
  assert.ok(bab, 'BAB harus ada di root');
  const bagian = bab.children.find((c) => c.type === 'bagian');
  assert.ok(bagian, 'BAGIAN harus jadi child BAB');
  const paragraf = bagian.children.find((c) => c.type === 'paragraf');
  assert.ok(paragraf, 'PARAGRAF harus jadi child BAGIAN');
  const pasal = paragraf.children.find((c) => c.type === 'pasal');
  assert.ok(pasal, 'PASAL harus jadi child PARAGRAF');
  assert.strictEqual(pasal.children[0].type, 'ayat');
  const pasal2 = paragraf.children.find((c) => c.type === 'pasal' && c.number === '2');
  assert.ok(pasal2, 'Pasal 2 harus jadi sibling Pasal 1');
});

test('documentTreeBuilder splits paragraphs across pages', async () => {
  const lines = [
    new Line({ text: 'Paragraf halaman satu', page: 0 }),
    new Line({ text: 'lanjutan paragraf halaman satu', page: 0 }),
    new Line({ text: 'Paragraf baru halaman dua', page: 1 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const paragraphs = tree.children.filter((c) => c.type === 'paragraph');
  assert.strictEqual(paragraphs.length, 2, 'paragraf lintas halaman harus dipisah');
  assert.ok(paragraphs[0].text.includes('halaman satu'));
  assert.ok(paragraphs[1].text.includes('halaman dua'));
});

test('documentTreeBuilder interleaves table at original position', async () => {
  const lines = [
    new Line({ text: 'Pasal 1', page: 0 }),
    new Line({ text: '(1) Ayat satu', page: 0 }),
    new Line({ text: '| Kolom A | Kolom B |', page: 0 }),
    new Line({ text: '| nilai 1 | nilai 2 |', page: 0 }),
    new Line({ text: '(2) Ayat dua', page: 0 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const pasal = tree.children.find((c) => c.type === 'pasal');
  const childTypes = pasal.children.map((c) => c.type);
  const tableIdx = childTypes.indexOf('table');
  assert.ok(tableIdx > 0, 'tabel harus ada di antara ayat');
  assert.ok(childTypes[tableIdx - 1] === 'ayat' || childTypes[tableIdx - 1] === 'paragraph');
});

test('documentTreeBuilder membersihkan garbage OCR dalam sel tabel', async () => {
  const lines = [
    new Line({ text: '| No | Dinas | Kontribusi |', page: 0 }),
    new Line({ text: '| 1 | Dinas Lingkungan 1 1 T T 1 1 | 30% 国 |', page: 0 }),
    new Line({ text: '| 2 | Dinas Pekerjaan Umum | Rp 5.000 |', page: 0 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const table = tree.children.find((c) => c.type === 'table');
  assert.ok(table, 'tabel harus terdeteksi');
  const md = markdownGenerator.generate(tree);
  assert.ok(md.includes('Dinas Lingkungan'), 'teks sah dalam sel dipertahankan');
  assert.ok(!md.includes('T T'), 'run mirror dalam sel dibersihkan');
  assert.ok(!/国/.test(md), 'CJK dalam sel dibersihkan');
  assert.ok(md.includes('30%'), 'angka dalam sel dipertahankan');
  assert.ok(md.includes('Rp 5.000'), 'Rp dalam sel dipertahankan');
});

test('documentTreeBuilder detects title', async () => {
  const lines = [
    new Line({ text: 'PERATURAN DESA NOMOR 5 TAHUN 2020 TENTANG PEMERINTAHAN DESA', page: 0 }),
    new Line({ text: 'BAB I KETENTUAN UMUM', page: 0 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const title = tree.children[0];
  assert.strictEqual(title.type, 'title');
  assert.strictEqual(tree.children[1].type, 'bab');
});

test('markdownGenerator renders title node bold', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [new DocumentNode({ type: 'title', text: 'PERATURAN DESA NOMOR 5', title: 'PERATURAN DESA NOMOR 5' })],
  });
  const md = markdownGenerator.generate(root);
  assert.ok(md.includes('**PERATURAN DESA NOMOR 5**'));
});

test('documentTreeBuilder splits ayat and huruf into separate nodes', async () => {
  const lines = [
    new Line({ text: 'BAB I KETENTUAN UMUM', page: 0 }),
    new Line({ text: 'Pasal 1', page: 0 }),
    new Line({ text: '(1) Dalam peraturan ini yang dimaksud dengan:', page: 0 }),
    new Line({ text: 'a. Pemerintah Desa adalah penyelenggaraan urusan', page: 0 }),
    new Line({ text: '(2) Peraturan Desa adalah peraturan yang ditetapkan kepala desa', page: 0 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const pasal = tree.children[0].children[0];
  assert.strictEqual(pasal.type, 'pasal');
  assert.deepStrictEqual(
    pasal.children.map((c) => c.type),
    ['ayat', 'huruf', 'ayat'],
  );
  assert.strictEqual(pasal.children[0].number, 1);
  assert.strictEqual(pasal.children[0].text, 'Dalam peraturan ini yang dimaksud dengan:');
  assert.strictEqual(pasal.children[2].number, 2);
});

test('markdownGenerator BAB heading without duplicate number', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({
        type: 'bab',
        number: 'I',
        title: 'BAB I KETENTUAN UMUM',
        text: 'BAB I KETENTUAN UMUM',
        level: 1,
      }),
    ],
  });
  const md = markdownGenerator.generate(root);
  assert.ok(md.includes('## BAB I KETENTUAN UMUM'));
  assert.ok(!md.includes('## I BAB'));
});

test('legalParser detects document types', () => {
  const root = new DocumentNode({
    type: 'root',
    children: [new DocumentNode({ type: 'paragraph', text: 'PERATURAN BUPATI DAIRI NOMOR 2 TAHUN 2020' })],
  });
  legalParser.parse(root);
  assert.ok(root.metadata.documentTypes.includes('PERATURAN'));
});

test('legalParser tags menimbang', () => {
  const root = new DocumentNode({
    type: 'root',
    children: [new DocumentNode({ type: 'paragraph', text: 'Menimbang: bahwa perlu menetapkan Peraturan Bupati' })],
  });
  legalParser.parse(root);
  assert.strictEqual(root.children[0].type, 'menimbang');
});

test('markdownGenerator generates bab heading', () => {
  const root = new DocumentNode({
    type: 'root',
    children: [new DocumentNode({ type: 'bab', number: 'I', title: 'BAB I KETENTUAN UMUM', level: 1 })],
  });
  const md = markdownGenerator.generate(root);
  assert.ok(md.includes('##'));
  assert.ok(md.includes('I'));
});

test('markdownGenerator generates pasal bold', () => {
  const root = new DocumentNode({
    type: 'root',
    children: [new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi pasal' })],
  });
  const md = markdownGenerator.generate(root);
  assert.ok(md.includes('**Pasal 1**'));
});

test('markdownGenerator returns empty for null', () => {
  assert.strictEqual(markdownGenerator.generate(null), '');
});

test('htmlGenerator wraps in html', () => {
  const html = htmlGenerator.generate(new DocumentNode({ type: 'root' }), { title: 'Test' });
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('<h1>Test</h1>'));
});

test('htmlGenerator handles pasal', () => {
  const root = new DocumentNode({ type: 'root', children: [new DocumentNode({ type: 'pasal', title: 'Pasal 1' })] });
  const html = htmlGenerator.generate(root);
  assert.ok(html.includes('class="pasal"'));
  assert.ok(html.includes('<strong>Pasal 1</strong>'));
});

test('semanticJsonGenerator output structure', () => {
  const root = new DocumentNode({
    type: 'root',
    children: [new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi' })],
  });
  const json = semanticJsonGenerator.generate(root, { title: 'Test', pageCount: 5 });
  assert.strictEqual(json.version, '1.0');
  assert.strictEqual(json.title, 'Test');
  assert.strictEqual(json.children.length, 1);
  assert.strictEqual(json.children[0].type, 'pasal');
});

test('chunkBuilder creates chunks', () => {
  const root = new DocumentNode({
    type: 'root',
    children: [
      new DocumentNode({
        type: 'bab',
        number: 'I',
        title: 'BAB I',
        level: 1,
        children: [new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi pasal 1' })],
      }),
    ],
  });
  const chunks = chunkBuilder.build(root, { chunkSize: 100, chunkOverlap: 20 });
  assert.ok(chunks.length > 0);
  assert.ok(chunks[0].id);
  assert.ok(chunks[0].text);
  assert.ok(chunks[0].metadata);
  assert.ok(chunks[0].order != null);
});

test('chunkBuilder returns empty for null root', () => {
  assert.deepStrictEqual(chunkBuilder.build(null), []);
});

test('Document constructor sets defaults', () => {
  const d = new Document({});
  assert.strictEqual(d.title, '');
  assert.strictEqual(d.pages, 0);
  assert.deepStrictEqual(d.chunks, []);
});

test('Document toJSON includes markdown', () => {
  const d = new Document({ title: 'Doc', markdown: '# Doc' });
  assert.strictEqual(d.toJSON().markdown, '# Doc');
});

// ========================================================================
console.log('\n=== 11. Review & Kualitas ===');

const { computeQualityScore, shouldAcceptPage, selectRetryStrategy } = require('./src/ocr/qualityMetrics');
const { documentReviewer } = require('./src/reconstruction/review/documentReviewer');

test('computeQualityScore empty blocks -> score 0', () => {
  const s = computeQualityScore([]);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.garbageRatio, 1);
});

test('computeQualityScore good blocks -> high score', () => {
  const blocks = [
    { text: 'Peraturan Desa Nomor 5 Tahun 2020', confidence: 0.95 },
    { text: 'Bupati adalah kepala pemerintahan daerah', confidence: 0.9 },
    { text: 'Menimbang bahwa peraturan ini perlu ditetapkan', confidence: 0.88 },
  ];
  const s = computeQualityScore(blocks);
  assert.ok(s.score > 0.7, `score harus tinggi, dapat ${s.score}`);
});

test('computeQualityScore garbage blocks -> low score', () => {
  const blocks = [
    { text: 'M M 1 1 7 0 9', confidence: 0.1 },
    { text: '1 1 0 1 9', confidence: 0.05 },
    { text: 'I I I I 8', confidence: 0.08 },
  ];
  const s = computeQualityScore(blocks);
  assert.ok(s.score < 0.3, `score harus rendah, dapat ${s.score}`);
});

test('shouldAcceptPage rejects empty page', () => {
  assert.strictEqual(shouldAcceptPage({ confidence: 0, garbageRatio: 1, wordCount: 0, score: 0 }), false);
});

test('shouldAcceptPage accepts good page', () => {
  assert.strictEqual(shouldAcceptPage({ confidence: 0.9, garbageRatio: 0.05, wordCount: 40, score: 0.9 }), true);
});

test('shouldAcceptPage rejects high garbage ratio', () => {
  assert.strictEqual(shouldAcceptPage({ confidence: 0.8, garbageRatio: 0.7, wordCount: 40, score: 0.5 }), false);
});

test('shouldAcceptPage rejects too few words', () => {
  assert.strictEqual(shouldAcceptPage({ confidence: 0.9, garbageRatio: 0.1, wordCount: 2, score: 0.7 }), false);
});

test('selectRetryStrategy retry 1 uses engine auto', () => {
  const s = selectRetryStrategy(1);
  assert.strictEqual(s.engine, 'auto');
});

test('reviewer no issues on well-formed document', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({
        type: 'section',
        text: 'PERATURAN DESA NOMOR 5 TAHUN 2020 TENTANG PEMERINTAHAN DESA',
        page: 1,
      }),
      new DocumentNode({ type: 'section', text: 'Menimbang: bahwa peraturan desa perlu ditetapkan', page: 1 }),
      new DocumentNode({
        type: 'bab',
        number: 'I',
        title: 'BAB I',
        text: 'BAB I KETENTUAN UMUM',
        children: [
          new DocumentNode({
            type: 'pasal',
            number: 1,
            title: 'Pasal 1',
            text: 'Pasal 1',
            children: [
              new DocumentNode({
                type: 'ayat',
                number: 1,
                title: '(1)',
                text: 'Dalam peraturan ini yang dimaksud dengan:',
                page: 1,
              }),
              new DocumentNode({ type: 'ayat', number: 2, title: '(2)', text: 'Pemerintah Desa adalah...', page: 1 }),
            ],
            page: 1,
          }),
          new DocumentNode({ type: 'pasal', number: 2, title: 'Pasal 2', text: 'Pasal 2', page: 1 }),
        ],
        page: 1,
      }),
    ],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.strictEqual(report.score, 1);
  assert.strictEqual(report.issueCount, 0);
});

test('reviewer flags out-of-order BAB', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({ type: 'bab', number: 'II', title: 'BAB II', text: 'BAB II', children: [], page: 1 }),
      new DocumentNode({ type: 'bab', number: 'I', title: 'BAB I', text: 'BAB I', children: [], page: 1 }),
    ],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.ok(
    report.issues.some((i) => i.type === 'bab-order'),
    'harus ada issue bab-order',
  );
  assert.ok(report.score < 1);
});

test('reviewer flags duplicate pasal', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({
        type: 'bab',
        number: 'I',
        title: 'BAB I',
        text: 'BAB I',
        children: [
          new DocumentNode({ type: 'pasal', number: 1, title: 'Pasal 1', text: 'Pasal 1', page: 1 }),
          new DocumentNode({ type: 'pasal', number: 1, title: 'Pasal 1', text: 'Pasal 1', page: 1 }),
        ],
        page: 1,
      }),
    ],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.ok(report.issues.some((i) => i.type === 'pasal-duplicate'));
});

test('reviewer flags pasal outside BAB', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({
        type: 'pasal',
        number: 1,
        title: 'Pasal 1',
        text: 'Pasal 1',
        children: [new DocumentNode({ type: 'ayat', number: 1, title: '(1)', text: 'ayat satu', page: 1 })],
        page: 1,
      }),
    ],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.ok(report.issues.some((i) => i.type === 'heading-parent'));
});

test('reviewer flags orphan ayat', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [new DocumentNode({ type: 'ayat', number: 1, title: '(1)', text: 'ayat yatim', page: 1 })],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.ok(report.issues.some((i) => i.type === 'orphan-ayat'));
});

test('reviewer flags ayat out of order', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({
        type: 'bab',
        number: 'I',
        title: 'BAB I',
        text: 'BAB I',
        children: [
          new DocumentNode({
            type: 'pasal',
            number: 1,
            title: 'Pasal 1',
            text: 'Pasal 1',
            children: [
              new DocumentNode({ type: 'ayat', number: 2, title: '(2)', text: 'dua', page: 1 }),
              new DocumentNode({ type: 'ayat', number: 3, title: '(3)', text: 'tiga', page: 1 }),
              new DocumentNode({ type: 'ayat', number: 1, title: '(1)', text: 'satu', page: 1 }),
            ],
            page: 1,
          }),
        ],
        page: 1,
      }),
    ],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.ok(report.issues.some((i) => i.type === 'ayat-order'));
});

test('reviewer flags page order non-monotonic', () => {
  const lines = [
    { text: 'baris 1', page: 1 },
    { text: 'baris 2', page: 1 },
    { text: 'baris 3', page: 0 },
  ];
  const report = documentReviewer.review({ tree: null, lines });
  assert.ok(report.issues.some((i) => i.type === 'page-order'));
});

test('reviewer flags low quality blocks', () => {
  const blocks = [
    { text: 'teks bagus', page: 0 },
    { text: 'sampah 1 1 1', page: 1, quality: 'low' },
  ];
  blocks.pageQuality = [{ page: 2, lowQuality: true, accepted: false }];
  const report = documentReviewer.review({ tree: null, lines: [], ocrBlocks: blocks });
  assert.ok(report.issues.some((i) => i.type === 'low-quality'));
});

test('reviewer flags empty table', () => {
  const root = new DocumentNode({
    type: 'root',
    title: 'root',
    children: [
      new DocumentNode({ type: 'bab', number: 'I', title: 'BAB I', text: 'BAB I', children: [], page: 1 }),
      new DocumentNode({ type: 'table', headers: [], rows: [], page: 1 }),
    ],
  });
  const report = documentReviewer.review({ tree: root, lines: [] });
  assert.ok(report.issues.some((i) => i.type === 'table-empty'));
});

test('Document toJSON includes review', () => {
  const d = new Document({ title: 'Doc', markdown: '# Doc', review: { score: 0.9, issueCount: 1, issues: [] } });
  assert.ok(d.toJSON().review);
  assert.strictEqual(d.toJSON().review.score, 0.9);
});

// ========================================================================
console.log('\n=== 12. Deskew Hough-lite & Region OCR ===');

const { detectSkewHoughLite } = require('./src/ocr/deskewRouter');
const { detectTableRegions } = require('./src/ocr/tableRegionOcr');
const { isGarbageWord } = require('./src/ocr/qualityMetrics');

function makeTiltedLineGray(w, h, angleDeg) {
  const gray = new Uint8Array(w * h).fill(255);
  const rad = (angleDeg * Math.PI) / 180;
  const tan = Math.tan(rad);
  const cx = w / 2;
  const cy = h / 2;
  for (let x = 0; x < w; x++) {
    const y = Math.round(cy + (x - cx) * tan);
    for (let dy = -2; dy <= 2; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < h) gray[yy * w + x] = 0;
    }
  }
  return gray;
}

test('isGarbageWord flags CJK-only word', () => {
  assert.strictEqual(isGarbageWord('楼'), true);
});

test('isGarbageWord flags CJK-latin mix', () => {
  assert.strictEqual(isGarbageWord('Q楼'), true);
});

test('isGarbageWord flags short digit word', () => {
  assert.strictEqual(isGarbageWord('123'), true);
});

test('isGarbageWord keeps valid Indonesian words', () => {
  assert.strictEqual(isGarbageWord('desa'), false);
  assert.strictEqual(isGarbageWord('Bupati'), false);
  assert.strictEqual(isGarbageWord('penghasilan'), false);
});

test('isGarbageWord keeps year/number with letters', () => {
  assert.strictEqual(isGarbageWord('2020'), false);
  assert.strictEqual(isGarbageWord('Rp5.000'), false);
  assert.strictEqual(isGarbageWord('UndangUndang'), false);
});

test('computeQualityScore CJK garbage lowers score', () => {
  const s = computeQualityScore([
    { text: 'teks bagus sekali', confidence: 0.9 },
    { text: 'Q楼 绿 廾 鬼', confidence: 0.5 },
  ]);
  assert.ok(s.garbageRatio > 0.4, `garbageRatio harus tinggi, dapat ${s.garbageRatio}`);
});

test('detectSkewHoughLite detects +3 degrees', () => {
  const gray = makeTiltedLineGray(400, 300, 3);
  const res = detectSkewHoughLite(gray, 400, 300, 15);
  assert.ok(res, 'angle harus terdeteksi');
  assert.ok(Math.abs(res.angle - 3) < 1.5, `angle harus ~3°, dapat ${res.angle}°`);
});

test('detectSkewHoughLite detects -8 degrees', () => {
  const gray = makeTiltedLineGray(400, 300, -8);
  const res = detectSkewHoughLite(gray, 400, 300, 15);
  assert.ok(res, 'angle harus terdeteksi');
  assert.ok(Math.abs(res.angle - -8) < 1.5, `angle harus ~-8°, dapat ${res.angle}°`);
});

test('detectSkewHoughLite returns null on blank image', () => {
  const gray = new Uint8Array(400 * 300).fill(255);
  assert.strictEqual(detectSkewHoughLite(gray, 400, 300, 15), null);
});

test('detectSkewHoughLite returns null on horizontal line', () => {
  const gray = new Uint8Array(400 * 300).fill(255);
  for (let x = 0; x < 400; x++) gray[150 * 400 + x] = 0;
  assert.strictEqual(detectSkewHoughLite(gray, 400, 300, 15), null);
});

function mockCanvas(grayArray, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = grayArray[i];
    data[i * 4 + 1] = grayArray[i];
    data[i * 4 + 2] = grayArray[i];
    data[i * 4 + 3] = 255;
  }
  return {
    width: w,
    height: h,
    getContext: () => ({ getImageData: () => ({ data }) }),
  };
}

function makeGridGray(w, h) {
  const gray = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 50 || x === 150 || x === 250 || y === 50 || y === 100 || y === 150) gray[y * w + x] = 0;
    }
  }
  return gray;
}

test('detectTableRegions finds grid table', () => {
  const canvas = mockCanvas(makeGridGray(300, 200), 300, 200);
  const regions = detectTableRegions(canvas);
  assert.ok(regions.length >= 1, 'region tabel harus terdeteksi');
  const r = regions[0];
  assert.ok(r.y <= 50 && r.y + r.h >= 150, `region harus menutupi y 50-150, dapat y=${r.y} h=${r.h}`);
  assert.ok(r.w >= 150, `region harus selebar 150px, dapat ${r.w}`);
});

test('detectTableRegions empty on blank page', () => {
  const canvas = mockCanvas(new Uint8Array(300 * 200).fill(255), 300, 200);
  assert.deepStrictEqual(detectTableRegions(canvas), []);
});

test('detectTableRegions empty on single horizontal line', () => {
  const gray = new Uint8Array(300 * 200).fill(255);
  for (let x = 0; x < 300; x++) gray[100 * 300 + x] = 0;
  const canvas = mockCanvas(gray, 300, 200);
  assert.deepStrictEqual(detectTableRegions(canvas), []);
});

function makeTiltedGridGray(w, h, angleDeg) {
  const gray = new Uint8Array(w * h).fill(255);
  const tan = Math.tan((angleDeg * Math.PI) / 180);
  const cx = w / 2;
  const cy = h / 2;
  const mark = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w) gray[yy * w + xx] = 0;
      }
    }
  };
  for (const yLine of [50, 100, 150]) {
    for (let x = 0; x < w; x++) mark(x, Math.round(yLine + (x - cx) * tan));
  }
  for (const xLine of [50, 150, 250]) {
    for (let y = 0; y < h; y++) mark(Math.round(xLine - (y - cy) * tan), y);
  }
  return gray;
}

test('detectTableRegions empty on tilted grid (bug: tabel miring tidak terdeteksi)', () => {
  const gray = makeTiltedGridGray(300, 200, 4);
  const canvas = mockCanvas(gray, 300, 200);
  assert.deepStrictEqual(detectTableRegions(canvas), [], 'grid miring 4° harus 0 region sebelum rectify');
});

test('detectTableRegions contrast: grid rectified (0°) terdeteksi, grid miring tidak', () => {
  const tilted = mockCanvas(makeTiltedGridGray(300, 200, 4), 300, 200);
  const straight = mockCanvas(makeTiltedGridGray(300, 200, 0), 300, 200);
  assert.deepStrictEqual(detectTableRegions(tilted), [], 'grid miring harus tidak terdeteksi');
  assert.ok(detectTableRegions(straight).length >= 1, 'grid lurus (hasil rectify) harus terdeteksi');
});

test('detectSkewHoughLite detects tilted grid angle', () => {
  const gray = makeTiltedGridGray(400, 300, 4);
  const res = detectSkewHoughLite(gray, 400, 300, 15);
  assert.ok(res, 'angle grid miring harus terdeteksi');
  assert.ok(Math.abs(res.angle - 4) < 1.5, `angle harus ~4°, dapat ${res.angle}°`);
});

// ========================================================================
console.log('\n=== 14. Text Layer Validator ===');
const { commonWordRatio, textLayerIsTrustworthy } = require('./src/pdf/textLayerValidator');

const LEGAL_TEXT = [
  'SALINAN BUPATI DAIRI PROVINSI SUMATERA UTARA PERATURAN BUPATI DAIRI NOMOR 2 TAHUN 2020',
  'TENTANG KEBIJAKAN DAN STRATEGI PENGELOLAAN SAMPAH RUMAH TANGGA',
  'Menimbang : Mengingat : Pasal Ayat bahwa dengan peraturan daerah ini',
  'dimaksud untuk pemerintah yang dan dalam pada dengan tahun tentang',
].join(' ');

const GARBLED_TEXT = Array.from(
  { length: 40 },
  (_, i) => ['xqzl', 'kjmw', 'rtvy', 'hnpl', 'opzs', 'wqru', 'mgfe', 'lkds', 'jhba'][i % 9],
).join(' ');

test('commonWordRatio: teks hukum Indonesia > 0.05', () => {
  const ratio = commonWordRatio(LEGAL_TEXT);
  assert.ok(ratio !== null, 'rasio tidak null');
  assert.ok(ratio >= 0.05, `rasio harus >= 0.05, dapat ${ratio}`);
});

test('commonWordRatio: teks garbled acak = 0', () => {
  const ratio = commonWordRatio(GARBLED_TEXT);
  assert.ok(ratio !== null, 'rasio tidak null');
  assert.ok(ratio < 0.05, `rasio harus < 0.05, dapat ${ratio}`);
});

test('commonWordRatio: < 15 kata return null', () => {
  assert.strictEqual(commonWordRatio('yang dan untuk'), null);
  assert.strictEqual(commonWordRatio(''), null);
  assert.strictEqual(commonWordRatio('12345678'), null);
});

test('textLayerIsTrustworthy: teks hukum normal diterima', () => {
  assert.strictEqual(textLayerIsTrustworthy(LEGAL_TEXT), true);
});

test('textLayerIsTrustworthy: teks garbled ditolak', () => {
  assert.strictEqual(textLayerIsTrustworthy(GARBLED_TEXT), false);
});

test('textLayerIsTrustworthy: < 40 chars ditolak (dipaksa OCR)', () => {
  assert.strictEqual(textLayerIsTrustworthy('Pasal 1 yang dan'), false);
});

test('textLayerIsTrustworthy: null ratio (teks pendek) diterima', () => {
  const short = 'Bupati Dairi Provinsi Sumatera Utara Kebijakan Strategi Pengelolaan';
  assert.ok(short.trim().length >= 40, 'panjang teks uji harus >= 40 chars');
  assert.strictEqual(commonWordRatio(short), null);
  assert.strictEqual(textLayerIsTrustworthy(short), true);
});

test('textLayerIsTrustworthy: teks non-Latin (CJK) diterima, bukan false positive', () => {
  const cjk = Array.from({ length: 60 }, () => '楼').join(' ');
  assert.strictEqual(textLayerIsTrustworthy(cjk), true);
});

// ========================================================================
console.log('\n=== 15. Table-Aware Gate & Config ===');
const { detectWiredGridRegions, blockInRegion } = require('./src/ocr/tableRegionOcr');
const tableAwareService = require('./src/services/tableAwareService');

test('config.tableAware structure valid', () => {
  assert.strictEqual(typeof config.tableAware.enabled, 'boolean');
  assert.strictEqual(typeof config.tableAware.serviceUrl, 'string');
  assert.strictEqual(typeof config.tableAware.timeout, 'number');
});

test('detectWiredGridRegions finds wired grid', () => {
  const canvas = mockCanvas(makeGridGray(300, 200), 300, 200);
  const regions = detectWiredGridRegions(canvas);
  assert.ok(regions.length >= 1, 'grid wired 3 kolom harus lolos gate');
});

test('detectWiredGridRegions empty on blank page', () => {
  const canvas = mockCanvas(new Uint8Array(300 * 200).fill(255), 300, 200);
  assert.deepStrictEqual(detectWiredGridRegions(canvas), []);
});

test('detectWiredGridRegions rejects page border box (hanya kotak halaman)', () => {
  const gray = new Uint8Array(300 * 200).fill(255);
  for (let y = 0; y < 200; y++) {
    gray[y * 300 + 2] = 0;
    gray[y * 300 + 297] = 0;
  }
  for (let x = 0; x < 300; x++) {
    gray[2 * 300 + x] = 0;
    gray[197 * 300 + x] = 0;
  }
  const canvas = mockCanvas(gray, 300, 200);
  assert.deepStrictEqual(detectWiredGridRegions(canvas), [], 'border kotak halaman di tepi 5% harus ditolak');
});

test('detectWiredGridRegions rejects horizontal-only lines (tanpa fallback)', () => {
  const gray = new Uint8Array(300 * 200).fill(255);
  for (const yLine of [50, 100, 150]) {
    for (let x = 0; x < 300; x++) gray[yLine * 300 + x] = 0;
  }
  const canvas = mockCanvas(gray, 300, 200);
  assert.deepStrictEqual(detectWiredGridRegions(canvas), [], '3 garis horizontal tanpa vertikal = bukan tabel wired');
  assert.ok(detectTableRegions(canvas).length >= 1, 'legacy detectTableRegions tetap punya fallback');
});

test('detectWiredGridRegions empty on paragraph text lines', () => {
  const gray = new Uint8Array(400 * 300).fill(255);
  for (let i = 0; i < 8; i++) {
    const y = 60 + i * 32;
    for (let x = 40; x < 360; x++) gray[y * 400 + x] = 0;
  }
  const canvas = mockCanvas(gray, 400, 300);
  assert.deepStrictEqual(detectWiredGridRegions(canvas), [], 'baris teks paragraf tanpa vertikal = 0 region');
});

test('blockInRegion: center dalam region true, di luar false', () => {
  const region = { x: 100, y: 50, w: 200, h: 100 };
  const inside = { bbox: { x: 150, y: 80, w: 10, h: 10 } };
  const outside = { bbox: { x: 350, y: 20, w: 10, h: 10 } };
  assert.strictEqual(blockInRegion(inside, region), true);
  assert.strictEqual(blockInRegion(outside, region), false);
});

test('tableAwareService.analyzeTables returns null when disabled', async () => {
  const original = { ...config.tableAware };
  config.tableAware.enabled = false;
  try {
    const res = await tableAwareService.analyzeTables([{ image: 'abc', engine: 'img2table' }]);
    assert.strictEqual(res, null);
  } finally {
    Object.assign(config.tableAware, original);
  }
});

test('tableAwareService.analyzeTables returns null when serviceUrl kosong', async () => {
  const original = { ...config.tableAware };
  config.tableAware.enabled = true;
  config.tableAware.serviceUrl = '';
  try {
    const res = await tableAwareService.analyzeTables([{ image: 'abc', engine: 'img2table' }]);
    assert.strictEqual(res, null);
  } finally {
    Object.assign(config.tableAware, original);
  }
});

// Gate "kualitas > estetika": blok table-aware hanya menggantikan blok OCR
// bila tidak lebih buruk (mirror/CJK, None, terlalu pendek, skor rendah).
const { ocrRouter } = require('./src/ocr/router');

test('tableAwareWins: clean table replaces garbage OCR blocks', () => {
  const ta = {
    text: 'NO | KEBIJAKAN\n1. Program pengelolaan sampah\n2. Pelaksanaan pelatihan\n3. Pembinaan daerah',
  };
  const ocr = [
    { text: 'qedurrs uesureinsued epep euesn', confidence: 0.5 },
    { text: 'NOLERA TA RORANS AN D p 2 国', confidence: 0.5 },
  ];
  const decision = ocrRouter.tableAwareWins(ta, ocr);
  assert.strictEqual(decision.replace, true, decision.reason || '');
});

test('tableAwareWins: garbage table (CJK mirror) rejected against clean OCR', () => {
  const ta = {
    text: 'qedurrs uesureinsued epep euesn n eed esnpond 国 国 丽 图 T W E',
  };
  const ocr = [
    { text: 'Pasal 1 (1) Pengelolaan sampah rumah tangga dan sampah sejenis', confidence: 0.95 },
    { text: 'BAB II Kebijakan dan strategi kabupaten', confidence: 0.95 },
  ];
  const decision = ocrRouter.tableAwareWins(ta, ocr);
  assert.strictEqual(decision.replace, false, 'blok mirror harus ditolak');
});

test('tableAwareWins: None-laden table rejected', () => {
  const ta = {
    text: 'PROGRAM | SATUAN\nNone | Daerah\nNone None | None',
  };
  const ocr = [{ text: 'Program pengelolaan sampah daerah kabupaten', confidence: 0.9 }];
  const decision = ocrRouter.tableAwareWins(ta, ocr);
  assert.strictEqual(decision.replace, false, 'placeholder None berlebih harus ditolak');
});

test('tableAwareWins: too short table rejected', () => {
  const ta = { text: '1' };
  const ocr = [{ text: 'Pasal 2 Permohonan izin pengelolaan sampah', confidence: 0.9 }];
  const decision = ocrRouter.tableAwareWins(ta, ocr);
  assert.strictEqual(decision.replace, false, 'tabel 1 kata harus ditolak');
});

test('tableAwareWins: both good -> best score wins', () => {
  const ta = {
    text: 'PROGRAM | SATUAN\n1. Pengelolaan sampah | Daerah\n2. Pelatihan | Kabupaten',
  };
  const ocr = [
    { text: 'Tabel program dan satuan pengelolaan sampah rumah tangga', confidence: 0.9 },
    { text: 'Pelaksanaan pelatihan penanganan sampah sejenis', confidence: 0.9 },
  ];
  const decision = ocrRouter.tableAwareWins(ta, ocr);
  assert.strictEqual(decision.replace, true, decision.reason || '');
});

// ========================================================================
// 13. Perbaikan kualitas output (P2/P5/P3): garbage non-Latin, mirror
//     detection, dedup baris lintas halaman
// ========================================================================
console.log('\n=== 13. Perbaikan kualitas output ===');

test('isGarbageWord: Greek letter mixed token', () => {
  assert.strictEqual(isGarbageWord('ν1'), true, '"ν1" harus garbage (Yunani)');
});

test('isGarbageWord: isolated union symbol', () => {
  assert.strictEqual(isGarbageWord('∪'), true, '"∪" harus garbage');
});

test('isGarbageWord: isolated greek letter', () => {
  assert.strictEqual(isGarbageWord('ν'), true, '"ν" harus garbage');
});

test('isGarbageWord: repeated superscript token', () => {
  assert.strictEqual(isGarbageWord('u¹5nu1¹5aux'), true, 'superscript berulang harus garbage');
});

test('isGarbageWord: digit-dominant with few letters', () => {
  assert.strictEqual(isGarbageWord('bo20202'), true, '"bo20202" harus garbage');
});

test('isGarbageWord: legit words not garbage', () => {
  assert.strictEqual(isGarbageWord('Dinas'), false);
  assert.strictEqual(isGarbageWord('melalui'), false);
  assert.strictEqual(isGarbageWord('lingkungan'), false);
  assert.strictEqual(isGarbageWord('pelaksanaan'), false);
});

test('isGarbageWord: legit numbers not garbage', () => {
  assert.strictEqual(isGarbageWord('1.000'), false, 'angka murni bukan garbage');
  assert.strictEqual(isGarbageWord('2020'), false);
  assert.strictEqual(isGarbageWord('Rp1.500'), false, 'nilai uang Rp bukan garbage');
  assert.strictEqual(isGarbageWord('tahun2020'), false, 'kata dengan digit bukan garbage');
});

const { _hasMirrorGarbage, _reOcrWithScaleEscalation } = require('./src/ocr/router');

test('_hasMirrorGarbage: CJK mirror text detected', () => {
  assert.strictEqual(_hasMirrorGarbage('NOLERA TA RORANS AN D p 2 国 lpom era'), true);
});

test('_hasMirrorGarbage: union symbol garbage detected', () => {
  assert.strictEqual(_hasMirrorGarbage('Dias LIugKuugaul rcup1Uvouuatc1a ∪ aua'), true);
});

test('_hasMirrorGarbage: clean text not detected', () => {
  assert.strictEqual(
    _hasMirrorGarbage('Bupati Dairi menetapkan peraturan tentang pengelolaan sampah rumah tangga'),
    false,
  );
});

test('_reOcrWithScaleEscalation: no-op when preprocess disabled', async () => {
  const current = { score: { score: 0.5 }, blocks: [], text: 'teks awal', engine: 'paddle' };
  const result = await _reOcrWithScaleEscalation(0, [], { preprocess: false }, null, current);
  assert.strictEqual(result, current, 'harus return current apa adanya');
});

// ========================================================================
// 14. Output Cleaner v29 (outputCleaner) — rapikan tanpa hapus konten
// ========================================================================
console.log('\n=== 14. Output Cleaner v29 ===');

const {
  cleanLineText,
  cleanOutputText,
  cleanLines,
  countGarbageTokens,
} = require('./src/reconstruction/cleaner/outputCleaner');

test('cleanLineText: token CJK acak dihapus, kata Latin utuh', () => {
  const out = cleanLineText('Bupati Dairi 国 楼 menetapkan peraturan 区');
  assert.strictEqual(out, 'Bupati Dairi menetapkan peraturan');
});

test('cleanLineText: simbol terisolasi (∪ ν ¹) dihapus', () => {
  const out = cleanLineText('Pasal 1 ∪ ν ¹ ayat (2) ¹');
  assert.strictEqual(out, 'Pasal 1 ayat (2)');
});

test('cleanLineText: kata Latin dan angka sah tidak disentuh', () => {
  const out = cleanLineText('Rp1.500,00 30% (tiga puluh persen) Tahun 2020');
  assert.strictEqual(out, 'Rp1.500,00 30% (tiga puluh persen) Tahun 2020');
});

test('cleanLineText: normalisasi spasi ganda', () => {
  assert.strictEqual(cleanLineText('Bupati    Dairi   menetapkan'), 'Bupati Dairi menetapkan');
});

test('cleanOutputText: baris murni garbage jadi kosong, baris sah utuh', () => {
  const text = 'Bupati Dairi menetapkan\n国 国 ∪\nkota kecil Kota 1 1';
  const out = cleanOutputText(text);
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'Bupati Dairi menetapkan');
  assert.strictEqual(lines[1], '');
  assert.strictEqual(lines[2], 'kota kecil Kota 1 1');
});

test('cleanLines: mempertahankan metadata line, teks dibersihkan', () => {
  const lines = [
    { text: 'Bupati Dairi 国 menetapkan', page: 3, order: 0 },
    { text: 'Pasal 1 ayat (2) ∪', page: 3, order: 1 },
  ];
  const out = cleanLines(lines);
  assert.strictEqual(out.length, 2, 'jumlah baris tidak berubah');
  assert.strictEqual(out[0].text, 'Bupati Dairi menetapkan');
  assert.strictEqual(out[1].text, 'Pasal 1 ayat (2)');
  assert.strictEqual(out[0].page, 3, 'metadata page dipertahankan');
  assert.strictEqual(out[1].order, 1, 'metadata order dipertahankan');
});

test('countGarbageTokens: menghitung token garbage saja', () => {
  assert.strictEqual(countGarbageTokens('Bupati 国 ∪ menetapkan ν1'), 3);
  assert.strictEqual(countGarbageTokens('Bupati Dairi menetapkan'), 0);
});

test('cleanLineText: run fragmen mirror dihapus, kata Latin utuh dipertahankan', () => {
  const out = cleanLineText('T E SALINAN L R 3 1 E 5. E BUPATI DAIRI');
  assert.strictEqual(out, 'SALINAN BUPATI DAIRI');
});

test('cleanLineText: run mirror per baris (whole-page multi-line)', () => {
  const out = cleanOutputText('T E SALINAN\nL R 3 1 E 5. E BUPATI\nPasal 1 ayat (2)');
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'SALINAN');
  assert.strictEqual(lines[1], 'BUPATI');
  assert.strictEqual(lines[2], 'Pasal 1 ayat (2)');
});

test('cleanLineText: angka menempel di kata dinormalisasi (TAHUN2020)', () => {
  const out = cleanLineText('PERATURAN BUPATI DAIRI NOMOR20 TAHUN2020 TENTANG');
  assert.strictEqual(out, 'PERATURAN BUPATI DAIRI NOMOR 20 TAHUN 2020 TENTANG');
});

test('cleanLineText: struktur sah tidak disentuh (BAB I, huruf a, Rp 5.000)', () => {
  assert.strictEqual(cleanLineText('BAB I di daerah'), 'BAB I di daerah');
  assert.strictEqual(cleanLineText('huruf a ayat (1)'), 'huruf a ayat (1)');
  assert.strictEqual(cleanLineText('Rp 5.000 sebesar 30%'), 'Rp 5.000 sebesar 30%');
  assert.strictEqual(cleanLineText('1. Undang-Undang Dasar 1945'), '1. Undang-Undang Dasar 1945');
});

test('cleanLineText: run digit tanpa huruf tetap utuh (data tabel)', () => {
  assert.strictEqual(cleanLineText('kota kecil Kota 1 1'), 'kota kecil Kota 1 1');
});

test('cleanLineText: run bare campur huruf dihapus dari baris tabel OCR', () => {
  const out = cleanLineText('kota kecil Kota 1 1 T T 1 1 Dinas Lingkungan');
  assert.strictEqual(out, 'kota kecil Kota Dinas Lingkungan');
});

test('cleanLineText: huruf tunggal setelah penanda daftar dihapus (b. I, d. F, e. k)', () => {
  assert.strictEqual(cleanLineText('b. I Kelurahan Batang Beruh'), 'b. Kelurahan Batang Beruh');
  assert.strictEqual(cleanLineText('d. F Kelurahan Kuta Garmbir'), 'd. Kelurahan Kuta Garmbir');
  assert.strictEqual(cleanLineText('e. k Kelurahan Bintang Hulu'), 'e. Kelurahan Bintang Hulu');
});

test('cleanLineText: angka & marker setelah penanda daftar tetap utuh', () => {
  assert.strictEqual(cleanLineText('a. 1 Kelurahan Sidikalang'), 'a. 1 Kelurahan Sidikalang');
  assert.strictEqual(cleanLineText('a. b. c. d.'), 'a. b. c. d.');
  assert.strictEqual(cleanLineText('huruf a dan b'), 'huruf a dan b');
});

test('cleanLineText: dot internal artefak OCR dirapikan, singkatan sah utuh', () => {
  assert.strictEqual(cleanLineText('L SAL.INAN T BUPATI DAIRI'), 'L SALINAN T BUPATI DAIRI');
  assert.strictEqual(
    cleanLineText('ttd. EDDY KELENG ATE BERUTU, NIP. 197010221998031006'),
    'ttd. EDDY KELENG ATE BERUTU, NIP. 197010221998031006',
  );
  assert.strictEqual(cleanLineText('a.n. Kepala Bagian Hukum'), 'a.n. Kepala Bagian Hukum');
});

test('cleanLineText: BAB menempel dengan angka Romawi dirapikan (BABI)', () => {
  assert.strictEqual(cleanLineText('BABI KETENTUAN UMUM'), 'BAB I KETENTUAN UMUM');
  assert.strictEqual(cleanLineText('BABII ARAH JAKSTRADA'), 'BAB II ARAH JAKSTRADA');
  assert.strictEqual(cleanLineText('BAB IV di daerah'), 'BAB IV di daerah');
  assert.strictEqual(cleanLineText('BABINSA desa binaan'), 'BABINSA desa binaan');
});

test('cleanLineText: baris tabel mirror konsonan-dense dihapus, prosa aman', () => {
  assert.strictEqual(
    cleanLineText(
      '| s88rsT smuA rdsqms& rlslmsi Istsxgrnimsq ns1sesd .d Tusbi9t sggrtsT dsmu9 rdsqms2 eisjp2 rfsqmse n |',
    ),
    '',
  );
  assert.strictEqual(
    cleanLineText('Bupati Dairi menetapkan peraturan daerah yang mengatur sampah'),
    'Bupati Dairi menetapkan peraturan daerah yang mengatur sampah',
  );
  assert.strictEqual(cleanLineText('APBD DAK DAU'), 'APBD DAK DAU');
  assert.strictEqual(cleanLineText('Bupati Dairi Kabupaten Dairi'), 'Bupati Dairi Kabupaten Dairi');
});

test('cleanLineText: baris tabel sah dengan angka tetap utuh', () => {
  assert.strictEqual(
    cleanLineText('Kelurahan Sidikalang 366.000.000,00 1.500.000,00'),
    'Kelurahan Sidikalang 366.000.000,00 1.500.000,00',
  );
});

// ========================================================================
// 14.5 v30 — kata terpecah, chrome halaman, struktur preambul & Pasal
// ========================================================================
console.log('\n=== 14.5 v30 (wordFixer + chrome + preambul) ===');

const { mergeSplitWords, countSplitWords } = require('./src/utils/wordFixer');
const { filterPageChrome } = require('./src/reconstruction/cleaner/outputCleaner');

test('wordFixer: kata terpecah digabung (Dala m, kerjasa ma, Ta mbahan)', () => {
  assert.strictEqual(mergeSplitWords('Dala m'), 'Dalam');
  assert.strictEqual(mergeSplitWords('kerjasa ma'), 'kerjasama');
  assert.strictEqual(mergeSplitWords('Ta mbahan'), 'Tambahan');
  assert.strictEqual(mergeSplitWords('Dala m Pasal 1 hal ini'), 'Dalam Pasal 1 hal ini');
});

test('wordFixer: frasa sah tidak digabung (di mana, huruf a, kota kecil)', () => {
  assert.strictEqual(mergeSplitWords('di mana'), 'di mana');
  assert.strictEqual(mergeSplitWords('huruf a'), 'huruf a');
  assert.strictEqual(mergeSplitWords('kota kecil'), 'kota kecil');
  assert.strictEqual(mergeSplitWords('peraturan daerah'), 'peraturan daerah');
  assert.strictEqual(mergeSplitWords('kabupaten dairi'), 'kabupaten dairi');
});

test('wordFixer: docTokens memperkuat validasi dokumen', () => {
  assert.strictEqual(mergeSplitWords('kerja sama', new Set(['kerjasama'])), 'kerjasama');
  assert.strictEqual(mergeSplitWords('kerja sama', new Set(['kerja', 'sama'])), 'kerja sama');
});

test('wordFixer: countSplitWords menghitung pasangan terpecah (gate retry)', () => {
  assert.strictEqual(countSplitWords('Dala m kerjasa ma'), 2);
  assert.strictEqual(countSplitWords('kota kecil di mana'), 0);
});

test('cleanLineText: kata terpecah digabung di pipeline cleaning', () => {
  assert.strictEqual(cleanLineText('Dala m'), 'Dalam');
  assert.strictEqual(cleanLineText('Bupati menetapkan Ta mbahan'), 'Bupati menetapkan Tambahan');
});

test('filterPageChrome: nomor halaman & cap SALINAN dibuang dari tepi', () => {
  const lines = [
    { text: 'BAB I KETENTUAN UMUM', page: 1 },
    { text: 'Pasal 1', page: 1 },
    { text: '2', page: 1 },
    { text: 'SALINAN E3', page: 2 },
    { text: 'Pasal 2', page: 2 },
    { text: '- 3 -', page: 2 },
  ];
  const out = filterPageChrome(lines);
  assert.deepStrictEqual(
    out.map((l) => l.text),
    ['BAB I KETENTUAN UMUM', 'Pasal 1', 'Pasal 2'],
  );
});

test('filterPageChrome: konten tepi yang unik tidak dibuang', () => {
  const lines = [
    { text: 'Judul halaman satu', page: 1 },
    { text: 'isi halaman 1', page: 1 },
    { text: 'Judul halaman dua', page: 2 },
    { text: 'isi halaman 2', page: 2 },
  ];
  const out = filterPageChrome(lines);
  assert.strictEqual(out.length, 4, 'baris unik di tepi tidak boleh hilang');
});

test('lineMerger: blok multi-baris (whole-page) dipecah per baris', () => {
  const blocks = [
    { text: 'BAB II\nPasal 1\nSetiap orang yang', confidence: 1, bbox: { x: 0, y: 0, w: 100, h: 30 }, page: 1 },
    { text: 'melakukan', confidence: 1, bbox: { x: 0, y: 100, w: 100, h: 20 }, page: 1 },
  ];
  const lines = lineMerger.merge(blocks);
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0].text, 'BAB II');
  assert.strictEqual(lines[1].text, 'Pasal 1');
  assert.strictEqual(lines[2].text, 'Setiap orang yang');
  assert.strictEqual(lines[3].text, 'melakukan');
});

test('documentTreeBuilder: preambul menggabung dipecah jadi komponen', async () => {
  const lines = [
    new Line({
      text: 'Menimbang : a. bahwa X; b. bahwa Y; Mengingat : 1. UU; MEMUTUSKAN : Menetapkan : hal',
      order: 0,
    }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const types = tree.children.map((c) => c.type);
  assert.ok(types.includes('menimbang'), 'Menimbang terdeteksi');
  assert.ok(types.includes('mengingat'), 'Mengingat terdeteksi');
  assert.ok(types.includes('memutuskan'), 'MEMUTUSKAN terdeteksi');
  assert.ok(types.includes('menetapkan'), 'Menetapkan terdeteksi');
  assert.ok(types.includes('huruf'), 'isi a. terdeteksi');
});

test('documentTreeBuilder: kalimat biasa tidak terpecah preambul', () => {
  assert.strictEqual(documentTreeBuilder._splitPreambleText('dengan menimbang : bahwa hal ini').length, 1);
  assert.strictEqual(documentTreeBuilder._splitPreambleText('Peraturan ini menetapkan : hal-hal').length, 1);
});

test('documentTreeBuilder: Pasal dengan isi menempel dipisah judul/body', () => {
  const node = documentTreeBuilder._classifyParagraph([
    new Line({ text: 'Pasal 1 Setiap orang yang dengan sengaja', order: 0 }),
  ]);
  assert.strictEqual(node.title, 'Pasal 1');
  assert.strictEqual(node.text, 'Setiap orang yang dengan sengaja');
});

test('markdownGenerator: isi Pasal dan preambul dirender (tidak hilang)', async () => {
  const lines = [
    new Line({ text: 'PERATURAN BUPATI DAIRI NOMOR 1 TAHUN 2020 TENTANG PENYELENGGARAAN', order: 0 }),
    new Line({ text: 'Menimbang : a. bahwa X; b. bahwa Y', order: 1 }),
    new Line({ text: 'Mengingat : 1. UU Nomor 23 Tahun 2014', order: 2 }),
    new Line({ text: 'MEMUTUSKAN : Menetapkan : Peraturan tentang hal', order: 3 }),
    new Line({ text: 'Pasal 1', order: 4 }),
    new Line({ text: '(1) Setiap orang wajib', order: 5 }),
  ];
  const tree = await documentTreeBuilder.build(lines);
  const parsed = legalParser.parse(tree);
  const md = markdownGenerator.generate(parsed);
  assert.ok(md.includes('**Menimbang:**'), 'heading Menimbang');
  assert.ok(md.includes('a. bahwa X'), 'isi Menimbang a.');
  assert.ok(md.includes('b. bahwa Y'), 'isi Menimbang b.');
  assert.ok(md.includes('**Mengingat:**'), 'heading Mengingat');
  assert.ok(md.includes('1. UU Nomor 23 Tahun 2014'), 'isi Mengingat 1.');
  assert.ok(md.includes('**MEMUTUSKAN:**'), 'heading MEMUTUSKAN');
  assert.ok(md.includes('**Menetapkan:**'), 'heading Menetapkan');
  assert.ok(md.includes('Peraturan tentang hal'), 'isi Menetapkan');
  assert.ok(md.includes('**Pasal 1**'), 'heading Pasal 1');
  assert.ok(md.includes('(1) Setiap orang wajib'), 'ayat (1)');
});

test('textCleaner legacy: chrome dibuang sebelum join kalimat, kata terpecah digabung', () => {
  const out = cleanText('BAB I\n- 3 -\nDala m hal\nSALINAN E3\nPasal 1\n\nDitetapkan di Jakarta');
  assert.ok(!out.includes('- 3 -'), 'nomor halaman hilang');
  assert.ok(!out.includes('SALINAN'), 'cap SALINAN hilang');
  assert.ok(out.includes('Dalam hal'), 'kata terpecah digabung');
  assert.ok(out.includes('BAB I'), 'konten tetap');
});

test('textCleaner legacy: tahun & angka sah dipertahankan', () => {
  const out = cleanText('Tahun 2020\nPasal 1\n');
  assert.ok(out.includes('2020'), 'tahun tidak ikut terhapus');
  assert.ok(out.includes('Pasal 1'), 'Pasal tetap');
});

// ========================================================================
// 14.6 v30.1 — typo OCR, footer chrome, fallback tabel, limit PaddleX
// ========================================================================
console.log('\n=== 14.6 v30.1 (ocrTypos + chrome footer + tabel + PaddleX limit) ===');

const { fixOcrTypos } = require('./src/utils/ocrTypos');

test('ocrTypos: token map typo OCR dikoreksi (case-preserving)', () => {
  assert.strictEqual(fixOcrTypos('BAE III'), 'BAB III');
  assert.strictEqual(fixOcrTypos('Fasal 5'), 'Pasal 5');
  assert.strictEqual(fixOcrTypos('DAIEI'), 'DAIRI');
  assert.strictEqual(fixOcrTypos('YANCMAHA ESA'), 'YANG MAHA ESA');
  assert.strictEqual(fixOcrTypos('avat (2)'), 'ayat (2)');
  assert.strictEqual(fixOcrTypos('Nonor 8'), 'Nomor 8');
  assert.strictEqual(fixOcrTypos('Nornor 8'), 'Nomor 8');
  assert.strictEqual(fixOcrTypos('kepaca Kepala'), 'kepada Kepala');
  assert.strictEqual(fixOcrTypos('cengan demikian'), 'dengan demikian');
  assert.strictEqual(fixOcrTypos('Euvati Dairi'), 'Bupati Dairi');
  assert.strictEqual(fixOcrTypos('MEMUTUISKAN :'), 'MEMUTUSKAN :');
});

test('ocrTypos: aturan generik (kolon dalam kata, ¿, l+konsonan+dict, nyva)', () => {
  assert.strictEqual(fixOcrTypos('se:besar-besarnyva'), 'sebesar-besarnya');
  assert.strictEqual(fixOcrTypos('¿udalah'), 'sudah');
  assert.strictEqual(fixOcrTypos('lkegiatan'), 'kegiatan');
  assert.strictEqual(fixOcrTypos('Lkegiatan'), 'Kegiatan');
  assert.strictEqual(fixOcrTypos('besarnyva'), 'besarnya');
});

test('ocrTypos: kata sah tidak tersentuh', () => {
  assert.strictEqual(fixOcrTypos('BAB I Pasal 5 dengan sudah'), 'BAB I Pasal 5 dengan sudah');
  assert.strictEqual(fixOcrTypos('a.n. NIP. lampiran lucu besarnya'), 'a.n. NIP. lampiran lucu besarnya');
  assert.strictEqual(fixOcrTypos('12:30 jatuh tempo'), '12:30 jatuh tempo');
});

test('cleanLineText: typo OCR dikoreksi di pipeline cleaning', () => {
  assert.strictEqual(cleanLineText('BAE III Fasal 5'), 'BAB III Pasal 5');
  assert.strictEqual(cleanLineText('se:besar-besarnyva'), 'sebesar-besarnya');
  assert.strictEqual(cleanLineText('Bupati Dairi menetapkan lkegiatan'), 'Bupati Dairi menetapkan kegiatan');
});

test('wordFixer: kata fiskal/daerah baru digabung, frasa sah tetap utuh', () => {
  assert.strictEqual(mergeSplitWords('pengalokas ian'), 'pengalokasian');
  assert.strictEqual(mergeSplitWords('bupa ti'), 'bupati');
  assert.strictEqual(mergeSplitWords('daer ah'), 'daerah');
  assert.strictEqual(mergeSplitWords('penyalur an'), 'penyaluran');
  assert.strictEqual(mergeSplitWords('mengalokas ikan'), 'mengalokasikan');
  assert.strictEqual(mergeSplitWords('pa jak retribu si hu kum alo kasi'), 'pajak retribusi hukum alokasi');
  assert.strictEqual(mergeSplitWords('peraturan daerah'), 'peraturan daerah');
});

test('filterPageChrome: footer sah (NIP, ttd., Salinan sesuai, KEPALA BAGIAN HUKUM) dibuang', () => {
  const lines = [
    { text: 'Pasal 1', page: 1 },
    { text: 'KEPALA BAGIAN HUKUM', page: 1 },
    { text: 'ttd.', page: 1 },
    { text: 'NIP. 19701022 1998031006', page: 1 },
    { text: 'Pasal 2', page: 2 },
    { text: 'KEPALA BAGIAN HUKUM', page: 2 },
    { text: 'ttd.', page: 2 },
    { text: 'Salinan sesuai dengan aslinya', page: 2 },
  ];
  const out = filterPageChrome(lines);
  assert.deepStrictEqual(
    out.map((l) => l.text),
    ['Pasal 1', 'Pasal 2'],
  );
});

test('filterPageChrome: duplikat heading preambul (ghost layer) dibuang', () => {
  const lines = [
    { text: 'Menimbang :', page: 1 },
    { text: 'a. bahwa X', page: 1 },
    { text: 'Menimbang :', page: 1 },
    { text: 'b. bahwa Y', page: 1 },
    { text: 'Mengingat :', page: 2 },
    { text: '1. UU Nomor 23 Tahun 2014', page: 2 },
    { text: 'Mengingat :', page: 2 },
  ];
  const out = filterPageChrome(lines);
  assert.deepStrictEqual(
    out.map((l) => l.text),
    ['Menimbang :', 'a. bahwa X', 'b. bahwa Y', 'Mengingat :', '1. UU Nomor 23 Tahun 2014'],
  );
});

test('filterPageChrome: a.n. Kepala Bagian Hukum (konten) tidak dibuang', () => {
  const lines = [
    { text: 'a.n. Kepala Bagian Hukum', page: 1 },
    { text: 'Salinan sesuai dengan aslinya', page: 2 },
  ];
  const out = filterPageChrome(lines);
  assert.deepStrictEqual(
    out.map((l) => l.text),
    ['a.n. Kepala Bagian Hukum'],
  );
});

test('textCleaner legacy: footer NIP/ttd & duplikat Menimbang dibuang, typo dikoreksi', () => {
  const out = cleanText(
    'KEPALA BAGIAN HUKUM\nMenimbang :\na. bahwa X\nMenimbang :\nb. bahwa Y\nMengingat :\n1. UU\nNIP. 19701022 1998031006\nttd.\n',
  );
  assert.ok(!out.includes('NIP.'), 'NIP hilang');
  assert.ok(!out.includes('ttd.'), 'ttd hilang');
  assert.ok(!out.includes('KEPALA BAGIAN HUKUM'), 'KEPALA BAGIAN HUKUM hilang');
  assert.strictEqual((out.match(/Menimbang/g) || []).length, 1, 'duplikat Menimbang dibuang');
  assert.ok(out.includes('a. bahwa X'), 'konten a. tetap');
  assert.ok(out.includes('b. bahwa Y'), 'konten b. tetap');
});

test('textCleaner legacy: typo BAE/Fasal/avat dikoreksi', () => {
  const out = cleanText('BAE III\nFasal 5\navat (2)');
  assert.ok(out.includes('BAB III'), 'BAE -> BAB');
  assert.ok(out.includes('Pasal 5'), 'Fasal -> Pasal');
  assert.ok(out.includes('ayat (2)'), 'avat -> ayat');
});

test('tableFormatter: tabel korup (baris 1-sel di samping 5-sel) -> plain text per baris', () => {
  const html =
    '<table><tr><td>NO</td><td>URAIAN</td><td>JUMLAH</td><td>KET</td><td>SUMBER</td></tr>' +
    '<tr><td>1</td><td>Belanja pegawai</td><td>100</td><td>lunas</td><td>APBD</td></tr>' +
    '<tr><td colspan="5">JUMLAH</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(!result.includes('+---'), 'grid korup tidak dipakai');
  assert.ok(result.includes('NO | URAIAN | JUMLAH | KET | SUMBER'), 'sel digabung plain');
  assert.ok(result.includes('Belanja pegawai'), 'info tetap ada');
  assert.ok(result.includes('JUMLAH'), 'sel colspan tetap ada');
});

test('tableFormatter: tabel bersih tetap pakai grid ASCII', () => {
  const html = '<table><tr><th>NO</th><th>URAIAN</th></tr><tr><td>1</td><td>Belanja</td></tr></table>';
  const result = formatTableHtmlToText(html);
  assert.ok(result.includes('+'), 'grid dipertahankan');
  assert.ok(result.includes('| NO |'), 'sel header dipertahankan');
});

test('config: TABLE_AWARE_MAX_PADDLEX_PAGES default 2, nilai 0 dihormati', () => {
  assert.strictEqual(config.tableAware.maxPaddlexPages, 2, 'default 2');
  const old = process.env.TABLE_AWARE_MAX_PADDLEX_PAGES;
  process.env.TABLE_AWARE_MAX_PADDLEX_PAGES = '0';
  delete require.cache[require.resolve('./src/config/index.js')];
  const cfg0 = require('./src/config/index.js');
  assert.strictEqual(cfg0.tableAware.maxPaddlexPages, 0, '0 = PaddleX nonaktif');
  process.env.TABLE_AWARE_MAX_PADDLEX_PAGES = old;
  delete require.cache[require.resolve('./src/config/index.js')];
  require('./src/config/index.js');
});

// ========================================================================
console.log('\n=== 15. Exit code ===');
console.log(`\nHasil: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Test gagal:');
  failedTests.forEach((t) => console.log(`  - ${t.name}: ${t.error}`));
}
process.exit(failed > 0 ? 1 : 0);

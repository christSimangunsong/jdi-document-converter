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
  assert.ok(contentLines.some((l) => l.includes('NO|KEBIJAKAN')), `konten hilang: ${result}`);
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
console.log('\n=== 13. Exit code ===');
console.log(`\nHasil: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Test gagal:');
  failedTests.forEach((t) => console.log(`  - ${t.name}: ${t.error}`));
}
process.exit(failed > 0 ? 1 : 0);

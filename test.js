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
console.log('\n=== 10. Reconstruction Pipeline ===');

const { BBox, Document, DocumentNode, Table, Heading, Line, Block } = require('./src/reconstruction/models/documentModel');
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
  const t = new Table({ headers: ['No', 'Nama', 'Keterangan'], rows: [['1', 'A', 'X'], ['2', 'B', 'Y']] });
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
  const lines = [new Line({ text: 'BAB I KETENTUAN UMUM', order: 0 }),
    new Line({ text: 'Pasal 1', order: 1 }),
    new Line({ text: '(1) Ayat satu', order: 2 })];
  const tree = await documentTreeBuilder.build(lines);
  assert.strictEqual(tree.type, 'root');
  assert.ok(tree.children.length >= 1);
  const bab = tree.children[0];
  assert.strictEqual(bab.type, 'bab');
  assert.strictEqual(bab.number, 'I');
});

test('documentTreeBuilder detects pasal', async () => {
  const lines = [new Line({ text: 'Pasal 1', order: 0 }),
    new Line({ text: 'Isi Pasal 1', order: 1 })];
  const tree = await documentTreeBuilder.build(lines);
  const pasal = tree.children[0];
  assert.strictEqual(pasal.type, 'pasal');
  assert.strictEqual(pasal.number, '1');
});

test('documentTreeBuilder detects ayat', async () => {
  const lines = [new Line({ text: 'Pasal 1', order: 0 }),
    new Line({ text: '(1) Ayat satu', order: 1 }),
    new Line({ text: '(2) Ayat dua', order: 2 })];
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

test('legalParser detects document types', () => {
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'paragraph', text: 'PERATURAN BUPATI DAIRI NOMOR 2 TAHUN 2020' }),
  ]});
  legalParser.parse(root);
  assert.ok(root.metadata.documentTypes.includes('PERATURAN'));
});

test('legalParser tags menimbang', () => {
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'paragraph', text: 'Menimbang: bahwa perlu menetapkan Peraturan Bupati' }),
  ]});
  legalParser.parse(root);
  assert.strictEqual(root.children[0].type, 'menimbang');
});

test('markdownGenerator generates bab heading', () => {
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'bab', number: 'I', title: 'BAB I KETENTUAN UMUM', level: 1 }),
  ]});
  const md = markdownGenerator.generate(root);
  assert.ok(md.includes('##'));
  assert.ok(md.includes('I'));
});

test('markdownGenerator generates pasal bold', () => {
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi pasal' }),
  ]});
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
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'pasal', title: 'Pasal 1' }),
  ]});
  const html = htmlGenerator.generate(root);
  assert.ok(html.includes('class="pasal"'));
  assert.ok(html.includes('<strong>Pasal 1</strong>'));
});

test('semanticJsonGenerator output structure', () => {
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi' }),
  ]});
  const json = semanticJsonGenerator.generate(root, { title: 'Test', pageCount: 5 });
  assert.strictEqual(json.version, '1.0');
  assert.strictEqual(json.title, 'Test');
  assert.strictEqual(json.children.length, 1);
  assert.strictEqual(json.children[0].type, 'pasal');
});

test('chunkBuilder creates chunks', () => {
  const root = new DocumentNode({ type: 'root', children: [
    new DocumentNode({ type: 'bab', number: 'I', title: 'BAB I', level: 1, children: [
      new DocumentNode({ type: 'pasal', number: '1', title: 'Pasal 1', text: 'Isi pasal 1' }),
    ]}),
  ]});
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
console.log('\n=== 11. Exit code ===');
console.log(`\nHasil: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Test gagal:');
  failedTests.forEach((t) => console.log(`  - ${t.name}: ${t.error}`));
}
process.exit(failed > 0 ? 1 : 0);

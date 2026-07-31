function isTableGarbage(line) {
  const t = line.trim();
  if (!t || t.length < 5) return false;

  const words = t.split(/\s+/);
  if (words.length <= 3) return false;

  const hasLongWord = words.some((w) => w.length >= 6);
  if (hasLongWord) return false;

  const shortCount = words.filter((w) => w.length <= 2).length;
  const shortPct = shortCount / words.length;

  const digitCount = (t.match(/\d/g) || []).length;
  const digitPct = digitCount / t.length;

  const letterCount = (t.match(/[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/g) || []).length;
  const letterPct = letterCount / t.length;

  if (shortPct > 0.8) return true;

  if (shortPct > 0.6 && digitPct > 0.25 && letterPct < digitPct) return true;

  return false;
}

function filterTableGarbage(text) {
  const lines = text.split('\n');

  let garbageStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isTableGarbage(lines[i]) && garbageStart === -1) {
      garbageStart = i;
    } else if (!isTableGarbage(lines[i]) && garbageStart !== -1) {
      break;
    }
  }

  if (garbageStart === -1) return text;

  const keep = lines.slice(0, garbageStart);
  const cleaned = keep.filter((l) => !isTableGarbage(l));

  return cleaned.join('\n');
}

function fixHyphenatedLineBreaks(text) {
  return text.replace(/(\p{Ll})-\s*\n\s*/gu, '$1');
}

function joinBrokenSentences(text) {
  return text.replace(/(?<=\p{Ll})\.?[^\S\n]*\n[^\S\n]*(?=\p{Lu})/gu, '. ');
}

function fixLegalHeadings(text) {
  text = text.replace(/^(BAB)\s+/gim, '\n\n$1 ');
  text = text.replace(/^(Pasal)\s+/gim, '\n\n$1 ');
  text = text.replace(/^(Ayat)\s+/gim, '\n\n$1 ');
  text = text.replace(/^(Pasal\s+\d+)/gim, '\n\n$1');
  text = text.replace(/^(Bagian\s+(Kesatu|Kedua|Ketiga|Keempat|Kelima))/gim, '\n\n$1');
  text = text.replace(/^(Paragraf\s+\d+)/gim, '\n\n$1');
  text = text.replace(/^(Menimbang|Mengingat|Memutuskan|Menetapkan|MEMUTUSKAN|MENETAPKAN)\s*:/gim, '\n\n$1:');
  return text;
}

function cleanText(rawText) {
  if (!rawText) return '';

  let text = rawText;

  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\r/g, '\n');

  text = fixHyphenatedLineBreaks(text);

  text = text.replace(/[•●▪→➢❖▶]/g, '-');

  text = text.replace(/[“”]/g, '"');
  text = text.replace(/[‘’]/g, "'");
  text = text.replace(/[–—─]/g, '-');

  text = text.replace(/…/g, '...');

  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  /* eslint-disable no-control-regex */
  text = text.replace(
    /([^\x20-\x7E\x0A\x0D\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF\u2190-\u21FF\u2600-\u26FF\u2700-\u27BF])/g,
    '',
  );
  /* eslint-enable no-control-regex */

  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ +\n/g, '\n');
  text = text.replace(/\n +/g, '\n');

  text = fixLegalHeadings(text);

  text = joinBrokenSentences(text);

  text = text.replace(/\n{4,}/g, '\n\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  text = filterTableGarbage(text);

  text = text.replace(/^\s+/, '');
  text = text.replace(/\s+$/, '');

  return text;
}

module.exports = {
  cleanText,
  isTableGarbage,
  filterTableGarbage,
  fixHyphenatedLineBreaks,
  joinBrokenSentences,
  fixLegalHeadings,
};

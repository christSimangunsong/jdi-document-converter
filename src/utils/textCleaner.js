function cleanText(rawText) {
  if (!rawText) return '';

  let text = rawText;

  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\r/g, '\n');

  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  text = text.replace(/([^\x20-\x7E\x0A\x0D\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF])/g, '');

  text = text.replace(/[•●▪→➢❖▶]/g, '-');

  text = text.replace(/[""'']/g, '"');

  text = text.replace(/[''']/g, "'");

  text = text.replace(/[–—─]/g, '-');

  text = text.replace(/\n{4,}/g, '\n\n\n');

  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ +\n/g, '\n');
  text = text.replace(/\n +/g, '\n');

  text = text.replace(/\n{3,}/g, '\n\n');

  text = text.replace(/^(BAB)\s+/gim, '\n\n$1 ');
  text = text.replace(/^(Pasal)\s+/gim, '\n\n$1 ');
  text = text.replace(/^(Ayat)\s+/gim, '\n\n$1 ');
  text = text.replace(/^(Pasal\s+\d+)/gim, '\n\n$1');
  text = text.replace(/^(Bagian\s+(Kesatu|Kedua|Ketiga|Keempat|Kelima))/gim, '\n\n$1');
  text = text.replace(/^(Paragraf\s+\d+)/gim, '\n\n$1');

  text = text.replace(/^\s+/, '');
  text = text.replace(/\s+$/, '');

  return text;
}

module.exports = { cleanText };

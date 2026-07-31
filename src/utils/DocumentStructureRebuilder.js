class DocumentStructureRebuilder {
  rebuild(text) {
    if (!text) return '';

    const blocks = this.parseBlocks(text);
    return this.serialize(blocks);
  }

  parseBlocks(text) {
    const lines = text.split('\n');
    const blocks = [];
    let bodyLines = [];

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line) {
        if (bodyLines.length > 0) {
          blocks.push(this.makeBody(bodyLines));
          bodyLines = [];
        }
        continue;
      }

      const type = this.detect(line);
      if (type === 'BODY') {
        bodyLines.push(line);
      } else {
        if (bodyLines.length > 0) {
          blocks.push(this.makeBody(bodyLines));
          bodyLines = [];
        }
        blocks.push({ type, text: line });
      }
    }

    if (bodyLines.length > 0) {
      blocks.push(this.makeBody(bodyLines));
    }

    return this.buildHierarchy(blocks);
  }

  detect(line) {
    if (/^(?:BAB)\s+(?:[IVXLCDM]+\b|\d+)/i.test(line)) return 'BAB';
    if (/^Bagian\s+(?:Kesatu|Kedua|Ketiga|Keempat|Kelima|Keenam|Ketujuh|Kedelapan|Kesembilan|Kesepuluh)/i.test(line))
      return 'BAGIAN';
    if (/^Paragraf\s+\d+/i.test(line)) return 'PARAGRAF';
    if (/^Pasal\s+\d+/i.test(line)) return 'PASAL';
    if (/^Ayat\s+/i.test(line)) return 'AYAT_HEADER';
    if (/^\(\d+[a-z]?\)/.test(line)) return 'AYAT';
    if (/^[a-z][.)]\s/.test(line)) return 'HURUF';
    if (/^\d+[.)]\s/.test(line)) return 'NOMOR';
    if (/^[-•▪➢]\s/.test(line)) return 'BULLET';
    if (/^(Menimbang|Mengingat|Memutuskan|Menetapkan|MEMUTUSKAN|MENETAPKAN)\s*:/.test(line)) return 'LEGAL_PREAMBLE';
    if (/^(PEMERINTAH|MENTERI|BUPATI|WALIKOTA|GUBERNUR)\s+/.test(line)) return 'LEGAL_AUTHORITY';
    return 'BODY';
  }

  level(type) {
    switch (type) {
      case 'LEGAL_AUTHORITY':
        return 1;
      case 'LEGAL_PREAMBLE':
        return 2;
      case 'BAB':
        return 3;
      case 'BAGIAN':
        return 4;
      case 'PARAGRAF':
        return 5;
      case 'PASAL':
        return 6;
      case 'AYAT_HEADER':
        return 7;
      case 'AYAT':
        return 7;
      case 'HURUF':
        return 8;
      case 'NOMOR':
        return 8;
      case 'BULLET':
        return 8;
      default:
        return 9;
    }
  }

  makeBody(lines) {
    const joined = lines.join('\n').replace(/(?<=\S)\n(?=\S)/g, ' ');
    return { type: 'BODY', text: joined };
  }

  buildHierarchy(blocks) {
    const root = { type: 'ROOT', level: 0, children: [] };
    const stack = [root];

    for (const block of blocks) {
      const lvl = this.level(block.type);
      const node = { type: block.type, text: block.text, children: [], level: lvl };

      while (stack.length > 1 && stack[stack.length - 1].level >= lvl) {
        stack.pop();
      }

      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }

    return root.children;
  }

  serialize(blocks) {
    return (
      blocks
        .map((b) => this.serializeBlock(b, 0))
        .join('\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/\n{3,}/g, '\n\n') + '\n'
    );
  }

  serializeBlock(block, depth) {
    let out = '';
    const indentType = {
      AYAT_HEADER: '  ',
      AYAT: '  ',
      HURUF: '    ',
      NOMOR: '    ',
      BULLET: '    ',
      BODY: '',
      LEGAL_PREAMBLE: '',
      LEGAL_AUTHORITY: '',
    };
    const indent = indentType[block.type] || '';

    switch (block.type) {
      case 'LEGAL_AUTHORITY':
      case 'LEGAL_PREAMBLE':
        out = '\n' + block.text + '\n';
        break;
      case 'BAB':
        out = '\n' + block.text + '\n' + '='.repeat(block.text.length) + '\n';
        break;
      case 'BAGIAN':
        out = '\n' + block.text + '\n';
        break;
      case 'PARAGRAF':
      case 'PASAL':
        out = '\n' + block.text + '\n';
        break;
      case 'AYAT_HEADER':
      case 'AYAT':
      case 'HURUF':
      case 'NOMOR':
      case 'BULLET':
      case 'BODY':
        out = indent + block.text + '\n';
        break;
      default:
        out = block.text + '\n';
    }

    if (block.children && block.children.length > 0) {
      out += block.children
        .map((c) => this.serializeBlock(c, depth + 1))
        .join('\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/\n{3,}/g, '\n\n');
    }

    return out;
  }
}

function rebuildDocumentStructure(text) {
  const rb = new DocumentStructureRebuilder();
  return rb.rebuild(text);
}

module.exports = { DocumentStructureRebuilder, rebuildDocumentStructure };

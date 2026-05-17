import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  createDraftDocx,
  replacePlaceholdersInXml,
} from '../templateDraftWriter';
import { xmlEscapeText } from '../templatePlaceholderUtils';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function runsXml(parts) {
  return parts.map((part) => `<w:r><w:t>${xmlEscapeText(part)}</w:t></w:r>`).join('');
}

function documentXml(parts) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}">
  <w:body><w:p>${runsXml(parts)}</w:p></w:body>
</w:document>`;
}

function headerXml(parts) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W_NS}"><w:p>${runsXml(parts)}</w:p></w:hdr>`;
}

function footerXml(parts) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W_NS}"><w:p>${runsXml(parts)}</w:p></w:ftr>`;
}

async function makeDocx({ documentParts, headerParts, footerParts }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.folder('_rels').file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.folder('word').file('document.xml', documentXml(documentParts));
  if (headerParts) zip.folder('word').file('header1.xml', headerXml(headerParts));
  if (footerParts) zip.folder('word').file('footer1.xml', footerXml(footerParts));
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function readDocxPart(blob, partName) {
  const zip = await JSZip.loadAsync(blob);
  return zip.file(partName).async('string');
}

function replaceXml(parts, input) {
  return replacePlaceholdersInXml(documentXml(parts), input).xml;
}

describe('templateDraftWriter split-run replacement', () => {
  it('replaces a placeholder inside one text node', () => {
    const xml = replaceXml(['Agreement with [COUNTERPARTY]'], {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    expect(xml).toContain('Agreement with BackSlash Pty Ltd');
    expect(xml).not.toContain('[COUNTERPARTY]');
  });

  it('replaces a placeholder split across two text nodes', () => {
    const xml = replaceXml(['[COUNTER', 'PARTY]'], {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    expect(xml).toContain('BackSlash Pty Ltd');
    expect(xml).not.toContain('[COUNTER');
  });

  it('replaces a placeholder split across three text nodes', () => {
    const xml = replaceXml(['[INSERT', ' COMPANY', ' NAME]'], {
      fields: { companyName: 'ContractIQ RF Proprietary Limited' },
    });
    expect(xml).toContain('ContractIQ RF Proprietary Limited');
    expect(xml).not.toContain('[INSERT');
  });

  it('preserves text before a split placeholder', () => {
    const xml = replaceXml(['Agreement with [COUNTER', 'PARTY NAME]'], {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    expect(xml).toContain('Agreement with BackSlash Pty Ltd');
  });

  it('preserves text after a split placeholder', () => {
    const xml = replaceXml(['[COUNTER', 'PARTY NAME] effective'], {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    expect(xml).toContain('BackSlash Pty Ltd');
    expect(xml).toContain(' effective');
  });

  it('replaces multiple placeholders in one paragraph', () => {
    const xml = replaceXml(['[COUNTERPARTY] starts on [EFFECTIVE DATE]'], {
      fields: { counterparty: 'BackSlash Pty Ltd', effectiveDate: '16 May 2026' },
    });
    expect(xml).toContain('BackSlash Pty Ltd starts on 16 May 2026');
  });

  it('replaces the same placeholder repeated multiple times', () => {
    const result = replacePlaceholdersInXml(documentXml(['[COUNTERPARTY] and [COUNTERPARTY]']), {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    expect(result.xml.match(/BackSlash Pty Ltd/g)).toHaveLength(2);
    expect(result.replaced.reduce((sum, item) => sum + item.occurrences, 0)).toBe(2);
  });

  it('replaces a curly placeholder', () => {
    const xml = replaceXml(['{{EffectiveDate}}'], {
      fields: { effectiveDate: '16 May 2026' },
    });
    expect(xml).toContain('16 May 2026');
  });

  it('replaces an uppercase underscore placeholder', () => {
    const xml = replaceXml(['INSERT_COMPANY_NAME'], {
      fields: { companyName: 'ContractIQ RF Proprietary Limited' },
    });
    expect(xml).toContain('ContractIQ RF Proprietary Limited');
  });

  it('escapes XML special characters in replacement values', () => {
    const xml = replaceXml(['[COMPANY NAME]'], {
      fields: { companyName: 'A & B < C > D' },
    });
    expect(xml).toContain('A &amp; B &lt; C &gt; D');
  });

  it('does not replace a generic legal word unless it is detected as a placeholder', () => {
    const xml = replaceXml(['The Company shall deliver services.'], {
      fields: { companyName: 'BackSlash Pty Ltd' },
    });
    expect(xml).toContain('The Company shall deliver services.');
    expect(xml).not.toContain('BackSlash Pty Ltd shall');
  });

  it('reports unresolved placeholders when no value is provided', () => {
    const result = replacePlaceholdersInXml(documentXml(['[UNKNOWN FIELD]']), {});
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        placeholder: '[UNKNOWN FIELD]',
        normalizedKey: 'unknown_field',
        reason: 'noValueProvided',
      }),
    ]);
  });
});

describe('templateDraftWriter DOCX integration', () => {
  it('replaces header placeholders', async () => {
    const blob = await makeDocx({
      documentParts: ['Body'],
      headerParts: ['Header for [COUNTER', 'PARTY]'],
    });
    const result = await createDraftDocx(blob, {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    const header = await readDocxPart(result.blob, 'word/header1.xml');
    expect(header).toContain('Header for BackSlash Pty Ltd');
  });

  it('replaces footer placeholders', async () => {
    const blob = await makeDocx({
      documentParts: ['Body'],
      footerParts: ['Footer {{EffectiveDate}}'],
    });
    const result = await createDraftDocx(blob, {
      fields: { effectiveDate: '16 May 2026' },
    });
    const footer = await readDocxPart(result.blob, 'word/footer1.xml');
    expect(footer).toContain('Footer 16 May 2026');
  });

  it('keeps generated DOCX structure readable by JSZip', async () => {
    const blob = await makeDocx({ documentParts: ['[COUNTERPARTY]'] });
    const result = await createDraftDocx(blob, {
      fields: { counterparty: 'BackSlash Pty Ltd' },
    });
    const zip = await JSZip.loadAsync(result.blob);
    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    expect(zip.file('_rels/.rels')).toBeTruthy();
    expect(zip.file('word/document.xml')).toBeTruthy();
  });

  it('creates a draft from a minimal DOCX with split [INSERT COMPANY NAME]', async () => {
    const blob = await makeDocx({
      documentParts: ['Party: [INSERT', ' COMPANY', ' NAME]'],
    });
    const result = await createDraftDocx(blob, {
      fields: { companyName: 'ContractIQ RF Proprietary Limited' },
    });
    const document = await readDocxPart(result.blob, 'word/document.xml');
    expect(document).toContain('Party: ContractIQ RF Proprietary Limited');
    expect(document).not.toContain('[INSERT');
  });

  it('replaces current regression placeholders and does not report them unresolved', async () => {
    const blob = await makeDocx({
      documentParts: [
        'INSERT_COMPANY_NAME ',
        'INSERT_REG._NO. ',
        'COUNTERPARTY_NAME ',
        'EFFECTIVE_DATE ',
        'COMMENCEMENT_DATE',
      ],
    });
    const result = await createDraftDocx(blob, {
      fields: {
        companyName: 'ContractIQ RF Proprietary Limited',
        registrationNumber: '2026/123456/07',
        counterparty: 'BackSlash',
        effectiveDate: '16 May 2026',
      },
    });
    const document = await readDocxPart(result.blob, 'word/document.xml');
    expect(document).toContain('ContractIQ RF Proprietary Limited');
    expect(document).toContain('2026/123456/07');
    expect(document).toContain('BackSlash');
    expect(document.match(/16 May 2026/g)).toHaveLength(2);
    expect(result.replacementReport.unresolved.map((item) => item.normalizedKey)).not.toEqual(
      expect.arrayContaining([
        'insert_company_name',
        'insert_reg_no',
        'counterparty_name',
        'effective_date',
        'commencement_date',
      ])
    );
  });
});

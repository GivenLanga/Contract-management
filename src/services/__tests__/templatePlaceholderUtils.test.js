import { describe, expect, it } from 'vitest';
import {
  generateBarePlaceholderAliases,
  generatePlaceholderAliases,
  normalizePlaceholderKey,
  xmlEscapeText,
} from '../templatePlaceholderUtils';

describe('templatePlaceholderUtils', () => {
  it('normalizes [INSERT REG. NO.]', () => {
    expect(normalizePlaceholderKey('[INSERT REG. NO.]')).toBe('insert_reg_no');
  });

  it('normalizes INSERT_REG._NO.', () => {
    expect(normalizePlaceholderKey('INSERT_REG._NO.')).toBe('insert_reg_no');
  });

  it('normalizes {{EffectiveDate}}', () => {
    expect(normalizePlaceholderKey('{{EffectiveDate}}')).toBe('effective_date');
  });

  it('aliases for counterparty include counterparty_name and COUNTERPARTY NAME', () => {
    expect(generatePlaceholderAliases('counterparty_name')).toContain('COUNTERPARTY_NAME');
    expect(generateBarePlaceholderAliases('counterparty_name')).toContain('COUNTERPARTY NAME');
  });

  it('xmlEscapeText escapes XML-sensitive characters', () => {
    expect(xmlEscapeText('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D');
  });
});

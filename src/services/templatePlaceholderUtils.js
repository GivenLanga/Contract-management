const GENERIC_BARE_KEYS = new Set([
  'company',
  'date',
  'party',
  'contract',
  'agreement',
]);

const FIELD_ALIAS_GROUPS = [
  {
    keys: ['counterparty', 'counterparty_name'],
    aliases: ['counterparty', 'counterparty_name'],
  },
  {
    keys: ['company', 'company_name', 'insert_company_name'],
    aliases: ['company', 'company_name', 'insert_company_name'],
  },
  {
    keys: ['registration_number', 'registration_no', 'reg_no', 'insert_reg_no', 'insert_beneficiary_reg_no'],
    aliases: ['registration_number', 'registration_no', 'reg_no', 'insert_reg_no', 'insert_beneficiary_reg_no'],
  },
  {
    keys: ['effective_date', 'commencement_date', 'insert_date', 'date'],
    aliases: ['effective_date', 'commencement_date', 'insert_date', 'date'],
  },
];

export function xmlEscapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function xmlDecodeText(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripPlaceholderWrapper(raw) {
  let value = String(raw ?? '').trim();
  if (value.startsWith('{{') && value.endsWith('}}')) {
    value = value.slice(2, -2).trim();
  } else if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitCamelCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

export function normalizePlaceholderKey(raw) {
  const unwrapped = splitCamelCase(xmlDecodeText(stripPlaceholderWrapper(raw)));
  return unwrapped
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function toWords(key) {
  return normalizePlaceholderKey(key).split('_').filter(Boolean);
}

function titleCaseWords(words) {
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

function camelCaseWords(words, upperFirst = false) {
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0 && !upperFirst) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

export function humanizePlaceholderLabel(raw) {
  const stripped = stripPlaceholderWrapper(raw);
  const words = toWords(stripped);
  return words.length ? titleCaseWords(words) : String(stripped || raw || '').trim();
}

export function getRelatedPlaceholderKeys(raw) {
  const normalized = normalizePlaceholderKey(raw);
  const related = new Set([normalized]);

  for (const group of FIELD_ALIAS_GROUPS) {
    if (group.keys.includes(normalized)) {
      group.aliases.forEach((alias) => related.add(alias));
    }
  }

  if (normalized.startsWith('insert_')) {
    related.add(normalized.replace(/^insert_/, ''));
  }

  return Array.from(related).filter(Boolean);
}

export function isGenericBarePlaceholderKey(key) {
  return GENERIC_BARE_KEYS.has(normalizePlaceholderKey(key));
}

export function isPlaceholderLike(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (/^\[[A-Za-z][^[\]\n]{0,120}\]$/.test(value)) return true;
  if (/^\{\{[A-Za-z][^{}\n]{0,120}\}\}$/.test(value)) return true;
  if (/^[A-Z][A-Z0-9]*(?:[._]+[A-Z0-9]+)+\.?$/.test(value)) return true;
  if (/^X{4,}$/i.test(value)) return true;
  return false;
}

export function generatePlaceholderAliases(raw) {
  const normalized = normalizePlaceholderKey(raw);
  const words = toWords(normalized);
  const upperWords = words.join(' ').toUpperCase();
  const lowerWords = words.join(' ').toLowerCase();
  const titleWords = titleCaseWords(words);
  const upperUnderscore = words.join('_').toUpperCase();
  const lowerUnderscore = words.join('_').toLowerCase();
  const pascal = camelCaseWords(words, true);
  const camel = camelCaseWords(words, false);
  const aliases = new Set();

  if (!normalized) return [];

  aliases.add(upperUnderscore);
  aliases.add(lowerUnderscore);
  aliases.add(`[${upperWords}]`);
  aliases.add(`[${titleWords}]`);
  aliases.add(`[${lowerWords}]`);
  aliases.add(`{{${pascal}}}`);
  aliases.add(`{{${camel}}}`);
  aliases.add(`{{${upperUnderscore}}}`);

  if (normalized.includes('reg_no')) {
    aliases.add(upperUnderscore.replace('REG_NO', 'REG._NO.'));
    aliases.add(`[${upperWords.replace('REG NO', 'REG. NO.')}]`);
    aliases.add(`[${upperWords.replace('REG NO', 'REG. NO')}]`);
  }

  return Array.from(aliases).filter(Boolean);
}

export function generateBarePlaceholderAliases(raw) {
  const words = toWords(raw);
  if (!words.length) return [];
  return [
    words.join(' ').toUpperCase(),
    words.join('_').toUpperCase(),
  ];
}

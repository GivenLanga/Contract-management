'use strict';

const TYPO_REPLACEMENTS = [
  [/\bwhats\b/g, 'what is'],
  [/\bwhat\s+task\s+are\b/g, 'what tasks are'],
  [/\bagreements\b/g, 'contracts'],
  [/\bagreement\b/g, 'contract'],
  [/\bsignign\b/g, 'signing'],
  [/\buploaded documents\b/g, 'uploaded documents'],
];

const normalizeMessage = (value) => {
  let text = String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [pattern, replacement] of TYPO_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return text.replace(/\s+/g, ' ').trim();
};

const hasAny = (text, ...terms) => terms.some((term) => text.includes(term));

const hasAll = (text, ...terms) => terms.every((term) => text.includes(term));

const isCountQuery = (text) => /\b(how many|count|number of|total)\b/.test(text);

const isListQuery = (text) => /\b(show|list|which|what|find|get|display)\b/.test(text);

const parseDays = (raw, fallback = 30) => {
  const text = String(raw || '').toLowerCase();
  const match = text.match(/\b(?:next|within|in)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/);
  if (match) {
    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1;
    return Math.min(Math.max(value * multiplier, 1), 365);
  }
  if (/\bnext\s+3\s+months?\b/.test(text)) return 90;
  if (/\bnext\s+quarter\b/.test(text)) return 90;
  if (/\bnext\s+month\b/.test(text)) return 30;
  if (/\bthis\s+month\b/.test(text)) return 30;
  if (/\bthis\s+quarter\b/.test(text)) return 90;
  return fallback;
};

const parsePeriod = (text) => {
  if (/\btoday\b/.test(text)) return 'today';
  if (/\bthis\s+week\b|\bweek\b/.test(text)) return 'this_week';
  if (/\bthis\s+month\b|\bmonth\b/.test(text)) return 'this_month';
  if (/\bthis\s+quarter\b|\bquarter\b/.test(text)) return 'this_quarter';
  if (/\bthis\s+year\b|\byear\b/.test(text)) return 'this_year';
  if (/\ball\b|\beverything\b|\bwhole\b/.test(text)) return 'all';
  return 'this_week';
};

module.exports = {
  hasAll,
  hasAny,
  isCountQuery,
  isListQuery,
  normalizeMessage,
  parseDays,
  parsePeriod,
};

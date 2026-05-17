// Pure lifecycle classifier for contract/document records.
//
// Priority: concrete record.lifecycleStage → path segment → status field → UNKNOWN
//
// Path segment rules:
//  - Only folder segments determine the stage; the filename is always excluded.
//  - Normalise each segment (lowercase, hyphens/underscores → spaces, collapse spaces).
//  - Try exact alias match first (high confidence), then a conservative token rule (medium).
//  - Use the deepest/rightmost matching lifecycle folder segment to resolve conflicts
//    (e.g. Contracts/…/Final/Signed/file.pdf → SIGNED because Signed is deeper).
//  - Signing-workflow folders (Awaiting Signature, Signing Queue, …) are never SIGNED.

export const LIFECYCLE = Object.freeze({
  TEMPLATE: 'TEMPLATE',
  DRAFT: 'DRAFT',
  FINAL: 'FINAL',
  SIGNED: 'SIGNED',
  UNKNOWN: 'UNKNOWN',
});

const CONCRETE_STAGES = new Set([
  LIFECYCLE.TEMPLATE,
  LIFECYCLE.DRAFT,
  LIFECYCLE.FINAL,
  LIFECYCLE.SIGNED,
]);

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Normalise a single path segment for alias matching.
 * Lowercases, converts hyphens and underscores to spaces, removes harmless
 * punctuation around words, and collapses whitespace.
 *
 * Examples:
 *   "Signed Documents"  → "signed documents"
 *   "e-signed"          → "e signed"
 *   "Signed_Contracts"  → "signed contracts"
 *   "  Fully   Signed " → "fully signed"
 */
export function normalizePathSegment(seg) {
  return String(seg || '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Alias sets (all pre-normalised) ──────────────────────────────────────────

const SIGNED_ALIASES = new Set([
  // Single-word
  'sign',
  'signed',
  'executed',
  'completed',
  // Multi-word — "signed" variants
  'signed documents',
  'signed docs',
  'signed contracts',
  'signed agreements',
  'documents signed',
  'docs signed',
  'contracts signed',
  'agreements signed',
  'fully signed',
  'fully signed documents',
  'fully signed contracts',
  'fully signed agreements',
  // Multi-word — "executed" variants
  'executed documents',
  'executed contracts',
  'executed agreements',
  // Multi-word — "completed" variants
  'completed documents',
  'completed contracts',
  'completed agreements',
  // Combined stage names
  'signed final',
  'final signed',
  // Electronic / wet signing
  'e signed',
  'e signed documents',
  'electronically signed',
  'electronically signed documents',
  'wet signed',
  'wet signed documents',
  // Short forms
  'doc signed',
  'document signed',
  'contract signed',
  'agreement signed',
]);

const FINAL_ALIASES = new Set([
  'final',
  'finals',
  'approved',
  'approved final',
  'ready for signature',
  'ready for signing',
  'for signature',
  'for signing',
  'to sign',
  'awaiting signature',
  'pending signature',
  'needs signature',
]);

const DRAFT_ALIASES = new Set([
  'draft',
  'drafts',
  'working drafts',
]);

const TEMPLATE_ALIASES = new Set([
  'templates',
  'legal templates',
  'contract templates',
  'standard templates',
  'precedents',
]);

// ── Token-based signed rule ───────────────────────────────────────────────────
//
// Catches real-world folder names like "Client Signed Documents" or
// "Executed Client Contracts" that aren't in the exact alias list.
//
// A segment classifies as SIGNED when it contains:
//   • a primary token: "signed" or "executed"  (exact word, not substring)
//   • AND a qualifying companion from the companion set
//
// This prevents false positives from workflow folders:
//   "Awaiting Signature" → no primary token → NOT SIGNED
//   "Signing Queue"      → "signing" ≠ "signed" → NOT SIGNED
//   "Design"             → single word, not in token set → NOT SIGNED
//   "Consignment"        → single word → NOT SIGNED

const SIGNED_PRIMARY_TOKENS = new Set(['signed', 'executed']);

const SIGNED_COMPANION_TOKENS = new Set([
  'document', 'documents',
  'doc', 'docs',
  'contract', 'contracts',
  'agreement', 'agreements',
  'final',
  'fully',
]);

function matchesSignedTokenRule(normalizedSeg) {
  const words = normalizedSeg.split(/\s+/).filter(Boolean);
  const hasPrimary = words.some((w) => SIGNED_PRIMARY_TOKENS.has(w));
  if (!hasPrimary) return false;
  return words.some((w) => SIGNED_COMPANION_TOKENS.has(w));
}

// ── Per-segment classifier ────────────────────────────────────────────────────

function stageForSegment(originalSeg) {
  const norm = normalizePathSegment(originalSeg);

  if (SIGNED_ALIASES.has(norm)) {
    return {
      stage: LIFECYCLE.SIGNED,
      reason: 'PATH_SEGMENT_SIGNED_ALIAS',
      matchedSegment: originalSeg,
      confidence: 'high',
    };
  }
  if (matchesSignedTokenRule(norm)) {
    return {
      stage: LIFECYCLE.SIGNED,
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      matchedSegment: originalSeg,
      confidence: 'medium',
    };
  }
  if (FINAL_ALIASES.has(norm)) {
    return {
      stage: LIFECYCLE.FINAL,
      reason: 'PATH_SEGMENT_FINAL_ALIAS',
      matchedSegment: originalSeg,
      confidence: 'high',
    };
  }
  if (DRAFT_ALIASES.has(norm)) {
    return {
      stage: LIFECYCLE.DRAFT,
      reason: 'PATH_SEGMENT_DRAFT_ALIAS',
      matchedSegment: originalSeg,
      confidence: 'high',
    };
  }
  if (TEMPLATE_ALIASES.has(norm)) {
    return {
      stage: LIFECYCLE.TEMPLATE,
      reason: 'PATH_SEGMENT_TEMPLATE_ALIAS',
      matchedSegment: originalSeg,
      confidence: 'high',
    };
  }
  return null;
}

// ── Path-level classifier (deepest segment wins) ──────────────────────────────

function hasFileExtension(segment) {
  return /\.[a-z0-9]{1,10}$/i.test(String(segment || '').trim());
}

function stageFromPath(path, { isFolderPath = false } = {}) {
  const parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  // Exclude the filename when the field points at a file. folderPath is allowed
  // to end at the lifecycle folder itself, so keep its last segment only when
  // it does not look like a file.
  const folderParts = isFolderPath && !hasFileExtension(parts[parts.length - 1])
    ? parts
    : parts.slice(0, -1);

  // Iterate left → right; keep updating so the rightmost (deepest) match wins.
  let deepest = null;
  for (const part of folderParts) {
    const match = stageForSegment(part);
    if (match) deepest = match;
  }
  return deepest;
}

// ── Public API ────────────────────────────────────────────────────────────────

const PATH_FIELDS = [
  'relativePath',
  'legalFolderPath',
  'sourcePath',
  'folderPath',
  'displayPath',
  'path',
  'filePath',
  'fullPath',
  'relativeFilePath',
  'legalFolderRelativePath',
  'sourceRelativePath',
];

export function getPathSegmentsFromRecord(record) {
  if (!record) return [];
  for (const field of PATH_FIELDS) {
    if (!record[field]) continue;
    const parts = String(record[field])
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) continue;
    const segments = field === 'folderPath' && !hasFileExtension(parts[parts.length - 1])
      ? parts
      : parts.slice(0, -1);
    if (segments.length) return segments;
  }
  return [];
}

/**
 * Classifies a contract/document record into its lifecycle stage.
 *
 * Priority:
 *   1. record.lifecycleStage — used as-is only when it is TEMPLATE/DRAFT/FINAL/SIGNED.
 *      UNKNOWN is not authoritative; paths may still reveal the real stage.
 *   2. Path-based classification — deepest lifecycle folder segment wins.
 *   3. Status field fallback (documentStage > stage > status).
 *   4. UNKNOWN.
 *
 * @param {object} record
 * @returns {{
 *   lifecycleStage: 'TEMPLATE'|'DRAFT'|'FINAL'|'SIGNED'|'UNKNOWN',
 *   reason: string,
 *   confidence: 'high'|'medium'|'none',
 *   pathUsed: string|null,
 *   matchedSegment: string|null,
 * }}
 */
export function classifyLifecycleStage(record) {
  if (!record) {
    return {
      lifecycleStage: LIFECYCLE.UNKNOWN,
      reason: 'NO_RECORD',
      confidence: 'none',
      pathUsed: null,
      matchedSegment: null,
    };
  }

  // 1. Use existing lifecycleStage only when it is a concrete known value.
  // UNKNOWN is intentionally not trusted; it often comes from an earlier,
  // weaker scan and must not block path-based recovery.
  const existing = String(record.lifecycleStage || '').toUpperCase();
  if (CONCRETE_STAGES.has(existing)) {
    return {
      lifecycleStage: existing,
      reason: 'EXISTING_FIELD',
      confidence: 'high',
      pathUsed: null,
      matchedSegment: null,
    };
  }

  // 2. Path-based classification — try each path field in priority order.
  for (const field of PATH_FIELDS) {
    if (!record[field]) continue;
    const match = stageFromPath(record[field], { isFolderPath: field === 'folderPath' });
    if (match) {
      return {
        lifecycleStage: match.stage,
        reason: match.reason,
        confidence: match.confidence,
        pathUsed: field,
        matchedSegment: match.matchedSegment,
      };
    }
  }

  // 3. Status-based fallback — documentStage > stage > status.
  const raw = String(record.documentStage || record.stage || record.status || '').toLowerCase();
  if (raw === 'signed') {
    return {
      lifecycleStage: LIFECYCLE.SIGNED,
      reason: 'SIGNED_BY_STATUS_NO_PATH',
      confidence: 'medium',
      pathUsed: null,
      matchedSegment: null,
    };
  }
  if (raw === 'draft' || raw === 'authoring') {
    return {
      lifecycleStage: LIFECYCLE.DRAFT,
      reason: 'STATUS_FIELD',
      confidence: 'medium',
      pathUsed: null,
      matchedSegment: null,
    };
  }
  if (
    raw === 'final' ||
    raw === 'ready for signature' ||
    raw === 'ready for signing' ||
    raw === 'for signature' ||
    raw === 'for signing' ||
    raw === 'to sign' ||
    raw === 'awaiting signature' ||
    raw === 'pending signature' ||
    raw === 'needs signature' ||
    raw === 'approved'
  ) {
    return {
      lifecycleStage: LIFECYCLE.FINAL,
      reason: 'STATUS_FIELD',
      confidence: 'medium',
      pathUsed: null,
      matchedSegment: null,
    };
  }
  if (raw === 'template') {
    return {
      lifecycleStage: LIFECYCLE.TEMPLATE,
      reason: 'STATUS_FIELD',
      confidence: 'medium',
      pathUsed: null,
      matchedSegment: null,
    };
  }

  return {
    lifecycleStage: LIFECYCLE.UNKNOWN,
    reason: 'NO_SIGNAL',
    confidence: 'none',
    pathUsed: null,
    matchedSegment: null,
  };
}

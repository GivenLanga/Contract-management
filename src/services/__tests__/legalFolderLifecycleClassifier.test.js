import { describe, it, expect } from 'vitest';
import { classifyLifecycleStage, normalizePathSegment } from '../legalFolderLifecycleClassifier';

// ── normalizePathSegment ──────────────────────────────────────────────────────

describe('normalizePathSegment', () => {
  it('lowercases', () => expect(normalizePathSegment('Signed Documents')).toBe('signed documents'));
  it('converts hyphens to spaces', () => expect(normalizePathSegment('e-signed')).toBe('e signed'));
  it('converts underscores to spaces', () => expect(normalizePathSegment('Signed_Docs')).toBe('signed docs'));
  it('collapses multiple spaces', () => expect(normalizePathSegment('Fully   Signed')).toBe('fully signed'));
  it('trims whitespace', () => expect(normalizePathSegment('  Signed  ')).toBe('signed'));
  it('handles hyphens and underscores together', () => {
    expect(normalizePathSegment('e-Signed_Documents')).toBe('e signed documents');
  });
  it('removes harmless punctuation around words', () => {
    expect(normalizePathSegment(' (Signed Documents). ')).toBe('signed documents');
  });
  it('preserves word boundaries when punctuation is removed', () => {
    expect(normalizePathSegment('Client: Signed/Documents')).toBe('client signed documents');
  });
});

// ── Existing core signed segments (updated reasons) ───────────────────────────

describe('Signed folder → SIGNED (core exact aliases)', () => {
  it('Signed segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Service Providers/ABC/Signed/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', reason: 'PATH_SEGMENT_SIGNED_ALIAS' });
  });

  it('Executed segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/XYZ/Executed/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', reason: 'PATH_SEGMENT_SIGNED_ALIAS' });
  });

  it('Completed segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/NDAs/Corp/Completed/NDA.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', reason: 'PATH_SEGMENT_SIGNED_ALIAS' });
  });

  it('Fully Signed segment (multi-word folder name)', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/ABC/Fully Signed/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', reason: 'PATH_SEGMENT_SIGNED_ALIAS' });
  });
});

// ── New: SIGNED alias variants (tests 1-19) ───────────────────────────────────

describe('Signed folder alias variants → SIGNED', () => {
  const signedAlias = (folderName) => ({
    sourcePath: `Contracts/2026/Service Providers/ABC/${folderName}/Agreement.pdf`,
  });

  it('1. Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Signed Documents'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_ALIAS',
      matchedSegment: 'Signed Documents',
      confidence: 'high',
    });
  });

  it('2. Signed Docs → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Signed Docs'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('3. Signed Contracts → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Signed Contracts'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('4. Signed Agreements → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Signed Agreements'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('5. Documents Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Documents Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('6. Docs Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Docs Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('7. Contracts Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Contracts Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('8. Fully Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Fully Signed Documents'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('9. Executed Documents → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Executed Documents'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('10. Executed Contracts → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Executed Contracts'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('11. Completed Contracts → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Completed Contracts'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('12. Final Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Final Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('13. Signed Final → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Signed Final'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('14. E-Signed Documents → SIGNED (hyphen normalized)', () => {
    expect(classifyLifecycleStage(signedAlias('E-Signed Documents'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_ALIAS',
      confidence: 'high',
    });
  });

  it('15. Electronically Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Electronically Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('16. Wet Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Wet Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('17. Doc Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Doc Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('18. Contract Signed → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Contract Signed'))).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('19. Sign → SIGNED', () => {
    expect(classifyLifecycleStage(signedAlias('Sign'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_ALIAS',
      confidence: 'high',
    });
  });
});

// ── Token-based signed rule ───────────────────────────────────────────────────

describe('Token-based signed rule → SIGNED', () => {
  const tokenPath = (folder) => ({
    sourcePath: `Contracts/2026/Service Providers/ABC/${folder}/Agreement.pdf`,
  });

  it('Client Signed Documents → SIGNED via token rule', () => {
    expect(classifyLifecycleStage(tokenPath('Client Signed Documents'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      confidence: 'medium',
    });
  });

  it('Signed Contract Documents → SIGNED via token rule', () => {
    expect(classifyLifecycleStage(tokenPath('Signed Contract Documents'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      confidence: 'medium',
    });
  });

  it('Fully Signed Agreement → SIGNED via token rule', () => {
    expect(classifyLifecycleStage(tokenPath('Fully Signed Agreement'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      confidence: 'medium',
    });
  });

  it('Executed Client Contract → SIGNED via token rule', () => {
    expect(classifyLifecycleStage(tokenPath('Executed Client Contract'))).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      confidence: 'medium',
    });
  });

  it('token rule confidence is lower than alias confidence', () => {
    const alias = classifyLifecycleStage(tokenPath('Signed Documents')); // exact alias
    const token = classifyLifecycleStage(tokenPath('Client Signed Documents')); // token rule
    const rank = { none: 0, medium: 1, high: 2 };
    expect(rank[alias.confidence]).toBeGreaterThan(rank[token.confidence]);
  });
});

// ── Negative tests: signing-workflow folders (tests 20-29) ───────────────────

describe('Signing workflow folders → NOT SIGNED', () => {
  const notSignedAlias = (folderName) => ({
    sourcePath: `Contracts/2026/Service Providers/ABC/${folderName}/Agreement.pdf`,
  });

  it('20. Signing Queue → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Signing Queue'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('21. Awaiting Signature → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Awaiting Signature'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('22. Pending Signature → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Pending Signature'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('23. Needs Signature → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Needs Signature'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('24. To Sign → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('To Sign'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('25. For Signing → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('For Signing'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('26. Signature Fields → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Signature Fields'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('27. Design → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Design'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('28. Assignments → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Assignments'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('29. Consignment → not SIGNED', () => {
    expect(classifyLifecycleStage(notSignedAlias('Consignment'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('Signed-Off Notes → not SIGNED (token rule: "off" and "notes" are not companions)', () => {
    expect(classifyLifecycleStage(notSignedAlias('Signed-Off Notes'))).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });
});

// ── File-name safety (tests 30-32) ────────────────────────────────────────────

describe('File name must not determine stage', () => {
  it('30. Templates/Signed NDA Template.docx → TEMPLATE (filename excluded)', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Templates/Signed NDA Template.docx',
    })).toMatchObject({ lifecycleStage: 'TEMPLATE' });
  });

  it('31. Contracts/2026/ABC/Final/Signed Agreement.pdf → FINAL not SIGNED', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/ABC/Final/Signed Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('32. Contracts/2026/ABC/Signed Documents/Agreement.pdf → SIGNED', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/ABC/Signed Documents/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', matchedSegment: 'Signed Documents' });
  });

  it('33. Contracts/2026/ABC/Ready for Signature/Agreement.pdf → FINAL not SIGNED', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/ABC/Ready for Signature/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/ABC/Ready for Signature/Agreement.pdf',
    })).not.toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('folderPath can end at a signed alias folder without being treated as a filename', () => {
    expect(classifyLifecycleStage({
      folderPath: 'Contracts/2026/ABC/Signed Documents',
    })).toMatchObject({
      lifecycleStage: 'SIGNED',
      matchedSegment: 'Signed Documents',
    });
  });

  it('folderPath still ignores a file name when a file path is supplied there', () => {
    expect(classifyLifecycleStage({
      folderPath: 'Contracts/2026/ABC/Final/Signed Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('file named signed.pdf in a plain folder is UNKNOWN', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/signed.pdf',
    })).toMatchObject({ lifecycleStage: 'UNKNOWN' });
  });
});

// ── UNKNOWN lifecycleStage must not block path recovery ──────────────────────

describe('UNKNOWN lifecycleStage does not block path-based classification', () => {
  it('1. lifecycleStage UNKNOWN but path has Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    })).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_ALIAS',
      pathUsed: 'relativePath',
      matchedSegment: 'Signed Documents',
    });
  });

  it('2. lifecycleStage UNKNOWN but path has Signed → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts/2026/Service Providers/ABC/Signed/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', matchedSegment: 'Signed' });
  });

  it('3. lifecycleStage UNKNOWN but path has Executed Contracts → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts/2026/Service Providers/ABC/Executed Contracts/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', matchedSegment: 'Executed Contracts' });
  });

  it('4. Windows backslash path with Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts\\2026\\Service Providers\\ABC\\Signed Documents\\Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', matchedSegment: 'Signed Documents' });
  });

  it('5. legalFolderRelativePath with Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      legalFolderRelativePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', pathUsed: 'legalFolderRelativePath' });
  });

  it('6. filePath with Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      filePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', pathUsed: 'filePath' });
  });

  it('7. sourceRelativePath with Signed Documents → SIGNED', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      sourceRelativePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', pathUsed: 'sourceRelativePath' });
  });

  it('8. concrete lifecycleStage FINAL still takes priority over Signed Documents path', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'FINAL',
      relativePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL', reason: 'EXISTING_FIELD' });
  });

  it('9. Final/Signed Agreement.pdf remains FINAL because Signed is only in file name', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts/2026/Service Providers/ABC/Final/Signed Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL', matchedSegment: 'Final' });
  });

  it('10. Templates/Signed NDA Template.docx remains TEMPLATE', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Templates/Signed NDA Template.docx',
    })).toMatchObject({ lifecycleStage: 'TEMPLATE', matchedSegment: 'Templates' });
  });
});

// ── Conflict resolution — deepest folder segment wins (tests 34-35) ───────────

describe('Conflict resolution — deepest lifecycle folder wins', () => {
  it('34. Contracts/2026/ABC/Final/Signed/file.pdf → SIGNED (Signed deeper than Final)', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/ABC/Final/Signed/file.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('35. Contracts/2026/ABC/Signed/Final/file.docx → FINAL (Final deeper than Signed)', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/ABC/Signed/Final/file.docx',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('Templates/…/Signed/file.pdf → SIGNED because Signed is deeper than Templates', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Templates/ABC/Signed/file.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED' });
  });
});

// ── Existing: Final folder paths ──────────────────────────────────────────────

describe('Final folder → FINAL', () => {
  it('Final segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Service Providers/ABC/Final/Agreement.docx',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('Finals segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Service Providers/ABC/Finals/Agreement.docx',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('Approved segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/XYZ/Approved/Agreement.docx',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('Approved Final segment (multi-word)', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/XYZ/Approved Final/Agreement.docx',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('Ready for Signature → FINAL', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/Ready for Signature/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL', reason: 'PATH_SEGMENT_FINAL_ALIAS' });
  });

  it('Ready for Signing → FINAL', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/Ready for Signing/Agreement.pdf',
    })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('For Signature → FINAL, not SIGNED', () => {
    const result = classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/For Signature/Agreement.pdf',
    });
    expect(result).toMatchObject({ lifecycleStage: 'FINAL', reason: 'PATH_SEGMENT_FINAL_ALIAS' });
  });

  it('To Sign → FINAL, not SIGNED', () => {
    const result = classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/To Sign/Agreement.pdf',
    });
    expect(result).toMatchObject({ lifecycleStage: 'FINAL', reason: 'PATH_SEGMENT_FINAL_ALIAS' });
  });

  it('Pending Signature → FINAL, not SIGNED', () => {
    const result = classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/Pending Signature/Agreement.pdf',
    });
    expect(result).toMatchObject({ lifecycleStage: 'FINAL', reason: 'PATH_SEGMENT_FINAL_ALIAS' });
  });
});

// ── Existing: Draft folder paths ──────────────────────────────────────────────

describe('Draft folder → DRAFT', () => {
  it('Drafts segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Service Providers/ABC/Drafts/Agreement v1.docx',
    })).toMatchObject({ lifecycleStage: 'DRAFT' });
  });

  it('Draft segment (singular)', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/Draft/Agreement v2.docx',
    })).toMatchObject({ lifecycleStage: 'DRAFT' });
  });

  it('Working Drafts segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/Working Drafts/Agreement v1.docx',
    })).toMatchObject({ lifecycleStage: 'DRAFT' });
  });
});

// ── Existing: Template folder paths ──────────────────────────────────────────

describe('Template folder → TEMPLATE', () => {
  it('Templates root', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Templates/Addendum.docx',
    })).toMatchObject({ lifecycleStage: 'TEMPLATE' });
  });

  it('Legal Templates segment', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Legal Folder/Legal Templates/NDA.docx',
    })).toMatchObject({ lifecycleStage: 'TEMPLATE' });
  });
});

// ── Existing: Unknown paths ───────────────────────────────────────────────────

describe('Unknown paths → UNKNOWN', () => {
  it('path outside Contracts and Templates', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Other/file.docx',
    })).toMatchObject({ lifecycleStage: 'UNKNOWN' });
  });

  it('no path fields at all returns UNKNOWN', () => {
    expect(classifyLifecycleStage({ title: 'Something' })).toMatchObject({
      lifecycleStage: 'UNKNOWN',
    });
  });
});

// ── Existing: Case-insensitivity ──────────────────────────────────────────────

describe('Matching is case-insensitive', () => {
  it('SIGNED (uppercase) folder matches', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/ABC/SIGNED/file.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('signed (lowercase) folder matches', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/ABC/signed/file.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED' });
  });

  it('DRAFTS folder matches', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Services/Corp/DRAFTS/v1.docx',
    })).toMatchObject({ lifecycleStage: 'DRAFT' });
  });

  it('SIGNED_DOCUMENTS (underscore) folder matches via normalization', () => {
    expect(classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Loans/ABC/SIGNED_DOCUMENTS/file.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED' });
  });
});

// ── Existing: Priority — lifecycleStage field beats path ─────────────────────

describe('Valid lifecycleStage field takes highest priority', () => {
  it('SIGNED stage field used without path', () => {
    expect(classifyLifecycleStage({ lifecycleStage: 'SIGNED' })).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'EXISTING_FIELD',
      confidence: 'high',
    });
  });

  it('FINAL stage field used without path', () => {
    expect(classifyLifecycleStage({ lifecycleStage: 'FINAL' })).toMatchObject({ lifecycleStage: 'FINAL' });
  });

  it('TEMPLATE stage field used without path', () => {
    expect(classifyLifecycleStage({ lifecycleStage: 'TEMPLATE' })).toMatchObject({ lifecycleStage: 'TEMPLATE' });
  });

  it('pre-existing lifecycleStage takes priority over path', () => {
    expect(classifyLifecycleStage({
      lifecycleStage: 'DRAFT',
      sourcePath: 'Contracts/2026/Services/Corp/Signed/file.pdf',
    })).toMatchObject({ lifecycleStage: 'DRAFT', reason: 'EXISTING_FIELD' });
  });
});

// ── Existing: Status-field fallback ──────────────────────────────────────────

describe('Status field fallback (no path, no lifecycleStage)', () => {
  it('status: Signed → SIGNED with SIGNED_BY_STATUS_NO_PATH reason', () => {
    expect(classifyLifecycleStage({ status: 'signed' })).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'SIGNED_BY_STATUS_NO_PATH',
      confidence: 'medium',
    });
  });

  it('status: Draft → DRAFT', () => {
    expect(classifyLifecycleStage({ status: 'Draft' })).toMatchObject({ lifecycleStage: 'DRAFT' });
  });

  it('status: Active → UNKNOWN (not a lifecycle stage)', () => {
    expect(classifyLifecycleStage({ status: 'Active' })).toMatchObject({ lifecycleStage: 'UNKNOWN' });
  });

  it('null record → UNKNOWN', () => {
    expect(classifyLifecycleStage(null)).toMatchObject({ lifecycleStage: 'UNKNOWN', reason: 'NO_RECORD' });
  });
});

// ── Regression: path with Signed segment, no lifecycleStage field (updated) ──

describe('Regression: signed path works without lifecycleStage pre-populated', () => {
  it('record with only sourcePath containing Signed is classified as SIGNED', () => {
    const record = {
      id: 'IMPORT-001',
      title: 'Agreement Signed',
      sourcePath: 'Contracts/2026/Service Providers/ABC/Signed/Agreement Signed.pdf',
    };
    const result = classifyLifecycleStage(record);
    expect(result.lifecycleStage).toBe('SIGNED');
    expect(result.reason).toBe('PATH_SEGMENT_SIGNED_ALIAS');
    expect(result.pathUsed).toBe('sourcePath');
    expect(result.matchedSegment).toBe('Signed');
  });

  it('relativePath field also works as a source of path classification', () => {
    expect(classifyLifecycleStage({
      relativePath: 'Contracts/2026/Services/Corp/Executed/contract.pdf',
    })).toMatchObject({ lifecycleStage: 'SIGNED', pathUsed: 'relativePath' });
  });

  it('Signed Documents folder via sourcePath — no lifecycleStage field', () => {
    const result = classifyLifecycleStage({
      sourcePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    });
    expect(result.lifecycleStage).toBe('SIGNED');
    expect(result.matchedSegment).toBe('Signed Documents');
  });
});

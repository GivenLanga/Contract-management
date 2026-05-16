// Client-side draft destination path builder.
// Constructs a safe, versioned path within the connected Legal Folder for a
// draft document. Never writes outside the provided directory handle.

// ── Sanitisation ─────────────────────────────────────────────────────────────

function sanitizeSegment(name) {
  return String(name || 'Unknown')
    .replace(/[/\\?%*:|"<>]/g, '-')   // unsafe filesystem chars
    .replace(/\.{2,}/g, '.')           // prevent path traversal sequences
    .replace(/^\.|\.$/g, '')           // no leading/trailing dots
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Unknown';
}

function sanitizeFilename(name) {
  return String(name || 'Untitled')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled';
}

// ── Agreement family → category folder ───────────────────────────────────────

const FAMILY_TO_CATEGORY = {
  FUNDING_LOAN_AGREEMENT: 'Loans',
  LOAN_AGREEMENT: 'Loans',
  BRIDGING_FINANCE_AGREEMENT: 'Loans',
  GRANT_AGREEMENT: 'Grants',
  ASSISTANCE_AGREEMENT: 'Assistance Agreements',
  MASTER_SERVICE_AGREEMENT: 'Services',
  ONCE_OFF_SERVICE_AGREEMENT: 'Services',
  SERVICE_PROVIDER_AGREEMENT: 'Services',
  CONSULTANCY_AGREEMENT: 'Consultancy',
  SLA: 'Services',
  VENDOR_AGREEMENT: 'Vendor Agreements',
  LEASE_AGREEMENT: 'Leases',
  ADDENDUM: 'Addenda',
  AMENDMENT_AGREEMENT: 'Amendments',
  NDA: 'NDAs',
  CONFIDENTIALITY_AGREEMENT: 'NDAs',
  MOU: 'MOUs',
  MOA: 'MOAs',
  EMPLOYMENT_AGREEMENT: 'Employment',
  OTHER: 'Contracts',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a draft file destination path inside the connected Legal Folder.
 *
 * Pattern: Contracts/{year}/{category}/{counterparty}/Drafts/{fileName}
 * If category is already set explicitly, it takes precedence over agreementFamily.
 *
 * @param {{ year?, agreementFamily?, category?, counterparty?, documentTitle?, stage? }} opts
 * @returns {{ pathParts: string[], fileName: string, displayPath: string }}
 */
export function buildDraftPath({
  year,
  agreementFamily,
  category,
  counterparty,
  documentTitle,
  stage = 'Drafts',
} = {}) {
  const resolvedYear = sanitizeSegment(year || new Date().getFullYear());
  const resolvedCategory = sanitizeSegment(
    category || FAMILY_TO_CATEGORY[agreementFamily] || 'Contracts'
  );
  const resolvedCounterparty = sanitizeSegment(counterparty || 'Unknown Counterparty');
  const resolvedStage = sanitizeSegment(stage);
  const safeTitle = sanitizeFilename(documentTitle || 'Draft');

  const pathParts = ['Contracts', resolvedYear, resolvedCategory, resolvedCounterparty, resolvedStage];
  const baseFileName = `${safeTitle} - Draft`;

  return {
    pathParts,
    baseFileName,
    displayPath: [...pathParts, `${baseFileName} v1.docx`].join('/'),
  };
}

/**
 * Writes a Blob to the Legal Folder under the given path, incrementing the
 * draft version number (v1 → v2 → …) if the file already exists.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {{ pathParts: string[], baseFileName: string }} pathInfo
 * @param {Blob} blob
 * @returns {Promise<{ fileName: string, displayPath: string }>}
 */
export async function writeToLegalFolder(rootHandle, pathInfo, blob) {
  const { pathParts, baseFileName } = pathInfo;

  // Navigate (and create) the directory tree
  let current = rootHandle;
  for (const part of pathParts) {
    current = await current.getDirectoryHandle(sanitizeSegment(part), { create: true });
  }

  // Find a non-colliding filename: "Title - Draft v1.docx", "... v2.docx", …
  let fileName = '';
  for (let v = 1; v <= 99; v++) {
    const candidate = `${baseFileName} v${v}.docx`;
    try {
      await current.getFileHandle(candidate);
      // file exists — try next version
    } catch (e) {
      if (e.name === 'NotFoundError') {
        fileName = candidate;
        break;
      }
      throw e;
    }
  }

  if (!fileName) {
    fileName = `${baseFileName} v${Date.now().toString(36)}.docx`;
  }

  const fileHandle = await current.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();

  const displayPath = [...pathParts, fileName].join('/');
  return { fileName, displayPath };
}

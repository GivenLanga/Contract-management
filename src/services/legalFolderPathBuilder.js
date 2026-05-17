// Client-side draft destination path builder.
// All file system operations use File System Access API handles only.
// Never opens save dialogs; never writes outside the connected Legal Folder.

// ── Sanitisation ─────────────────────────────────────────────────────────────

function sanitizeSegment(name) {
  return String(name || 'Unknown')
    .replace(/[/\\?%*:|"<>]/g, '-')   // unsafe filesystem chars — prevent path traversal
    .replace(/\.{2,}/g, '.')           // prevent .. path traversal sequences
    .replace(/^\.|\.$/g, '')           // no leading/trailing dots
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Unknown';
}

/** Exported alias for sanitizeSegment — required by spec. */
export function sanitizePathPart(value) {
  return sanitizeSegment(value);
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
// Each family lists preferred folder names in priority order.
// mapAgreementFamilyToFolder checks existing Legal Folder dirs first so the
// app prefers names already present on disk.

const FAMILY_CANDIDATES = {
  ONCE_OFF_SERVICE_AGREEMENT: ['Service Providers', 'Services'],
  MASTER_SERVICE_AGREEMENT:   ['Service Providers', 'Services'],
  SERVICE_PROVIDER_AGREEMENT: ['Service Providers', 'Services'],
  CONSULTANCY_AGREEMENT:      ['Consultancy Agreements', 'Service Providers', 'Consultancy'],
  FUNDING_LOAN_AGREEMENT:     ['Funding Loan Agreement', 'Loans'],
  LOAN_AGREEMENT:             ['Funding Loan Agreement', 'Loans'],
  BRIDGING_FINANCE_AGREEMENT: ['Funding Loan Agreement', 'Loans'],
  GRANT_AGREEMENT:            ['Grants'],
  ASSISTANCE_AGREEMENT:       ['Assistance Agreements'],
  SLA:                        ['Service Providers', 'Services'],
  VENDOR_AGREEMENT:           ['Vendor Agreements', 'Vendors'],
  LEASE_AGREEMENT:            ['Leases'],
  ADDENDUM:                   ['Addenda'],
  AMENDMENT_AGREEMENT:        ['Amendments'],
  NDA:                        ['Confidentiality', 'NDAs'],
  CONFIDENTIALITY_AGREEMENT:  ['Confidentiality', 'NDAs'],
  MOU:                        ['MOUs'],
  MOA:                        ['MOAs'],
  EMPLOYMENT_AGREEMENT:       ['Employment'],
  SOW:                        ['Service Providers', 'Services'],
  DPA:                        ['Data Processing'],
  OTHER:                      ['Contracts'],
};

// Legacy flat map — kept so existing tests that check 'Services' and 'Loans' pass.
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

/**
 * Maps an agreement family to the best matching folder name.
 * Checks existingFolders (names already in Legal Folder/Contracts/{year}/) to
 * prefer names already present on disk.
 *
 * @param {string} agreementFamily
 * @param {string} [templateCategory]
 * @param {string[]} [existingFolders]
 * @returns {string}
 */
export function mapAgreementFamilyToFolder(agreementFamily, templateCategory, existingFolders = []) {
  const family = String(agreementFamily || 'OTHER').toUpperCase();
  const candidates = FAMILY_CANDIDATES[family] || FAMILY_CANDIDATES.OTHER;
  const lowerExisting = existingFolders.map((f) => f.toLowerCase());

  // Prefer a candidate that already exists on disk (return exact on-disk casing)
  for (const candidate of candidates) {
    const idx = lowerExisting.indexOf(candidate.toLowerCase());
    if (idx !== -1) return existingFolders[idx];
  }

  // No existing match — return the first preferred name for this family
  return candidates[0];
}

// ── File System Access API helpers ────────────────────────────────────────────

/**
 * Returns directory names found in Contracts/{currentYear}/ within rootHandle.
 * Used to detect existing category folder names for smart category matching.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @returns {Promise<string[]>}
 */
export async function getExistingCategoryFolders(rootHandle) {
  const year = String(new Date().getFullYear());
  try {
    const contractsHandle = await rootHandle.getDirectoryHandle('Contracts');
    const yearHandle = await contractsHandle.getDirectoryHandle(year);
    const names = [];
    for await (const [name, entry] of yearHandle.entries()) {
      if (entry.kind === 'directory') names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Creates directories along pathParts (relative to rootHandle) and returns the
 * final directory handle.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string[]} pathParts
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function ensureDirectoryPath(rootHandle, pathParts) {
  let current = rootHandle;
  for (const part of pathParts) {
    current = await current.getDirectoryHandle(sanitizeSegment(part), { create: true });
  }
  return current;
}

/**
 * Finds the next non-colliding draft filename in a Drafts directory.
 * Pattern: "{title} - {counterparty} - Draft v1.docx", incrementing to v99.
 *
 * @param {FileSystemDirectoryHandle} draftsHandle
 * @param {string} baseTitle
 * @param {string} [counterparty]
 * @returns {Promise<string>}
 */
export async function resolveDraftFileName(draftsHandle, baseTitle, counterparty) {
  const safeTitle = sanitizeFilename(baseTitle);
  const safeCounterparty = counterparty ? sanitizeFilename(counterparty) : '';
  const baseName = safeCounterparty
    ? `${safeTitle} - ${safeCounterparty} - Draft`
    : `${safeTitle} - Draft`;

  for (let v = 1; v <= 99; v++) {
    const candidate = `${baseName} v${v}.docx`;
    try {
      await draftsHandle.getFileHandle(candidate);
      // file exists — try next version
    } catch (e) {
      if (e.name === 'NotFoundError') return candidate;
      throw e;
    }
  }
  return `${baseName} v${Date.now().toString(36)}.docx`;
}

/**
 * Builds and creates the full draft destination in the connected Legal Folder.
 * Creates Contracts/{year}/{category}/{counterparty}/Drafts/ and also ensures
 * Final/ and Signed/ sibling folders exist next to Drafts/.
 *
 * @param {{
 *   rootHandle: FileSystemDirectoryHandle,
 *   agreementFamily?: string,
 *   templateCategory?: string,
 *   counterparty: string,
 *   documentTitle: string,
 * }} opts
 * @returns {Promise<{
 *   pathParts: string[],
 *   directoryHandle: FileSystemDirectoryHandle,
 *   fileName: string,
 *   relativePath: string,
 *   displayPath: string,
 * }>}
 */
export async function buildDraftDestination({
  rootHandle,
  agreementFamily,
  templateCategory,
  counterparty,
  documentTitle,
}) {
  const year = String(new Date().getFullYear());
  const existingFolders = await getExistingCategoryFolders(rootHandle);
  const category = mapAgreementFamilyToFolder(agreementFamily, templateCategory, existingFolders);
  const safeCounterparty = sanitizeSegment(counterparty || 'Unknown Counterparty');

  const pathParts = ['Contracts', year, category, safeCounterparty, 'Drafts'];
  const draftsHandle = await ensureDirectoryPath(rootHandle, pathParts);

  // Ensure Final and Signed sibling folders exist alongside Drafts
  const counterpartyHandle = await ensureDirectoryPath(rootHandle, pathParts.slice(0, -1));
  await counterpartyHandle.getDirectoryHandle('Final', { create: true });
  await counterpartyHandle.getDirectoryHandle('Signed', { create: true });

  const fileName = await resolveDraftFileName(draftsHandle, documentTitle, counterparty);
  const relativePath = [...pathParts, fileName].join('/');

  return {
    pathParts,
    directoryHandle: draftsHandle,
    fileName,
    relativePath,
    displayPath: relativePath,
  };
}

/**
 * Writes a Blob directly to an open Drafts directory handle.
 * Uses File System Access API only — never opens an OS save dialog.
 *
 * @param {FileSystemDirectoryHandle} draftsHandle
 * @param {string} fileName
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
export async function writeDraftToFolder(draftsHandle, fileName, blob) {
  const fileHandle = await draftsHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ── Sync path builder (no handle required, for preview only) ──────────────────

/**
 * Builds a draft path string for preview purposes only.
 * Does NOT create any directories or files. Use buildDraftDestination for actual writes.
 *
 * @param {{ year?, agreementFamily?, category?, counterparty?, documentTitle?, stage? }} opts
 * @returns {{ pathParts: string[], baseFileName: string, displayPath: string }}
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
    category ||
    (FAMILY_CANDIDATES[String(agreementFamily || 'OTHER').toUpperCase()] || FAMILY_CANDIDATES.OTHER)[0]
  );
  const resolvedCounterparty = sanitizeSegment(counterparty || 'Unknown Counterparty');
  const resolvedStage = sanitizeSegment(stage);
  const safeTitle = sanitizeFilename(documentTitle || 'Draft');
  const safeCounterpartyName = counterparty ? sanitizeFilename(counterparty) : '';

  const pathParts = ['Contracts', resolvedYear, resolvedCategory, resolvedCounterparty, resolvedStage];
  const baseName = safeCounterpartyName
    ? `${safeTitle} - ${safeCounterpartyName} - Draft`
    : `${safeTitle} - Draft`;

  return {
    pathParts,
    baseFileName: baseName,
    displayPath: [...pathParts, `${baseName} v1.docx`].join('/'),
  };
}

/**
 * Writes a Blob to the Legal Folder under the given path, incrementing the
 * draft version number (v1 → v2 → …) if the file already exists.
 * Kept for backwards compatibility with existing tests.
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

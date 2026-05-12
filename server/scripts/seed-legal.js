'use strict';
/**
 * Seed script — imports contracts from the sa_mock_contracts folders
 * into the CLM database without modifying the source files.
 *
 * Usage:
 *   cd server && node scripts/seed-legal.js
 *
 * Safe to run multiple times — skips contracts whose contractId already exists.
 */

const path  = require('path');
const fs    = require('fs');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ── Models ────────────────────────────────────────────────────────────────────
const Contract = require('../src/models/Contract');
const Document = require('../src/models/Document');
const User     = require('../src/models/User');

// ── Config ────────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const SOURCE_DIRS = [
  '/home/creepydoll/Documents/sa_mock_contracts_50/Contracts',
  '/home/creepydoll/Documents/sa_mock_contracts_pack/Contracts',
];
const TODAY = new Date();

// ── Mappings ──────────────────────────────────────────────────────────────────
const STATUS_FROM_FOLDER = {
  'Signed Documents': 'SIGNED',
  'Final':            'FINAL',
  'Drafts':           'DRAFT',
};

const DEPT_MAP = {
  'Service Providers':       'Procurement',
  'Loan Agreements':         'Finance',
  'Grant Agreements':        'Finance',
  'Compliance and Audit':    'Legal',
  'Facilities and Maintenance': 'Operations',
  'Insurance and Risk':      'Legal',
  'Lease Agreements':        'Operations',
  'Marketing and Events':    'Operations',
  'Partnerships and MOUs':   'Legal',
  'Collections and Recoveries': 'Finance',
  'Software and Licensing':  'Operations',
  'Training and Development':'Operations',
};

function contractTypeFromTitle(title) {
  const t = title.toLowerCase();
  if (t.includes('service level') || t.includes('managed it') ||
      t.includes('cloud hosting') || t.includes('cybersecurity monitoring') ||
      t.includes('loan management system development') ||
      t.includes('implementation and support')) return 'SLA';
  if (t.includes('lease') || t.includes('office lease')) return 'Lease';
  if (t.includes('memorandum of understanding')) return 'MOA';
  if (t.includes('software') || t.includes('licensing') || t.includes('b-bbee')) return 'License';
  if (t.includes('facilities') || t.includes('maintenance') ||
      t.includes('events management') || t.includes('courier') ||
      t.includes('physical security') || t.includes('office supplies') ||
      t.includes('payroll') || t.includes('document digitisation') ||
      t.includes('field verification') || t.includes('call centre') ||
      t.includes('debt collection')) return 'Vendor';
  if (t.includes('employment')) return 'Employment';
  return 'Other';
}

// Deterministic value based on sequence number
const VALUE_TABLE = {
  SLA:        [520000, 750000, 1200000, 1850000, 2600000, 3400000],
  Lease:      [1200000, 2400000, 3600000, 5000000, 7500000, 9800000],
  Vendor:     [180000, 340000, 610000, 920000, 1450000, 2100000],
  MOA:        [400000, 820000, 1500000, 2600000, 4200000],
  License:    [320000, 660000, 1150000, 1900000, 2800000],
  Employment: [240000, 420000, 720000, 960000],
  Other:      [110000, 260000, 510000, 920000, 1550000, 2300000],
};

function seededValue(num, type) {
  const arr = VALUE_TABLE[type] || VALUE_TABLE.Other;
  return arr[num % arr.length];
}

function seededPriority(num) {
  const r = num % 20;
  if (r < 8)  return 'Low';
  if (r < 15) return 'Medium';
  if (r < 19) return 'High';
  return 'Critical';
}

// ── Path Parser ───────────────────────────────────────────────────────────────
function parseFilePath(filePath, sourceBase) {
  const rel   = path.relative(sourceBase, filePath);
  const parts = rel.split(path.sep);
  // [year, category, company, statusFolder, filename.docx]
  const [year, category, company, statusFolder, filename] = parts;

  const base    = filename.replace(/\.docx$/i, '');
  const dashIdx = base.indexOf(' - ');
  if (dashIdx === -1) return null;

  const contractId  = base.substring(0, dashIdx).trim();
  const rest        = base.substring(dashIdx + 3).trim();

  // Some filenames: "Title - Company_Underscored", others just "Title"
  let title     = rest;
  let partyName = company;
  const innerDash = rest.indexOf(' - ');
  if (innerDash > -1) {
    title     = rest.substring(0, innerDash).trim();
    partyName = rest.substring(innerDash + 3).replace(/_/g, ' ').trim();
  }

  const numMatch = contractId.match(/(\d+)$/);
  const seqNum   = numMatch ? parseInt(numMatch[1], 10) : 1;

  const yearInt    = parseInt(year, 10);
  const month      = ((seqNum - 1) % 11) + 1;
  const startDate  = new Date(yearInt, month - 1, 1);
  const endDate    = new Date(yearInt + 3, month - 1, 0);   // 3 years
  const renewalDate= new Date(yearInt + 2, month - 1, 1);
  const createdAt  = new Date(yearInt, Math.max(0, month - 2), 15);

  const folderStatus = STATUS_FROM_FOLDER[statusFolder] || 'DRAFT';
  let contractStatus;
  if (folderStatus === 'DRAFT') {
    contractStatus = 'Draft';
  } else if (folderStatus === 'FINAL') {
    contractStatus = 'Approved';
  } else {
    // Signed — check whether the contract has since expired
    contractStatus = endDate < TODAY ? 'Expired' : 'Active';
  }

  const contractType = contractTypeFromTitle(title);
  const department   = DEPT_MAP[category] || 'Operations';
  const value        = seededValue(seqNum, contractType);
  const priority     = seededPriority(seqNum);

  const docStatus = folderStatus === 'SIGNED' ? 'Signed'
                  : folderStatus === 'FINAL'   ? 'Approved'
                  : 'Draft';

  return {
    contractId,
    title: `${title} — ${partyName}`,
    type:          contractType,
    status:        contractStatus,
    description:   `${title} with ${partyName}. Managed under the ${category} portfolio.`,
    value,
    currency:      'ZAR',
    department,
    priority,
    parties: [{
      name:  partyName,
      role:  'vendor',
      type:  'external',
    }],
    startDate,
    endDate,
    expiryDate:  endDate,
    renewalDate,
    autoRenew:   seqNum % 6 === 0,
    tags:        [category.toLowerCase().replace(/ /g, '-'), year],
    createdAt,
    updatedAt:   new Date(Math.max(startDate.getTime(), createdAt.getTime())),
    // Doc metadata
    _srcPath:    filePath,
    _srcFilename:filename,
    _docStatus:  docStatus,
  };
}

// ── Collect all .docx files from both sources ─────────────────────────────────
function collectFiles(dir) {
  const results = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.docx')) results.push(full);
    }
  }
  walk(dir);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Ensure uploads dir exists
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // Find or create seed admin user
  let adminUser = await User.findOne({ role: 'admin' });
  if (!adminUser) {
    adminUser = await User.create({
      name:       'System Admin',
      email:      'admin@clm.internal',
      password:   'Admin1234!',
      role:       'admin',
      department: 'Legal',
      title:      'System Administrator',
      isActive:   true,
    });
    console.log('Created seed admin user: admin@clm.internal / Admin1234!');
  }

  // Parse all source contracts
  const parsed = [];
  for (const srcDir of SOURCE_DIRS) {
    if (!fs.existsSync(srcDir)) {
      console.warn(`Source dir not found, skipping: ${srcDir}`);
      continue;
    }
    for (const filePath of collectFiles(srcDir)) {
      const meta = parseFilePath(filePath, srcDir);
      if (meta) parsed.push(meta);
    }
  }
  console.log(`Parsed ${parsed.length} contracts from source folders`);

  // Load already-imported contractIds to support idempotent re-runs
  const existing = new Set(
    (await Contract.find({}, 'contractId').lean()).map(c => c.contractId)
  );

  let inserted = 0, skipped = 0;

  for (const meta of parsed) {
    if (existing.has(meta.contractId)) {
      skipped++;
      continue;
    }

    // Copy file to uploads with a UUID name
    const uploadName = `${uuidv4()}.docx`;
    const uploadPath = path.join(UPLOAD_DIR, uploadName);
    fs.copyFileSync(meta._srcPath, uploadPath);
    const fileSize = fs.statSync(uploadPath).size;

    // Insert Contract (use collection.insertOne so we control createdAt)
    const contractDoc = {
      _id:         new mongoose.Types.ObjectId(),
      contractId:  meta.contractId,
      title:       meta.title,
      type:        meta.type,
      status:      meta.status,
      description: meta.description,
      value:       meta.value,
      currency:    meta.currency,
      department:  meta.department,
      priority:    meta.priority,
      parties:     meta.parties,
      startDate:   meta.startDate,
      endDate:     meta.endDate,
      expiryDate:  meta.expiryDate,
      renewalDate: meta.renewalDate,
      autoRenew:   meta.autoRenew,
      tags:        meta.tags,
      createdBy:   adminUser._id,
      assignedTo:  [],
      approvers:   [],
      isLocked:    false,
      expiryAlertsSent: { thirtyDay: false, sevenDay: false, onDay: false },
      createdAt:   meta.createdAt,
      updatedAt:   meta.updatedAt,
    };
    await Contract.collection.insertOne(contractDoc);

    // Insert linked Document
    const docDoc = {
      _id:           new mongoose.Types.ObjectId(),
      name:          meta.title,
      originalName:  meta._srcFilename,
      filename:      uploadName,
      path:          `uploads/${uploadName}`,
      mimetype:      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size:          fileSize,
      type:          'docx',
      contract:      contractDoc._id,
      uploadedBy:    adminUser._id,
      status:        meta._docStatus,
      version:       1,
      isInLegalFolder: false,
      isLocked:      false,
      distributedTo: [],
      signers:       [],
      createdAt:     meta.createdAt,
      updatedAt:     meta.updatedAt,
    };
    await Document.collection.insertOne(docDoc);

    // Point the contract at its document
    await Contract.collection.updateOne(
      { _id: contractDoc._id },
      { $set: { legalFolderPath: `uploads/${uploadName}` } }
    );

    inserted++;
    process.stdout.write(`  ✓ ${meta.contractId}\n`);
  }

  console.log(`\nDone. Inserted: ${inserted} | Skipped (already exist): ${skipped}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

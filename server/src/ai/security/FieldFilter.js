const { redactSensitiveText } = require('./PromptSecurity');

const idText = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  return String(value);
};

const role = (user) => String(user?.role || '').toLowerCase();
const isAdminOrManager = (user) => ['admin', 'manager'].includes(role(user));

const SENSITIVE_KEY_RE = /(password|passwordhash|resettoken|verificationtoken|sessiontoken|jwt|apikey|api_key|secret|credential|authorization|cookie|privatekey|private_key|webhooksecret|webhook_secret|smtp|databaseuri|dburi|mongo_uri|mongodb_uri|token|tokenhash|signaturetoken|signingtoken|accesstoken|refreshtoken|authcodehash|authsessionhash|lockedpassword|signaturedata|initialsdata|evidence|devicefingerprint|fingerprint|certificatepath|certificatehash|certificatefingerprint|secureurl|signingurl|rawpayload)/i;
const PRIVATE_NOTE_RE = /(?:internalnotes?|managernotes?|risknotes?|legalrisknotes?|privilegedlegaladvice|privatecomments?|deleteddata|rawsnippet|fullprompt|ragsnippet)/i;

const normalizeRecord = (record) => {
  if (!record) return record;
  if (record instanceof Date) return record;
  if (typeof record.toObject === 'function') return record.toObject({ getters: false, virtuals: false });
  return record;
};

function redactSensitiveFields(value, options = {}) {
  const { user, resourceType, maxStringChars = 1000 } = options;
  if (value == null) return value;
  if (value instanceof Date) return value;
  if (typeof value === 'string') return redactSensitiveText(value, { maxChars: maxStringChars });
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return '[binary-redacted]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSensitiveFields(item, options));

  const record = normalizeRecord(value);
  const safe = {};
  for (const [key, raw] of Object.entries(record)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (PRIVATE_NOTE_RE.test(key) && !isAdminOrManager(user)) continue;
    if (String(resourceType || '').toLowerCase() === 'audit' && /prompt|snippet|payload|args|result/i.test(key)) continue;
    safe[key] = redactSensitiveFields(raw, options);
  }
  return safe;
}

const safeUserFields = (record, user, options = {}) => {
  const u = normalizeRecord(record) || {};
  const sameUser = idText(u) && idText(u) === idText(user);
  const includeEmail = options.includeEmail === true || isAdminOrManager(user) || sameUser;
  return {
    _id: idText(u),
    name: u.name || null,
    role: u.role || null,
    department: u.department || null,
    title: u.title || null,
    isActive: u.isActive !== undefined ? Boolean(u.isActive) : undefined,
    ...(includeEmail && u.email ? { email: u.email } : {}),
  };
};

const safeContractFields = (record, user) => {
  const c = normalizeRecord(record) || {};
  return {
    _id: idText(c),
    contractId: c.contractId,
    title: c.title,
    type: c.type,
    status: c.status,
    value: c.value,
    currency: c.currency,
    startDate: c.startDate,
    endDate: c.endDate,
    expiryDate: c.expiryDate,
    renewalDate: c.renewalDate,
    priority: c.priority,
    department: c.department,
    counterparty: c.counterparty || (c.parties || []).find((p) => p.type === 'external')?.name,
    parties: (c.parties || []).map((party) => ({
      name: party.name,
      role: party.role,
      type: party.type,
      signingOrder: party.signingOrder,
    })),
    createdBy: typeof c.createdBy === 'object' ? safeUserFields(c.createdBy, user) : c.createdBy,
    assignedTo: Array.isArray(c.assignedTo)
      ? c.assignedTo.map((assignee) => typeof assignee === 'object' ? safeUserFields(assignee, user) : assignee)
      : undefined,
  };
};

const safeDocumentFields = (record, user) => {
  const d = normalizeRecord(record) || {};
  return {
    _id: idText(d),
    name: d.name,
    originalName: d.originalName,
    type: d.type,
    status: d.status,
    version: d.version,
    size: d.size,
    documentStage: d.documentStage,
    contract: d.contract && typeof d.contract === 'object'
      ? { _id: idText(d.contract), title: d.contract.title, contractId: d.contract.contractId, status: d.contract.status }
      : d.contract,
    uploadedBy: d.uploadedBy && typeof d.uploadedBy === 'object' ? safeUserFields(d.uploadedBy, user) : d.uploadedBy,
    isLocked: Boolean(d.isLocked),
    signingOrder: d.signingOrder,
    signersCount: Array.isArray(d.signers) ? d.signers.length : d.signersCount,
    pendingSignatoriesCount: d.pendingSignatoriesCount,
    completedSignatoriesCount: d.completedSignatoriesCount,
    signedAt: d.signedAt,
    updatedAt: d.updatedAt,
  };
};

const safeTaskFields = (record, user) => {
  const t = normalizeRecord(record) || {};
  return {
    _id: idText(t),
    title: t.title,
    status: t.status,
    priority: t.priority,
    deadline: t.deadline,
    type: t.type,
    assignedTo: t.assignedTo && typeof t.assignedTo === 'object' ? safeUserFields(t.assignedTo, user) : t.assignedTo,
    assignedBy: t.assignedBy && typeof t.assignedBy === 'object' ? safeUserFields(t.assignedBy, user) : t.assignedBy,
	    contract: t.contract && typeof t.contract === 'object'
	      ? { _id: idText(t.contract), title: t.contract.title, contractId: t.contract.contractId }
	      : t.contract,
	    sourceType: t.sourceType,
	    trackerMeta: t.trackerMeta,
	  };
	};

const safeSignatureFields = (record, user) => {
  const s = normalizeRecord(record) || {};
  return {
    _id: idText(s),
    document: s.document,
    signerName: s.signerName || s.externalName || s.name,
    signerRole: s.signerRole || s.role,
    status: s.status || (s.signedAt ? 'SIGNED' : undefined),
    signed: Boolean(s.signedAt || s.signed),
    emailSentAt: s.emailSentAt || s.sentAt,
    viewedAt: s.viewedAt,
    signedAt: s.signedAt,
    declinedAt: s.declinedAt,
    lastReminderAt: s.lastReminderAt,
    ...(isAdminOrManager(user) && (s.signerEmail || s.externalEmail || s.email)
      ? { signerEmail: s.signerEmail || s.externalEmail || s.email }
      : {}),
  };
};

const safeAuditFields = (record, user) => {
  if (!isAdminOrManager(user)) return null;
  const log = normalizeRecord(record) || {};
  return {
    _id: idText(log),
    createdAt: log.createdAt,
    action: log.action,
    category: log.category,
    result: log.result,
    errorMessage: log.errorMessage,
    performedBy: log.performedBy && typeof log.performedBy === 'object' ? safeUserFields(log.performedBy, user) : log.performedBy,
    metadata: redactSensitiveFields(log.metadata, { user, resourceType: 'audit', maxStringChars: 300 }),
  };
};

module.exports = {
  redactSensitiveFields,
  safeAuditFields,
  safeContractFields,
  safeDocumentFields,
  safeSignatureFields,
  safeTaskFields,
  safeUserFields,
};

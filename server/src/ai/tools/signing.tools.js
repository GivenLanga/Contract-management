const Document  = require('../../models/Document');
const Signature = require('../../models/Signature');
const User      = require('../../models/User');
const { getClientSigningStateService } = require('../state/ClientSigningStateService');
const {
  documentVisibilityFilter,
  escapeRegExp,
  mergeFilters,
  safeRegExp,
} = require('../security/DataScope');

const PENDING_STATUS = 'Pending Signature';
const SIGNED_STATUS = 'Signed';
const parsedMaxSigningToolDocs = parseInt(process.env.AI_SIGNING_TOOL_MAX_DOCS || '500', 10);
const MAX_SIGNING_TOOL_DOCS = Number.isFinite(parsedMaxSigningToolDocs)
  ? Math.max(20, parsedMaxSigningToolDocs)
  : 500;

const clampLimit = (value, fallback = 10) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), 20);
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const idText = (value) => String(value?._id || value || '');
const emailRegex = (email) => new RegExp(`^${escapeRegExp(email)}$`, 'i');

const signedEmailsFor = (doc) =>
  new Set((doc.signatures || []).map((signature) => normalizeEmail(signature.signerEmail)).filter(Boolean));

const fieldIsComplete = (field, signedEmails) => {
  const assignedTo = normalizeEmail(field.assignedTo);
  return field.filled === true || Boolean(assignedTo && signedEmails.has(assignedTo));
};

const requiredFields = (doc) =>
  (doc.signingFields || []).filter((field) => field.required !== false);

const openRequiredFields = (doc) => {
  const signedEmails = signedEmailsFor(doc);
  return requiredFields(doc).filter((field) => !fieldIsComplete(field, signedEmails));
};

const signingProgress = (doc) => {
  const required = requiredFields(doc);
  const signedEmails = signedEmailsFor(doc);
  const completed = required.filter((field) => fieldIsComplete(field, signedEmails)).length;

  return {
    total: required.length,
    completed,
    pending: Math.max(required.length - completed, 0),
  };
};

const signerMatchesUser = (signer, context) => {
  const userId = idText(context.userId || context.user?._id);
  const currentEmail = normalizeEmail(context.user?.email);
  return Boolean(
    (userId && idText(signer.userId) === userId) ||
    (currentEmail && normalizeEmail(signer.email) === currentEmail)
  );
};

const documentNeedsCurrentUser = (doc, context) => {
  if (doc.status !== PENDING_STATUS) return false;

  const currentEmail = normalizeEmail(context.user?.email);
  const openFields = openRequiredFields(doc);
  if (openFields.length) {
    return openFields.some((field) => {
      const assignedTo = normalizeEmail(field.assignedTo);
      return !assignedTo || (currentEmail && assignedTo === currentEmail);
    });
  }

  const signedEmails = signedEmailsFor(doc);
  return (doc.signers || []).some((signer) =>
    signerMatchesUser(signer, context) && !signedEmails.has(normalizeEmail(signer.email))
  );
};

const isExternalEmail = (email, usersByEmail) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const user = usersByEmail.get(normalized);
  return !user || user.role === 'external';
};

const isExternalSigner = (signer, usersByEmail) => {
  if (String(signer.type || '').toLowerCase() === 'external') return true;
  const email = normalizeEmail(signer.email);
  const user = usersByEmail.get(email);
  if (user) return user.role === 'external';
  return Boolean(email && !signer.userId);
};

const documentNeedsExternalParty = (doc, usersByEmail) => {
  if (doc.status !== PENDING_STATUS) return false;

  const openFields = openRequiredFields(doc);
  if (openFields.length) {
    return openFields.some((field) => isExternalEmail(field.assignedTo, usersByEmail));
  }

  const signedEmails = signedEmailsFor(doc);
  return (doc.signers || []).some((signer) =>
    isExternalSigner(signer, usersByEmail) && !signedEmails.has(normalizeEmail(signer.email))
  );
};

const mapDocument = (doc) => {
  const progress = signingProgress(doc);
  return {
    _id: doc._id,
    source: doc.source,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    contract: doc.contract?.title,
    contractId: doc.contract?.contractId,
    uploadedBy: doc.uploadedBy?.name,
    updatedAt: doc.updatedAt,
    signingOrder: doc.signingOrder,
    signingProgress: progress,
    signers: (doc.signers || []).map((signer) => ({
      name: signer.name,
      email: signer.email,
      role: signer.role,
    })),
    pendingFields: openRequiredFields(doc).map((field) => ({
      assignedTo: field.assignedTo,
      role: field.role,
    })),
  };
};

const normalizeServerDoc = (doc, signatures) => ({
  _id: idText(doc._id),
  source: 'server',
  name: doc.name,
  type: doc.type,
  status: doc.status,
  contract: doc.contract
    ? { title: doc.contract.title, contractId: doc.contract.contractId }
    : null,
  uploadedBy: doc.uploadedBy
    ? { _id: idText(doc.uploadedBy._id), name: doc.uploadedBy.name, email: doc.uploadedBy.email }
    : null,
  updatedAt: doc.updatedAt,
  signingOrder: doc.signingOrder,
  signingFields: (doc.signingFields || []).map((field) => ({
    id: field.id,
    type: field.type,
    assignedTo: normalizeEmail(field.assignedTo),
    role: field.role,
    required: field.required !== false,
    filled: field.filled === true,
    filledBy: normalizeEmail(field.filledBy),
    filledAt: field.filledAt,
  })),
  signers: (doc.signers || []).map((signer) => ({
    email: normalizeEmail(signer.email),
    name: signer.name,
    role: signer.role,
    userId: idText(signer.userId),
  })),
  signatures: (signatures || []).map((signature) => ({
    signerEmail: normalizeEmail(signature.signerEmail),
    signerName: signature.signerName,
    signerRole: signature.signerRole,
    signedAt: signature.signedAt,
  })),
});

const normalizeClientDoc = (doc) => ({
  ...doc,
  _id: idText(doc._id),
  status: doc.status,
  signers: (doc.signers || []).map((signer) => ({
    ...signer,
    email: normalizeEmail(signer.email),
    userId: idText(signer.userId),
  })),
  signingFields: (doc.signingFields || []).map((field) => ({
    ...field,
    assignedTo: normalizeEmail(field.assignedTo),
    filledBy: normalizeEmail(field.filledBy),
  })),
  signatures: (doc.signatures || []).map((signature) => ({
    ...signature,
    signerEmail: normalizeEmail(signature.signerEmail),
  })),
});

const loadServerSigningDocs = async (context, statuses = [PENDING_STATUS]) => {
  const docs = await Document.find(mergeFilters(
    { status: { $in: statuses } },
    documentVisibilityFilter(context.user)
  ))
    .populate('uploadedBy', 'name email')
    .populate('contract', 'title contractId')
    .sort({ updatedAt: -1 })
    .limit(MAX_SIGNING_TOOL_DOCS)
    .lean();

  const docIds = docs.map((doc) => doc._id);
  const signatures = docIds.length
    ? await Signature.find({ document: { $in: docIds } })
      .select('document signerName signerEmail signerRole signedAt isValid')
      .lean()
    : [];

  const byDocument = new Map();
  for (const signature of signatures) {
    const key = idText(signature.document);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key).push(signature);
  }

  return docs.map((doc) => normalizeServerDoc(doc, byDocument.get(idText(doc._id)) || []));
};

const loadClientSigningDocs = (context) =>
  getClientSigningStateService()
    .getDocuments(context.userId)
    .map(normalizeClientDoc);

const loadSigningDocs = async (context, statuses = [PENDING_STATUS]) => {
  const serverDocs = await loadServerSigningDocs(context, statuses);
  const wantedStatuses = new Set(statuses);
  const clientDocs = loadClientSigningDocs(context)
    .filter((doc) => wantedStatuses.has(doc.status));

  const byId = new Map();
  for (const doc of [...serverDocs, ...clientDocs]) {
    byId.set(`${doc.source}:${doc._id}`, doc);
  }
  return Array.from(byId.values());
};

const loadUsersByEmail = async (docs) => {
  const emails = new Set();
  for (const doc of docs) {
    for (const signer of doc.signers || []) {
      const email = normalizeEmail(signer.email);
      if (email) emails.add(email);
    }
    for (const field of doc.signingFields || []) {
      const email = normalizeEmail(field.assignedTo);
      if (email) emails.add(email);
    }
  }
  if (!emails.size) return new Map();

  const users = await User.find({ email: { $in: Array.from(emails) } })
    .select('_id email role')
    .lean();

  return new Map(users.map((user) => [normalizeEmail(user.email), user]));
};

const resultForDocuments = (docs, { message, limit = 10, count = docs.length }) => ({
  type: 'success',
  data: {
    documents: docs.slice(0, limit).map(mapDocument),
    count,
    message,
  },
});

module.exports = [
  {
    name: 'list_pending_signatures',
    description: 'List documents currently in the signing platform waiting for at least one signature.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const limit = clampLimit(args.limit, 10);
      const docs = await loadSigningDocs(context, [PENDING_STATUS]);
      const count = docs.length;
      return resultForDocuments(docs, {
        limit,
        count,
        message: count === 0
          ? 'There are no documents in the signing platform waiting for signatures.'
          : `${count} document${count !== 1 ? 's are' : ' is'} in the signing platform waiting for signatures.`,
      });
    },
  },

  {
    name: 'count_documents_in_signing_platform',
    description: 'Count documents currently in the signing platform waiting for signatures.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const docs = await loadSigningDocs(context, [PENDING_STATUS]);
      const count = docs.length;
      return {
        type: 'success',
        data: {
          count,
          message: count === 0
            ? 'There are no documents currently in the signing platform.'
            : `${count} document${count !== 1 ? 's are' : ' is'} currently in the signing platform.`,
        },
      };
    },
  },

  {
    name: 'list_my_pending_signatures',
    description: 'List documents where the current user still needs to sign.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const limit = clampLimit(args.limit, 10);
      const docs = (await loadSigningDocs(context, [PENDING_STATUS]))
        .filter((doc) => documentNeedsCurrentUser(doc, context));
      const count = docs.length;
      return resultForDocuments(docs, {
        limit,
        count,
        message: count === 0
          ? 'No documents need your signature right now.'
          : `${count} document${count !== 1 ? 's need' : ' needs'} your signature.`,
      });
    },
  },

  {
    name: 'count_my_pending_signatures',
    description: 'Count documents where the current user still needs to sign.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const docs = (await loadSigningDocs(context, [PENDING_STATUS]))
        .filter((doc) => documentNeedsCurrentUser(doc, context));
      const count = docs.length;
      return {
        type: 'success',
        data: {
          count,
          message: count === 0
            ? 'No documents need your signature right now.'
            : `${count} document${count !== 1 ? 's need' : ' needs'} your signature.`,
        },
      };
    },
  },

  {
    name: 'list_external_party_pending_signatures',
    description: 'List documents waiting for at least one external party signature.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const limit = clampLimit(args.limit, 10);
      const allPending = await loadSigningDocs(context, [PENDING_STATUS]);
      const usersByEmail = await loadUsersByEmail(allPending);
      const docs = allPending.filter((doc) => documentNeedsExternalParty(doc, usersByEmail));
      const count = docs.length;
      return resultForDocuments(docs, {
        limit,
        count,
        message: count === 0
          ? 'No documents are waiting for an external party signature.'
          : `${count} document${count !== 1 ? 's are' : ' is'} waiting for an external party signature.`,
      });
    },
  },

  {
    name: 'count_external_party_pending_signatures',
    description: 'Count documents waiting for at least one external party signature.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const allPending = await loadSigningDocs(context, [PENDING_STATUS]);
      const usersByEmail = await loadUsersByEmail(allPending);
      const count = allPending.filter((doc) => documentNeedsExternalParty(doc, usersByEmail)).length;
      return {
        type: 'success',
        data: {
          count,
          message: count === 0
            ? 'No documents are waiting for an external party signature.'
            : `${count} document${count !== 1 ? 's are' : ' is'} waiting for an external party signature.`,
        },
      };
    },
  },

  {
    name: 'get_signing_status',
    description: 'Get the signing status and signer progress for a specific document.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    async execute(args, context) {
      const queryRegex = safeRegExp(args.query);
      const serverDoc = await Document.findOne(mergeFilters(
        { name: queryRegex },
        documentVisibilityFilter(context.user)
      ))
        .populate('uploadedBy', 'name email')
        .populate('contract', 'title contractId')
        .lean();

      let doc;
      if (serverDoc) {
        const signatures = await Signature.find({ document: serverDoc._id })
          .select('document signerName signerEmail signerRole signedAt isValid')
          .lean();
        doc = normalizeServerDoc(serverDoc, signatures);
      } else {
        const lowered = String(args.query || '').toLowerCase();
        doc = loadClientSigningDocs(context).find((candidate) =>
          String(candidate.name || '').toLowerCase().includes(lowered)
        );
      }

      if (!doc) return { type: 'not_found', message: `No signing document found for "${args.query}".` };

      const signedEmails = signedEmailsFor(doc);
      const signers = (doc.signers || []).map((signer) => {
        const email = normalizeEmail(signer.email);
        const signedAt = (doc.signatures || []).find((signature) => normalizeEmail(signature.signerEmail) === email)?.signedAt || null;
        return {
          name: signer.name,
          email,
          role: signer.role,
          signed: signedEmails.has(email),
          signedAt,
        };
      });
      const progress = signingProgress(doc);

      return {
        type: 'success',
        data: {
          name: doc.name,
          status: doc.status,
          contract: doc.contract?.title,
          signingOrder: doc.signingOrder,
          signers,
          totalSigners: signers.length || progress.total,
          completedSigners: signers.filter((signer) => signer.signed).length || progress.completed,
          signingProgress: progress,
          message: `${doc.name} is ${doc.status}. ${progress.completed}/${progress.total} required signing field${progress.total !== 1 ? 's' : ''} completed.`,
        },
      };
    },
  },

  {
    name: 'show_current_drafters',
    description: 'Show which users currently have documents in Draft or Under Review status, indicating who is actively drafting.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_args, context) {
      const docs = await Document.find(mergeFilters(
        { status: { $in: ['Draft', 'Under Review'] } },
        documentVisibilityFilter(context.user)
      ))
        .populate('uploadedBy', 'name email')
        .select('name status uploadedBy updatedAt')
        .sort({ updatedAt: -1 })
        .lean();

      const byUser = {};
      for (const d of docs) {
        const key = d.uploadedBy?._id?.toString() || 'unknown';
        if (!byUser[key]) {
          byUser[key] = { name: d.uploadedBy?.name || 'Unknown', documents: [] };
        }
        byUser[key].documents.push({ name: d.name, status: d.status });
      }

      return {
        type: 'success',
        data: {
          drafters: Object.values(byUser),
          totalDocuments: docs.length,
        },
      };
    },
  },

  {
    name: 'count_signed_documents',
    description: 'Count and list documents that have been fully signed.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const limit = clampLimit(args.limit, 10);
      const docs = await loadSigningDocs(context, [SIGNED_STATUS]);
      const count = docs.length;

      return resultForDocuments(docs, {
        limit,
        count,
        message: count === 0
          ? 'No documents have been fully signed yet.'
          : `${count} document${count !== 1 ? 's have' : ' has'} been signed.`,
      });
    },
  },

  {
    name: 'open_document_in_signing',
    description: 'Navigate the user to the signing view for a specific document by returning a navigation action.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    async execute(args, context) {
      const queryRegex = safeRegExp(args.query);
      const doc = await Document.findOne(mergeFilters(
        { name: queryRegex },
        documentVisibilityFilter(context.user)
      ))
        .select('_id name status')
        .lean();

      if (!doc) {
        const lowered = String(args.query || '').toLowerCase();
        const clientDoc = loadClientSigningDocs(context).find((candidate) =>
          String(candidate.name || '').toLowerCase().includes(lowered)
        );
        if (!clientDoc) return { type: 'not_found', message: `No signing document found for "${args.query}".` };
        return {
          type: 'navigation',
          data: {
            path: `/signing/view/${clientDoc._id}`,
            label: clientDoc.name,
            message: `Opening "${clientDoc.name}" in the signing platform.`,
          },
        };
      }

      return {
        type: 'navigation',
        data: {
          path: `/signing/view/${doc._id}`,
          label: doc.name,
          message: `Opening "${doc.name}" in the signing platform.`,
        },
      };
    },
  },
];

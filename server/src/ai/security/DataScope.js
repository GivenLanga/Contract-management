const NO_MATCH_FILTER = { _id: null };

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const userId = (user) => user?._id || null;

const userEmail = (user) => String(user?.email || '').trim().toLowerCase();

const isPrivilegedUser = (user) => ['admin', 'manager'].includes(user?.role);

const isObjectIdLike = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const mergeFilters = (...filters) => {
  const active = filters.filter((filter) => filter && Object.keys(filter).length > 0);
  if (active.length === 0) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
};

const contractVisibilityFilter = (user) => {
  if (isPrivilegedUser(user)) return {};

  const id = userId(user);
  const email = userEmail(user);
  const clauses = [];

  if (id) {
    clauses.push(
      { createdBy: id },
      { assignedTo: id },
      { 'approvers.user': id }
    );
  }
  if (email) clauses.push({ 'parties.email': new RegExp(`^${escapeRegExp(email)}$`, 'i') });

  return clauses.length ? { $or: clauses } : NO_MATCH_FILTER;
};

const documentVisibilityFilter = (user) => {
  if (isPrivilegedUser(user)) return {};

  const id = userId(user);
  const email = userEmail(user);
  const clauses = [];

  if (id) {
    clauses.push(
      { uploadedBy: id },
      { 'signers.userId': id },
      { lockedBy: id }
    );
  }
  if (email) {
    const emailRegex = new RegExp(`^${escapeRegExp(email)}$`, 'i');
    clauses.push(
      { 'signers.email': emailRegex },
      { 'distributedTo.email': emailRegex },
      { 'signingFields.assignedTo': emailRegex }
    );
  }

  return clauses.length ? { $or: clauses } : NO_MATCH_FILTER;
};

const taskVisibilityFilter = (user) => {
  if (isPrivilegedUser(user)) return {};

  const id = userId(user);
  return id ? { $or: [{ assignedTo: id }, { assignedBy: id }] } : NO_MATCH_FILTER;
};

const safeRegExp = (value, flags = 'i', maxChars = 200) => {
  const text = String(value || '').trim().slice(0, maxChars);
  return new RegExp(escapeRegExp(text), flags);
};

const safeWordsRegExp = (value, flags = 'i', maxChars = 200) => {
  const text = String(value || '').trim().slice(0, maxChars);
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 10)
    .map(escapeRegExp);

  return new RegExp(words.length ? words.join('|') : escapeRegExp(text), flags);
};

const legalRequestVisibilityFilter = (user) => {
  if (isPrivilegedUser(user)) return {};

  const id = userId(user);
  return id
    ? { $or: [{ assignedTo: id }, { submittedBy: id }] }
    : NO_MATCH_FILTER;
};

module.exports = {
  NO_MATCH_FILTER,
  contractVisibilityFilter,
  documentVisibilityFilter,
  escapeRegExp,
  isObjectIdLike,
  isPrivilegedUser,
  legalRequestVisibilityFilter,
  mergeFilters,
  safeRegExp,
  safeWordsRegExp,
  taskVisibilityFilter,
  userEmail,
  userId,
};

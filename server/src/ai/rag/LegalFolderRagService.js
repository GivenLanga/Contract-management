const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Document = require('../../models/Document');
const { documentVisibilityFilter, mergeFilters } = require('../security/DataScope');
const { sanitizeRetrievedSnippet } = require('../security/PromptSecurity');

const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const MAX_SYNC_DOCUMENTS = envInt('AI_RAG_MAX_SYNC_DOCUMENTS', 500, 1);
const MAX_SYNC_TEXT_CHARS = envInt('AI_RAG_MAX_SYNC_TEXT_CHARS', 60000, 1000);
const MAX_SYNC_TOTAL_CHARS = Math.max(MAX_SYNC_TEXT_CHARS, envInt('AI_RAG_MAX_SYNC_TOTAL_CHARS', 3000000, 1000));
const MAX_CHUNK_CHARS = envInt('AI_RAG_CHUNK_CHARS', 1400, 400);
const CHUNK_OVERLAP_CHARS = envInt('AI_RAG_CHUNK_OVERLAP_CHARS', 180, 0);
const MAX_CONTEXT_SNIPPETS = envInt('AI_RAG_MAX_CONTEXT_SNIPPETS', 6, 1);
const QUERY_HINT = /\b(legal folder|document|contract|agreement|clause|section|party|parties|termination|renewal|expiry|liability|confidential|payment|signed|signature|obligation|deliverable|scope)\b/i;

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const decodeXmlEntities = (value) =>
  String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

const normalizeText = (value) =>
  String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const tokenize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
  'who', 'why', 'how', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'you',
  'please', 'show', 'tell', 'about', 'into', 'onto', 'does', 'did', 'which',
]);

const fileExtension = (name = '') => path.extname(name).toLowerCase().replace('.', '');

const readUInt16 = (buffer, offset) => buffer.readUInt16LE(offset);
const readUInt32 = (buffer, offset) => buffer.readUInt32LE(offset);

const docxXmlToText = (xml) =>
  decodeXmlEntities(xml)
    .replace(/<w:tab\b[^>]*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const extractDocxText = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  const minEocd = 22;
  const maxComment = 65535;
  const start = Math.max(0, buffer.length - minEocd - maxComment);
  let eocdOffset = -1;

  for (let offset = buffer.length - minEocd; offset >= start; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) return '';

  const totalEntries = readUInt16(buffer, eocdOffset + 10);
  let cursor = readUInt32(buffer, eocdOffset + 16);

  for (let i = 0; i < totalEntries; i += 1) {
    if (readUInt32(buffer, cursor) !== 0x02014b50) break;

    const compression = readUInt16(buffer, cursor + 10);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const fileNameLength = readUInt16(buffer, cursor + 28);
    const extraLength = readUInt16(buffer, cursor + 30);
    const commentLength = readUInt16(buffer, cursor + 32);
    const localHeaderOffset = readUInt32(buffer, cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');

    if (name === 'word/document.xml' && readUInt32(buffer, localHeaderOffset) === 0x04034b50) {
      const localNameLength = readUInt16(buffer, localHeaderOffset + 26);
      const localExtraLength = readUInt16(buffer, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      const content = compression === 0 ? compressed : zlib.inflateRawSync(compressed);
      return docxXmlToText(content.toString('utf8'));
    }

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return '';
};

const stripRtf = (text) =>
  String(text || '')
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/\\[a-z]+-?\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

class LegalFolderRagService {
  constructor() {
    this._userIndexes = new Map();
    this._fileTextCache = new Map();
  }

  syncLegalFolder({ userId, source, documents }) {
    const safeUserId = String(userId || 'anonymous');
    const limitedDocs = Array.isArray(documents) ? documents.slice(0, MAX_SYNC_DOCUMENTS) : [];
    const chunks = [];
    let consumedChars = 0;
    let truncated = false;
    let indexedDocuments = 0;

    for (const doc of limitedDocs) {
      if (consumedChars >= MAX_SYNC_TOTAL_CHARS) {
        truncated = true;
        break;
      }

      const remaining = MAX_SYNC_TOTAL_CHARS - consumedChars;
      const textLimit = Math.min(MAX_SYNC_TEXT_CHARS, remaining);
      const text = normalizeText(String(doc.textContent || '').slice(0, textLimit));
      const metadataText = normalizeText([
        doc.name,
        doc.contractTitle,
        doc.status,
        doc.type,
        doc.sourcePath,
        doc.company,
        doc.year,
      ].filter(Boolean).join('\n'));

      const content = text || metadataText;
      if (!content) continue;
      consumedChars += content.length;
      if (content.length >= remaining) truncated = true;
      indexedDocuments += 1;

      chunks.push(...this._chunkDocument({
        id: String(doc.id || doc._id || doc.sourcePath || doc.name),
        name: String(doc.name || 'Legal Folder document'),
        sourcePath: String(doc.sourcePath || ''),
        type: String(doc.type || ''),
        status: String(doc.status || ''),
        contractTitle: String(doc.contractTitle || doc.contract?.title || ''),
        source: 'browser-legal-folder',
        content,
      }));
    }

    this._userIndexes.set(safeUserId, {
      source: source || null,
      chunks,
      documentCount: indexedDocuments,
      syncedAt: new Date(),
    });

    return {
      indexedDocuments,
      indexedChunks: chunks.length,
      sourceName: source?.name || null,
      truncated,
    };
  }

  getStatus(userId) {
    const index = this._userIndexes.get(String(userId || 'anonymous'));
    return {
      indexed: Boolean(index),
      source: index?.source || null,
      indexedDocuments: index?.documentCount || 0,
      indexedChunks: index?.chunks?.length || 0,
      syncedAt: index?.syncedAt || null,
    };
  }

  shouldRetrieve(query) {
    return QUERY_HINT.test(query);
  }

  async getCounts(user) {
    const status = this.getStatus(user?._id);
    let serverDocuments = 0;

    try {
      if (Document.db.readyState === 1) {
        serverDocuments = await Document.countDocuments(this._legalFolderFilterForUser(user));
      }
    } catch (err) {
      console.warn(`[AI RAG] Legal Folder count skipped: ${err.message}`);
    }

    return {
      syncedDocuments: status.indexedDocuments,
      indexedChunks: status.indexedChunks,
      serverDocuments,
      syncedAt: status.syncedAt,
      source: status.source,
    };
  }

  async retrieve({ user, query }) {
    const userId = String(user?._id || 'anonymous');
    const tokens = tokenize(query);
    if (tokens.length === 0) return null;

    const memoryChunks = this._userIndexes.get(userId)?.chunks || [];
    let dbChunks = [];
    try {
      dbChunks = await this._retrieveDatabaseChunks(query, tokens, user);
    } catch (err) {
      console.warn(`[AI RAG] Database retrieval skipped: ${err.message}`);
    }
    const scored = [...memoryChunks, ...dbChunks]
      .map((chunk) => ({ ...chunk, score: this._scoreChunk(chunk, query, tokens) }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CONTEXT_SNIPPETS);

    if (!scored.length) return null;
    if (scored[0].score < 2 && !QUERY_HINT.test(query)) return null;

    return {
      snippets: scored.map((chunk, index) => ({
        id: `LF${index + 1}`,
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        sourcePath: chunk.sourcePath,
        contractTitle: chunk.contractTitle,
        snippet: chunk.text,
        securityFlags: chunk.securityFlags || [],
      })),
    };
  }

  formatContext(retrieval) {
    if (!retrieval?.snippets?.length) return '';

    return retrieval.snippets.map((item) => [
      `[${item.id}] Document: ${item.documentName}`,
      item.contractTitle ? `Contract: ${item.contractTitle}` : null,
      item.sourcePath ? `Source path: ${item.sourcePath}` : null,
      item.securityFlags?.length ? `Security note: prompt-like instructions were detected in this excerpt and removed before prompting. Flags: ${item.securityFlags.join(', ')}` : null,
      `Excerpt: ${item.snippet}`,
    ].filter(Boolean).join('\n')).join('\n\n');
  }

  _legalFolderFilterForUser(user) {
    return mergeFilters({ isInLegalFolder: true }, documentVisibilityFilter(user));
  }

  async _retrieveDatabaseChunks(query, tokens, user) {
    if (Document.db.readyState !== 1) return [];

    const regex = tokens.length
      ? new RegExp(tokens.slice(0, 8).map(escapeRegExp).join('|'), 'i')
      : null;

    const filter = this._legalFolderFilterForUser(user);
    if (regex) {
      filter.$or = [
        { name: regex },
        { originalName: regex },
        { description: regex },
        { tags: { $in: tokens } },
        { legalFolderPath: regex },
      ];
    }

    let docs = await Document.find(filter)
      .populate('contract', 'title contractId')
      .sort({ updatedAt: -1 })
      .limit(6)
      .lean();

    if (!docs.length && QUERY_HINT.test(query)) {
      docs = await Document.find(this._legalFolderFilterForUser(user))
        .populate('contract', 'title contractId')
        .sort({ updatedAt: -1 })
        .limit(6)
        .lean();
    }

    const chunks = [];
    for (const doc of docs) {
      const text = await this._getServerDocumentText(doc);
      const metadata = normalizeText([
        doc.name,
        doc.originalName,
        doc.description,
        doc.status,
        doc.tags?.join(' '),
        doc.contract?.title,
        doc.legalFolderPath,
      ].filter(Boolean).join('\n'));
      chunks.push(...this._chunkDocument({
        id: String(doc._id),
        name: doc.name,
        sourcePath: doc.legalFolderPath || doc.originalName || doc.name || '',
        type: doc.type,
        status: doc.status,
        contractTitle: doc.contract?.title || '',
        source: 'server-legal-folder',
        content: text || metadata,
      }));
    }

    return chunks;
  }

  async _getServerDocumentText(doc) {
    if (!doc?.path || !fs.existsSync(doc.path)) return '';

    let stat;
    try {
      stat = fs.statSync(doc.path);
    } catch {
      return '';
    }

    const cacheKey = `${doc.path}:${stat.size}:${stat.mtimeMs}`;
    if (this._fileTextCache.has(cacheKey)) return this._fileTextCache.get(cacheKey);

    let text = '';
    const ext = fileExtension(doc.path || doc.originalName || doc.name);

    try {
      if (['txt', 'md', 'csv', 'json'].includes(ext)) {
        text = fs.readFileSync(doc.path, 'utf8');
      } else if (ext === 'rtf') {
        text = stripRtf(fs.readFileSync(doc.path, 'utf8'));
      } else if (['docx', 'doc'].includes(ext)) {
        text = extractDocxText(doc.path);
      } else if (ext === 'pdf') {
        text = await this._extractPdfText(doc.path);
      }
    } catch (err) {
      console.warn(`[AI RAG] Could not extract text for document ${doc._id}: ${err.message}`);
    }

    text = normalizeText(text).slice(0, MAX_SYNC_TEXT_CHARS);
    this._fileTextCache.set(cacheKey, text);
    return text;
  }

  async _extractPdfText(filePath) {
    let PDFParse;
    try {
      ({ PDFParse } = require('pdf-parse'));
    } catch {
      return '';
    }

    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    try {
      const data = await parser.getText();
      return data.text || '';
    } finally {
      await parser.destroy();
    }
  }

  _chunkDocument(doc) {
    const clean = normalizeText(doc.content);
    if (!clean) return [];

    const chunks = [];
    let cursor = 0;
    while (cursor < clean.length) {
      const end = Math.min(clean.length, cursor + MAX_CHUNK_CHARS);
      const { text, securityFlags } = sanitizeRetrievedSnippet(clean.slice(cursor, end).trim(), {
        maxChars: MAX_CHUNK_CHARS,
      });
      if (text) {
        chunks.push({
          documentId: doc.id,
          documentName: doc.name,
          sourcePath: doc.sourcePath,
          type: doc.type,
          status: doc.status,
          contractTitle: doc.contractTitle,
          source: doc.source,
          text,
          securityFlags,
        });
      }
      if (end >= clean.length) break;
      cursor = Math.max(end - CHUNK_OVERLAP_CHARS, cursor + 1);
    }

    return chunks;
  }

  _scoreChunk(chunk, query, tokens) {
    const haystack = `${chunk.documentName} ${chunk.contractTitle} ${chunk.sourcePath} ${chunk.text}`.toLowerCase();
    const uniqueTokens = [...new Set(tokens)];
    let score = 0;

    for (const token of uniqueTokens) {
      if (haystack.includes(token)) score += token.length > 5 ? 2 : 1;
    }

    const quotedPhrases = String(query).match(/"([^"]+)"/g) || [];
    for (const phrase of quotedPhrases) {
      const clean = phrase.replace(/"/g, '').toLowerCase();
      if (clean && haystack.includes(clean)) score += 6;
    }

    if (chunk.sourcePath && haystack.includes(String(query).toLowerCase())) score += 4;
    if (QUERY_HINT.test(query)) score += 1;

    return score;
  }
}

let instance;
const getLegalFolderRagService = () => {
  if (!instance) instance = new LegalFolderRagService();
  return instance;
};

module.exports = { LegalFolderRagService, getLegalFolderRagService };

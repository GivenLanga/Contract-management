'use strict';

const fs = require('fs');
const path = require('path');
const {
  classifyLegalFolderPath,
  isSupportedLifecycleFile,
  normalizeRelativePath,
  shouldIgnoreLegalFolderPath,
} = require('./legalFolderClassifier');
const { extractContractMetadataFromFile } = require('./contractMetadataExtractor');
const { LegalFolderLifecycleIndex } = require('./legalFolderLifecycleIndex');

function toPosixRelative(rootPath, absolutePath, pathModule = path) {
  return normalizeRelativePath(pathModule.relative(rootPath, absolutePath));
}

function extensionWithoutDot(fileName) {
  return path.posix.extname(fileName).replace(/^\./, '').toLowerCase();
}

function shouldLogDiagnostics() {
  return process.env.NODE_ENV === 'development' || process.env.CONTRACTIQ_LIFECYCLE_DEBUG === '1';
}

function pathSegments(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function hasSignedLikePath(relativePath) {
  return /\b(signed|executed|completed|sign)\b/i.test(String(relativePath || '').replace(/[_-]/g, ' '));
}

function lifecycleClassifierResult(file) {
  return {
    lifecycleStage: file.lifecycleStage || 'UNKNOWN',
    reason: file.reason || null,
    matchedSegment: file.matchedSegment || null,
    confidence: file.confidence || null,
  };
}

function notificationForLifecycleEvent(eventType, file) {
  if (!file) return null;
  if (eventType === 'add' && file.lifecycleStage === 'TEMPLATE') {
    return { level: 'info', message: `New template detected: ${file.fileName}` };
  }
  if (eventType === 'change' && file.lifecycleStage === 'DRAFT') {
    return { level: 'info', message: `Draft updated: ${file.fileName}` };
  }
  if (eventType === 'add' && file.lifecycleStage === 'FINAL') {
    return { level: 'info', message: `Final contract detected: ${file.fileName}. Ready for signing.` };
  }
  if (eventType === 'add' && file.lifecycleStage === 'SIGNED') {
    return { level: 'info', message: `Signed contract detected: ${file.fileName}` };
  }
  return null;
}

async function statFile(fsModule, absolutePath) {
  const stat = await fsModule.promises.stat(absolutePath);
  if (!stat.isFile()) return null;
  return stat;
}

async function buildFileMetadata(absolutePath, options = {}) {
  const {
    rootPath,
    sourceId = 'legal-folder',
    fsModule = fs,
    pathModule = path,
    now = () => new Date(),
  } = options;
  if (!rootPath) throw new Error('rootPath is required to build lifecycle metadata.');

  const relativePath = toPosixRelative(rootPath, absolutePath, pathModule);
  if (!relativePath || shouldIgnoreLegalFolderPath(relativePath) || !isSupportedLifecycleFile(relativePath)) {
    return null;
  }

  const stat = await statFile(fsModule, absolutePath);
  if (!stat) return null;

  const fileName = path.posix.basename(relativePath);
  const classification = classifyLegalFolderPath(relativePath);
  const timestamp = now().toISOString();
  const contractMetadata = classification.lifecycleStage === 'SIGNED'
    ? await extractContractMetadataFromFile(absolutePath, { fsModule, pathModule })
    : {};
  const agreementFamily = classification.agreementFamily && classification.agreementFamily !== 'OTHER'
    ? classification.agreementFamily
    : contractMetadata.agreementFamily || classification.agreementFamily || 'OTHER';

  return {
    sourceId,
    fileName,
    relativePath,
    displayPath: relativePath,
    extension: extensionWithoutDot(fileName),
    fileSize: stat.size || 0,
    lastModified: stat.mtime ? stat.mtime.toISOString() : timestamp,
    ...classification,
    ...contractMetadata,
    counterparty: classification.counterparty || contractMetadata.counterparty || null,
    agreementFamily,
    detectedAt: timestamp,
    updatedAt: timestamp,
    missingFromDisk: false,
  };
}

async function scanLegalFolder(rootPath, options = {}) {
  const {
    fsModule = fs,
    pathModule = path,
    sourceId = 'legal-folder',
    logger = console,
  } = options;
  const root = pathModule.resolve(rootPath);
  const files = [];
  let skipped = 0;

  async function walk(absoluteDir, relativeDir = '') {
    let entries;
    try {
      entries = await fsModule.promises.readdir(absoluteDir, { withFileTypes: true });
    } catch (err) {
      logger.warn?.('[legalFolderLifecycleWatcher] scan directory failed', {
        relativeDir,
        code: err?.code || null,
        message: err?.message || String(err),
      });
      skipped += 1;
      return;
    }

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      if (shouldIgnoreLegalFolderPath(relativePath)) {
        skipped += 1;
        continue;
      }

      const absolutePath = pathModule.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      if (!isSupportedLifecycleFile(relativePath)) {
        skipped += 1;
        continue;
      }

      try {
        const metadata = await buildFileMetadata(absolutePath, {
          rootPath: root,
          sourceId,
          fsModule,
          pathModule,
        });
        if (metadata) files.push(metadata);
        else skipped += 1;
      } catch (err) {
        logger.warn?.('[legalFolderLifecycleWatcher] scan file failed', {
          relativePath,
          code: err?.code || null,
          message: err?.message || String(err),
        });
        skipped += 1;
      }
    }
  }

  await walk(root);
  const summary = files.reduce((acc, file) => {
    const stage = String(file.lifecycleStage || 'UNKNOWN').toLowerCase();
    if (stage === 'template') acc.templates += 1;
    else if (stage === 'draft') acc.drafts += 1;
    else if (stage === 'final') acc.finals += 1;
    else if (stage === 'signed') acc.signed += 1;
    else acc.unknown += 1;
    return acc;
  }, { templates: 0, drafts: 0, finals: 0, signed: 0, unknown: 0, scanned: files.length, skipped });
  summary.scanned = files.length;
  summary.skipped = skipped;

  if (shouldLogDiagnostics()) {
    const unknownSamples = files
      .filter((file) => file.lifecycleStage === 'UNKNOWN')
      .slice(0, 10)
      .map((file) => ({
        fileName: file.fileName,
        relativePath: file.relativePath,
        pathSegments: pathSegments(file.relativePath),
        classifierResult: lifecycleClassifierResult(file),
      }));
    const signedLikePaths = files
      .filter((file) => hasSignedLikePath(file.relativePath))
      .map((file) => ({
        relativePath: file.relativePath,
        segments: pathSegments(file.relativePath),
        lifecycleStage: file.lifecycleStage,
        reason: file.reason || null,
        matchedSegment: file.matchedSegment || null,
      }));

    logger.info?.('[legalFolderLifecycleWatcher] scan stage counts', {
      scanned: summary.scanned,
      template: summary.templates,
      draft: summary.drafts,
      final: summary.finals,
      signed: summary.signed,
      unknown: summary.unknown,
    });
    logger.info?.('[legalFolderLifecycleWatcher] unknown samples', unknownSamples);
    logger.info?.('[legalFolderLifecycleWatcher] signed-like path diagnostics', signedLikePaths);
  }

  return { files, summary };
}

async function applyLifecycleEvent(index, event, options = {}) {
  const {
    rootPath,
    sourceId = event.sourceId || 'legal-folder',
    fsModule = fs,
    pathModule = path,
    logger = console,
    live = true,
  } = options;
  const eventType = event.eventType || event.type;
  const relativePath = normalizeRelativePath(event.relativePath ||
    (event.absolutePath && rootPath ? toPosixRelative(rootPath, event.absolutePath, pathModule) : ''));

  logger.info?.('[legalFolderLifecycleWatcher] event received', { eventType, relativePath });

  if (eventType === 'unlink') {
    const removed = index.removeFileMetadata(relativePath, sourceId);
    return { action: 'remove', relativePath, removed, notification: null };
  }

  const metadata = event.metadata || await buildFileMetadata(event.absolutePath, {
    rootPath,
    sourceId,
    fsModule,
    pathModule,
  });
  if (!metadata) {
    logger.info?.('[legalFolderLifecycleWatcher] event skipped', { eventType, relativePath });
    return { action: 'skip', relativePath, notification: null };
  }

  const file = index.upsertFileMetadata(metadata);
  const notification = live ? notificationForLifecycleEvent(eventType, file) : null;
  return { action: 'upsert', file, notification };
}

class LegalFolderLifecycleWatcher {
  constructor(options = {}) {
    this.rootPath = options.rootPath;
    this.sourceId = options.sourceId || 'legal-folder';
    this.index = options.index || new LegalFolderLifecycleIndex();
    this.fsModule = options.fsModule || fs;
    this.pathModule = options.pathModule || path;
    this.logger = options.logger || console;
    this.onUpdate = options.onUpdate || (() => {});
    this.onNotification = options.onNotification || (() => {});
    this.debounceMs = options.debounceMs || 500;
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    this.watcher = null;
    this.pollTimer = null;
    this.pendingEvents = new Map();
  }

  async start() {
    this.stop();
    const initial = await this.fullScan({ notify: false });
    const chokidar = this.tryLoadChokidar();
    if (chokidar) this.startChokidar(chokidar);
    else this.startPolling();
    return initial;
  }

  stop() {
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.pendingEvents.values()) clearTimeout(timer);
    this.pendingEvents.clear();
  }

  async fullScan({ notify = false } = {}) {
    const result = await scanLegalFolder(this.rootPath, {
      fsModule: this.fsModule,
      pathModule: this.pathModule,
      sourceId: this.sourceId,
      logger: this.logger,
    });
    this.index.replaceSourceFiles(this.sourceId, result.files);
    const payload = this.payload({ eventType: 'scan', summary: result.summary, live: notify });
    this.onUpdate(payload);
    return payload;
  }

  payload(extra = {}) {
    const indexPayload = this.index.toJSON(this.sourceId);
    return {
      ok: true,
      sourceId: this.sourceId,
      rootName: this.rootPath ? this.pathModule.basename(this.rootPath) : null,
      files: indexPayload.files,
      summary: {
        ...indexPayload.summary,
        ...(extra.summary || {}),
      },
      eventType: extra.eventType || null,
      notification: extra.notification || null,
      live: Boolean(extra.live),
    };
  }

  tryLoadChokidar() {
    try {
      return require('chokidar');
    } catch {
      this.logger.info?.('[legalFolderLifecycleWatcher] chokidar unavailable; using polling scanner');
      return null;
    }
  }

  startChokidar(chokidar) {
    this.logger.info?.('[legalFolderLifecycleWatcher] starting chokidar watcher', {
      rootName: this.rootPath ? this.pathModule.basename(this.rootPath) : null,
    });
    this.watcher = chokidar.watch(this.rootPath, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
      ignored: (candidate) => {
        if (!candidate || candidate === this.rootPath) return false;
        const relativePath = toPosixRelative(this.rootPath, candidate, this.pathModule);
        return shouldIgnoreLegalFolderPath(relativePath);
      },
    });
    ['add', 'change', 'unlink'].forEach((eventType) => {
      this.watcher.on(eventType, (absolutePath) => this.queueEvent(eventType, absolutePath));
    });
    this.watcher.on('addDir', (absolutePath) => {
      this.logger.info?.('[legalFolderLifecycleWatcher] directory added', {
        relativePath: toPosixRelative(this.rootPath, absolutePath, this.pathModule),
      });
    });
    this.watcher.on('unlinkDir', (absolutePath) => {
      this.logger.info?.('[legalFolderLifecycleWatcher] directory removed', {
        relativePath: toPosixRelative(this.rootPath, absolutePath, this.pathModule),
      });
      this.queueScan();
    });
    this.watcher.on('error', (err) => {
      this.logger.warn?.('[legalFolderLifecycleWatcher] chokidar error', {
        code: err?.code || null,
        message: err?.message || String(err),
      });
    });
  }

  startPolling() {
    this.logger.info?.('[legalFolderLifecycleWatcher] starting polling watcher', {
      intervalMs: this.pollIntervalMs,
    });
    this.pollTimer = setInterval(() => {
      this.fullScan({ notify: false }).catch((err) => {
        this.logger.warn?.('[legalFolderLifecycleWatcher] polling scan failed', {
          code: err?.code || null,
          message: err?.message || String(err),
        });
      });
    }, this.pollIntervalMs);
  }

  queueScan() {
    if (this.pendingEvents.has('__scan__')) clearTimeout(this.pendingEvents.get('__scan__'));
    this.pendingEvents.set('__scan__', setTimeout(() => {
      this.pendingEvents.delete('__scan__');
      this.fullScan({ notify: false }).catch(() => {});
    }, this.debounceMs));
  }

  queueEvent(eventType, absolutePath) {
    const relativePath = toPosixRelative(this.rootPath, absolutePath, this.pathModule);
    const key = `${eventType}:${relativePath}`;
    if (this.pendingEvents.has(key)) clearTimeout(this.pendingEvents.get(key));
    this.pendingEvents.set(key, setTimeout(async () => {
      this.pendingEvents.delete(key);
      const result = await applyLifecycleEvent(this.index, {
        eventType,
        absolutePath,
        relativePath,
        sourceId: this.sourceId,
      }, {
        rootPath: this.rootPath,
        sourceId: this.sourceId,
        fsModule: this.fsModule,
        pathModule: this.pathModule,
        logger: this.logger,
        live: true,
      });
      const payload = this.payload({
        eventType,
        notification: result.notification,
        live: true,
      });
      this.onUpdate(payload);
      if (result.notification) this.onNotification(result.notification);
    }, this.debounceMs));
  }
}

module.exports = {
  LegalFolderLifecycleWatcher,
  scanLegalFolder,
  buildFileMetadata,
  applyLifecycleEvent,
  notificationForLifecycleEvent,
};

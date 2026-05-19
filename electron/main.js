'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  getSafeLegalFolderMetadata,
  openDraftWithDesktopStrategy,
} = require('./openDraftCore');
const {
  readLegalFolderFileFromRoot,
  safeReadLegalFolderFilePayload,
} = require('./readLegalFolderFileCore');
const { LegalFolderLifecycleIndex } = require('./services/legalFolderLifecycleIndex');
const { LegalFolderLifecycleWatcher } = require('./services/legalFolderLifecycleWatcher');
const trackerService = require('./services/legalTrackerWorkbookService');

const isDev = process.env.NODE_ENV === 'development';

// Main-process Legal Folder root path. It is persisted locally, used for
// desktop file operations, and never exposed to React except as dev-only debug.
let legalFolderRoot = null;

// Legal Tracker state — never expose absolutePath to renderer
let trackerAbsolutePath = null;
let trackerColumnMapping = {};
let trackerFileWatcher   = null;
let trackerDebounceTimer = null;

// Top-level reference prevents GC before the window finishes loading.
let mainWindow = null;
let lifecycleIndex = new LegalFolderLifecycleIndex();
let lifecycleWatcher = null;

const PRELOAD_PATH = path.join(__dirname, 'preload.js');

function getDesktopConfigPath() {
  return path.join(app.getPath('userData'), 'contractiq-desktop-config.json');
}

function getLifecycleIndexPath() {
  return path.join(app.getPath('userData'), 'contractiq-legal-folder-index.json');
}

function loadDesktopConfig() {
  try {
    const configPath = getDesktopConfigPath();
    if (!fs.existsSync(configPath)) {
      console.info('[electron] desktop config not found', { configPath });
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof parsed.legalFolderRoot === 'string' && parsed.legalFolderRoot) {
      legalFolderRoot = path.resolve(parsed.legalFolderRoot);
    }
    console.info('[electron] desktop config loaded', {
      hasLegalFolderRoot: Boolean(legalFolderRoot),
      rootName: legalFolderRoot ? path.basename(legalFolderRoot) : null,
      configPath,
    });
  } catch (err) {
    console.warn('[electron] desktop config load failed', {
      code: err?.code || null,
      message: err?.message || String(err),
    });
  }
}

function loadLifecycleIndex() {
  try {
    const indexPath = getLifecycleIndexPath();
    if (!fs.existsSync(indexPath)) {
      console.info('[electron:lifecycle] local index not found', { indexPath });
      lifecycleIndex = new LegalFolderLifecycleIndex();
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    lifecycleIndex = new LegalFolderLifecycleIndex(Array.isArray(parsed.files) ? parsed.files : []);
    console.info('[electron:lifecycle] local index loaded', {
      indexPath,
      fileCount: lifecycleIndex.getAllFiles().length,
    });
  } catch (err) {
    lifecycleIndex = new LegalFolderLifecycleIndex();
    console.warn('[electron:lifecycle] local index load failed', {
      code: err?.code || null,
      message: err?.message || String(err),
    });
  }
}

function saveLifecycleIndex() {
  try {
    const indexPath = getLifecycleIndexPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(lifecycleIndex.toJSON(), null, 2), 'utf8');
    console.info('[electron:lifecycle] local index saved', {
      indexPath,
      fileCount: lifecycleIndex.getAllFiles().length,
    });
  } catch (err) {
    console.warn('[electron:lifecycle] local index save failed', {
      code: err?.code || null,
      message: err?.message || String(err),
    });
  }
}

function saveDesktopConfig() {
  try {
    const configPath = getDesktopConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ legalFolderRoot }, null, 2),
      'utf8'
    );
    console.info('[electron] desktop config saved', {
      hasLegalFolderRoot: Boolean(legalFolderRoot),
      rootName: legalFolderRoot ? path.basename(legalFolderRoot) : null,
      configPath,
    });
  } catch (err) {
    console.warn('[electron] desktop config save failed', {
      code: err?.code || null,
      message: err?.message || String(err),
    });
  }
}

function legalFolderStatusPayload() {
  return getSafeLegalFolderMetadata(legalFolderRoot, {
    includeDebugRoot: isDev,
    pathModule: path,
  });
}

function lifecycleStatusPayload(extra = {}) {
  const status = legalFolderStatusPayload();
  const scopedIndex = status.sourceId ? lifecycleIndex.toJSON(status.sourceId) : { files: [], summary: lifecycleIndex.summary() };
  return {
    ok: true,
    ...status,
    name: status.rootName,
    files: scopedIndex.files,
    summary: scopedIndex.summary,
    eventType: extra.eventType || null,
    notification: extra.notification || null,
    live: Boolean(extra.live),
  };
}

function hasSignedLikePath(record) {
  return /\b(signed|executed|completed|sign)\b/i.test(
    String(record?.relativePath || record?.displayPath || record?.fileName || '').replace(/[_-]/g, ' ')
  );
}

function lifecycleIpcDiagnostics(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const signed = files.filter((file) => file.lifecycleStage === 'SIGNED');
  const unknown = files.filter((file) => file.lifecycleStage === 'UNKNOWN');
  return {
    totalFiles: files.length,
    signedCount: signed.length,
    unknownCount: unknown.length,
    sampleSigned: signed.slice(0, 5).map((file) => ({
      fileName: file.fileName,
      relativePath: file.relativePath,
      lifecycleStage: file.lifecycleStage,
      reason: file.reason || null,
      matchedSegment: file.matchedSegment || null,
    })),
    sampleUnknown: unknown.slice(0, 5).map((file) => ({
      fileName: file.fileName,
      relativePath: file.relativePath,
      lifecycleStage: file.lifecycleStage,
      reason: file.reason || null,
      matchedSegment: file.matchedSegment || null,
    })),
    signedLikeUnknown: unknown
      .filter(hasSignedLikePath)
      .slice(0, 10)
      .map((file) => ({
        fileName: file.fileName,
        relativePath: file.relativePath,
        lifecycleStage: file.lifecycleStage,
        reason: file.reason || null,
        matchedSegment: file.matchedSegment || null,
      })),
  };
}

function emitLifecycleUpdate(payload) {
  const safePayload = payload || lifecycleStatusPayload();
  console.info('[electron:lifecycle] update', {
    eventType: safePayload.eventType,
    live: safePayload.live,
    summary: safePayload.summary,
    notification: safePayload.notification || null,
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:lifecycleUpdated', safePayload);
  }
}

async function startLegalFolderLifecycleWatcher(reason = 'startup') {
  if (!legalFolderRoot) {
    console.info('[electron:lifecycle] watcher not started; no Legal Folder root', { reason });
    return lifecycleStatusPayload();
  }

  const status = legalFolderStatusPayload();
  const sourceId = status.sourceId;
  if (lifecycleWatcher) {
    lifecycleWatcher.stop();
    lifecycleWatcher = null;
  }

  lifecycleWatcher = new LegalFolderLifecycleWatcher({
    rootPath: legalFolderRoot,
    sourceId,
    index: lifecycleIndex,
    fsModule: fs,
    pathModule: path,
    logger: console,
    onUpdate: (payload) => {
      const merged = {
        ...lifecycleStatusPayload(payload),
        files: payload.files,
        summary: payload.summary,
        eventType: payload.eventType,
        notification: payload.notification,
        live: payload.live,
      };
      saveLifecycleIndex();
      emitLifecycleUpdate(merged);
    },
    onNotification: (notification) => {
      console.info('[electron:lifecycle] notification', notification);
    },
  });

  console.info('[electron:lifecycle] starting watcher', {
    reason,
    sourceId,
    rootName: path.basename(legalFolderRoot),
  });
  return lifecycleWatcher.start();
}

function stopLegalFolderLifecycleWatcher() {
  if (lifecycleWatcher) {
    lifecycleWatcher.stop();
    lifecycleWatcher = null;
  }
}

function safeOpenDraftPayload(payload = {}) {
  return {
    relativePath: payload.relativePath,
    legalFolderSourceId: payload.legalFolderSourceId,
    preferredApp: payload.preferredApp,
    hasNativePath: typeof payload.nativePath === 'string' && payload.nativePath.length > 0,
    nativePath: payload.nativePath,
  };
}

function createWindow() {
  if (isDev) {
    console.log('[electron] preload path:', PRELOAD_PATH);
    console.log('[electron] preload exists:', fs.existsSync(PRELOAD_PATH));
    console.log('[electron] isDev:', isDev, '  NODE_ENV:', process.env.NODE_ENV);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'ContractIQ',
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox:true requires kernel user-namespaces / seccomp-bpf on Linux.
      // Keeping it false here; nodeIntegration:false + contextIsolation:true
      // provide the essential isolation guarantees without kernel dependencies.
      sandbox: false,
    },
  });

  // ── Debug event listeners (active in all modes) ───────────────────────────

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[electron] did-fail-load', { code, desc, url });
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[electron] render-process-gone', details);
  });

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const label = ['verbose', 'info', 'warning', 'error'][level] ?? level;
    console.log(`[renderer:${label}] ${message}  (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[electron] did-finish-load — page loaded successfully');
  });

  // ── Load URL / file ───────────────────────────────────────────────────────

  if (isDev) {
    const devURL = process.env.ELECTRON_DEV_URL || 'http://localhost:5174';
    console.log('[electron] loading dev URL:', devURL);
    mainWindow.loadURL(devURL);
    mainWindow.webContents.openDevTools();
  } else {
    const prodFile = path.join(__dirname, '../dist/index.html');
    console.log('[electron] loading prod file:', prodFile);
    mainWindow.loadFile(prodFile);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  loadDesktopConfig();
  loadLifecycleIndex();
  loadTrackerConfig();
  createWindow();
  if (trackerAbsolutePath) startTrackerWatcher();
  startLegalFolderLifecycleWatcher('app_ready').catch((err) => {
    console.warn('[electron:lifecycle] startup scan failed', {
      code: err?.code || null,
      message: err?.message || String(err),
    });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// TODO: Add a Content-Security-Policy header via session.defaultSession.webRequest
// or a <meta http-equiv="Content-Security-Policy"> in index.html to suppress the
// CSP warning shown in DevTools. The warning does not cause a blank page and is
// safe to address as a follow-up.

app.on('window-all-closed', () => {
  stopLegalFolderLifecycleWatcher();
  stopTrackerWatcher();
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: desktop status ───────────────────────────────────────────────────────

ipcMain.handle('desktop:getStatus', () => {
  const status = {
    ...legalFolderStatusPayload(),
    isDesktop: true,
    platform: process.platform,
    hasLegalFolder: legalFolderRoot !== null,
    legalFolderName: legalFolderRoot ? path.basename(legalFolderRoot) : null,
  };
  console.info('[electron] desktop:getStatus', status);
  return status;
});

ipcMain.handle('desktop:getLegalFolderStatus', () => {
  const status = legalFolderStatusPayload();
  console.info('[electron] desktop:getLegalFolderStatus', status);
  return status;
});

// ── IPC: choose legal folder ──────────────────────────────────────────────────

ipcMain.handle('desktop:chooseLegalFolder', async (event) => {
  console.info('[electron] desktop:chooseLegalFolder called');
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Legal Folder',
  });
  if (result.canceled || !result.filePaths.length) {
    const cancelled = {
      ok: false,
      code: 'SELECTION_CANCELLED',
      message: 'Legal Folder selection was cancelled.',
    };
    console.info('[electron] desktop:chooseLegalFolder result', cancelled);
    return cancelled;
  }
  legalFolderRoot = path.resolve(result.filePaths[0]);
  saveDesktopConfig();
  const lifecycle = await startLegalFolderLifecycleWatcher('chooseLegalFolder');
  const status = legalFolderStatusPayload();
  const response = {
    ...status,
    name: status.rootName,
    lifecycleSummary: lifecycle.summary,
  };
  console.info('[electron] desktop:chooseLegalFolder result', response);
  return response;
});

// ── IPC: get legal folder root ────────────────────────────────────────────────

ipcMain.handle('desktop:getLegalFolderRoot', () => {
  const status = legalFolderStatusPayload();
  const response = {
    ...status,
    name: status.rootName,
  };
  console.info('[electron] desktop:getLegalFolderRoot', response);
  return response;
});

// ── IPC: read a file inside the selected Legal Folder ────────────────────────

ipcMain.handle('desktop:readLegalFolderFile', async (_event, payload = {}) => {
  console.info('[electron:readLegalFolderFile] payload received', safeReadLegalFolderFilePayload(payload));
  const result = await readLegalFolderFileFromRoot(payload, {
    legalFolderRoot,
    fsModule: fs,
    pathModule: path,
    logger: console,
  });
  console.info('[electron:readLegalFolderFile] result', {
    ok: result?.ok,
    code: result?.code || null,
    fileName: result?.fileName || null,
    extension: result?.extension || null,
    relativePath: result?.relativePath || payload?.relativePath || null,
    bytes: result?.arrayBuffer?.byteLength || null,
  });
  return result;
});

// ── IPC: Legal Folder lifecycle index ────────────────────────────────────────

ipcMain.handle('desktop:getLifecycleIndex', () => {
  const response = lifecycleStatusPayload();
  console.info('[electron:lifecycle] desktop:getLifecycleIndex', {
    hasRoot: response.hasRoot,
    rootName: response.rootName,
    summary: response.summary,
  });
  if (isDev) {
    console.info('[electron:lifecycle] desktop:getLifecycleIndex diagnostics', lifecycleIpcDiagnostics(response));
  }
  return response;
});

ipcMain.handle('desktop:rescanLegalFolderLifecycle', async () => {
  console.info('[electron:lifecycle] desktop:rescanLegalFolderLifecycle called');
  if (!legalFolderRoot) {
    const response = lifecycleStatusPayload({
      eventType: 'scan',
      notification: null,
      live: false,
    });
    console.info('[electron:lifecycle] rescan skipped; no root', response.summary);
    return response;
  }
  if (!lifecycleWatcher) {
    return startLegalFolderLifecycleWatcher('manual_rescan');
  }
  const payload = await lifecycleWatcher.fullScan({ notify: false });
  return {
    ...lifecycleStatusPayload(payload),
    files: payload.files,
    summary: payload.summary,
    eventType: payload.eventType,
    live: payload.live,
  };
});

ipcMain.handle('desktop:disconnectLegalFolder', () => {
  console.info('[electron:lifecycle] desktop:disconnectLegalFolder called');
  const previousStatus = legalFolderStatusPayload();
  stopLegalFolderLifecycleWatcher();
  if (previousStatus.sourceId) lifecycleIndex.clearIndexForSource(previousStatus.sourceId);
  else lifecycleIndex.clearIndexForSource();
  legalFolderRoot = null;
  saveDesktopConfig();
  saveLifecycleIndex();
  const response = lifecycleStatusPayload({
    eventType: 'disconnect',
    notification: null,
    live: true,
  });
  emitLifecycleUpdate(response);
  return {
    ...response,
    message: 'Legal Folder disconnected locally. Files on disk were not changed.',
  };
});

// ── IPC: open draft ───────────────────────────────────────────────────────────
//
// Priority for resolving the file on disk:
//   1. legalFolderRoot + relativePath, owned by Electron
//   2. nativePath fallback only when no Electron root has been chosen
//   3. Neither available → LEGAL_FOLDER_ROOT_NOT_SET

ipcMain.handle('desktop:openDraft', async (_event, payload = {}) => {
  console.info('[electron:openDraft] handler called');
  console.info('[electron:openDraft] payload received', safeOpenDraftPayload(payload));

  return openDraftWithDesktopStrategy(payload, {
    legalFolderRoot,
    platform: process.platform,
    fsModule: fs,
    pathModule: path,
    spawnDetached,
    shellOpenPath: (absolutePath) => shell.openPath(absolutePath),
    logger: console,
  });
});

// ── Legal Tracker config helpers ──────────────────────────────────────────────

function getTrackerConfigPath() {
  return path.join(app.getPath('userData'), 'contractiq-tracker-config.json');
}

function loadTrackerConfig() {
  try {
    const p = getTrackerConfigPath();
    if (!fs.existsSync(p)) return;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof parsed.absolutePath === 'string' && parsed.absolutePath.endsWith('.xlsx')) {
      trackerAbsolutePath  = path.resolve(parsed.absolutePath);
      trackerColumnMapping = parsed.columnMapping || {};
      console.info('[tracker] config loaded', { hasPath: true, name: path.basename(trackerAbsolutePath) });
    }
  } catch (err) {
    console.warn('[tracker] config load failed', err.message);
  }
}

function saveTrackerConfig() {
  try {
    const p = getTrackerConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      absolutePath:  trackerAbsolutePath,
      columnMapping: trackerColumnMapping,
    }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[tracker] config save failed', err.message);
  }
}

function clearTrackerConfig() {
  trackerAbsolutePath  = null;
  trackerColumnMapping = {};
  try { fs.unlinkSync(getTrackerConfigPath()); } catch {}
}

function safeTrackerStatus() {
  if (!trackerAbsolutePath) return { connected: false };
  const exists = fs.existsSync(trackerAbsolutePath);
  return {
    connected:    true,
    workbookName: path.basename(trackerAbsolutePath, '.xlsx'),
    watchStatus:  exists ? (trackerFileWatcher ? 'watching' : 'needs_resync') : 'missing_file',
    absolutePath: isDev ? trackerAbsolutePath : undefined,
  };
}

function startTrackerWatcher() {
  stopTrackerWatcher();
  if (!trackerAbsolutePath || !fs.existsSync(trackerAbsolutePath)) return;

  try {
    trackerFileWatcher = fs.watch(trackerAbsolutePath, (eventType) => {
      if (eventType !== 'change') return;
      clearTimeout(trackerDebounceTimer);
      trackerDebounceTimer = setTimeout(async () => {
        console.info('[tracker] file changed externally — re-importing');
        const result = await trackerService.readWorkbook(trackerAbsolutePath);
        if (result.ok) {
          trackerColumnMapping = result.columnMapping;
          saveTrackerConfig();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tracker:fileChanged', {
              ok:           true,
              workbookName: result.workbookName,
              sheetName:    result.sheetName,
              tasks:        result.tasks,
              rowsImported: result.rowsImported,
              warnings:     result.warnings,
              lastSyncedAt: result.lastSyncedAt,
            });
          }
        }
      }, 800);
    });
    console.info('[tracker] watcher started', { name: path.basename(trackerAbsolutePath) });
  } catch (err) {
    console.warn('[tracker] watcher start failed', err.message);
  }
}

function stopTrackerWatcher() {
  clearTimeout(trackerDebounceTimer);
  if (trackerFileWatcher) {
    try { trackerFileWatcher.close(); } catch {}
    trackerFileWatcher = null;
  }
}

// ── Legal Tracker IPC handlers ────────────────────────────────────────────────

ipcMain.handle('tracker:getStatus', () => safeTrackerStatus());

ipcMain.handle('tracker:chooseFile', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title:   'Select Legal Tracker Spreadsheet',
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, code: 'CANCELLED' };
  }
  const filePath = path.resolve(result.filePaths[0]);
  const parsed   = await trackerService.readWorkbook(filePath);
  if (!parsed.ok) return parsed;

  trackerAbsolutePath  = filePath;
  trackerColumnMapping = parsed.columnMapping;
  saveTrackerConfig();
  startTrackerWatcher();

  return {
    ok:           true,
    workbookName: parsed.workbookName,
    sheetName:    parsed.sheetName,
    tasks:        parsed.tasks,
    rowsImported: parsed.rowsImported,
    warnings:     parsed.warnings,
    lastSyncedAt: parsed.lastSyncedAt,
    watchStatus:  'watching',
    absolutePath: isDev ? filePath : undefined,
  };
});

ipcMain.handle('tracker:syncTracker', async () => {
  if (!trackerAbsolutePath) {
    return { ok: false, code: 'NO_TRACKER', message: 'No Legal Tracker connected.' };
  }
  const result = await trackerService.readWorkbook(trackerAbsolutePath);
  if (result.ok) {
    trackerColumnMapping = result.columnMapping;
    saveTrackerConfig();
    startTrackerWatcher(); // restart watcher if it died
  }
  return result.ok ? {
    ok:           true,
    workbookName: result.workbookName,
    sheetName:    result.sheetName,
    tasks:        result.tasks,
    rowsImported: result.rowsImported,
    warnings:     result.warnings,
    lastSyncedAt: result.lastSyncedAt,
    watchStatus:  trackerFileWatcher ? 'watching' : 'needs_resync',
  } : result;
});

ipcMain.handle('tracker:updateRow', async (_event, { rowNumber, fieldUpdates }) => {
  if (!trackerAbsolutePath) {
    return { ok: false, code: 'NO_TRACKER' };
  }
  return trackerService.updateRow(trackerAbsolutePath, {
    rowNumber,
    fieldUpdates,
    columnMapping: trackerColumnMapping,
  });
});

ipcMain.handle('tracker:readRow', async (_event, { rowNumber }) => {
  if (!trackerAbsolutePath) return { ok: false, code: 'NO_TRACKER' };
  const result = await trackerService.readWorkbook(trackerAbsolutePath);
  if (!result.ok) return result;
  const row = (result.tasks || []).find(t => t.rowNumber === rowNumber);
  return row ? { ok: true, row } : { ok: false, code: 'ROW_NOT_FOUND' };
});

ipcMain.handle('tracker:openFile', async () => {
  if (!trackerAbsolutePath || !fs.existsSync(trackerAbsolutePath)) {
    return { ok: false, code: 'FILE_NOT_FOUND' };
  }
  const err = await shell.openPath(trackerAbsolutePath);
  return err ? { ok: false, message: err } : { ok: true };
});

ipcMain.handle('tracker:disconnectTracker', () => {
  stopTrackerWatcher();
  clearTrackerConfig();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tracker:fileChanged', { ok: false, code: 'DISCONNECTED' });
  }
  return { ok: true };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Spawn a detached child process with an argument array (no shell interpolation).
// Resolves when the process successfully starts; rejects on ENOENT / EACCES.
function spawnDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false });
    let settled = false;

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch {}
      fn(val);
    }

    child.once('error', (err) => settle(reject, err));
    child.once('spawn', () => settle(resolve, undefined));

    // Fallback for Node versions that don't emit 'spawn': treat absence of error
    // within 400 ms as a successful start.
    setTimeout(() => settle(resolve, undefined), 400);
  });
}

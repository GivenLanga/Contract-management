'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  getSafeLegalFolderMetadata,
  openDraftWithDesktopStrategy,
} = require('./openDraftCore');

const isDev = process.env.NODE_ENV === 'development';

// Main-process Legal Folder root path. It is persisted locally, used for
// desktop file operations, and never exposed to React except as dev-only debug.
let legalFolderRoot = null;

// Top-level reference prevents GC before the window finishes loading.
let mainWindow = null;

const PRELOAD_PATH = path.join(__dirname, 'preload.js');

function getDesktopConfigPath() {
  return path.join(app.getPath('userData'), 'contractiq-desktop-config.json');
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
    const devURL = 'http://localhost:5173';
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// TODO: Add a Content-Security-Policy header via session.defaultSession.webRequest
// or a <meta http-equiv="Content-Security-Policy"> in index.html to suppress the
// CSP warning shown in DevTools. The warning does not cause a blank page and is
// safe to address as a follow-up.

app.on('window-all-closed', () => {
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
  const status = legalFolderStatusPayload();
  const response = {
    ...status,
    name: status.rootName,
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

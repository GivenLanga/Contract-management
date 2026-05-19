'use strict';

const { contextBridge, ipcRenderer } = require('electron');

console.info('[contractiq preload] preload loaded');

function safeOpenDraftPayload(args = {}) {
  return {
    relativePath: args.relativePath,
    legalFolderSourceId: args.legalFolderSourceId,
    preferredApp: args.preferredApp,
    hasNativePath: typeof args.nativePath === 'string' && args.nativePath.length > 0,
    nativePath: args.nativePath,
  };
}

function safeReadLegalFolderFilePayload(args = {}) {
  return {
    relativePath: args.relativePath,
  };
}

contextBridge.exposeInMainWorld('contractiq', {
  isDesktop: true,
  getDesktopStatus: async () => {
    console.info('[contractiq preload] getDesktopStatus called from renderer');
    const result = await ipcRenderer.invoke('desktop:getStatus');
    console.info('[contractiq preload] getDesktopStatus result', result);
    return result;
  },
  getLegalFolderStatus: async () => {
    console.info('[contractiq preload] getLegalFolderStatus called from renderer');
    const result = await ipcRenderer.invoke('desktop:getLegalFolderStatus');
    console.info('[contractiq preload] getLegalFolderStatus result', result);
    return result;
  },
  chooseLegalFolder: async () => {
    console.info('[contractiq preload] chooseLegalFolder called from renderer');
    const result = await ipcRenderer.invoke('desktop:chooseLegalFolder');
    console.info('[contractiq preload] chooseLegalFolder result', result);
    return result;
  },
  getLegalFolderRoot: async () => {
    console.info('[contractiq preload] getLegalFolderRoot called from renderer');
    const result = await ipcRenderer.invoke('desktop:getLegalFolderRoot');
    console.info('[contractiq preload] getLegalFolderRoot result', result);
    return result;
  },
  readLegalFolderFile: async (args) => {
    console.info('[contractiq preload] readLegalFolderFile called from renderer');
    console.info('[contractiq preload] readLegalFolderFile payload', safeReadLegalFolderFilePayload(args));
    const result = await ipcRenderer.invoke('desktop:readLegalFolderFile', args);
    console.info('[contractiq preload] readLegalFolderFile result', {
      ok: result?.ok,
      code: result?.code || null,
      fileName: result?.fileName || null,
      extension: result?.extension || null,
      relativePath: result?.relativePath || args?.relativePath || null,
      bytes: result?.arrayBuffer?.byteLength || null,
    });
    return result;
  },
  getLifecycleIndex: async () => {
    console.info('[contractiq preload] getLifecycleIndex called from renderer');
    const result = await ipcRenderer.invoke('desktop:getLifecycleIndex');
    console.info('[contractiq preload] getLifecycleIndex result', {
      ok: result?.ok,
      hasRoot: result?.hasRoot,
      rootName: result?.rootName,
      summary: result?.summary,
    });
    return result;
  },
  rescanLegalFolderLifecycle: async () => {
    console.info('[contractiq preload] rescanLegalFolderLifecycle called from renderer');
    const result = await ipcRenderer.invoke('desktop:rescanLegalFolderLifecycle');
    console.info('[contractiq preload] rescanLegalFolderLifecycle result', {
      ok: result?.ok,
      summary: result?.summary,
    });
    return result;
  },
  disconnectLegalFolder: async () => {
    console.info('[contractiq preload] disconnectLegalFolder called from renderer');
    const result = await ipcRenderer.invoke('desktop:disconnectLegalFolder');
    console.info('[contractiq preload] disconnectLegalFolder result', {
      ok: result?.ok,
      summary: result?.summary,
      message: result?.message,
    });
    return result;
  },
  onLifecycleUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      console.info('[contractiq preload] lifecycle update received', {
        ok: payload?.ok,
        eventType: payload?.eventType,
        summary: payload?.summary,
        notification: payload?.notification || null,
      });
      callback(payload);
    };
    ipcRenderer.on('desktop:lifecycleUpdated', listener);
    return () => ipcRenderer.removeListener('desktop:lifecycleUpdated', listener);
  },
  openDraft: async (args) => {
    console.info('[contractiq preload] openDraft called from renderer');
    console.info('[contractiq preload] openDraft payload', safeOpenDraftPayload(args));
    const result = await ipcRenderer.invoke('desktop:openDraft', args);
    console.info('[contractiq preload] openDraft result', result);
    return result;
  },

  // ── Legal Tracker ───────────────────────────────────────────────────────────
  trackerGetStatus: async () => {
    return ipcRenderer.invoke('tracker:getStatus');
  },
  trackerChooseFile: async () => {
    console.info('[contractiq preload] trackerChooseFile called');
    return ipcRenderer.invoke('tracker:chooseFile');
  },
  trackerSync: async () => {
    console.info('[contractiq preload] trackerSync called');
    return ipcRenderer.invoke('tracker:syncTracker');
  },
  trackerUpdateRow: async (args) => {
    return ipcRenderer.invoke('tracker:updateRow', args);
  },
  trackerReadRow: async (args) => {
    return ipcRenderer.invoke('tracker:readRow', args);
  },
  trackerOpenFile: async () => {
    return ipcRenderer.invoke('tracker:openFile');
  },
  trackerDisconnect: async () => {
    console.info('[contractiq preload] trackerDisconnect called');
    return ipcRenderer.invoke('tracker:disconnectTracker');
  },
  onTrackerFileChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      console.info('[contractiq preload] tracker:fileChanged received', {
        ok: payload?.ok,
        code: payload?.code,
        rowsImported: payload?.rowsImported,
      });
      callback(payload);
    };
    ipcRenderer.on('tracker:fileChanged', listener);
    return () => ipcRenderer.removeListener('tracker:fileChanged', listener);
  },
});

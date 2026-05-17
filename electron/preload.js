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
  openDraft: async (args) => {
    console.info('[contractiq preload] openDraft called from renderer');
    console.info('[contractiq preload] openDraft payload', safeOpenDraftPayload(args));
    const result = await ipcRenderer.invoke('desktop:openDraft', args);
    console.info('[contractiq preload] openDraft result', result);
    return result;
  },
});

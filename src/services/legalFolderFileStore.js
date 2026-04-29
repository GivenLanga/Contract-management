const DB_NAME = 'clm_legal_folder_file_cache';
const DB_VERSION = 1;
const STORE_NAME = 'files';
const DOCX_PREVIEW_TYPES = new Set(['docx']);

const openDb = () =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser file storage is not available.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'docId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open file cache.'));
  });

const transactionDone = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('File cache transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('File cache transaction aborted.'));
  });

const sourcePathOf = (entry) => entry.relativePath || entry.name;

export const replaceLegalFolderFiles = async (documents, entries) => {
  const db = await openDb();
  const documentByPath = new Map((documents || []).map((doc) => [doc.sourcePath, doc]));
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);

  store.clear();

  let stored = 0;
  for (const entry of entries || []) {
    const doc = documentByPath.get(sourcePathOf(entry));
    if (!doc || !entry.file) continue;

    store.put({
      docId: doc._id,
      name: doc.name,
      type: doc.type,
      mimeType: entry.file.type || '',
      size: entry.file.size || doc.size || 0,
      sourcePath: doc.sourcePath,
      updatedAt: doc.updatedAt,
      blob: entry.file,
      textContent: entry.textContent || '',
    });
    stored += 1;
  }

  await transactionDone(transaction);
  db.close();
  return { stored };
};

export const getLegalFolderFile = async (docId) => {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);

  const record = await new Promise((resolve, reject) => {
    const request = store.get(docId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read cached file.'));
  });

  db.close();
  return record;
};

export const canRenderDocxPreview = (record) =>
  DOCX_PREVIEW_TYPES.has(String(record?.type || '').toLowerCase());

export const clearLegalFolderFiles = async () => {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
  db.close();
};

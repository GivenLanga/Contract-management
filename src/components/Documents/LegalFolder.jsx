import { useState, useRef, useEffect } from 'react';
import {
  buildLegalFolderImport,
  clearLegalFolderImport,
  collectFilesFromDirectoryHandle,
  enrichLegalFolderEntries,
  entriesFromFileList,
  getLegalFolderImport,
  saveLegalFolderImport,
} from '../../services/legalFolderStore';
import { clearLegalFolderFiles, replaceLegalFolderFiles } from '../../services/legalFolderFileStore';
import { syncLegalFolderRagIndex } from '../../services/legalFolderRagSync';
import { templates as templatesApi } from '../../services/api';
import {
  setLegalFolderHandle,
  clearLegalFolderHandle,
  saveHandleToIndexedDB,
  clearHandleFromIndexedDB,
} from '../../services/legalFolderHandle';
import { getLegalFolderStatus, FOLDER_STATE } from '../../services/legalFolderAccess';
import './LegalFolder.css';

export default function LegalFolder() {
  const initialSnapshot = getLegalFolderImport();
  const folderInputRef = useRef(null);
  const [docs, setDocs] = useState(initialSnapshot.documents || []);
  const [total, setTotal] = useState(initialSnapshot.documents?.length || 0);
  const [importing, setImporting] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [disconnectMsg, setDisconnectMsg] = useState('');
  const [source, setSource] = useState(initialSnapshot.source || null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [writeStatus, setWriteStatus] = useState(null);

  // Check write access status on mount and whenever the source changes
  useEffect(() => {
    let cancelled = false;
    getLegalFolderStatus().then((s) => {
      if (!cancelled) setWriteStatus(s);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [source]);

  const applySnapshot = (snapshot) => {
    setDocs(snapshot.documents || []);
    setTotal(snapshot.documents?.length || 0);
    setSource(snapshot.source || null);
  };

  const syncEntries = async (entries, sourceName) => {
    const enrichedEntries = await enrichLegalFolderEntries(entries);
    const snapshot = buildLegalFolderImport(enrichedEntries, sourceName);
    const fileCache = await replaceLegalFolderFiles(snapshot.documents, enrichedEntries);
    const snapshotWithCache = {
      ...snapshot,
      source: {
        ...snapshot.source,
        fileCacheCount: fileCache.stored,
      },
    };
    saveLegalFolderImport(snapshotWithCache);
    applySnapshot(snapshotWithCache);
    syncLegalFolderRagIndex().catch(() => {});
    setSyncError('');
  };

  const handleChooseFolder = async () => {
    setImporting(true);
    setSyncError('');

    try {
      if ('showDirectoryPicker' in window) {
        // readwrite mode enables draft write-back into the connected Legal Folder
        const directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        setLegalFolderHandle(directoryHandle);
        // Persist the handle so drafts can be saved after page reload
        await saveHandleToIndexedDB(directoryHandle);
        const entries = await collectFilesFromDirectoryHandle(directoryHandle);
        await syncEntries(entries, directoryHandle.name);
      } else {
        folderInputRef.current?.click();
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setSyncError(error?.name === 'QuotaExceededError'
          ? 'The folder is too large for browser file preview storage. Try a smaller shared folder.'
          : 'Could not read that folder. Please choose a folder you can access.');
      }
    } finally {
      setImporting(false);
    }
  };

  const handleFolderInput = async (event) => {
    const entries = entriesFromFileList(event.target.files);
    const firstPath = entries[0]?.relativePath || '';
    const sourceName = firstPath.split('/')[0] || 'Shared Folder';

    setImporting(true);
    setSyncError('');

    try {
      if (entries.length) {
        // File input path — no directory handle available (browser limitation)
        // Index is built but write-back will require re-authorization
        await syncEntries(entries, sourceName);
      }
    } catch (error) {
      setSyncError(error?.name === 'QuotaExceededError'
        ? 'The folder is too large for browser file preview storage. Try a smaller shared folder.'
        : 'Could not read that folder. Please choose a folder you can access.');
    } finally {
      event.target.value = '';
      setImporting(false);
    }
  };

  const handleDisconnect = async () => {
    const sourceId = source?.name || null;

    clearLegalFolderImport();
    clearLegalFolderHandle();
    clearHandleFromIndexedDB().catch(() => {});
    clearLegalFolderFiles().catch(() => {});
    setDocs([]);
    setTotal(0);
    setSource(null);
    setWriteStatus(null);
    setSyncError('');
    setDisconnectMsg('');

    if (sourceId) {
      try {
        await templatesApi.disconnectSource(sourceId);
        setDisconnectMsg('Legal Folder disconnected. Discovered templates from this folder were removed.');
      } catch {
        setDisconnectMsg('Legal Folder disconnected locally, but server cleanup failed. Retry template cleanup.');
      }
    } else {
      setDisconnectMsg('Legal Folder disconnected.');
    }
  };

  const filtered = docs.filter((d) => {
    const matchesSearch = !search || d.name.toLowerCase().includes(search.toLowerCase());
    const matchesType = !typeFilter || d.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const grouped = filtered.reduce((acc, doc) => {
    const fullTitle = doc.contract?.title || 'Uncategorized';
    const group = fullTitle.split(' - ')[0].trim() || 'Uncategorized';
    if (!acc[group]) acc[group] = [];
    acc[group].push(doc);
    return acc;
  }, {});

  const sizeLabel = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const writeStatusLabel = () => {
    if (!writeStatus || !source) return null;
    switch (writeStatus.state) {
      case FOLDER_STATE.WRITE_READY:
        return { text: 'Read/write access active', color: '#166534' };
      case FOLDER_STATE.WRITE_REAUTH_REQUIRED:
        return { text: 'Write access not granted — re-authorize to save drafts', color: '#92400e' };
      case FOLDER_STATE.UNSUPPORTED_BROWSER:
        return { text: 'Indexed for viewing only — browser does not support direct folder write access', color: '#92400e' };
      default:
        return null;
    }
  };

  const wsLabel = writeStatusLabel();

  return (
    <div className="legal-folder">
      <div className="legal-folder-header">
        <div className="legal-folder-title">
          <span className="legal-folder-icon">⚖</span>
          <div>
            <h1>Legal Folder</h1>
            <p>
              {source
                ? `${total} document${total !== 1 ? 's' : ''} synced from ${source.name}`
                : 'Connect a shared departmental folder to populate contracts'}
            </p>
          </div>
        </div>
        <div className="legal-folder-actions">
          <button
            className="legal-folder-btn legal-folder-btn--primary"
            onClick={handleChooseFolder}
            disabled={importing}
          >
            {importing ? 'Syncing...' : source ? 'Sync Shared Folder' : 'Choose Shared Folder'}
          </button>
          {source && (
            <button className="legal-folder-btn legal-folder-btn--secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
          <input
            ref={folderInputRef}
            className="legal-folder-input"
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            onChange={handleFolderInput}
          />
        </div>
      </div>

      {disconnectMsg && (
        <div className="legal-folder-source legal-folder-source--disconnect">
          <span>{disconnectMsg}</span>
        </div>
      )}

      {(source || syncError) && (
        <div className={`legal-folder-source${syncError ? ' legal-folder-source--error' : ''}`}>
          {syncError ? (
            <span>{syncError}</span>
          ) : (
            <>
              <span className="legal-folder-source__name">{source.name}</span>
              <span>{source.contractCount} contract{source.contractCount !== 1 ? 's' : ''}</span>
              <span>{source.fileCount} imported file{source.fileCount !== 1 ? 's' : ''}</span>
              {source.fileCacheCount !== undefined && (
                <span>{source.fileCacheCount} preview file{source.fileCacheCount !== 1 ? 's' : ''} ready</span>
              )}
              <span>{source.scannedFileCount || source.fileCount} scanned</span>
              {source.skippedFileCount > 0 && (
                <span>{source.skippedFileCount} skipped</span>
              )}
              <span>Last sync {new Date(source.syncedAt).toLocaleString()}</span>
              {wsLabel && (
                <span style={{ color: wsLabel.color, fontWeight: 600 }}>
                  {wsLabel.text}
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="legal-folder-controls">
        <div className="legal-search">
          <span className="search-icon">🔍</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents..."
          />
        </div>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          <option value="pdf">PDF</option>
          <option value="docx">DOCX</option>
          <option value="doc">DOC</option>
          <option value="txt">TXT</option>
          <option value="md">MD</option>
          <option value="rtf">RTF</option>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="legal-empty">
          <div className="legal-empty-icon">📂</div>
          <h3>{docs.length === 0 ? 'No shared folder connected' : 'No results match your search'}</h3>
          <p>{docs.length === 0 ? 'Choose the department shared folder to sync contract records.' : 'Try a different search term.'}</p>
          {docs.length === 0 && (
            <button className="legal-folder-btn legal-folder-btn--primary" onClick={handleChooseFolder}>
              Choose Shared Folder
            </button>
          )}
        </div>
      ) : (
        <div className="legal-groups">
          {Object.entries(grouped).map(([contract, contractDocs]) => (
            <div key={contract} className="legal-group">
              <div className="legal-group-header">
                <span className="legal-group-icon">📁</span>
                <h2>{contract}</h2>
                <span className="legal-group-count">{contractDocs.length}</span>
              </div>
              <div className="legal-docs-grid">
                {contractDocs.map((doc) => (
                  <div key={doc._id} className="legal-doc-card">
                    <div className="legal-doc-top">
                      <div className="legal-doc-icon">{doc.type === 'pdf' ? '📄' : '📝'}</div>
                      <div className="legal-doc-info">
                        <div className="legal-doc-name">{doc.name}</div>
                        <div className="legal-doc-meta">
                          {doc.contract?.title ? <span>{doc.contract.title} · </span> : null}
                          <span>By {doc.uploadedBy?.name || 'Unknown'}</span>
                        </div>
                      </div>
                      {doc.type && <span className="legal-doc-type-badge">{doc.type.toUpperCase()}</span>}
                    </div>

                    <div className="legal-doc-chips">
                      {doc.company && <span className="legal-doc-chip legal-doc-chip--company">🏢 {doc.company}</span>}
                      {doc.year && <span className="legal-doc-chip">{doc.year}</span>}
                      {doc.size > 0 && <span className="legal-doc-chip">{sizeLabel(doc.size)}</span>}
                      {doc.status === 'Signed' && <span className="legal-doc-chip legal-doc-chip--signed">✅ Signed</span>}
                    </div>

                    <div className="legal-doc-date">
                      Updated {new Date(doc.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

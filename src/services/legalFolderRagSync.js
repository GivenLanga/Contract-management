import { ai } from './api';
import { getLegalFolderImport } from './legalFolderStore';
import { getLegalFolderFile } from './legalFolderFileStore';

const MAX_RAG_DOCUMENTS = 500;
const MAX_TEXT_CHARS = 60000;

export const syncLegalFolderRagIndex = async () => {
  const snapshot = getLegalFolderImport();
  const documents = (snapshot.documents || []).slice(0, MAX_RAG_DOCUMENTS);

  if (!documents.length) {
    return { ok: true, skipped: true, reason: 'No legal folder documents to sync.' };
  }

  const payloadDocuments = await Promise.all(documents.map(async (doc) => {
    const textContent = await getLegalFolderFile(doc._id)
      .then((cachedFile) => cachedFile?.textContent || '')
      .catch(() => '');

    return {
      id: doc._id,
      name: doc.name,
      type: doc.type,
      size: doc.size,
      status: doc.status,
      updatedAt: doc.updatedAt,
      sourcePath: doc.sourcePath,
      company: doc.company,
      year: doc.year,
      contractTitle: doc.contract?.title,
      textContent: String(textContent).slice(0, MAX_TEXT_CHARS),
    };
  }));

  return ai.syncLegalFolderRag({
    source: snapshot.source,
    documents: payloadDocuments,
  });
};

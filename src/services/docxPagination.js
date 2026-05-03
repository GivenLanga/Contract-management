const isPageBreakNode = (node) =>
  node?.nodeType === 1 && node.hasAttribute('data-docx-page-break');

const isPageChromeNode = (node) =>
  node?.nodeType === 1 && node.classList?.contains('docx-page-chrome');

const pageHasContent = (page) =>
  page?.dataset?.docxExplicitPage === 'true' ||
  Array.from(page.childNodes).some((node) => {
    if (isPageBreakNode(node) || isPageChromeNode(node)) return false;
    if (node.nodeType === 3) return Boolean(node.textContent.trim());
    return true;
  });

const createDocxPage = (ownerDocument) => {
  const page = ownerDocument.createElement('article');
  page.className = 'docx-page';
  return page;
};

const markOverflowingPages = (root) => {
  Array.from(root.children).forEach((page) => {
    page.classList.remove('docx-page--overflowing');
    if (page.scrollHeight > page.clientHeight + 2) {
      page.classList.add('docx-page--overflowing');
    }
  });
};

const textChunks = (text) => {
  const chunks = [];
  let current = '';
  for (const token of String(text || '').match(/\S+\s*|\s+/g) || []) {
    if (current && (current + token).length > 120) {
      chunks.push(current);
      current = token;
    } else {
      current += token;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

const htmlSegmentsFromNode = (node) =>
  Array.from(node.childNodes || []).flatMap((child) => {
    if (child.nodeType === 3) {
      return textChunks(child.textContent).map((chunk) => {
        const span = node.ownerDocument.createElement('span');
        span.textContent = chunk;
        return span.innerHTML;
      });
    }

    if (child.nodeType !== 1) return [];

    const tag = child.tagName?.toLowerCase();
    const text = child.textContent || '';
    if ((tag === 'span' || tag === 'strong' || tag === 'em' || tag === 'a') && text.length > 160 && child.children.length === 0) {
      return textChunks(text).map((chunk) => {
        const clone = child.cloneNode(false);
        clone.textContent = chunk;
        return clone.outerHTML;
      });
    }

    return [child.outerHTML];
  });

const cloneBlockWithSegments = (node, segments) => {
  const clone = node.cloneNode(false);
  clone.innerHTML = segments.join('');
  return clone;
};

const canSplitBlock = (node) => {
  if (node?.nodeType !== 1) return false;
  const tag = node.tagName?.toLowerCase();
  return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) && (node.textContent || '').trim().length > 0;
};

const canSplitTable = (node) =>
  node?.nodeType === 1 && node.tagName?.toLowerCase() === 'table' && node.rows?.length > 1;

const canSplitSingleCellTable = (node) =>
  node?.nodeType === 1 &&
  node.tagName?.toLowerCase() === 'table' &&
  node.rows?.length === 1 &&
  node.rows[0]?.cells?.length === 1 &&
  node.rows[0].cells[0].childNodes.length > 1;

const nodeSummary = (node) => {
  if (!node) return 'unknown';
  if (node.nodeType === 3) return `text:${String(node.textContent || '').trim().slice(0, 40)}`;
  const tag = node.tagName?.toLowerCase() || node.localName || 'node';
  const className = node.className ? `.${String(node.className).trim().replace(/\s+/g, '.')}` : '';
  const text = String(node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return `${tag}${className}${text ? ` "${text}"` : ''}`;
};

const tableShellForRows = (table) => {
  const clone = table.cloneNode(false);
  const tbody = table.tBodies?.[0]?.cloneNode(false) || table.ownerDocument.createElement('tbody');
  clone.appendChild(tbody);
  return { table: clone, rowHost: tbody };
};

const singleCellTableShell = (table) => {
  const sourceRow = table.rows[0];
  const sourceCell = sourceRow.cells[0];
  const clone = table.cloneNode(false);
  const tbody = table.tBodies?.[0]?.cloneNode(false) || table.ownerDocument.createElement('tbody');
  const row = sourceRow.cloneNode(false);
  const cell = sourceCell.cloneNode(false);
  row.appendChild(cell);
  tbody.appendChild(row);
  clone.appendChild(tbody);
  return { table: clone, cell };
};

export const paginateDocxPages = (root, sourceHtml) => {
  if (sourceHtml) root.innerHTML = sourceHtml;

  const originalPages = Array.from(root.children).filter((node) => node.classList?.contains('docx-page'));
  const nodes = originalPages.flatMap((page) =>
    Array.from(page.childNodes).filter((node) => !isPageChromeNode(node))
  );
  const diagnostics = {
    sourceHtmlLength: sourceHtml?.length || 0,
    sourcePageCount: originalPages.length,
    sourceNodeCount: nodes.length,
    explicitBreaks: 0,
    splitBlocks: 0,
    splitTables: 0,
    splitSingleCellTables: 0,
    unsplitOverflowNodes: [],
    outputPageCount: originalPages.length || 1,
    overflowingPages: 0,
  };
  if (!nodes.length) return { pageCount: originalPages.length || 1, diagnostics };

  root.textContent = '';

  let page = createDocxPage(root.ownerDocument);
  root.appendChild(page);

  const startNextPage = () => {
    page = createDocxPage(root.ownerDocument);
    root.appendChild(page);
  };

  const appendSplitBlock = (node) => {
    if (!canSplitBlock(node)) return false;

    const segments = htmlSegmentsFromNode(node);
    if (segments.length < 2) return false;

    let cursor = 0;
    while (cursor < segments.length) {
      const remaining = segments.length - cursor;
      const clone = cloneBlockWithSegments(node, []);
      page.appendChild(clone);

      let low = 1;
      let high = remaining;
      let best = 0;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        clone.innerHTML = segments.slice(cursor, cursor + mid).join('');
        if (page.scrollHeight <= page.clientHeight + 2) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (best === 0) {
        clone.innerHTML = segments[cursor] || '&nbsp;';
        cursor += 1;
      } else {
        clone.innerHTML = segments.slice(cursor, cursor + best).join('');
        cursor += best;
      }

      if (cursor < segments.length) startNextPage();
    }

    diagnostics.splitBlocks += 1;
    return true;
  };

  const appendSplitTable = (node) => {
    if (!canSplitTable(node)) return false;

    const rows = Array.from(node.rows);
    let cursor = 0;

    while (cursor < rows.length) {
      const hadPriorContent = pageHasContent(page);
      const { table, rowHost } = tableShellForRows(node);
      page.appendChild(table);

      let added = 0;
      while (cursor + added < rows.length) {
        const row = rows[cursor + added].cloneNode(true);
        rowHost.appendChild(row);

        if (page.scrollHeight > page.clientHeight + 2) {
          if (added === 0 && hadPriorContent) {
            page.removeChild(table);
            startNextPage();
            break;
          }

          if (added > 0) {
            rowHost.removeChild(row);
            break;
          }

          added = 1;
          break;
        }

        added += 1;
      }

      if (!table.isConnected) continue;
      if (added === 0) {
        page.removeChild(table);
        return false;
      }

      cursor += added;
      if (cursor < rows.length) startNextPage();
    }

    diagnostics.splitTables += 1;
    return true;
  };

  const appendSplitSingleCellTable = (node) => {
    if (!canSplitSingleCellTable(node)) return false;

    const sourceCell = node.rows[0].cells[0];
    const cellNodes = Array.from(sourceCell.childNodes || []).filter((child) =>
      child.nodeType !== 3 || Boolean(child.textContent.trim())
    );
    let cursor = 0;

    while (cursor < cellNodes.length) {
      const hadPriorContent = pageHasContent(page);
      const { table, cell } = singleCellTableShell(node);
      page.appendChild(table);

      let added = 0;
      while (cursor + added < cellNodes.length) {
        const child = cellNodes[cursor + added].cloneNode(true);
        cell.appendChild(child);

        if (page.scrollHeight > page.clientHeight + 2) {
          if (added === 0 && hadPriorContent) {
            page.removeChild(table);
            startNextPage();
            break;
          }

          if (added > 0) {
            cell.removeChild(child);
            break;
          }

          added = 1;
          break;
        }

        added += 1;
      }

      if (!table.isConnected) continue;
      if (added === 0) {
        page.removeChild(table);
        return false;
      }

      cursor += added;
      if (cursor < cellNodes.length) startNextPage();
    }

    diagnostics.splitSingleCellTables += 1;
    return true;
  };

  const appendAcrossPages = (node) => {
    if (appendSplitBlock(node) || appendSplitSingleCellTable(node) || appendSplitTable(node)) return;

    page.appendChild(node);
    if (page.scrollHeight > page.clientHeight + 2) {
      diagnostics.unsplitOverflowNodes.push(nodeSummary(node));
      startNextPage();
    }
  };

  nodes.forEach((node) => {
    if (isPageBreakNode(node)) {
      diagnostics.explicitBreaks += 1;
      page.appendChild(node);
      page.dataset.docxExplicitPage = 'true';
      startNextPage();
      return;
    }

    page.appendChild(node);
    if (page.scrollHeight > page.clientHeight + 2 && page.childNodes.length > 1) {
      page.removeChild(node);
      if (pageHasContent(page)) page.classList.remove('docx-page--overflowing');
      startNextPage();
      appendAcrossPages(node);
    } else if (page.scrollHeight > page.clientHeight + 2 && page.childNodes.length === 1) {
      page.removeChild(node);
      appendAcrossPages(node);
    }
  });

  Array.from(root.children).forEach((candidate) => {
    if (!pageHasContent(candidate) && root.children.length > 1) candidate.remove();
  });

  markOverflowingPages(root);
  diagnostics.outputPageCount = Array.from(root.children).filter(pageHasContent).length || 1;
  diagnostics.overflowingPages = Array.from(root.children).filter((node) =>
    node.classList?.contains('docx-page--overflowing')
  ).length;
  return { pageCount: diagnostics.outputPageCount, diagnostics };
};

export const decorateDocxPages = (root, chrome) => {
  if (!root) return;
  Array.from(root.children).forEach((page) => {
    Array.from(page.querySelectorAll(':scope > .docx-page-chrome')).forEach((node) => node.remove());

    if (chrome?.headerHtml) {
      const header = root.ownerDocument.createElement('div');
      header.className = 'docx-page-chrome docx-header';
      header.innerHTML = chrome.headerHtml;
      page.appendChild(header);
    }

    if (chrome?.footerHtml) {
      const footer = root.ownerDocument.createElement('div');
      footer.className = 'docx-page-chrome docx-footer';
      footer.innerHTML = chrome.footerHtml;
      page.appendChild(footer);
    }
  });
};

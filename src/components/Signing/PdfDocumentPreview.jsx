import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PREVIEW_SCALE = 1.6;

const destroyPdf = (pdfDocument) => {
  try {
    pdfDocument?.destroy?.();
  } catch {
    // PDF.js can already be cleaning up during rapid remounts.
  }
};

const isRenderCancelled = (error) => error?.name === 'RenderingCancelledException';

function PdfPageCanvas({ pdfDocument, page, zoom, pageClassName, renderOverlay }) {
  const pageRef = useRef(null);
  const canvasRef = useRef(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [renderError, setRenderError] = useState('');
  const displayWidth = page.width * zoom;
  const displayHeight = page.height * zoom;

  useEffect(() => {
    const pageElement = pageRef.current;
    if (!pageElement) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldRender(true);
        observer.disconnect();
      }
    }, { rootMargin: '1600px 0px' });

    observer.observe(pageElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldRender || !pdfDocument || !canvasRef.current) return undefined;

    let cancelled = false;
    let renderTask = null;

    const renderPage = async () => {
      setRenderError('');

      try {
        const pdfPage = await pdfDocument.getPage(page.pageNumber);
        if (cancelled) {
          pdfPage.cleanup();
          return;
        }

        const viewport = pdfPage.getViewport({ scale: PREVIEW_SCALE });
        const canvas = canvasRef.current;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        renderTask = pdfPage.render({
          canvas,
          viewport,
          background: '#ffffff',
        });
        await renderTask.promise;
        pdfPage.cleanup();
      } catch (error) {
        if (!cancelled && !isRenderCancelled(error)) {
          setRenderError(error?.message || `Could not render page ${page.pageNumber}.`);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel?.();
      } catch {
        // PDF.js may already have completed or cancelled this render task.
      }
    };
  }, [pdfDocument, page.pageNumber, shouldRender]);

  return (
    <div
      ref={pageRef}
      className={`pdf-preview-page${pageClassName ? ` ${pageClassName}` : ''}`}
      data-page-number={page.pageNumber}
      data-env-page-number={page.pageNumber}
      data-sv-page-number={page.pageNumber}
      style={{ width: displayWidth, height: displayHeight, position: 'relative', background: '#fff' }}
    >
      <canvas
        ref={canvasRef}
        className="pdf-preview-image"
        aria-label={`Page ${page.pageNumber}`}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          objectFit: 'fill',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
      {renderError && <div className="pdf-preview-page-error">{renderError}</div>}
      {renderOverlay?.({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        displayWidth,
        displayHeight,
      })}
    </div>
  );
}

export default function PdfDocumentPreview({
  blob,
  zoom = 1,
  className = '',
  pageClassName = '',
  onDocumentLoad,
  renderOverlay,
}) {
  const [pages, setPages] = useState([]);
  const [pdfDocument, setPdfDocument] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!blob) {
      setPages([]);
      setPdfDocument(null);
      setError('');
      onDocumentLoad?.({ pageCount: 0, pageMetrics: {} });
      return undefined;
    }

    let cancelled = false;
    let loadingTask = null;
    let loadedPdf = null;

    const load = async () => {
      setError('');
      setPages([]);
      setPdfDocument(null);

      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        loadingTask = pdfjsLib.getDocument({ data: bytes, useSystemFonts: true });
        loadedPdf = await loadingTask.promise;

        const loadedPages = [];
        const metrics = {};

        for (let pageNumber = 1; pageNumber <= loadedPdf.numPages; pageNumber += 1) {
          if (cancelled) break;

          const pdfPage = await loadedPdf.getPage(pageNumber);
          const baseViewport = pdfPage.getViewport({ scale: 1 });
          pdfPage.cleanup();

          const page = {
            pageNumber,
            width: baseViewport.width,
            height: baseViewport.height,
            rotation: baseViewport.rotation,
          };
          loadedPages.push(page);
          metrics[pageNumber] = {
            page: pageNumber,
            width: baseViewport.width,
            height: baseViewport.height,
            rotation: baseViewport.rotation,
          };
        }

        if (!cancelled) {
          setPdfDocument(loadedPdf);
          setPages(loadedPages);
          onDocumentLoad?.({ pageCount: loadedPdf.numPages, pageMetrics: metrics });
        }
      } catch (loadError) {
        if (loadedPdf) destroyPdf(loadedPdf);
        if (!cancelled) {
          setError(loadError?.message || 'Could not render this PDF.');
          onDocumentLoad?.({ pageCount: 0, pageMetrics: {} });
        }
      }
    };

    load();

    return () => {
      cancelled = true;
      if (loadedPdf) destroyPdf(loadedPdf);
      else if (loadingTask) loadingTask.destroy();
    };
  }, [blob, onDocumentLoad]);

  if (error) {
    return (
      <div className={`pdf-preview-error${className ? ` ${className}` : ''}`}>
        {error}
      </div>
    );
  }

  return (
    <div className={`pdf-preview-document${className ? ` ${className}` : ''}`}>
      {pages.map((page) => (
        <PdfPageCanvas
          key={page.pageNumber}
          pdfDocument={pdfDocument}
          page={page}
          zoom={zoom}
          pageClassName={pageClassName}
          renderOverlay={renderOverlay}
        />
      ))}
    </div>
  );
}

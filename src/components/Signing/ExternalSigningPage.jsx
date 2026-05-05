import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import PdfDocumentPreview from './PdfDocumentPreview';
import {
  SIGNATURE_FIELD_TYPES,
  VALUE_FIELD_TYPES,
  defaultFieldValue,
  fieldDisplayValue,
  fieldPercentStyle,
  fieldTypeConfig,
} from '../../services/signingFields';
import './ExternalSigningPage.css';

const BASE_URL = import.meta.env.VITE_API_URL || '/api';
const MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024;
const DRAWN_SIGNATURE_MIN_POINTS = 3;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const tokenSegment = (token) => encodeURIComponent(token || '');

const parseResponseBody = async (res) => {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};

const publicJsonFetch = async (path, options = {}) => {
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const body = await parseResponseBody(res);

  if (!res.ok) {
    const error = new Error(body.error || `Request failed (${res.status}).`);
    error.status = res.status;
    error.body = body;
    throw error;
  }

  return body;
};

const fieldValueIsComplete = (field, value) => {
  if (field?.type === 'checkbox' || field?.type === 'radio') {
    return value === true || value === 'true';
  }
  return String(value ?? '').trim().length > 0;
};

const requirePlacedFields = (fields = []) =>
  (fields || []).map((field) => ({ ...field, required: true }));

const normalizedEmail = (value) => String(value || '').trim().toLowerCase();

const initialsFor = (signer) => {
  const source = signer?.name || signer?.email || 'Signer';
  const parts = source
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (parts.length ? parts : [source])
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
};

const removeWhiteBackground = (imageData) => {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    if (red > 235 && green > 235 && blue > 235) data[i + 3] = 0;
  }
  return imageData;
};

const signatureMethodForTab = (tab) => {
  if (tab === 'upload') return 'uploaded';
  if (tab === 'type') return 'typed';
  return 'drawn';
};

function ExternalSignatureModal({ documentName, signer, signingField, captureMode = 'signature', initialFocus = 'signature', submitLabel = 'Preview Signature', onClose, onSigned }) {
  const canvasRef = useRef(null);
  const initialsCanvasRef = useRef(null);
  const initialsSectionRef = useRef(null);
  const initialsInputRef = useRef(null);
  const signatureTelemetryRef = useRef({ strokes: [] });
  const activeStrokeRef = useRef(null);
  const [drawingKind, setDrawingKind] = useState('');
  const [tab, setTab] = useState('draw');
  const [uploadedSignature, setUploadedSignature] = useState('');
  const [uploadedInitials, setUploadedInitials] = useState('');
  const [typedName, setTypedName] = useState(signer?.name || signer?.email || '');
  const [typedInitials, setTypedInitials] = useState(initialsFor(signer));
  const [hasDrawnSignature, setHasDrawnSignature] = useState(false);
  const [hasDrawnInitials, setHasDrawnInitials] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const initCanvas = useCallback((canvas) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    if (tab !== 'draw') return;
    initCanvas(canvasRef.current);
    signatureTelemetryRef.current = { strokes: [] };
    activeStrokeRef.current = null;
    setHasDrawnSignature(false);
  }, [initCanvas, tab]);

  useEffect(() => {
    initCanvas(initialsCanvasRef.current);
  }, [initCanvas]);

  useEffect(() => {
    if (initialFocus !== 'initials') return;
    window.setTimeout(() => {
      initialsSectionRef.current?.scrollIntoView({ block: 'center' });
      initialsInputRef.current?.focus();
      initialsInputRef.current?.select();
    }, 0);
  }, [initialFocus]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !loading) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loading, onClose]);

  const getPointerPosition = (canvas, event) => {
    const rect = canvas.getBoundingClientRect();
    const point = event.touches ? event.touches[0] : event;
    return {
      x: (point.clientX - rect.left) * (canvas.width / rect.width),
      y: (point.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const telemetryPoint = (canvas, event, point) => ({
    x: Number(point.x.toFixed(2)),
    y: Number(point.y.toFixed(2)),
    t: Math.round(performance.now()),
    pressure: Number((event.pressure ?? event.touches?.[0]?.force ?? 0).toFixed(3)),
    pointerType: event.pointerType || (event.touches ? 'touch' : 'mouse'),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });

  const startDraw = useCallback((ref, kind, event) => {
    event.preventDefault();
    const canvas = ref.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const point = getPointerPosition(canvas, event);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    setDrawingKind(kind);

    if (kind === 'signature') {
      const stroke = { points: [telemetryPoint(canvas, event, point)] };
      activeStrokeRef.current = stroke;
      signatureTelemetryRef.current = {
        startedAt: Date.now(),
        devicePixelRatio: window.devicePixelRatio || 1,
        strokes: [...(signatureTelemetryRef.current.strokes || []), stroke],
      };
      setHasDrawnSignature(true);
    } else {
      setHasDrawnInitials(true);
    }
  }, []);

  const draw = useCallback((ref, kind, event) => {
    event.preventDefault();
    if (drawingKind !== kind) return;

    const canvas = ref.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const point = getPointerPosition(canvas, event);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();

    if (kind === 'signature' && activeStrokeRef.current) {
      activeStrokeRef.current.points.push(telemetryPoint(canvas, event, point));
    }
  }, [drawingKind]);

  const endDraw = useCallback(() => {
    if (signatureTelemetryRef.current.startedAt) {
      signatureTelemetryRef.current.durationMs = Date.now() - signatureTelemetryRef.current.startedAt;
    }
    activeStrokeRef.current = null;
    setDrawingKind('');
  }, []);

  const clearCanvas = (ref, kind) => {
    initCanvas(ref.current);
    if (kind === 'initials') {
      setHasDrawnInitials(false);
    } else {
      signatureTelemetryRef.current = { strokes: [] };
      activeStrokeRef.current = null;
      setHasDrawnSignature(false);
    }
  };

  const canvasToTransparentPng = (canvas) => {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cleaned = removeWhiteBackground(imageData);
    const offscreen = window.document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    offscreen.getContext('2d').putImageData(cleaned, 0, 0);
    return offscreen.toDataURL('image/png');
  };

  const drawTypedSignature = () => {
    const name = typedName.trim();
    if (!name) return null;

    const canvas = window.document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111827';

    let size = 48;
    do {
      ctx.font = `italic ${size}px Georgia, "Times New Roman", serif`;
      size -= 2;
    } while (ctx.measureText(name).width > canvas.width - 48 && size > 24);

    ctx.textBaseline = 'middle';
    ctx.fillText(name, 24, canvas.height / 2 + 4);
    return canvas.toDataURL('image/png');
  };

  const signaturePointCount = () =>
    (signatureTelemetryRef.current.strokes || []).reduce(
      (sum, stroke) => sum + (Array.isArray(stroke.points) ? stroke.points.length : 0),
      0
    );

  const getSignatureData = () => {
    if (tab === 'draw') {
      const canvas = canvasRef.current;
      if (!canvas || !hasDrawnSignature || signaturePointCount() < DRAWN_SIGNATURE_MIN_POINTS) return null;
      return canvasToTransparentPng(canvas);
    }
    if (tab === 'upload') return uploadedSignature || null;
    return drawTypedSignature();
  };

  const getInitialsData = () => {
    const canvas = initialsCanvasRef.current;
    if (canvas && hasDrawnInitials) return canvasToTransparentPng(canvas);
    if (uploadedInitials) return uploadedInitials;

    const initials = typedInitials.trim().toUpperCase().slice(0, 4);
    if (!initials) return null;

    const canvasElement = window.document.createElement('canvas');
    canvasElement.width = 160;
    canvasElement.height = 70;
    const ctx = canvasElement.getContext('2d');
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ctx.font = '700 34px Arial, sans-serif';
    ctx.fillStyle = '#111827';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 14, canvasElement.height / 2 + 2);
    return canvasElement.toDataURL('image/png');
  };

  const handleFileUpload = (setter) => (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setError('Upload a PNG or JPG image file.');
      event.target.value = '';
      return;
    }

    if (file.size > MAX_SIGNATURE_IMAGE_BYTES) {
      setError('Signature image must be 2 MB or smaller.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      setError('');
      setter(String(loadEvent.target?.result || ''));
    };
    reader.onerror = () => setError('Could not read that image file.');
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    const wantsSignature = captureMode !== 'initials';
    const wantsInitials = captureMode !== 'signature';

    if (wantsSignature && tab === 'draw' && hasDrawnSignature && signaturePointCount() < DRAWN_SIGNATURE_MIN_POINTS) {
      setError('Add a little more ink to your signature before signing.');
      return;
    }

    const signatureData = wantsSignature ? getSignatureData() : null;
    if (wantsSignature && (!signatureData || signatureData === 'data:,')) {
      setError('Provide your signature before submitting.');
      return;
    }

    const initialsData = wantsInitials ? getInitialsData() : null;
    if (wantsInitials && !initialsData) {
      setError('Add your initials or keep the typed initials provided.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await onSigned({
        ...(wantsSignature ? {
          signatureData,
          method: signatureMethodForTab(tab),
          signatureTelemetry: tab === 'draw' ? signatureTelemetryRef.current : undefined,
          fieldId: signingField?.id,
          page: signingField?.page || 1,
          position: signingField
            ? {
                x: signingField.x,
                y: signingField.y,
                width: signingField.width,
                height: signingField.height,
                origin: signingField.coordinateOrigin || 'normalized',
              }
            : undefined,
        } : {}),
        ...(wantsInitials ? { initialsData } : {}),
      });
    } catch (submitError) {
      setError(submitError.message || 'Unable to record your signature.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ext-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="ext-sign-modal" role="dialog" aria-modal="true" aria-labelledby="ext-sign-title">
        <header className="ext-modal-header">
          <div>
            <h2 id="ext-sign-title">{captureMode === 'initials' ? 'Add Initials' : 'Add Signature'}</h2>
            <p>{documentName}</p>
          </div>
          <button type="button" className="ext-icon-button" aria-label="Close signing dialog" onClick={onClose}>
            x
          </button>
        </header>

        <div className="ext-modal-body">
          <div className="ext-signer-strip">
            <span>{signer?.name || signer?.email || 'External signer'}</span>
            {signer?.role && <strong>{signer.role}</strong>}
          </div>

          {captureMode !== 'initials' && (
          <section className="ext-sign-section">
            <h3>Your Signature</h3>
            <div className="ext-sign-tabs" role="tablist" aria-label="Signature method">
              {[
                ['draw', 'Draw'],
                ['upload', 'Upload'],
                ['type', 'Type'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={`ext-sign-tab${tab === key ? ' ext-sign-tab--active' : ''}`}
                  onClick={() => {
                    setError('');
                    setTab(key);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'draw' && (
              <div className="ext-canvas-wrap">
                <canvas
                  ref={canvasRef}
                  width={560}
                  height={160}
                  className="ext-sign-canvas"
                  aria-label="Draw your signature"
                  onMouseDown={(event) => startDraw(canvasRef, 'signature', event)}
                  onMouseMove={(event) => draw(canvasRef, 'signature', event)}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={(event) => startDraw(canvasRef, 'signature', event)}
                  onTouchMove={(event) => draw(canvasRef, 'signature', event)}
                  onTouchEnd={endDraw}
                  onTouchCancel={endDraw}
                />
                <button type="button" className="ext-secondary-button" onClick={() => clearCanvas(canvasRef, 'signature')}>
                  Clear
                </button>
              </div>
            )}

            {tab === 'upload' && (
              <label className="ext-upload-box">
                {uploadedSignature ? (
                  <img src={uploadedSignature} alt="Uploaded signature preview" className="ext-upload-preview" />
                ) : (
                  <span>Choose a signature image</span>
                )}
                <input type="file" accept="image/png,image/jpeg" onChange={handleFileUpload(setUploadedSignature)} />
              </label>
            )}

            {tab === 'type' && (
              <div className="ext-type-wrap">
                <input
                  className="ext-type-input"
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                  placeholder="Type your full legal name"
                />
                <div className="ext-type-preview" aria-hidden="true">{typedName}</div>
              </div>
            )}
          </section>
          )}

          {captureMode !== 'signature' && (
          <section className="ext-sign-section" ref={initialsSectionRef}>
            <h3>Initials</h3>
            <div className="ext-initials-row">
              <canvas
                ref={initialsCanvasRef}
                width={180}
                height={64}
                className="ext-sign-canvas ext-sign-canvas--initials"
                aria-label="Draw your initials"
                onMouseDown={(event) => startDraw(initialsCanvasRef, 'initials', event)}
                onMouseMove={(event) => draw(initialsCanvasRef, 'initials', event)}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={(event) => startDraw(initialsCanvasRef, 'initials', event)}
                onTouchMove={(event) => draw(initialsCanvasRef, 'initials', event)}
                onTouchEnd={endDraw}
                onTouchCancel={endDraw}
              />
              <div className="ext-initials-actions">
                <button type="button" className="ext-secondary-button" onClick={() => clearCanvas(initialsCanvasRef, 'initials')}>
                  Clear
                </button>
                <label className="ext-upload-small">
                  Upload
                  <input type="file" accept="image/png,image/jpeg" onChange={handleFileUpload(setUploadedInitials)} />
                </label>
              </div>
            </div>
            <label className="ext-initials-typed">
              <span>Typed initials</span>
              <input
                ref={initialsInputRef}
                value={typedInitials}
                onChange={(event) => setTypedInitials(event.target.value.toUpperCase().slice(0, 4))}
                maxLength={4}
              />
            </label>
          </section>
          )}

          {error && <div className="ext-form-error" role="alert">{error}</div>}
        </div>

        <footer className="ext-modal-footer">
          <p>Review the placed signature and initials on the document before sending.</p>
          <div className="ext-modal-actions">
            <button type="button" className="ext-secondary-button" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="button" className="ext-primary-button" onClick={handleSubmit} disabled={loading}>
              {loading ? 'Preparing...' : submitLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function DeclineModal({ documentName, loading, error, reason, onReasonChange, onClose, onDecline }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !loading) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loading, onClose]);

  return (
    <div className="ext-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="ext-decline-modal" role="dialog" aria-modal="true" aria-labelledby="ext-decline-title">
        <header className="ext-modal-header">
          <div>
            <h2 id="ext-decline-title">Decline Signature</h2>
            <p>{documentName}</p>
          </div>
          <button type="button" className="ext-icon-button" aria-label="Close decline dialog" onClick={onClose}>
            x
          </button>
        </header>

        <div className="ext-modal-body">
          <label className="ext-reason-field">
            <span>Reason</span>
            <textarea
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              rows={4}
              maxLength={500}
              placeholder="Add a short reason for the sender"
            />
          </label>
          {error && <div className="ext-form-error" role="alert">{error}</div>}
        </div>

        <footer className="ext-modal-footer ext-modal-footer--inline">
          <button type="button" className="ext-secondary-button" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button type="button" className="ext-danger-button" onClick={onDecline} disabled={loading}>
            {loading ? 'Declining...' : 'Decline'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function ExternalSigningPage() {
  const { token } = useParams();
  const pdfScrollRef = useRef(null);

  const [info, setInfo] = useState(null);
  const [pdfBlob, setPdfBlob] = useState(null);
  const [firstPageMetric, setFirstPageMetric] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [fieldValues, setFieldValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [actionError, setActionError] = useState('');
  const [signed, setSigned] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [activeField, setActiveField] = useState(null);
  const [signatureDraft, setSignatureDraft] = useState(null);
  const [signatureFocus, setSignatureFocus] = useState('signature');
  const [captureMode, setCaptureMode] = useState('signature');
  const [submittingSignature, setSubmittingSignature] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineError, setDeclineError] = useState('');
  const [declineLoading, setDeclineLoading] = useState(false);

  const encodedToken = useMemo(() => tokenSegment(token), [token]);

  useEffect(() => {
    if (!token) {
      setError('Signing link is missing a token.');
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError('');
      setPreviewError('');
      setActionError('');
      setSigned(false);
      setDeclined(false);
      setSignatureDraft(null);
      setSubmittingSignature(false);
      setInfo(null);
      setPdfBlob(null);
      setFirstPageMetric(null);

      try {
        const infoData = await publicJsonFetch(`/signing/public/sign/${encodedToken}`, {
          signal: controller.signal,
        });
        const nextInfo = { ...infoData, fields: requirePlacedFields(infoData.fields) };
        setInfo(nextInfo);

        if (!nextInfo.isTurn) return;

        try {
          const docRes = await fetch(`${BASE_URL}/signing/public/document/${encodedToken}`, {
            signal: controller.signal,
            headers: { Accept: 'application/pdf,*/*' },
          });

          if (!docRes.ok) {
            const message = await docRes.text().catch(() => '');
            throw new Error(message || `Could not load document preview (${docRes.status}).`);
          }

          const blob = await docRes.blob();
          if (!blob.size) throw new Error('Document preview was empty.');
          setPdfBlob(blob);
        } catch (previewLoadError) {
          if (previewLoadError.name !== 'AbortError') {
            setPreviewError(previewLoadError.message || 'Document preview is unavailable.');
          }
        }
      } catch (loadError) {
        if (loadError.name === 'AbortError') return;
        if (loadError.status === 409 && /already signed/i.test(loadError.message)) {
          setSigned(true);
          return;
        }
        setError(loadError.message || 'Failed to load the signing request.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    load();
    return () => controller.abort();
  }, [encodedToken, token]);

  const signerIdentity = useMemo(() => ({
    name: info?.signer?.name || info?.signer?.email || '',
    email: info?.signer?.email || '',
  }), [info?.signer?.email, info?.signer?.name]);

  const fields = useMemo(() => info?.fields || [], [info?.fields]);
  const fieldBelongsToSigner = useCallback((field) => (
    Boolean(field) && (!field.assignedTo || normalizedEmail(field.assignedTo) === normalizedEmail(signerIdentity.email))
  ), [signerIdentity.email]);
  const draftAppliesToField = useCallback((field) => (
    Boolean(signatureDraft && !field?.filled && fieldBelongsToSigner(field))
  ), [fieldBelongsToSigner, signatureDraft]);
  const signatureImageForField = useCallback((field) => {
    if (!draftAppliesToField(field)) return '';
    return field.type === 'initials' ? signatureDraft.initialsData : signatureDraft.signatureData;
  }, [draftAppliesToField, signatureDraft]);

  useEffect(() => {
    if (!fields.length) {
      setFieldValues((current) => (Object.keys(current).length ? {} : current));
      return;
    }

    setFieldValues((current) => {
      const next = {};
      for (const field of fields) {
        if (!VALUE_FIELD_TYPES.has(field.type) || field.filled) continue;
        next[field.id] = Object.prototype.hasOwnProperty.call(current, field.id)
          ? current[field.id]
          : defaultFieldValue(field, signerIdentity);
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const changed = currentKeys.length !== nextKeys.length
        || nextKeys.some((key) => current[key] !== next[key]);
      return changed ? next : current;
    });
  }, [fields, signerIdentity]);

  useEffect(() => {
    const scroller = pdfScrollRef.current;
    if (!scroller || !firstPageMetric?.width) return undefined;

    const updateZoom = () => {
      const availableWidth = Math.max(260, scroller.clientWidth - 56);
      const nextZoom = clampNumber(availableWidth / firstPageMetric.width, 0.52, 1.18);
      setZoom(Number(nextZoom.toFixed(2)));
    };

    updateZoom();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateZoom);
      return () => window.removeEventListener('resize', updateZoom);
    }

    const observer = new ResizeObserver(updateZoom);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [firstPageMetric]);

  const handlePdfLoad = useCallback(({ pageCount, pageMetrics }) => {
    if (!pageCount) {
      setPreviewError('Document preview could not be rendered. Contact the sender before signing.');
      setPdfBlob(null);
      return;
    }

    const firstMetric = pageMetrics?.[1] || pageMetrics?.['1'];
    if (firstMetric) setFirstPageMetric(firstMetric);
  }, []);

  const updateFieldValue = (fieldId, value) => {
    setActionError('');
    setFieldValues((current) => ({ ...current, [fieldId]: value }));
  };

  const requiredValueFields = useMemo(
    () => fields.filter((field) => VALUE_FIELD_TYPES.has(field.type) && field.required && !field.filled),
    [fields],
  );

  const missingRequiredField = useMemo(
    () => requiredValueFields.find((field) => !fieldValueIsComplete(field, fieldValues[field.id])),
    [fieldValues, requiredValueFields],
  );

  const pendingSignatureField = useMemo(() => (
    fields.find((field) => field.type === 'signature' && !field.filled)
    || fields.find((field) => SIGNATURE_FIELD_TYPES.has(field.type) && !field.filled)
    || null
  ), [fields]);
  const hasPendingInitialsField = useMemo(
    () => fields.some((field) => field.type === 'initials' && !field.filled && fieldBelongsToSigner(field)),
    [fieldBelongsToSigner, fields],
  );
  const pendingInitialsField = useMemo(
    () => fields.find((field) => field.type === 'initials' && !field.filled && fieldBelongsToSigner(field)) || null,
    [fieldBelongsToSigner, fields],
  );

  const signingBlockedReason = useMemo(() => {
    if (!pdfBlob) return previewError || 'Document preview must load before signing.';
    if (!pendingSignatureField) return 'No signature field is assigned to this signing link.';
    if (missingRequiredField) {
      const label = fieldTypeConfig(missingRequiredField.type).label.toLowerCase();
      return `Complete the required ${label} field before signing.`;
    }
    return '';
  }, [missingRequiredField, pdfBlob, pendingSignatureField, previewError]);

  const draftHasSignature = Boolean(signatureDraft?.signatureData);
  const draftHasInitials = !hasPendingInitialsField || Boolean(signatureDraft?.initialsData);
  const draftReadyToSend = draftHasSignature && draftHasInitials;
  const canStartSigning = Boolean(info?.isTurn && !draftReadyToSend && !signingBlockedReason);
  const canSubmitDraft = Boolean(info?.isTurn && draftReadyToSend && !missingRequiredField && !submittingSignature);
  const completedFields = fields.filter((field) => {
    if (field.filled) return true;
    if (SIGNATURE_FIELD_TYPES.has(field.type) && draftAppliesToField(field) && signatureImageForField(field)) return true;
    if (VALUE_FIELD_TYPES.has(field.type)) {
      return fieldValueIsComplete(field, fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity));
    }
    return false;
  }).length;
  const fieldProgress = fields.length ? Math.round((completedFields / fields.length) * 100) : 0;

  const fieldValueForDisplay = (field, value) => {
    if (field.type === 'checkbox' || field.type === 'radio') return value === true || value === 'true' ? '✓' : '';
    return String(value ?? '').trim();
  };

  const fieldValuesForSubmission = () => {
    const values = {};
    fields.forEach((field) => {
      if (!VALUE_FIELD_TYPES.has(field.type) || field.filled) return;
      const value = fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity);
      if (field.required || fieldValueIsComplete(field, value)) {
        values[field.id] = value;
      }
    });
    return values;
  };

  const openSignatureModal = (field) => {
    if (!signatureDraft && !canStartSigning) {
      setActionError(signingBlockedReason);
      return;
    }

    const focus = field?.type === 'initials' ? 'initials' : 'signature';
    const mode = focus === 'initials' ? 'initials' : 'signature';
    const targetField = field?.type === 'signature' ? field : pendingSignatureField;
    setActionError('');
    setSignatureFocus(focus);
    setCaptureMode(mode);
    setActiveField(targetField);
    setShowModal(true);
  };

  const handleSign = async (payload) => {
    if (!canStartSigning && !signatureDraft) {
      throw new Error(signingBlockedReason || 'This signing request is not ready.');
    }

    setSignatureDraft((current) => ({
      ...(current || {}),
      ...payload,
      fieldId: payload.fieldId || current?.fieldId,
      page: payload.page || current?.page,
      position: payload.position || current?.position,
      method: payload.method || current?.method,
      signatureTelemetry: payload.signatureTelemetry || current?.signatureTelemetry,
    }));
    setShowModal(false);
    setActionError('');
  };

  const submitSignatureDraft = async () => {
    if (!signatureDraft?.signatureData) {
      setActionError('Add your signature before sending.');
      return;
    }
    if (!draftHasInitials) {
      setActionError('Add your initials before sending.');
      return;
    }
    if (missingRequiredField) {
      const label = fieldTypeConfig(missingRequiredField.type).label.toLowerCase();
      setActionError(`Complete the required ${label} field before sending.`);
      return;
    }

    setSubmittingSignature(true);
    setActionError('');
    try {
      await publicJsonFetch(`/signing/public/sign/${encodedToken}`, {
        method: 'POST',
        body: JSON.stringify({
          signatureData: signatureDraft.signatureData,
          initialsData: signatureDraft.initialsData,
          method: signatureDraft.method,
          signatureTelemetry: signatureDraft.signatureTelemetry,
          fieldId: signatureDraft.fieldId,
          page: signatureDraft.page,
          position: signatureDraft.position,
          fieldValues: fieldValuesForSubmission(),
        }),
      });

      setSignatureDraft(null);
      setSigned(true);
    } catch (submitError) {
      setActionError(submitError.message || 'Unable to send the signed document.');
    } finally {
      setSubmittingSignature(false);
    }
  };

  const handleDecline = async () => {
    setDeclineError('');
    setDeclineLoading(true);

    try {
      await publicJsonFetch(`/signing/reject-token/${encodedToken}`, {
        method: 'POST',
        body: JSON.stringify({ reason: declineReason.trim() || 'No reason provided.' }),
      });
      setShowDeclineModal(false);
      setDeclined(true);
    } catch (declineSubmitError) {
      setDeclineError(declineSubmitError.message || 'Unable to decline this signing request.');
    } finally {
      setDeclineLoading(false);
    }
  };

  const renderValueField = (field, cfg, metric, editable) => {
    const value = fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity);
    const className = [
      'ext-field',
      `ext-field--${field.type}`,
      field.filled ? 'ext-field--filled' : '',
      editable ? 'ext-field--editable' : 'ext-field--readonly',
    ].filter(Boolean).join(' ');
    const common = {
      key: field.id,
      className,
      style: fieldPercentStyle(field, metric),
      'aria-label': `${cfg.label}${field.required ? ' required' : ''}`,
    };

    if (!editable) {
      const displayValue = field.filled
        ? fieldDisplayValue(field)
        : fieldValueForDisplay(field, value);
      return (
        <div {...common}>
          {displayValue || cfg.label}
          {field.required && !field.filled && !displayValue && <span className="ext-field-req">*</span>}
        </div>
      );
    }

    if (field.type === 'checkbox' || field.type === 'radio') {
      return (
        <label {...common}>
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            onChange={(event) => updateFieldValue(field.id, event.target.checked)}
          />
        </label>
      );
    }

    if (field.type === 'dropdown') {
      const options = Array.isArray(field.fieldMeta?.options) ? field.fieldMeta.options : [];
      return (
        <label {...common}>
          <select value={value ?? ''} required={field.required} onChange={(event) => updateFieldValue(field.id, event.target.value)}>
            <option value="">Select</option>
            {options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      );
    }

    return (
      <label {...common}>
        <input
          type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
          value={value ?? ''}
          required={field.required}
          min={field.fieldMeta?.min}
          max={field.fieldMeta?.max}
          maxLength={field.fieldMeta?.maxLength}
          placeholder={cfg.label}
          onChange={(event) => updateFieldValue(field.id, event.target.value)}
        />
      </label>
    );
  };

  const renderOverlay = ({ pageNumber, width, height }) => {
    const metric = { width, height };
    const pageFields = fields.filter((field) => Number(field.page || 1) === pageNumber);
    if (!pageFields.length) return null;

    return (
      <div className="ext-field-layer">
        {pageFields.map((field) => {
          const cfg = fieldTypeConfig(field.type);
          const editable = Boolean(info?.isTurn && !field.filled);

          if (VALUE_FIELD_TYPES.has(field.type)) {
            return renderValueField(field, cfg, metric, editable);
          }

          const className = [
            'ext-field',
            `ext-field--${field.type}`,
            field.filled ? 'ext-field--filled' : '',
            signatureImageForField(field) ? 'ext-field--preview' : '',
            editable ? 'ext-field--editable' : 'ext-field--readonly',
          ].filter(Boolean).join(' ');
          const fieldImage = signatureImageForField(field);

          return (
            <button
              key={field.id}
              type="button"
              className={className}
              style={fieldPercentStyle(field, metric)}
              onClick={() => openSignatureModal(field)}
              disabled={(!editable && !fieldImage) || !SIGNATURE_FIELD_TYPES.has(field.type)}
              title={field.filled ? `${cfg.label} complete` : cfg.label}
            >
              {fieldImage ? (
                <img src={fieldImage} alt={field.type === 'initials' ? 'Initials preview' : 'Signature preview'} className="ext-field-image" />
              ) : (
                field.filled ? 'Complete' : cfg.label
              )}
              {field.required && !field.filled && !fieldImage && <span className="ext-field-req">*</span>}
            </button>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="ext-root ext-screen" role="status" aria-live="polite">
        <div className="ext-spinner" aria-hidden="true" />
        <p className="ext-screen-msg">Loading your signing request...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ext-root ext-screen">
        <div className="ext-screen-mark" aria-hidden="true">!</div>
        <h1>Unable to open this signing request</h1>
        <p className="ext-screen-msg">{error}</p>
      </div>
    );
  }

  if (signed || info?.signer?.signingStatus === 'signed') {
    return (
      <div className="ext-root ext-screen">
        <div className="ext-screen-mark ext-screen-mark--success" aria-hidden="true">OK</div>
        <h1>You have signed this document</h1>
        <p className="ext-screen-msg">Your signature has been recorded. You may close this tab.</p>
        {info?.document?.name && <div className="ext-screen-docname">{info.document.name}</div>}
      </div>
    );
  }

  if (declined) {
    return (
      <div className="ext-root ext-screen">
        <div className="ext-screen-mark" aria-hidden="true">--</div>
        <h1>You declined to sign</h1>
        <p className="ext-screen-msg">The sender has been notified.</p>
        {info?.document?.name && <div className="ext-screen-docname">{info.document.name}</div>}
      </div>
    );
  }

  if (!info?.isTurn) {
    return (
      <div className="ext-root ext-screen">
        <div className="ext-screen-mark" aria-hidden="true">...</div>
        <h1>Waiting for prior signers</h1>
        <p className="ext-screen-msg">You will receive an email when it is your turn to sign.</p>
        {info?.document?.name && <div className="ext-screen-docname">{info.document.name}</div>}
      </div>
    );
  }

  const { document: doc, signer } = info;

  return (
    <div className="ext-root">
      <header className="ext-header">
        <div className="ext-brand">
          <span className="ext-brand-mark" aria-hidden="true">CI</span>
          <span>ContractIQ</span>
        </div>
        <div className="ext-header-center">
          <span className="ext-header-docname">{doc?.name || 'Signing request'}</span>
          <span className="ext-header-signer">
            Signing as <strong>{signer?.name || signer?.email || 'External signer'}</strong>
            {signer?.role ? `, ${signer.role}` : ''}
          </span>
        </div>
        <div className="ext-header-actions">
          <button type="button" className="ext-link-button" onClick={() => setShowDeclineModal(true)}>
            Decline
          </button>
          <button
            type="button"
            className="ext-primary-button"
            disabled={signatureDraft ? (draftReadyToSend ? !canSubmitDraft : false) : !canStartSigning}
            onClick={signatureDraft
              ? (draftReadyToSend ? submitSignatureDraft : () => openSignatureModal(!draftHasInitials && pendingInitialsField ? pendingInitialsField : pendingSignatureField))
              : () => openSignatureModal(pendingSignatureField)}
          >
            {signatureDraft
              ? (draftReadyToSend ? (submittingSignature ? 'Sending...' : 'Send') : (!draftHasInitials ? 'Initials' : 'Sign'))
              : 'Sign'}
          </button>
        </div>
      </header>

      <main className="ext-body">
        <section className="ext-preview-panel" aria-label="Document preview">
          {pdfBlob ? (
            <div ref={pdfScrollRef} className="ext-pdf-scroll">
              <PdfDocumentPreview
                blob={pdfBlob}
                zoom={zoom}
                className="ext-pdf-document"
                pageClassName="ext-pdf-page"
                onDocumentLoad={handlePdfLoad}
                renderOverlay={renderOverlay}
              />
            </div>
          ) : (
            <div className="ext-no-preview">
              <div className="ext-no-preview-mark" aria-hidden="true">PDF</div>
              <h2>{doc?.name || 'Document preview unavailable'}</h2>
              <p>{previewError || 'Document preview is unavailable. Contact the sender before signing.'}</p>
            </div>
          )}
        </section>

        <aside className="ext-side-panel" aria-label="Signing status">
          <div className="ext-side-section">
            <span className="ext-eyebrow">{draftReadyToSend ? 'Ready to send' : signatureDraft ? 'Action required' : 'Action required'}</span>
            <h1>{draftReadyToSend ? 'Preview and send' : signatureDraft ? 'Complete signing' : 'Review and sign'}</h1>
            <p className="ext-side-copy">
              {signer?.name || signer?.email || 'External signer'}
              {signer?.role ? `, ${signer.role}` : ''}
            </p>
          </div>

          <div className="ext-progress-block">
            <div className="ext-progress-label">
              <span>Fields complete</span>
              <strong>{completedFields} of {fields.length}</strong>
            </div>
            <div className="ext-progress-track" aria-hidden="true">
              <span style={{ width: `${fieldProgress}%` }} />
            </div>
          </div>

          {actionError && <div className="ext-inline-alert" role="alert">{actionError}</div>}
          {!actionError && signatureDraft && (
            <div className="ext-inline-note">
              {draftReadyToSend
                ? 'Review the signature and initials on the document, then send when everything looks right.'
                : 'Add the remaining signature or initials before sending.'}
            </div>
          )}
          {!actionError && !signatureDraft && signingBlockedReason && (
            <div className="ext-inline-note">{signingBlockedReason}</div>
          )}

          <div className="ext-side-actions">
            {signatureDraft ? (
              <>
                <button type="button" className="ext-primary-button ext-primary-button--wide" disabled={!canSubmitDraft} onClick={submitSignatureDraft}>
                  {submittingSignature ? 'Sending...' : 'Send Signed Document'}
                </button>
                <button
                  type="button"
                  className="ext-secondary-button ext-secondary-button--wide"
                  onClick={() => openSignatureModal(!draftHasInitials && pendingInitialsField ? pendingInitialsField : pendingSignatureField)}
                >
                  {!draftHasInitials ? 'Add Initials' : 'Edit Signature'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="ext-primary-button ext-primary-button--wide" disabled={!canStartSigning} onClick={() => openSignatureModal(pendingSignatureField)}>
                  Sign Document
                </button>
                <button type="button" className="ext-secondary-button ext-secondary-button--wide" onClick={() => setShowDeclineModal(true)}>
                  Decline
                </button>
              </>
            )}
          </div>

          <p className="ext-legal-copy">
            By signing, you consent to transact electronically and to use an electronic signature for this document.
          </p>
        </aside>
      </main>

      {showModal && (
        <ExternalSignatureModal
          documentName={doc?.name || 'Document'}
          signer={signer}
          signingField={activeField || pendingSignatureField}
          captureMode={captureMode}
          initialFocus={signatureFocus}
          submitLabel={captureMode === 'initials' ? 'Save Initials' : 'Preview Signature'}
          onClose={() => setShowModal(false)}
          onSigned={handleSign}
        />
      )}

      {showDeclineModal && (
        <DeclineModal
          documentName={doc?.name || 'Document'}
          loading={declineLoading}
          error={declineError}
          reason={declineReason}
          onReasonChange={(value) => {
            setDeclineError('');
            setDeclineReason(value);
          }}
          onClose={() => setShowDeclineModal(false)}
          onDecline={handleDecline}
        />
      )}
    </div>
  );
}

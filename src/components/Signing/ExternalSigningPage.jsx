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
import { collectSigningClientEvidence } from '../../services/signingEvidenceClient';
import { normalizeSignatureCanvas, normalizeSignatureDataUrl } from './signatureImageUtils';
import './ExternalSigningPage.css';

const BASE_URL = import.meta.env.VITE_API_URL || '/api';
const MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024;
const DRAWN_SIGNATURE_MIN_POINTS = 8;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const MEDIA_EVIDENCE_MODES = new Set(['photo', 'video', 'ron']);

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('Could not read media evidence.'));
  reader.readAsDataURL(blob);
});
const baseMimeType = (value, fallback = '') =>
  String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase() || fallback;
const supportedVideoMimeType = () => {
  if (!window.MediaRecorder) return '';
  return ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
};

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
  const { signingSessionToken, idempotencyKey, devSkipVerification, ...fetchOptions } = options;
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(signingSessionToken ? { 'X-Signing-Session': signingSessionToken } : {}),
    ...(idempotencyKey ? { 'X-Signing-Idempotency-Key': idempotencyKey } : {}),
    ...(devSkipVerification ? { 'X-Signing-Dev-Bypass': 'true' } : {}),
    ...options.headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...fetchOptions, headers });
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
  if (field?.type === 'checkbox') {
    return value === true || value === 'true';
  }
  if (field?.type === 'radio') {
    if (value === false || value === 'false') return false;
  }
  return String(value ?? '').trim().length > 0;
};

const requirePlacedFields = (fields = []) =>
  (fields || []).map((field) => ({ ...field, required: true }));

const normalizedEmail = (value) => String(value || '').trim().toLowerCase();
const cssEscape = (value) => {
  if (typeof window !== 'undefined' && window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
};

const sessionStorageKeyFor = (token) => `contractiq.externalSigning.${token || ''}.session`;
const readSigningSession = (token) => {
  if (typeof window === 'undefined' || !token) return '';
  try {
    return window.sessionStorage.getItem(sessionStorageKeyFor(token)) || '';
  } catch {
    return '';
  }
};
const writeSigningSession = (token, sessionToken) => {
  if (typeof window === 'undefined' || !token) return;
  try {
    const key = sessionStorageKeyFor(token);
    if (sessionToken) window.sessionStorage.setItem(key, sessionToken);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Browser storage can be disabled; the in-memory session still works for this tab.
  }
};

const idempotencyKey = () => {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

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

  const canvasToSignaturePng = (canvas, kind = 'signature') =>
    normalizeSignatureCanvas(canvas, { kind });

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
    return normalizeSignatureCanvas(canvas, { kind: 'signature' }) || canvas.toDataURL('image/png');
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
      return canvasToSignaturePng(canvas, 'signature');
    }
    if (tab === 'upload') return uploadedSignature || null;
    return drawTypedSignature();
  };

  const getInitialsData = () => {
    const canvas = initialsCanvasRef.current;
    if (canvas && hasDrawnInitials) return canvasToSignaturePng(canvas, 'initials');
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
    return normalizeSignatureCanvas(canvasElement, { kind: 'initials' }) || canvasElement.toDataURL('image/png');
  };

  const handleFileUpload = (setter, kind = 'signature') => (event) => {
    const input = event.target;
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
    reader.onload = async (loadEvent) => {
      try {
        const dataUrl = String(loadEvent.target?.result || '');
        setter(await normalizeSignatureDataUrl(dataUrl, { kind }));
        setError('');
      } catch (readError) {
        setError(readError.message || 'Could not prepare that image file.');
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => {
      setError('Could not read that image file.');
      input.value = '';
    };
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
                <input type="file" accept="image/png,image/jpeg" onChange={handleFileUpload(setUploadedSignature, 'signature')} />
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
                  <input type="file" accept="image/png,image/jpeg" onChange={handleFileUpload(setUploadedInitials, 'initials')} />
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
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaChunksRef = useRef([]);
  const mediaEvidenceRef = useRef(null);

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
  const [completion, setCompletion] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [downloadingFinal, setDownloadingFinal] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [activeField, setActiveField] = useState(null);
  const [signatureDraft, setSignatureDraft] = useState(null);
  const [signatureFocus, setSignatureFocus] = useState('signature');
  const [captureMode, setCaptureMode] = useState('signature');
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [includeLocationEvidence, setIncludeLocationEvidence] = useState(false);
  const [mediaCaptureError, setMediaCaptureError] = useState('');
  const [ronTechCheck, setRonTechCheck] = useState({ status: 'idle', checkedAt: '', error: '' });
  const [ronAcknowledged, setRonAcknowledged] = useState(false);
  const [ronIdentityFile, setRonIdentityFile] = useState(null);
  const [ronIdentityUploading, setRonIdentityUploading] = useState(false);
  const [ronIdentityError, setRonIdentityError] = useState('');
  const [submittingSignature, setSubmittingSignature] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineError, setDeclineError] = useState('');
  const [declineLoading, setDeclineLoading] = useState(false);
  const [authSessionToken, setAuthSessionToken] = useState(() => readSigningSession(token));
  const [authCode, setAuthCode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [authSending, setAuthSending] = useState(false);
  const [authVerifying, setAuthVerifying] = useState(false);

  const encodedToken = useMemo(() => tokenSegment(token), [token]);
  const devSkipVerification = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('devSkipVerification') === '1';
  }, []);

  useEffect(() => {
    setAuthSessionToken(readSigningSession(token));
    setAuthCode('');
    setAuthError('');
    setAuthNotice('');
  }, [token]);

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
      setCompletion(null);
      setDownloadError('');
      setDeclined(false);
      setSignatureDraft(null);
      setConsentAccepted(false);
      setSubmittingSignature(false);
      setRonTechCheck({ status: 'idle', checkedAt: '', error: '' });
      setRonAcknowledged(false);
      setRonIdentityFile(null);
      setRonIdentityError('');
      setInfo(null);
      setPdfBlob(null);
      setFirstPageMetric(null);

      try {
        const infoData = await publicJsonFetch(`/signing/public/sign/${encodedToken}`, {
          signal: controller.signal,
          signingSessionToken: authSessionToken,
          devSkipVerification,
        });
        const nextInfo = { ...infoData, fields: requirePlacedFields(infoData.fields) };
        setInfo(nextInfo);
        if (nextInfo.receipt) {
          setCompletion(nextInfo.receipt);
          setSigned(true);
        }

        if (nextInfo.auth?.required && !nextInfo.auth?.verified) return;

        if (!nextInfo.isTurn) return;
        if (nextInfo.signer?.signingStatus === 'signed') return;

        try {
          const docRes = await fetch(`${BASE_URL}/signing/public/document/${encodedToken}`, {
            signal: controller.signal,
            headers: {
              Accept: 'application/pdf,*/*',
              ...(authSessionToken ? { 'X-Signing-Session': authSessionToken } : {}),
              ...(devSkipVerification ? { 'X-Signing-Dev-Bypass': 'true' } : {}),
            },
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
        if (loadError.status === 401) {
          writeSigningSession(token, '');
          setAuthSessionToken('');
        }
        if (loadError.status === 409 && /declined/i.test(loadError.message)) {
          setDeclined(true);
          return;
        }
        setError(loadError.message || 'Failed to load the signing request.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    load();
    return () => controller.abort();
  }, [authSessionToken, devSkipVerification, encodedToken, token]);

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
  const effectiveFieldValue = useCallback(
    (field) => fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity),
    [fieldValues, signerIdentity],
  );

  const requiredValueFields = useMemo(
    () => fields.filter((field) => VALUE_FIELD_TYPES.has(field.type) && field.required && !field.filled),
    [fields],
  );
  const hasRequiredValueFields = requiredValueFields.length > 0;

  const missingRequiredValueField = useMemo(
    () => {
      if (!hasRequiredValueFields) return null;
      return requiredValueFields.find((field) => !fieldValueIsComplete(field, effectiveFieldValue(field))) || null;
    },
    [effectiveFieldValue, hasRequiredValueFields, requiredValueFields],
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
  const evidenceMode = info?.document?.signingEvidence?.mode || 'standard';
  const ronPolicy = info?.document?.signingEvidence?.ron || null;
  const ronIdentity = ronPolicy?.identity?.signer || null;
  const ronSession = ronPolicy?.session || null;
  const requiresMediaEvidence = MEDIA_EVIDENCE_MODES.has(evidenceMode);
  const requiresVideoEvidence = evidenceMode === 'video' || evidenceMode === 'ron';
  const requiresRonReadiness = evidenceMode === 'ron';

  // Scheduled session: waiting room check
  const scheduledSessionAt = ronPolicy?.scheduledAt || ronSession?.scheduledAt || info?.document?.signingEvidence?.scheduledAt || null;
  const sessionIsScheduledAndPending = requiresRonReadiness && scheduledSessionAt
    && !ronSession?.notaryStartedAt
    && new Date(scheduledSessionAt).getTime() > Date.now();

  const signingBlockedReason = useMemo(() => {
    if (!pdfBlob) return previewError || 'Document preview must load before signing.';
    if (!pendingSignatureField) return 'No signature field is assigned to this signing link.';
    if (missingRequiredValueField) {
      const label = fieldTypeConfig(missingRequiredValueField.type).label.toLowerCase();
      return `Complete the required ${label} field before signing.`;
    }
    if (requiresRonReadiness && sessionIsScheduledAndPending) {
      return `The notarization session is scheduled. Please join at the scheduled time.`;
    }
    if (requiresRonReadiness && ronIdentity?.status !== 'verified') {
      return ronPolicy?.identityMethod === 'personal_knowledge'
        ? 'The Notary Public must verify personal knowledge before signing.'
        : 'Upload your identity document for the Notary Public to verify before signing.';
    }
    if (requiresRonReadiness && !ronSession?.notaryStartedAt) return 'Wait for the Notary Public to start the live session before signing.';
    if (requiresRonReadiness && ronTechCheck.status !== 'passed') return 'Complete the camera and microphone check before signing.';
    if (requiresRonReadiness && !ronAcknowledged) return 'Confirm the notarization requirements before signing.';
    return '';
  }, [missingRequiredValueField, pdfBlob, pendingSignatureField, previewError, requiresRonReadiness, ronAcknowledged, ronIdentity?.status, ronPolicy?.identityMethod, ronSession?.notaryStartedAt, ronTechCheck.status, sessionIsScheduledAndPending]);

  const draftHasSignature = Boolean(signatureDraft?.signatureData);
  const draftHasInitials = !hasPendingInitialsField || Boolean(signatureDraft?.initialsData);
  const draftReadyToSend = draftHasSignature && draftHasInitials;
  const canStartSigning = Boolean(info?.isTurn && !draftReadyToSend && !signingBlockedReason);
  const canSubmitDraft = Boolean(info?.isTurn && draftReadyToSend && consentAccepted && !missingRequiredValueField && !submittingSignature);

  const capturePhotoFromStream = useCallback(async (stream) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.onloadedmetadata = resolve;
    });
    const width = Math.min(640, video.videoWidth || 640);
    const height = Math.round(width * ((video.videoHeight || 480) / (video.videoWidth || 640)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    video.pause();
    video.srcObject = null;
    return canvas.toDataURL('image/jpeg', 0.78);
  }, []);

  const stopMediaTracks = useCallback(() => {
    mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const runRonTechCheck = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRonTechCheck({
        status: 'failed',
        checkedAt: '',
        error: 'This browser does not support the camera and microphone check required for RON.',
      });
      return;
    }

    setRonTechCheck({ status: 'checking', checkedAt: '', error: '' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      const hasVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
      const hasAudio = stream.getAudioTracks().some((track) => track.readyState === 'live');
      stream.getTracks().forEach((track) => track.stop());
      if (!hasVideo || !hasAudio) throw new Error('Camera and microphone access are both required for RON.');
      setRonTechCheck({ status: 'passed', checkedAt: new Date().toISOString(), error: '' });
      setMediaCaptureError('');
    } catch (checkError) {
      setRonTechCheck({
        status: 'failed',
        checkedAt: '',
        error: checkError.message || 'Camera and microphone access are required for RON.',
      });
    }
  }, []);

  const cancelActiveMediaCapture = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Recorder may already be stopping; cleanup continues below.
      }
    }
    mediaRecorderRef.current = null;
    mediaChunksRef.current = [];
    mediaEvidenceRef.current = null;
    stopMediaTracks();
  }, [stopMediaTracks]);

  const startMediaEvidenceCapture = useCallback(async ({ restart = false } = {}) => {
    if (!requiresMediaEvidence) return true;
    if (restart) cancelActiveMediaCapture();
    if (mediaEvidenceRef.current?.captureStartedAt) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaCaptureError('Camera capture is required for this audit trail option, but this browser does not support it.');
      return false;
    }

    try {
      setMediaCaptureError('');
      const constraints = {
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: evidenceMode === 'ron',
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      const captureStartedAt = new Date().toISOString();
      const photoData = await capturePhotoFromStream(stream);
      mediaEvidenceRef.current = {
        mode: evidenceMode,
        captureStartedAt,
        photoCapturedAt: new Date().toISOString(),
        photoData,
        userMediaConstraints: constraints,
      };

      if (requiresVideoEvidence) {
        const mimeType = supportedVideoMimeType();
        if (!window.MediaRecorder || !mimeType) throw new Error('This browser cannot record video evidence.');
        mediaChunksRef.current = [];
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 450000, audioBitsPerSecond: 64000 });
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data?.size) mediaChunksRef.current.push(event.data);
        };
        recorder.start(1000);
        mediaEvidenceRef.current.videoStartedAt = new Date().toISOString();
        mediaEvidenceRef.current.videoMimeType = baseMimeType(mimeType, 'video/webm');
        mediaEvidenceRef.current.videoRecorderMimeType = mimeType;
      } else {
        stopMediaTracks();
      }
      return true;
    } catch (captureError) {
      stopMediaTracks();
      mediaRecorderRef.current = null;
      mediaEvidenceRef.current = null;
      setMediaCaptureError(captureError.message || 'Camera capture is required for this audit trail option.');
      return false;
    }
  }, [cancelActiveMediaCapture, capturePhotoFromStream, evidenceMode, requiresMediaEvidence, requiresVideoEvidence, stopMediaTracks]);

  const stopMediaEvidenceCapture = useCallback(async () => {
    const current = mediaEvidenceRef.current;
    if (!current) return null;
    if (mediaRecorderRef.current?.state === 'recording') {
      await new Promise((resolve) => {
        mediaRecorderRef.current.onstop = resolve;
        try {
          mediaRecorderRef.current.requestData();
        } catch {
          // Some browsers only flush data on stop.
        }
        mediaRecorderRef.current.stop();
      });
      mediaRecorderRef.current = null;
    }
    if (requiresVideoEvidence && !current.videoData && mediaChunksRef.current.length) {
      const videoMimeType = baseMimeType(current.videoMimeType || current.videoRecorderMimeType, 'video/webm');
      const videoBlob = new Blob(mediaChunksRef.current, { type: videoMimeType });
      if (videoBlob.size) {
        current.videoData = await blobToDataUrl(videoBlob);
        current.videoMimeType = videoMimeType;
        current.videoStoppedAt = new Date().toISOString();
      }
    }
    mediaChunksRef.current = [];
    current.captureStoppedAt = new Date().toISOString();
    stopMediaTracks();
    return current;
  }, [requiresVideoEvidence, stopMediaTracks]);

  useEffect(() => () => {
    cancelActiveMediaCapture();
  }, [cancelActiveMediaCapture]);

  const fieldIsComplete = useCallback((field) => {
    if (field.filled) return true;
    if (SIGNATURE_FIELD_TYPES.has(field.type) && draftAppliesToField(field) && signatureImageForField(field)) return true;
    if (VALUE_FIELD_TYPES.has(field.type)) {
      return fieldValueIsComplete(field, effectiveFieldValue(field));
    }
    return false;
  }, [draftAppliesToField, effectiveFieldValue, signatureImageForField]);
  const requiredFieldItems = useMemo(() => {
    const items = [];
    const initialsFields = [];

    for (const field of fields) {
      if (!field.required) continue;

      if (field.type === 'initials') {
        initialsFields.push(field);
        continue;
      }

      items.push({ id: field.id, type: field.type, fields: [field] });
    }

    if (initialsFields.length) {
      items.push({ id: 'initials-group', type: 'initials', fields: initialsFields });
    }

    return items;
  }, [fields]);
  const fieldItemIsComplete = useCallback(
    (item) => item.fields.every((field) => fieldIsComplete(field)),
    [fieldIsComplete],
  );
  const completedFieldItems = requiredFieldItems.filter(fieldItemIsComplete).length;
  const fieldItemCount = requiredFieldItems.length;
  const fieldProgress = fieldItemCount ? Math.round((completedFieldItems / fieldItemCount) * 100) : 0;
  const nextRequiredItem = useMemo(
    () => requiredFieldItems.find((item) => !fieldItemIsComplete(item)) || null,
    [fieldItemIsComplete, requiredFieldItems],
  );
  const nextRequiredField = useMemo(
    () => nextRequiredItem?.fields.find((field) => !fieldIsComplete(field)) || null,
    [fieldIsComplete, nextRequiredItem],
  );
  const signerTokenExpiresAt = info?.signer?.tokenExpiresAt || '';
  const linkExpiryLabel = useMemo(() => {
    if (!signerTokenExpiresAt) return '';
    const parsed = new Date(signerTokenExpiresAt);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }, [signerTokenExpiresAt]);

  const fieldValueForDisplay = (field, value) => {
    if (field.type === 'checkbox') return value === true || value === 'true' ? '✓' : '';
    if (field.type === 'radio') return (value === false || value === 'false') ? '' : String(value ?? '').trim();
    return String(value ?? '').trim();
  };

  const fieldValuesForSubmission = () => {
    const values = {};
    fields.forEach((field) => {
      if (!VALUE_FIELD_TYPES.has(field.type) || field.filled) return;
      const value = effectiveFieldValue(field);
      if (field.required || fieldValueIsComplete(field, value)) {
        values[field.id] = value;
      }
    });
    return values;
  };

  const sendAuthCode = async () => {
    setAuthError('');
    setAuthNotice('');
    setAuthSending(true);
    try {
      const result = await publicJsonFetch(`/signing/public/sign/${encodedToken}/auth/send`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setInfo((current) => current ? { ...current, auth: result.auth || current.auth } : current);
      setAuthNotice(result.message || 'Verification code sent.');
    } catch (authSendError) {
      setAuthError(authSendError.message || 'Could not send a verification code.');
    } finally {
      setAuthSending(false);
    }
  };

  const verifyAuthCode = async (event) => {
    event?.preventDefault?.();
    const code = authCode.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) {
      setAuthError('Enter the 6 digit verification code.');
      return;
    }
    setAuthError('');
    setAuthNotice('');
    setAuthVerifying(true);
    try {
      const result = await publicJsonFetch(`/signing/public/sign/${encodedToken}/auth/verify`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      writeSigningSession(token, result.sessionToken);
      setAuthSessionToken(result.sessionToken || '');
      setInfo((current) => current ? { ...current, auth: result.auth || current.auth } : current);
      setAuthCode('');
    } catch (authVerifyError) {
      setAuthError(authVerifyError.message || 'Could not verify that code.');
    } finally {
      setAuthVerifying(false);
    }
  };

  const uploadRonIdentityDocument = async () => {
    if (!ronIdentityFile) {
      setRonIdentityError('Choose a government ID image or PDF first.');
      return;
    }
    setRonIdentityUploading(true);
    setRonIdentityError('');
    try {
      const formData = new FormData();
      formData.append('idDocument', ronIdentityFile);
      const res = await fetch(`${BASE_URL}/signing/public/sign/${encodedToken}/ron/identity`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          ...(authSessionToken ? { 'X-Signing-Session': authSessionToken } : {}),
          ...(devSkipVerification ? { 'X-Signing-Dev-Bypass': 'true' } : {}),
        },
        body: formData,
      });
      const body = await parseResponseBody(res);
      if (!res.ok) {
        const err = new Error(body.error || `Identity proofing failed (${res.status}).`);
        err.status = res.status;
        throw err;
      }
      if (body.signingEvidence) {
        setInfo((current) => current ? {
          ...current,
          document: {
            ...current.document,
            signingEvidence: body.signingEvidence,
          },
        } : current);
      }
      setRonIdentityFile(null);
    } catch (identityError) {
      setRonIdentityError(identityError.message || 'Could not complete RON identity proofing.');
    } finally {
      setRonIdentityUploading(false);
    }
  };

  const downloadFinalPdf = async () => {
    if (!completion?.downloadUrl) return;
    setDownloadError('');
    setDownloadingFinal(true);
    try {
      const res = await fetch(`${BASE_URL}${completion.downloadUrl}`, {
        headers: {
          Accept: 'application/pdf',
          ...(authSessionToken ? { 'X-Signing-Session': authSessionToken } : {}),
          ...(devSkipVerification ? { 'X-Signing-Dev-Bypass': 'true' } : {}),
        },
      });
      if (!res.ok) {
        const message = await res.text().catch(() => '');
        throw new Error(message || `Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${completion.document?.name || 'signed-document'}.pdf`;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (downloadFailure) {
      setDownloadError(downloadFailure.message || 'Could not download the finalized PDF.');
    } finally {
      setDownloadingFinal(false);
    }
  };

  const scrollToField = (field) => {
    if (!field?.id) return;
    const target = pdfScrollRef.current?.querySelector(`[data-ext-field-id="${cssEscape(field.id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    window.setTimeout(() => {
      const focusTarget = target.matches('button, input, select, textarea')
        ? target
        : target.querySelector('button, input, select, textarea');
      focusTarget?.focus?.({ preventScroll: true });
    }, 240);
  };

  const goToRequiredField = (field) => {
    if (!field) return;
    scrollToField(field);
    if (SIGNATURE_FIELD_TYPES.has(field.type)) {
      window.setTimeout(() => { void openSignatureModal(field); }, 280);
    }
  };

  const openSignatureModal = async (field) => {
    if (!signatureDraft && !canStartSigning) {
      setActionError(signingBlockedReason);
      return;
    }

    const focus = field?.type === 'initials' ? 'initials' : 'signature';
    const mode = focus === 'initials' ? 'initials' : 'signature';
    const targetField = field?.type === 'signature' ? field : pendingSignatureField;
    if (focus === 'signature') {
      const mediaReady = await startMediaEvidenceCapture({ restart: Boolean(signatureDraft?.signatureData) });
      if (!mediaReady) return;
    }
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

    const capturedMediaEvidence = payload.signatureData && requiresMediaEvidence
      ? await stopMediaEvidenceCapture()
      : null;
    if (payload.signatureData && requiresMediaEvidence && !capturedMediaEvidence?.photoData) {
      throw new Error('Photo evidence could not be captured. Allow camera access and try again.');
    }
    if (payload.signatureData && requiresVideoEvidence && !capturedMediaEvidence?.videoData) {
      throw new Error('Video evidence could not be captured. Allow camera access and try again.');
    }
    if (payload.signatureData && evidenceMode === 'ron' && capturedMediaEvidence) {
      capturedMediaEvidence.ronSession = {
        notary: ronPolicy?.notary || null,
        identityMethod: ronPolicy?.identityMethod || 'credential_analysis_kba',
        identityStatus: ronIdentity?.status || 'not_started',
        meetingUrl: ronSession?.meetingUrl || '',
        roomId: ronSession?.roomId || '',
        sessionStatus: ronSession?.status || '',
        notaryStartedAt: ronSession?.notaryStartedAt || null,
        signerAcknowledgedAt: ronAcknowledged ? new Date().toISOString() : null,
        techCheckedAt: ronTechCheck.checkedAt || null,
        sessionStartedAt: capturedMediaEvidence.captureStartedAt || null,
        sessionStoppedAt: capturedMediaEvidence.captureStoppedAt || null,
      };
    }

    setSignatureDraft((current) => ({
      ...(current || {}),
      ...payload,
      fieldId: payload.fieldId || current?.fieldId,
      page: payload.page || current?.page,
      position: payload.position || current?.position,
      method: payload.method || current?.method,
      signatureTelemetry: payload.signatureTelemetry || current?.signatureTelemetry,
      mediaEvidence: capturedMediaEvidence || current?.mediaEvidence,
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
    if (missingRequiredValueField) {
      const label = fieldTypeConfig(missingRequiredValueField.type).label.toLowerCase();
      setActionError(`Complete the required ${label} field before sending.`);
      return;
    }
    if (!consentAccepted) {
      setActionError('Accept electronic signature consent before sending.');
      return;
    }

    setSubmittingSignature(true);
    setActionError('');
    try {
      const mediaEvidence = signatureDraft.mediaEvidence || await stopMediaEvidenceCapture();
      if (requiresMediaEvidence && !mediaEvidence?.photoData) {
        setActionError('Photo evidence is required for this signing request. Edit the signature and allow camera access.');
        setSubmittingSignature(false);
        return;
      }
      if (requiresVideoEvidence && !mediaEvidence?.videoData) {
        setActionError('Video evidence is required for this signing request. Edit the signature and allow camera access.');
        setSubmittingSignature(false);
        return;
      }
      const clientEvidence = await collectSigningClientEvidence({
        scope: token,
        includeLocation: includeLocationEvidence,
      });
      const result = await publicJsonFetch(`/signing/public/sign/${encodedToken}`, {
        method: 'POST',
        signingSessionToken: authSessionToken,
        idempotencyKey: idempotencyKey(),
        devSkipVerification,
        body: JSON.stringify({
          signatureData: signatureDraft.signatureData,
          initialsData: signatureDraft.initialsData,
          method: signatureDraft.method,
          signatureTelemetry: signatureDraft.signatureTelemetry,
          fieldId: signatureDraft.fieldId,
          page: signatureDraft.page,
          position: signatureDraft.position,
          fieldValues: fieldValuesForSubmission(),
          consentAccepted,
          consentVersion: info?.consent?.version,
          clientEvidence,
          mediaEvidence,
        }),
      });

      setSignatureDraft(null);
      setConsentAccepted(false);
      setIncludeLocationEvidence(false);
      mediaEvidenceRef.current = null;
      setCompletion(result.receipt || null);
      setSigned(true);
    } catch (submitError) {
      if (submitError.status === 401) {
        writeSigningSession(token, '');
        setAuthSessionToken('');
      }
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
        signingSessionToken: authSessionToken,
        devSkipVerification,
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
    const value = effectiveFieldValue(field);
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
      'data-ext-field-id': field.id,
      'aria-label': `${cfg.label}${field.required ? ' required' : ''}`,
    };

    if (!editable) {
      const displayValue = field.filled
        ? (field.type === 'radio' ? fieldValueForDisplay(field, field.fieldValue) : fieldDisplayValue(field))
        : fieldValueForDisplay(field, value);
      return (
        <div {...common}>
          {displayValue || cfg.label}
          {field.required && !field.filled && !displayValue && <span className="ext-field-req">*</span>}
        </div>
      );
    }

    if (field.type === 'checkbox') {
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

    if (field.type === 'radio') {
      const options = Array.isArray(field.fieldMeta?.options) && field.fieldMeta.options.length
        ? field.fieldMeta.options
        : ['Yes', 'No'];
      return (
        <fieldset {...common}>
          <div className="ext-radio-options">
            {options.map((option) => (
              <label key={option} className="ext-radio-option">
                <input
                  type="radio"
                  name={`ext-radio-${field.id}`}
                  value={option}
                  checked={String(value ?? '') === String(option)}
                  onChange={() => updateFieldValue(field.id, option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </fieldset>
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
              data-ext-field-id={field.id}
              onClick={() => { void openSignatureModal(field); }}
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

  if (info?.auth?.required && !info.auth.verified) {
    return (
      <div className="ext-root ext-screen">
        <div className="ext-screen-card ext-auth-card">
          <div className="ext-screen-mark" aria-hidden="true">ID</div>
          <h1>Verify your signing access</h1>
          <p className="ext-screen-msg">
            We will send a verification code to {info.signer?.maskedEmail || info.auth.maskedEmail || 'the signer email'} before showing the document.
          </p>
          <div className="ext-auth-actions">
            <button type="button" className="ext-secondary-button ext-secondary-button--wide" onClick={sendAuthCode} disabled={authSending || authVerifying}>
              {authSending ? 'Sending...' : 'Send Code'}
            </button>
            <form className="ext-auth-form" onSubmit={verifyAuthCode}>
              <input
                value={authCode}
                onChange={(event) => setAuthCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 digit code"
                aria-label="Verification code"
              />
              <button type="submit" className="ext-primary-button ext-primary-button--wide" disabled={authVerifying || authCode.length < 6}>
                {authVerifying ? 'Verifying...' : 'Verify'}
              </button>
            </form>
          </div>
          {authNotice && <div className="ext-inline-note">{authNotice}</div>}
          {authError && <div className="ext-inline-alert" role="alert">{authError}</div>}
          {info?.document?.name && <div className="ext-screen-docname">{info.document.name}</div>}
        </div>
      </div>
    );
  }

  if (signed || (info?.signer?.signingStatus === 'signed' && info?.auth?.verified)) {
    return (
      <div className="ext-root ext-screen">
        <div className="ext-screen-card">
          <div className="ext-screen-mark ext-screen-mark--success" aria-hidden="true">OK</div>
          <h1>You have signed this document</h1>
          <p className="ext-screen-msg">Your signature has been recorded in the signing audit trail.</p>
          {completion?.signature?.signedAt && (
            <div className="ext-receipt-grid">
              <span>Signed</span>
              <strong>{new Date(completion.signature.signedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong>
              <span>Audit hash</span>
              <strong>{completion.signature.auditHash?.slice(0, 18)}...</strong>
              <span>Status</span>
              <strong>{completion.finalization?.status === 'finalized' ? 'Finalized' : 'Recorded'}</strong>
            </div>
          )}
          {completion?.downloadUrl && (
            <button type="button" className="ext-primary-button ext-primary-button--wide" onClick={downloadFinalPdf} disabled={downloadingFinal}>
              {downloadingFinal ? 'Preparing PDF...' : 'Download Signed PDF'}
            </button>
          )}
          {downloadError && <div className="ext-inline-alert" role="alert">{downloadError}</div>}
          {info?.document?.name && <div className="ext-screen-docname">{info.document.name}</div>}
        </div>
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
              ? (draftReadyToSend ? submitSignatureDraft : () => { void openSignatureModal(!draftHasInitials && pendingInitialsField ? pendingInitialsField : pendingSignatureField); })
              : () => { void openSignatureModal(pendingSignatureField); }}
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
              <strong>{completedFieldItems} of {fieldItemCount}</strong>
            </div>
            <div className="ext-progress-track" aria-hidden="true">
              <span style={{ width: `${fieldProgress}%` }} />
            </div>
            {nextRequiredField && (
              <button
                type="button"
                className="ext-next-field-button"
                onClick={() => goToRequiredField(nextRequiredField)}
              >
                Next required field
              </button>
            )}
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
          {requiresMediaEvidence && (
            <div className="ext-inline-note">
              This request requires {evidenceMode === 'photo' ? 'a signer photo' : evidenceMode === 'video' ? 'signer video evidence' : 'audio/video evidence for RON review'} before it can be completed.
            </div>
          )}
          {evidenceMode === 'ron' && (
            <div className="ext-ron-card">
              <div className="ext-ron-card-head">
                <span>South African Notarization</span>
                <strong className={ronSession?.status === 'live' ? 'ext-ron-badge--live' : undefined}>
                  {ronSession?.status === 'live' ? '● LIVE' : ronTechCheck.status === 'passed' ? 'Ready' : 'Setup required'}
                </strong>
              </div>

              {/* Notary credentials */}
              <div className="ext-ron-detail">
                <span>Notary Public</span>
                <strong>{ronPolicy?.notary?.name || 'Assigned Notary'}</strong>
              </div>
              <div className="ext-ron-detail">
                <span>Admission / Commission</span>
                <strong>{ronPolicy?.notary?.admissionNumber || ronPolicy?.notary?.commissionNumber || 'Pending'}</strong>
              </div>
              <div className="ext-ron-detail">
                <span>High Court province</span>
                <strong>{ronPolicy?.notary?.province || ronPolicy?.notary?.commissionState || 'Pending'}</strong>
              </div>
              <div className="ext-ron-detail">
                <span>Identity proofing</span>
                <strong>
                  {ronPolicy?.identityMethod === 'personal_knowledge'
                    ? 'Notary personal knowledge'
                    : ronPolicy?.identityMethod === 'sa_id_document'
                      ? 'South African ID document'
                      : ronPolicy?.identityMethod === 'passport_document'
                        ? 'Passport document'
                        : 'Government ID verification'}
                </strong>
              </div>

              {/* SA document type info */}
              {ronPolicy?.saDocumentType && (
                <div className="ext-ron-detail">
                  <span>Document type</span>
                  <strong style={{ textTransform: 'capitalize' }}>{ronPolicy.saDocumentType.replace(/_/g, ' ')}</strong>
                </div>
              )}

              {/* Waiting room — scheduled session */}
              {sessionIsScheduledAndPending && (
                <div className="ext-ron-waiting-room">
                  <div className="ext-ron-waiting-icon">🗓</div>
                  <div>
                    <strong>Session scheduled</strong>
                    <p>Your notarization session is booked for:</p>
                    <div className="ext-ron-scheduled-time">
                      {new Date(scheduledSessionAt).toLocaleString('en-ZA', {
                        dateStyle: 'full',
                        timeStyle: 'short',
                        timeZone: 'Africa/Johannesburg',
                      })} (SAST)
                    </div>
                    <p>Please return at this time. The Notary Public will start the live video session.</p>
                  </div>
                </div>
              )}

              {/* Identity upload */}
              <div className="ext-ron-detail">
                <span>Identity status</span>
                <strong className={ronIdentity?.status === 'verified' ? 'ext-ron-verified' : undefined}>
                  {ronIdentity?.status === 'verified' ? '✓ Verified' : ronIdentity?.status || 'Not submitted'}
                </strong>
              </div>
              {ronPolicy?.identityMethod !== 'personal_knowledge' && ronIdentity?.status !== 'verified' && (
                <div className="ext-ron-upload">
                  <p className="ext-ron-upload-hint">
                    {ronPolicy?.identityMethod === 'passport_document'
                      ? 'Upload a clear photo or scan of your valid passport (photo page).'
                      : 'Upload a clear photo or scan of your South African ID book or smart ID card.'}
                  </p>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(event) => {
                      setRonIdentityFile(event.target.files?.[0] || null);
                      setRonIdentityError('');
                    }}
                    aria-label="Upload identity document"
                  />
                  <button
                    type="button"
                    className="ext-secondary-button ext-secondary-button--wide"
                    onClick={() => { void uploadRonIdentityDocument(); }}
                    disabled={ronIdentityUploading || !ronIdentityFile}
                  >
                    {ronIdentityUploading ? 'Submitting for verification...' : 'Submit identity document'}
                  </button>
                </div>
              )}
              {ronIdentityError && <div className="ext-inline-alert" role="alert">{ronIdentityError}</div>}

              {/* Live session */}
              <div className="ext-ron-detail">
                <span>Session status</span>
                <strong>{ronSession?.status || 'awaiting notary'}</strong>
              </div>
              {ronSession?.meetingUrl && (
                <div className="ext-ron-meeting">
                  <a href={ronSession.meetingUrl} target="_blank" rel="noreferrer" className="ext-ron-join-link">
                    Join live notarization session →
                  </a>
                  <iframe
                    src={ronSession.meetingUrl}
                    title="Live notarization session"
                    allow="camera; microphone; fullscreen; display-capture"
                  />
                </div>
              )}

              {/* Tech check */}
              <button
                type="button"
                className="ext-secondary-button ext-secondary-button--wide"
                onClick={() => { void runRonTechCheck(); }}
                disabled={ronTechCheck.status === 'checking'}
              >
                {ronTechCheck.status === 'checking'
                  ? 'Checking camera and microphone...'
                  : ronTechCheck.status === 'passed'
                    ? '✓ Camera and microphone ready'
                    : 'Test camera and microphone'}
              </button>
              {ronTechCheck.error && <div className="ext-inline-alert" role="alert">{ronTechCheck.error}</div>}

              {/* SA notarization acknowledgement */}
              <label className="ext-consent-check ext-consent-check--ron">
                <input
                  type="checkbox"
                  checked={ronAcknowledged}
                  onChange={(event) => setRonAcknowledged(event.target.checked)}
                />
                <span>
                  I confirm that I am appearing before the Notary Public in a live audio/video session,
                  my identity has been verified, and I am signing this document voluntarily and of my own free will
                  in accordance with South African law.
                </span>
              </label>

              {/* Apostille notice */}
              {ronPolicy?.apostilleRequired && (
                <div className="ext-ron-apostille-notice">
                  <strong>Apostille required:</strong> This document will be used abroad. After notarization,
                  an Apostille must be obtained from the Department of International Relations and Cooperation (DIRCO).
                </div>
              )}
            </div>
          )}
          {mediaCaptureError && <div className="ext-inline-alert" role="alert">{mediaCaptureError}</div>}

          <label className="ext-consent-check">
            <input
              type="checkbox"
              checked={consentAccepted}
              onChange={(event) => {
                setConsentAccepted(event.target.checked);
                if (event.target.checked && actionError === 'Accept electronic signature consent before sending.') {
                  setActionError('');
                }
              }}
            />
            <span>{info?.consent?.text || 'I agree to use electronic records and signatures for this document.'}</span>
          </label>
          <label className="ext-consent-check ext-consent-check--optional">
            <input
              type="checkbox"
              checked={includeLocationEvidence}
              onChange={(event) => setIncludeLocationEvidence(event.target.checked)}
            />
            <span>Include my location in the signing evidence. Your browser will ask for permission before sharing it.</span>
          </label>

          <div className="ext-side-actions">
            {signatureDraft ? (
              <>
                <button type="button" className="ext-primary-button ext-primary-button--wide" disabled={!canSubmitDraft} onClick={submitSignatureDraft}>
                  {submittingSignature ? 'Sending...' : 'Send Signed Document'}
                </button>
                <button
                  type="button"
                  className="ext-secondary-button ext-secondary-button--wide"
                  onClick={() => { void openSignatureModal(!draftHasInitials && pendingInitialsField ? pendingInitialsField : pendingSignatureField); }}
                >
                  {!draftHasInitials ? 'Add Initials' : 'Edit Signature'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="ext-primary-button ext-primary-button--wide" disabled={!canStartSigning} onClick={() => { void openSignatureModal(pendingSignatureField); }}>
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
            {linkExpiryLabel ? ` This link expires ${linkExpiryLabel}.` : ''}
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
          onClose={() => {
            if (captureMode === 'signature' && !signatureDraft?.signatureData) cancelActiveMediaCapture();
            setShowModal(false);
          }}
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

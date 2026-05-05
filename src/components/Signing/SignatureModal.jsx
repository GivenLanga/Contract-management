import { useRef, useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import './SignatureModal.css';

const MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024;
const DRAWN_SIGNATURE_MIN_POINTS = 3;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

const signatureMethodForTab = (tab) => {
  if (tab === 'upload') return 'uploaded';
  if (tab === 'type') return 'typed';
  return 'drawn';
};

const initialsFrom = (value) => {
  const source = String(value || 'Signer').replace(/@.*/, '');
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return (parts.length ? parts : [source])
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
};

export default function SignatureModal({ document, signingField, captureMode = 'signature', initialFocus = 'signature', submitLabel = 'Preview Signature', onClose, onSigned }) {
  const { user } = useAuth();
  const canvasRef = useRef(null);
  const initialsCanvasRef = useRef(null);
  const initialsSectionRef = useRef(null);
  const initialsInputRef = useRef(null);
  const signatureTelemetryRef = useRef({ strokes: [] });
  const activeSignatureStrokeRef = useRef(null);
  const [drawingKind, setDrawingKind] = useState('');
  const [tab, setTab] = useState('draw');
  const [uploadedSig, setUploadedSig] = useState(null);
  const [uploadedInitials, setUploadedInitials] = useState(null);
  const [typedName, setTypedName] = useState(user?.name || user?.email || '');
  const [typedInitials, setTypedInitials] = useState(initialsFrom(user?.name || user?.email));
  const [signerRole, setSignerRole] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasDrawnSignature, setHasDrawnSignature] = useState(false);
  const [hasDrawnInitials, setHasDrawnInitials] = useState(false);

  const userEmail = String(user?.email || '').trim().toLowerCase();
  const providedSignatureField = signingField?.type === 'signature' ? signingField : null;
  const myField = providedSignatureField || document.signingFields?.find(
    (field) => (!field.assignedTo || String(field.assignedTo).trim().toLowerCase() === userEmail) && !field.filled && field.type === 'signature'
  );

  const initCanvas = useCallback((canvas) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#1a2744';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    if (tab !== 'draw') return;
    initCanvas(canvasRef.current);
    signatureTelemetryRef.current = { strokes: [] };
    activeSignatureStrokeRef.current = null;
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

  const getPos = (canvas, event) => {
    const rect = canvas.getBoundingClientRect();
    const point = event.touches ? event.touches[0] : event;
    return {
      x: (point.clientX - rect.left) * (canvas.width / rect.width),
      y: (point.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const telemetryPoint = (canvas, event, pos) => ({
    x: Number(pos.x.toFixed(2)),
    y: Number(pos.y.toFixed(2)),
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
    const pos = getPos(canvas, event);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawingKind(kind);
    setError('');

    if (kind === 'signature') {
      const stroke = { points: [telemetryPoint(canvas, event, pos)] };
      activeSignatureStrokeRef.current = stroke;
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
    const pos = getPos(canvas, event);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();

    if (kind === 'signature' && activeSignatureStrokeRef.current) {
      activeSignatureStrokeRef.current.points.push(telemetryPoint(canvas, event, pos));
    }
  }, [drawingKind]);

  const endDraw = useCallback(() => {
    if (signatureTelemetryRef.current.startedAt) {
      signatureTelemetryRef.current.durationMs = Date.now() - signatureTelemetryRef.current.startedAt;
    }
    activeSignatureStrokeRef.current = null;
    setDrawingKind('');
  }, []);

  const startSignatureDraw = useCallback((event) => startDraw(canvasRef, 'signature', event), [startDraw]);
  const drawSignature = useCallback((event) => draw(canvasRef, 'signature', event), [draw]);
  const startInitialsDraw = useCallback((event) => startDraw(initialsCanvasRef, 'initials', event), [startDraw]);
  const drawInitials = useCallback((event) => draw(initialsCanvasRef, 'initials', event), [draw]);

  const clearCanvas = (ref, kind = 'signature') => {
    const canvas = ref?.current;
    if (!canvas) return;
    initCanvas(canvas);
    if (kind === 'initials') {
      setHasDrawnInitials(false);
    } else {
      signatureTelemetryRef.current = { strokes: [] };
      activeSignatureStrokeRef.current = null;
      setHasDrawnSignature(false);
    }
  };

  const removeBackground = (imageData) => {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      if (red > 230 && green > 230 && blue > 230) data[i + 3] = 0;
    }
    return imageData;
  };

  const canvasToTransparentPng = (canvas) => {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cleaned = removeBackground(imgData);
    const offscreen = window.document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    offscreen.getContext('2d').putImageData(cleaned, 0, 0);
    return offscreen.toDataURL('image/png');
  };

  const signaturePointCount = () =>
    (signatureTelemetryRef.current.strokes || []).reduce(
      (sum, stroke) => sum + (Array.isArray(stroke.points) ? stroke.points.length : 0),
      0
    );

  const typedSignatureData = () => {
    const name = typedName.trim();
    if (!name) return null;

    const canvas = window.document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1a2744';

    let fontSize = 48;
    do {
      ctx.font = `italic ${fontSize}px Georgia, "Times New Roman", serif`;
      fontSize -= 2;
    } while (ctx.measureText(name).width > canvas.width - 48 && fontSize > 24);

    ctx.textBaseline = 'middle';
    ctx.fillText(name, 24, canvas.height / 2 + 4);
    return canvas.toDataURL('image/png');
  };

  const typedInitialsData = () => {
    const initials = typedInitials.trim().toUpperCase().slice(0, 4);
    if (!initials) return null;

    const canvas = window.document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 70;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '700 34px Arial, sans-serif';
    ctx.fillStyle = '#1a2744';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 14, canvas.height / 2 + 2);
    return canvas.toDataURL('image/png');
  };

  const getSignatureData = () => {
    if (tab === 'draw') {
      if (!hasDrawnSignature || signaturePointCount() < DRAWN_SIGNATURE_MIN_POINTS) return null;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      return canvasToTransparentPng(canvas);
    }
    if (tab === 'upload') return uploadedSig;
    if (tab === 'type') return typedSignatureData();
    return null;
  };

  const getInitialsData = () => {
    const canvas = initialsCanvasRef.current;
    if (canvas && hasDrawnInitials) return canvasToTransparentPng(canvas);
    if (uploadedInitials) return uploadedInitials;
    return typedInitialsData();
  };

  const handleFileUpload = (setter, label) => (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setError(`${label} must be a PNG or JPG image.`);
      event.target.value = '';
      return;
    }

    if (file.size > MAX_SIGNATURE_IMAGE_BYTES) {
      setError(`${label} must be 2 MB or smaller.`);
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      setError('');
      setter(String(loadEvent.target?.result || ''));
    };
    reader.onerror = () => setError(`Could not read the ${label.toLowerCase()} image.`);
    reader.readAsDataURL(file);
  };

  const handleSign = async () => {
    const wantsSignature = captureMode !== 'initials';
    const wantsInitials = captureMode !== 'signature';

    if (wantsSignature && tab === 'draw' && hasDrawnSignature && signaturePointCount() < DRAWN_SIGNATURE_MIN_POINTS) {
      setError('Add a little more ink to your signature before signing.');
      return;
    }

    const sigData = wantsSignature ? getSignatureData() : null;
    if (wantsSignature && (!sigData || sigData === 'data:,')) {
      setError(tab === 'type' ? 'Type your full name before signing.' : 'Provide your signature before signing.');
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
          signatureData: sigData,
          method: signatureMethodForTab(tab),
          signatureTelemetry: tab === 'draw' ? signatureTelemetryRef.current : undefined,
          fieldId: myField?.id,
          page: myField?.page || 1,
          position: myField ? {
            x: myField.x,
            y: myField.y,
            width: myField.width,
            height: myField.height,
            origin: myField.coordinateOrigin || 'normalized',
          } : undefined,
          signerRole: signerRole || myField?.role,
        } : {}),
        ...(wantsInitials ? { initialsData } : {}),
      });
    } catch (err) {
      setError(err.message || 'Unable to record signature.');
    } finally {
      setLoading(false);
    }
  };

  const changeTab = (nextTab) => {
    setError('');
    setTab(nextTab);
  };

  return (
    <div className="sig-overlay" onClick={(event) => event.target === event.currentTarget && !loading && onClose()}>
      <div className="sig-modal" role="dialog" aria-modal="true" aria-labelledby="sig-modal-title">
        <div className="sig-modal-header">
          <div>
            <h2 id="sig-modal-title">{captureMode === 'initials' ? 'Add Initials' : 'Add Signature'}</h2>
            <p>{document.name}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} disabled={loading} aria-label="Close signing dialog">x</button>
        </div>

        <div className="sig-modal-body">
          <div className="sig-info-bar">
            <span>Signing as: <strong>{user?.name || user?.email}</strong>{user?.email ? ` (${user.email})` : ''}</span>
            {myField && <span className="sig-role-tag">{myField.role || 'Signatory'}</span>}
          </div>

          {!myField && (
            <div className="sig-role-field">
              <label>Your signing role</label>
              <input
                value={signerRole}
                onChange={(event) => setSignerRole(event.target.value)}
                placeholder="e.g. Lender, Borrower, Witness"
              />
            </div>
          )}

          {captureMode !== 'initials' && (
          <div className="sig-section">
            <h3>Your Signature</h3>
            <div className="sig-tabs" role="tablist" aria-label="Signature method">
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
                  className={`sig-tab${tab === key ? ' sig-tab--active' : ''}`}
                  onClick={() => changeTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'draw' && (
              <div className="sig-canvas-wrap">
                <canvas
                  ref={canvasRef}
                  width={560}
                  height={160}
                  className="sig-canvas"
                  aria-label="Draw your signature"
                  onMouseDown={startSignatureDraw}
                  onMouseMove={drawSignature}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={startSignatureDraw}
                  onTouchMove={drawSignature}
                  onTouchEnd={endDraw}
                  onTouchCancel={endDraw}
                />
                <button type="button" className="sig-clear-btn" onClick={() => clearCanvas(canvasRef)}>
                  Clear
                </button>
                <p className="sig-hint">Draw your signature above.</p>
              </div>
            )}

            {tab === 'upload' && (
              <div className="sig-upload-area">
                <label className="sig-upload-label">
                  {uploadedSig ? (
                    <img src={uploadedSig} alt="Signature preview" className="sig-preview" />
                  ) : (
                    <div className="sig-upload-placeholder">
                      <span className="sig-upload-icon" aria-hidden="true">PNG</span>
                      <p>Choose a signature image</p>
                      <span>PNG or JPG, 2 MB max.</span>
                    </div>
                  )}
                  <input type="file" accept="image/png,image/jpeg" hidden onChange={handleFileUpload(setUploadedSig, 'Signature')} />
                </label>
              </div>
            )}

            {tab === 'type' && (
              <div className="sig-type-area">
                <input
                  className="sig-type-input"
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                  placeholder="Type your full legal name"
                />
                <div className="sig-type-preview" aria-hidden="true">{typedName}</div>
              </div>
            )}
          </div>
          )}

          {captureMode !== 'signature' && (
          <div className="sig-section sig-section--initials" ref={initialsSectionRef}>
            <h3>Initials <span className="sig-optional">used for any initials fields assigned to you</span></h3>
            <div className="sig-initials-wrap">
              <canvas
                ref={initialsCanvasRef}
                width={180}
                height={60}
                className="sig-canvas sig-canvas--initials"
                aria-label="Draw your initials"
                onMouseDown={startInitialsDraw}
                onMouseMove={drawInitials}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startInitialsDraw}
                onTouchMove={drawInitials}
                onTouchEnd={endDraw}
                onTouchCancel={endDraw}
              />
              <div className="sig-initials-actions">
                <button type="button" className="sig-clear-btn" onClick={() => clearCanvas(initialsCanvasRef, 'initials')}>
                  Clear
                </button>
                <label className="sig-upload-btn">
                  Upload
                  <input type="file" accept="image/png,image/jpeg" hidden onChange={handleFileUpload(setUploadedInitials, 'Initials')} />
                </label>
              </div>
            </div>
            <label className="sig-initials-typed">
              <span>Typed initials</span>
              <input
                ref={initialsInputRef}
                value={typedInitials}
                onChange={(event) => setTypedInitials(event.target.value.toUpperCase().slice(0, 4))}
                maxLength={4}
                aria-label="Typed initials"
              />
            </label>
            <p className="sig-hint">Draw or upload initials, or keep the typed initials shown here.</p>
          </div>
          )}

          {error && <div className="sig-error" role="alert">{error}</div>}
        </div>

        <div className="sig-modal-footer">
          <div className="sig-legal-notice">
            Review the placed signature and initials on the document before sending.
          </div>
          <div className="sig-actions">
            <button type="button" className="sig-btn sig-btn--cancel" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="button" className="sig-btn sig-btn--sign" onClick={handleSign} disabled={loading}>
              {loading ? 'Preparing...' : submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useRef, useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import './SignatureModal.css';

export default function SignatureModal({ document, signingField, onClose, onSigned }) {
  const { user } = useAuth();
  const canvasRef = useRef();
  const initialsCanvasRef = useRef();
  const signatureTelemetryRef = useRef({ strokes: [] });
  const activeSignatureStrokeRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [tab, setTab] = useState('draw');
  const [uploadedSig, setUploadedSig] = useState(null);
  const [uploadedInitials, setUploadedInitials] = useState(null);
  const [typedName, setTypedName] = useState(user?.name || '');
  const [signerRole, setSignerRole] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasDrawnSignature, setHasDrawnSignature] = useState(false);
  const [hasDrawnInitials, setHasDrawnInitials] = useState(false);

  // Find the signing field assigned to this user
  const myField = signingField || document.signingFields?.find(
    (f) => (f.assignedTo === user?.email || !f.assignedTo) && !f.filled
  );

  const initCanvas = useCallback((ref) => {
    const canvas = ref?.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#1a2744';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    initCanvas(canvasRef);
    initCanvas(initialsCanvasRef);
  }, [initCanvas, tab]);

  const getPos = (canvas, e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const telemetryPoint = (canvas, e, pos) => ({
    x: Number(pos.x.toFixed(2)),
    y: Number(pos.y.toFixed(2)),
    t: Math.round(performance.now()),
    pressure: Number((e.pressure ?? e.touches?.[0]?.force ?? 0).toFixed(3)),
    pointerType: e.pointerType || (e.touches ? 'touch' : 'mouse'),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });

  const startDraw = useCallback((ref, kind, e) => {
    e.preventDefault();
    setDrawing(true);
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pos = getPos(canvas, e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    if (kind === 'initials') {
      setHasDrawnInitials(true);
    } else {
      const stroke = { points: [telemetryPoint(canvas, e, pos)] };
      activeSignatureStrokeRef.current = stroke;
      signatureTelemetryRef.current = {
        startedAt: Date.now(),
        devicePixelRatio: window.devicePixelRatio || 1,
        strokes: [...(signatureTelemetryRef.current.strokes || []), stroke],
      };
      setHasDrawnSignature(true);
    }
  }, []);

  const draw = useCallback((ref, kind, e) => {
    e.preventDefault();
    if (!drawing) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pos = getPos(canvas, e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    if (kind === 'signature' && activeSignatureStrokeRef.current) {
      activeSignatureStrokeRef.current.points.push(telemetryPoint(canvas, e, pos));
    }
  }, [drawing]);

  const endDraw = useCallback(() => {
    setDrawing(false);
    activeSignatureStrokeRef.current = null;
    if (signatureTelemetryRef.current.startedAt) {
      signatureTelemetryRef.current.durationMs = Date.now() - signatureTelemetryRef.current.startedAt;
    }
  }, []);

  const startSignatureDraw = useCallback((event) => startDraw(canvasRef, 'signature', event), [startDraw]);
  const drawSignature = useCallback((event) => draw(canvasRef, 'signature', event), [draw]);
  const startInitialsDraw = useCallback((event) => startDraw(initialsCanvasRef, 'initials', event), [startDraw]);
  const drawInitials = useCallback((event) => draw(initialsCanvasRef, 'initials', event), [draw]);

  const clearCanvas = (ref, kind = 'signature') => {
    const canvas = ref?.current;
    if (!canvas) return;
    initCanvas({ current: canvas });
    if (kind === 'initials') {
      setHasDrawnInitials(false);
    } else {
      signatureTelemetryRef.current = { strokes: [] };
      activeSignatureStrokeRef.current = null;
      setHasDrawnSignature(false);
    }
  };

  const removeBackground = (imageData) => {
    // Simple white background removal
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 230 && g > 230 && b > 230) data[i + 3] = 0;
    }
    return imageData;
  };

  const getSignatureData = () => {
    if (tab === 'draw') {
      if (!hasDrawnSignature) return null;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const cleaned = removeBackground(imgData);
      const offscreen = window.document.createElement('canvas');
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      offscreen.getContext('2d').putImageData(cleaned, 0, 0);
      return offscreen.toDataURL('image/png');
    }
    if (tab === 'upload') return uploadedSig;
    if (tab === 'type') {
      // Generate typed signature as canvas image
      const canvas = window.document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'transparent';
      ctx.font = 'italic 42px Georgia, serif';
      ctx.fillStyle = '#1a2744';
      ctx.fillText(typedName, 20, 70);
      return canvas.toDataURL('image/png');
    }
    return null;
  };

  const getInitialsData = () => {
    const canvas = initialsCanvasRef?.current;
    if (canvas && hasDrawnInitials) {
      return canvas.toDataURL('image/png');
    }
    if (uploadedInitials) return uploadedInitials;
    // Auto-generate initials
    const initials = user?.name?.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 3) || 'XX';
    const c = window.document.createElement('canvas');
    c.width = 120; c.height = 50;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#1a2744';
    ctx.fillText(initials, 10, 38);
    return c.toDataURL('image/png');
  };

  const handleFileUpload = (setter) => (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setter(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleSign = async () => {
    const sigData = getSignatureData();
    if (!sigData || sigData === 'data:,' ) {
      setError('Please provide your signature before signing.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await onSigned({
        signatureData: sigData,
        initialsData: getInitialsData(),
        method: tab,
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
      });
    } catch (err) {
      setError(err.message || 'Unable to record signature.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sig-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sig-modal">
        <div className="sig-modal-header">
          <div>
            <h2>Sign Document</h2>
            <p>{document.name}</p>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="sig-modal-body">
          <div className="sig-info-bar">
            <span>Signing as: <strong>{user?.name}</strong> ({user?.email})</span>
            {myField && <span className="sig-role-tag">{myField.role || 'Signatory'}</span>}
          </div>

          {!myField && (
            <div className="sig-role-field">
              <label>Your signing role</label>
              <input
                value={signerRole}
                onChange={(e) => setSignerRole(e.target.value)}
                placeholder="e.g. Lender, Borrower, Witness"
              />
            </div>
          )}

          <div className="sig-section">
            <h3>Your Signature</h3>
            <div className="sig-tabs">
              {[['draw', '✏️ Draw'], ['upload', '📁 Upload'], ['type', 'T Type']].map(([key, label]) => (
                <button
                  key={key}
                  className={`sig-tab${tab === key ? ' sig-tab--active' : ''}`}
                  onClick={() => setTab(key)}
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
                  onMouseDown={startSignatureDraw}
                  onMouseMove={drawSignature}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={startSignatureDraw}
                  onTouchMove={drawSignature}
                  onTouchEnd={endDraw}
                />
                <button className="sig-clear-btn" onClick={() => clearCanvas(canvasRef)}>Clear</button>
                <p className="sig-hint">Draw your signature above</p>
              </div>
            )}

            {tab === 'upload' && (
              <div className="sig-upload-area">
                <label className="sig-upload-label">
                  {uploadedSig ? (
                    <img src={uploadedSig} alt="Signature" className="sig-preview" />
                  ) : (
                    <div className="sig-upload-placeholder">
                      <span>📁</span>
                      <p>Click to upload signature image</p>
                      <span>PNG, JPG — white background will be removed</span>
                    </div>
                  )}
                  <input type="file" accept="image/*" hidden onChange={handleFileUpload(setUploadedSig)} />
                </label>
              </div>
            )}

            {tab === 'type' && (
              <div className="sig-type-area">
                <input
                  className="sig-type-input"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder="Type your full name"
                />
                <div className="sig-type-preview">{typedName}</div>
              </div>
            )}
          </div>

          <div className="sig-section sig-section--initials">
            <h3>Initials <span className="sig-optional">(auto-added to middle pages)</span></h3>
            <div className="sig-initials-wrap">
              <canvas
                ref={initialsCanvasRef}
                width={180}
                height={60}
                className="sig-canvas sig-canvas--initials"
                onMouseDown={startInitialsDraw}
                onMouseMove={drawInitials}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
              />
              <div className="sig-initials-actions">
                <button className="sig-clear-btn" onClick={() => clearCanvas(initialsCanvasRef, 'initials')}>Clear</button>
                <label className="sig-upload-btn">
                  Upload
                  <input type="file" accept="image/*" hidden onChange={handleFileUpload(setUploadedInitials)} />
                </label>
              </div>
            </div>
            <p className="sig-hint">Leave blank to use auto-generated initials</p>
          </div>

          {error && <div className="sig-error">{error}</div>}
        </div>

        <div className="sig-modal-footer">
          <div className="sig-legal-notice">
            By clicking "Sign Document", you agree that this electronic signature is the legal equivalent of your manual signature.
          </div>
          <div className="sig-actions">
            <button className="sig-btn sig-btn--cancel" onClick={onClose}>Cancel</button>
            <button className="sig-btn sig-btn--sign" onClick={handleSign} disabled={loading}>
              {loading ? 'Signing...' : 'Sign Document'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

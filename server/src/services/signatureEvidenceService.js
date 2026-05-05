const crypto = require('crypto');

const sha256 = (value) =>
  crypto.createHash('sha256').update(value || '').digest('hex');

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const dataUriPayload = (dataUri) =>
  String(dataUri || '').replace(/^data:[^;]+;base64,/, '');

const imageHash = (dataUri) => sha256(dataUriPayload(dataUri));

const normalizeSignatureMethod = (method) => {
  const value = String(method || '').trim().toLowerCase();
  if (value === 'upload' || value === 'uploaded') return 'uploaded';
  if (value === 'type' || value === 'typed') return 'typed';
  return 'drawn';
};

const summarizePointerTelemetry = (telemetry = {}) => {
  const strokes = Array.isArray(telemetry.strokes) ? telemetry.strokes : [];
  const events = strokes.flatMap((stroke) => Array.isArray(stroke.points) ? stroke.points : []);
  const pressures = events
    .map((event) => Number(event.pressure))
    .filter((value) => Number.isFinite(value));
  const timestamps = events
    .map((event) => Number(event.t))
    .filter((value) => Number.isFinite(value));
  const pointerTypes = [...new Set(events.map((event) => event.pointerType).filter(Boolean))];
  const durationMs = timestamps.length > 1
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : Number(telemetry.durationMs) || null;

  return {
    strokeCount: strokes.length,
    pointCount: events.length,
    durationMs,
    pointerTypes,
    pressure: pressures.length
      ? {
          min: Math.min(...pressures),
          max: Math.max(...pressures),
          avg: pressures.reduce((sum, value) => sum + value, 0) / pressures.length,
        }
      : null,
    devicePixelRatio: Number(telemetry.devicePixelRatio) || null,
  };
};

const fraudSignals = ({ telemetry, ipAddress, userAgent, method }) => {
  const warnings = [];
  const summary = summarizePointerTelemetry(telemetry);

  if (!ipAddress) warnings.push('missing_ip_address');
  if (!userAgent) warnings.push('missing_user_agent');
  if (method === 'drawn' && summary.pointCount < 8) warnings.push('low_signature_motion_data');
  if (method === 'uploaded') warnings.push('uploaded_signature_image');
  if (summary.durationMs !== null && summary.durationMs < 300) warnings.push('very_fast_signature');

  return {
    riskScore: Math.min(100, warnings.length * 20),
    warnings,
    summary,
  };
};

const buildSignatureEvidence = ({
  signatureData,
  initialsData,
  telemetry,
  ipAddress,
  userAgent,
  method,
  signedAt,
}) => {
  const normalizedMethod = normalizeSignatureMethod(method);
  const signatureImageHash = imageHash(signatureData);
  const initialsImageHash = initialsData ? imageHash(initialsData) : '';
  const telemetryHash = telemetry ? sha256(stableJson(telemetry)) : '';
  const signals = fraudSignals({
    telemetry,
    ipAddress,
    userAgent,
    method: normalizedMethod,
  });

  return {
    normalizedMethod,
    signatureImageHash,
    initialsImageHash,
    evidence: {
      signedAt,
      ipAddress,
      userAgent,
      signatureMethod: normalizedMethod,
      signatureImageHash,
      initialsImageHash,
      strokeHash: telemetryHash,
      strokeCount: signals.summary.strokeCount,
      pointCount: signals.summary.pointCount,
      durationMs: signals.summary.durationMs,
      pointerTypes: signals.summary.pointerTypes,
      pressure: signals.summary.pressure,
      devicePixelRatio: signals.summary.devicePixelRatio,
      riskScore: signals.riskScore,
      warnings: signals.warnings,
    },
  };
};

module.exports = {
  sha256,
  imageHash,
  buildSignatureEvidence,
  normalizeSignatureMethod,
  summarizePointerTelemetry,
};

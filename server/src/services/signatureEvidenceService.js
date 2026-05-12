const crypto = require('crypto');
const { stableJson } = require('../utils/stableJson');

const sha256 = (value) =>
  crypto.createHash('sha256').update(value || '').digest('hex');

const dataUriPayload = (dataUri) =>
  String(dataUri || '').replace(/^data:[^;]+;base64,/, '');

const imageHash = (dataUri) => sha256(dataUriPayload(dataUri));
const limitedString = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const finiteNumber = (value, { min = -Infinity, max = Infinity } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
};

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

const DRAWN_SIGNATURE_MIN_POINTS = Number(process.env.DRAWN_SIGNATURE_MIN_POINTS) || 8;

const fraudSignals = ({ telemetry, ipAddress, userAgent, method }) => {
  const warnings = [];
  const summary = summarizePointerTelemetry(telemetry);

  if (!ipAddress) warnings.push('missing_ip_address');
  if (!userAgent) warnings.push('missing_user_agent');
  if (method === 'drawn' && summary.pointCount < DRAWN_SIGNATURE_MIN_POINTS) warnings.push('low_signature_motion_data');
  if (method === 'uploaded') warnings.push('uploaded_signature_image');
  if (summary.durationMs !== null && summary.durationMs < 300) warnings.push('very_fast_signature');

  return {
    riskScore: Math.min(100, warnings.length * 20),
    warnings,
    summary,
  };
};

const sanitizeClientEvidence = (clientEvidence = {}) => {
  if (!clientEvidence || typeof clientEvidence !== 'object') return null;
  const rawDevice = clientEvidence.device && typeof clientEvidence.device === 'object' ? clientEvidence.device : {};
  const rawLocation = clientEvidence.location && typeof clientEvidence.location === 'object' ? clientEvidence.location : {};
  const device = {
    collectedAt: limitedString(rawDevice.collectedAt, 60),
    userAgent: limitedString(rawDevice.userAgent, 700),
    platform: limitedString(rawDevice.platform, 120),
    vendor: limitedString(rawDevice.vendor, 120),
    language: limitedString(rawDevice.language, 40),
    languages: Array.isArray(rawDevice.languages) ? rawDevice.languages.slice(0, 8).map((item) => limitedString(item, 40)) : [],
    timezone: limitedString(rawDevice.timezone, 80),
    timezoneOffsetMinutes: finiteNumber(rawDevice.timezoneOffsetMinutes, { min: -1440, max: 1440 }),
    cookieEnabled: Boolean(rawDevice.cookieEnabled),
    doNotTrack: limitedString(rawDevice.doNotTrack, 20),
    hardwareConcurrency: finiteNumber(rawDevice.hardwareConcurrency, { min: 0, max: 512 }),
    maxTouchPoints: finiteNumber(rawDevice.maxTouchPoints, { min: 0, max: 64 }),
    deviceMemory: finiteNumber(rawDevice.deviceMemory, { min: 0, max: 1024 }),
    devicePixelRatio: finiteNumber(rawDevice.devicePixelRatio, { min: 0, max: 20 }),
    screen: {
      width: finiteNumber(rawDevice.screen?.width, { min: 0, max: 20000 }),
      height: finiteNumber(rawDevice.screen?.height, { min: 0, max: 20000 }),
      availWidth: finiteNumber(rawDevice.screen?.availWidth, { min: 0, max: 20000 }),
      availHeight: finiteNumber(rawDevice.screen?.availHeight, { min: 0, max: 20000 }),
      colorDepth: finiteNumber(rawDevice.screen?.colorDepth, { min: 0, max: 128 }),
    },
    viewport: {
      width: finiteNumber(rawDevice.viewport?.width, { min: 0, max: 20000 }),
      height: finiteNumber(rawDevice.viewport?.height, { min: 0, max: 20000 }),
    },
    userAgentData: rawDevice.userAgentData && typeof rawDevice.userAgentData === 'object'
      ? {
          brands: Array.isArray(rawDevice.userAgentData.brands)
            ? rawDevice.userAgentData.brands.slice(0, 8).map((brand) => ({
                brand: limitedString(brand?.brand, 80),
                version: limitedString(brand?.version, 40),
              }))
            : [],
          mobile: Boolean(rawDevice.userAgentData.mobile),
          platform: limitedString(rawDevice.userAgentData.platform, 80),
          highEntropy: rawDevice.userAgentData.highEntropy && typeof rawDevice.userAgentData.highEntropy === 'object'
            ? {
                architecture: limitedString(rawDevice.userAgentData.highEntropy.architecture, 40),
                bitness: limitedString(rawDevice.userAgentData.highEntropy.bitness, 20),
                model: limitedString(rawDevice.userAgentData.highEntropy.model, 100),
                platformVersion: limitedString(rawDevice.userAgentData.highEntropy.platformVersion, 80),
                fullVersionList: Array.isArray(rawDevice.userAgentData.highEntropy.fullVersionList)
                  ? rawDevice.userAgentData.highEntropy.fullVersionList.slice(0, 8).map((brand) => ({
                      brand: limitedString(brand?.brand, 80),
                      version: limitedString(brand?.version, 80),
                    }))
                  : [],
              }
            : undefined,
        }
      : null,
  };
  const location = {
    consent: Boolean(rawLocation.consent),
    status: limitedString(rawLocation.status || 'not_requested', 40),
    source: limitedString(rawLocation.source, 80),
    permissionState: limitedString(rawLocation.permissionState, 40),
    reason: limitedString(rawLocation.reason, 120),
    code: finiteNumber(rawLocation.code, { min: 0, max: 10 }),
    message: limitedString(rawLocation.message, 180),
    collectedAt: limitedString(rawLocation.collectedAt, 60),
    positionTimestamp: limitedString(rawLocation.positionTimestamp, 60),
    latitude: finiteNumber(rawLocation.latitude, { min: -90, max: 90 }),
    longitude: finiteNumber(rawLocation.longitude, { min: -180, max: 180 }),
    accuracyMeters: finiteNumber(rawLocation.accuracyMeters, { min: 0, max: 1000000 }),
    altitude: finiteNumber(rawLocation.altitude, { min: -12000, max: 100000 }),
    altitudeAccuracyMeters: finiteNumber(rawLocation.altitudeAccuracyMeters, { min: 0, max: 1000000 }),
    heading: finiteNumber(rawLocation.heading, { min: 0, max: 360 }),
    speedMetersPerSecond: finiteNumber(rawLocation.speedMetersPerSecond, { min: 0, max: 12000 }),
  };
  const sanitized = {
    evidenceVersion: Number(clientEvidence.evidenceVersion) || 1,
    collectedAt: limitedString(clientEvidence.collectedAt, 60),
    deviceSessionId: limitedString(clientEvidence.deviceSessionId, 120),
    device,
    location,
  };
  return {
    ...sanitized,
    deviceProfileHash: sha256(stableJson(device)),
    locationHash: sha256(stableJson(location)),
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
  documentId,
  signerEmail,
  fieldId,
  page,
  position,
  fieldValues,
  documentHash,
  consent,
  clientEvidence,
  mediaEvidence,
  imageMetadata,
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

  const fieldValuesHash = fieldValues ? sha256(stableJson(fieldValues)) : '';
  const consentEvidence = consent || null;
  const sanitizedClientEvidence = sanitizeClientEvidence(clientEvidence);
  const clientEvidenceHash = sanitizedClientEvidence ? sha256(stableJson(sanitizedClientEvidence)) : '';
  const mediaEvidenceHash = mediaEvidence ? sha256(stableJson(mediaEvidence)) : '';
  const imageMetadataHash = imageMetadata ? sha256(stableJson(imageMetadata)) : '';
  const evidenceHash = sha256(stableJson({
    version: 3,
    documentId: String(documentId || ''),
    signerEmail: String(signerEmail || '').toLowerCase().trim(),
    signedAt,
    signatureMethod: normalizedMethod,
    signatureImageHash,
    initialsImageHash,
    strokeHash: telemetryHash,
    documentHash: documentHash || '',
    fieldId: fieldId || '',
    page: page || '',
    position: position || null,
    fieldValuesHash,
    consent: consentEvidence,
    clientEvidenceHash,
    mediaEvidenceHash,
    imageMetadataHash,
    ipAddress: ipAddress || '',
    userAgent: userAgent || '',
  }));

  return {
    normalizedMethod,
    signatureImageHash,
    initialsImageHash,
    evidence: {
      evidenceVersion: 3,
      signedAt,
      ipAddress,
      userAgent,
      documentId: String(documentId || ''),
      signerEmail: String(signerEmail || '').toLowerCase().trim(),
      documentHash: documentHash || '',
      fieldId: fieldId || '',
      page: page || null,
      position: position || null,
      fieldValuesHash,
      signatureMethod: normalizedMethod,
      consent: consentEvidence,
      clientEvidence: sanitizedClientEvidence,
      clientEvidenceHash,
      mediaEvidence: mediaEvidence || null,
      mediaEvidenceHash,
      imageMetadata: imageMetadata || null,
      imageMetadataHash,
      signatureImageHash,
      initialsImageHash,
      strokeHash: telemetryHash,
      evidenceHash,
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

// Platform attestation — the platform acts as a cryptographic witness to the signing event.
// Uses HMAC-SHA256 keyed to a platform secret so the attestation is verifiable server-side
// but cannot be forged externally. This is the AES (Advanced Electronic Signature) model
// used by DocuSign and Adobe Sign: the platform issues its own certificate of witnessing
// rather than requiring the signer to hold a private key.
const platformAttestationSecret = () => {
  const secret = process.env.PLATFORM_ATTESTATION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'PLATFORM_ATTESTATION_SECRET or ENCRYPTION_KEY must be set. ' +
      'Signature attestation cannot proceed without a configured secret in any environment.'
    );
  }
  return secret;
};

const ensurePlatformAttestationConfigured = () => {
  platformAttestationSecret();
};

const buildPlatformAttestation = (signature) => {
  const secret = platformAttestationSecret();
  const witnessedAt = new Date().toISOString();
  const payload = [
    'ContractIQ',
    String(signature.document || ''),
    String(signature.signerEmail || '').toLowerCase().trim(),
    signature.signedAt instanceof Date
      ? signature.signedAt.toISOString()
      : String(signature.signedAt || ''),
    String(signature.auditHash || ''),
    String(signature.ipAddress || ''),
    witnessedAt,
  ].join(':');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `contractiq-witness-v1:${witnessedAt}:${hmac}`;
};

module.exports = {
  sha256,
  imageHash,
  buildSignatureEvidence,
  buildPlatformAttestation,
  ensurePlatformAttestationConfigured,
  normalizeSignatureMethod,
  summarizePointerTelemetry,
};

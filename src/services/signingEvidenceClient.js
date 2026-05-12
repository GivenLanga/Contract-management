const SESSION_PREFIX = 'contractiq:signing-session:';

const limitedString = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const storageKeyFor = (scope) => `${SESSION_PREFIX}${limitedString(scope || 'default', 120)}`;

const randomId = () => {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const signingSessionId = (scope) => {
  const key = storageKeyFor(scope);
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = randomId();
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    return randomId();
  }
};

const collectUserAgentData = async () => {
  const uaData = navigator.userAgentData;
  if (!uaData) return null;

  const lowEntropy = {
    brands: uaData.brands || [],
    mobile: Boolean(uaData.mobile),
    platform: limitedString(uaData.platform, 80),
  };

  try {
    const highEntropy = await uaData.getHighEntropyValues([
      'architecture',
      'bitness',
      'model',
      'platformVersion',
      'fullVersionList',
    ]);
    return { ...lowEntropy, highEntropy };
  } catch {
    return lowEntropy;
  }
};

const permissionState = async (name) => {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const result = await navigator.permissions.query({ name });
    return result.state || 'unknown';
  } catch {
    return 'unknown';
  }
};

const collectLocation = async (includeLocation) => {
  if (!includeLocation) {
    return {
      consent: false,
      status: 'not_requested',
      collectedAt: new Date().toISOString(),
    };
  }

  if (!window.isSecureContext) {
    return {
      consent: true,
      status: 'unavailable',
      reason: 'secure_context_required',
      collectedAt: new Date().toISOString(),
    };
  }

  if (!navigator.geolocation) {
    return {
      consent: true,
      status: 'unavailable',
      reason: 'geolocation_api_unavailable',
      collectedAt: new Date().toISOString(),
    };
  }

  const beforePermission = await permissionState('geolocation');

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = position.coords || {};
        resolve({
          consent: true,
          status: 'captured',
          source: 'browser_geolocation',
          permissionState: beforePermission,
          collectedAt: new Date().toISOString(),
          positionTimestamp: position.timestamp ? new Date(position.timestamp).toISOString() : null,
          latitude: finiteNumber(coords.latitude),
          longitude: finiteNumber(coords.longitude),
          accuracyMeters: finiteNumber(coords.accuracy),
          altitude: finiteNumber(coords.altitude),
          altitudeAccuracyMeters: finiteNumber(coords.altitudeAccuracy),
          heading: finiteNumber(coords.heading),
          speedMetersPerSecond: finiteNumber(coords.speed),
        });
      },
      (error) => {
        const statusByCode = {
          1: 'denied',
          2: 'unavailable',
          3: 'timeout',
        };
        resolve({
          consent: true,
          status: statusByCode[error?.code] || 'failed',
          code: error?.code || null,
          message: limitedString(error?.message || 'Location could not be captured.', 180),
          permissionState: beforePermission,
          collectedAt: new Date().toISOString(),
        });
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      },
    );
  });
};

const collectDeviceProfile = async () => ({
  collectedAt: new Date().toISOString(),
  userAgent: limitedString(navigator.userAgent, 700),
  userAgentData: await collectUserAgentData(),
  platform: limitedString(navigator.platform, 120),
  vendor: limitedString(navigator.vendor, 120),
  language: limitedString(navigator.language, 40),
  languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 8).map((item) => limitedString(item, 40)) : [],
  timezone: limitedString(Intl.DateTimeFormat().resolvedOptions().timeZone, 80),
  timezoneOffsetMinutes: new Date().getTimezoneOffset(),
  cookieEnabled: Boolean(navigator.cookieEnabled),
  doNotTrack: limitedString(navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack, 20),
  hardwareConcurrency: finiteNumber(navigator.hardwareConcurrency),
  maxTouchPoints: finiteNumber(navigator.maxTouchPoints),
  deviceMemory: finiteNumber(navigator.deviceMemory),
  devicePixelRatio: finiteNumber(window.devicePixelRatio),
  screen: {
    width: finiteNumber(window.screen?.width),
    height: finiteNumber(window.screen?.height),
    availWidth: finiteNumber(window.screen?.availWidth),
    availHeight: finiteNumber(window.screen?.availHeight),
    colorDepth: finiteNumber(window.screen?.colorDepth),
  },
  viewport: {
    width: finiteNumber(window.innerWidth),
    height: finiteNumber(window.innerHeight),
  },
});

export const collectSigningClientEvidence = async ({ scope, includeLocation = false } = {}) => ({
  evidenceVersion: 1,
  collectedAt: new Date().toISOString(),
  deviceSessionId: signingSessionId(scope),
  device: await collectDeviceProfile(),
  location: await collectLocation(includeLocation),
});

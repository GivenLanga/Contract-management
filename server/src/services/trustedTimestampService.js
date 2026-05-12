const crypto = require('crypto');
const fetch = require('node-fetch');

const TSA_TIMEOUT_MS = Number(process.env.SIGNING_TSA_TIMEOUT_MS) || 10000;
const MAX_TSA_RESPONSE_BYTES = Number(process.env.SIGNING_TSA_MAX_RESPONSE_BYTES) || 1024 * 1024;

const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const derLength = (length) => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let next = length;
  while (next > 0) {
    bytes.unshift(next & 0xff);
    next >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const der = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const derSequence = (...items) => der(0x30, Buffer.concat(items));
const derInteger = (value) => {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = Buffer.from(value);
  } else {
    let number = BigInt(value);
    const parts = [];
    do {
      parts.unshift(Number(number & 0xffn));
      number >>= 8n;
    } while (number > 0n);
    bytes = Buffer.from(parts);
  }
  while (bytes.length > 1 && bytes[0] === 0 && bytes[1] < 0x80) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
};
const derOctetString = (value) => der(0x04, Buffer.from(value));
const derNull = () => Buffer.from([0x05, 0x00]);
const derBoolean = (value) => der(0x01, Buffer.from([value ? 0xff : 0x00]));

const derOid = (oid) => {
  const parts = String(oid).split('.').map((item) => Number(item));
  const bytes = [parts[0] * 40 + parts[1]];
  parts.slice(2).forEach((part) => {
    const stack = [part & 0x7f];
    part >>= 7;
    while (part > 0) {
      stack.unshift((part & 0x7f) | 0x80);
      part >>= 7;
    }
    bytes.push(...stack);
  });
  return der(0x06, Buffer.from(bytes));
};

const readTlv = (buffer, offset = 0) => {
  const tag = buffer[offset];
  let cursor = offset + 1;
  let length = buffer[cursor];
  cursor += 1;
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length << 8) | buffer[cursor + index];
    }
    cursor += lengthBytes;
  }
  const headerLength = cursor - offset;
  return {
    tag,
    headerLength,
    length,
    start: cursor,
    end: cursor + length,
    raw: buffer.subarray(offset, cursor + length),
    value: buffer.subarray(cursor, cursor + length),
  };
};

const parseTimestampResponse = (buffer) => {
  const response = readTlv(buffer, 0);
  if (response.tag !== 0x30) return { pkiStatus: null, token: null };
  const statusInfo = readTlv(response.value, 0);
  const statusInteger = readTlv(statusInfo.value, 0);
  const pkiStatus = statusInteger.value.reduce((sum, byte) => (sum << 8) | byte, 0);
  const tokenOffset = statusInfo.raw.length;
  const token = tokenOffset < response.value.length ? readTlv(response.value, tokenOffset).raw : null;
  return { pkiStatus, token };
};

const buildTimestampRequest = ({ hashHex, nonce }) => {
  const messageImprint = derSequence(
    derSequence(
      derOid('2.16.840.1.101.3.4.2.1'),
      derNull(),
    ),
    derOctetString(Buffer.from(hashHex, 'hex')),
  );
  return derSequence(
    derInteger(1),
    messageImprint,
    derInteger(nonce),
    derBoolean(true),
  );
};

const timestampEvidenceHash = async (hashHex) => {
  const tsaUrl = String(process.env.SIGNING_TSA_URL || '').trim();
  const normalizedHash = String(hashHex || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
    return { status: 'skipped', reason: 'invalid_sha256_imprint', algorithm: 'sha256' };
  }
  if (!tsaUrl) {
    return { status: 'not_configured', algorithm: 'sha256', imprintHash: normalizedHash };
  }

  const nonce = crypto.randomBytes(16);
  const requestBytes = buildTimestampRequest({ hashHex: normalizedHash, nonce });
  const headers = {
    'Content-Type': 'application/timestamp-query',
    Accept: 'application/timestamp-reply',
  };
  if (process.env.SIGNING_TSA_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.SIGNING_TSA_BEARER_TOKEN}`;
  } else if (process.env.SIGNING_TSA_USERNAME || process.env.SIGNING_TSA_PASSWORD) {
    const credential = Buffer
      .from(`${process.env.SIGNING_TSA_USERNAME || ''}:${process.env.SIGNING_TSA_PASSWORD || ''}`)
      .toString('base64');
    headers.Authorization = `Basic ${credential}`;
  }

  try {
    const response = await fetch(tsaUrl, {
      method: 'POST',
      headers,
      body: requestBytes,
      timeout: TSA_TIMEOUT_MS,
    });
    const responseBytes = await response.buffer();
    if (responseBytes.length > MAX_TSA_RESPONSE_BYTES) {
      return {
        status: 'failed',
        reason: 'tsa_response_too_large',
        algorithm: 'sha256',
        imprintHash: normalizedHash,
        requestHash: sha256Buffer(requestBytes),
        receivedAt: new Date(),
        httpStatus: response.status,
      };
    }

    let parsed = { pkiStatus: null, token: null };
    try {
      parsed = parseTimestampResponse(responseBytes);
    } catch {
      parsed = { pkiStatus: null, token: null };
    }
    const granted = response.ok && [0, 1].includes(parsed.pkiStatus);

    return {
      status: granted ? 'granted' : 'failed',
      standard: 'RFC3161',
      algorithm: 'sha256',
      tsaUrl,
      imprintHash: normalizedHash,
      nonce: nonce.toString('hex'),
      requestHash: sha256Buffer(requestBytes),
      responseHash: sha256Buffer(responseBytes),
      tokenHash: parsed.token ? sha256Buffer(parsed.token) : '',
      tokenBase64: parsed.token ? parsed.token.toString('base64') : '',
      responseBase64: responseBytes.toString('base64'),
      pkiStatus: parsed.pkiStatus,
      httpStatus: response.status,
      contentType: response.headers.get('content-type') || '',
      receivedAt: new Date(),
    };
  } catch (error) {
    return {
      status: 'failed',
      standard: 'RFC3161',
      algorithm: 'sha256',
      tsaUrl,
      imprintHash: normalizedHash,
      requestHash: sha256Buffer(requestBytes),
      nonce: nonce.toString('hex'),
      reason: String(error.message || 'TSA request failed').slice(0, 240),
      receivedAt: new Date(),
    };
  }
};

module.exports = {
  timestampEvidenceHash,
};

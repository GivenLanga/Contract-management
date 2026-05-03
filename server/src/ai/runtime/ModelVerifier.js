const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

class ModelVerifier {
  async verify(modelPath, expectedSha256, options = {}) {
    const quarantineInvalid = options.quarantineInvalid !== false;
    const allowUnverified = process.env.ALLOW_UNVERIFIED_MODELS === 'true';

    if (!fs.existsSync(modelPath)) {
      return { valid: false, expectedSha256, actualSha256: null, error: 'File not found' };
    }

    if (!this._isSha256(expectedSha256)) {
      if (allowUnverified) {
        return { valid: true, expectedSha256: null, actualSha256: null, skipped: true };
      }
      return {
        valid: false,
        expectedSha256: null,
        actualSha256: null,
        error: 'No SHA-256 checksum is configured for this model.',
      };
    }

    let actualSha256;
    try {
      actualSha256 = await this._sha256(modelPath);
    } catch (err) {
      return { valid: false, expectedSha256, actualSha256: null, error: err.message };
    }

    const valid = actualSha256.toLowerCase() === expectedSha256.toLowerCase();

    if (!valid) {
      const quarantinePath = quarantineInvalid ? this._quarantine(modelPath) : null;
      return {
        valid: false,
        expectedSha256,
        actualSha256,
        error: quarantinePath
          ? `Checksum mismatch — file quarantined at ${quarantinePath}`
          : 'Checksum mismatch',
      };
    }

    return { valid: true, expectedSha256, actualSha256 };
  }

  _isSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  }

  _quarantine(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = path.join(dir, `${base}.invalid-${stamp}`);

    try {
      fs.renameSync(filePath, quarantinePath);
      return quarantinePath;
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* cleanup is best effort */ }
      return null;
    }
  }

  _sha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash   = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end',  ()  => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}

module.exports = { ModelVerifier };

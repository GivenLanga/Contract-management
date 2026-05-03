const https = require('https');
const http  = require('http');
const fs    = require('fs');
const { ensureModelsDir, getModelPartPath } = require('./ModelStorage');

class ModelDownloader {
  constructor() {
    this._active      = null;  // current in-flight request state
    this._downloading = false; // true for the entire duration including retry waits
  }

  get isDownloading() { return this._downloading; }
  get currentProgress() { return this._active?.progress || null; }

  async download(modelDef, onProgress, options = {}) {
    if (this._downloading) throw new Error('A download is already in progress.');
    this._downloading = true;

    ensureModelsDir();
    const partPath = getModelPartPath(modelDef.fileName);
    const retries  = Number.isInteger(options.retries) ? options.retries : 5;

    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this._downloadOnce(modelDef, partPath, onProgress);
        } catch (err) {
          if (err.cancelled || attempt === retries) throw err;
          // Brief pause before retry so transient throttle clears
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      throw new Error('Download failed after all retries.');
    } finally {
      this._downloading = false;
      this._active = null;
    }
  }

  cancel() {
    this._active?.cancel();
    // Synchronously clear the guard so a new download can start immediately
    // without waiting for the async teardown of the current request.
    this._downloading = false;
    this._active = null;
  }

  _downloadOnce(modelDef, partPath, onProgress) {
    return new Promise((resolve, reject) => {
      let cancelled  = false;
      let req        = null;
      let settled    = false;
      const stallTimeoutMs = Number(process.env.MODEL_DOWNLOAD_STALL_TIMEOUT_MS) || 120000;
      let stallTimer = null;

      // Resume from existing partial file if present
      let resumeFrom = 0;
      try {
        const stat = fs.statSync(partPath);
        if (stat.size > 0) resumeFrom = stat.size;
      } catch { /* no partial file, start fresh */ }

      let downloaded = resumeFrom;
      const startMs  = Date.now();

      const progress = {
        modelId: modelDef.id,
        downloadedBytes: downloaded,
        totalBytes: modelDef.downloadSizeBytes,
        percentage: 0,
        speedBytesPerSecond: 0,
        estimatedSecondsRemaining: null,
        sourceUrl: modelDef.downloadUrl,
        resolvedUrl: modelDef.downloadUrl,
      };

      this._active = {
        progress,
        cancel: () => { cancelled = true; req?.destroy(); },
      };

      const cleanupTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = null;
      };

      // On stall/error keep the partial file so the next retry can resume
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanupTimer();
        this._active = null;
        if (err.cancelled) {
          // User cancelled — delete partial so a fresh download starts next time
          try { fs.unlinkSync(partPath); } catch { /* best effort */ }
        }
        reject(err);
      };

      const resetStallTimer = () => {
        cleanupTimer();
        stallTimer = setTimeout(() => {
          const err = new Error(`Download stalled: no data for ${Math.round(stallTimeoutMs / 1000)}s — will resume.`);
          try { req?.destroy(err); } catch { /* already closed */ }
          fail(err);
        }, stallTimeoutMs);
      };

      const doRequest = (url, hops = 0) => {
        if (hops > 8) { fail(new Error('Too many redirects')); return; }

        let parsed;
        try { parsed = new URL(url); } catch {
          fail(new Error('Invalid model download URL.')); return;
        }
        const allowInsecure = process.env.ALLOW_INSECURE_MODEL_DOWNLOADS === 'true';
        const isLocalHttp = parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname);
        if (parsed.protocol !== 'https:' && !(allowInsecure || isLocalHttp)) {
          fail(new Error('Unsupported protocol.')); return;
        }

        const headers = { 'User-Agent': 'ContractIQ/1.0' };
        if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;

        const client = parsed.protocol === 'https:' ? https : http;
        progress.resolvedUrl = url;
        resetStallTimer();

        req = client.get(url, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return doRequest(new URL(res.headers.location, url).toString(), hops + 1);
          }

          // 416 = Range Not Satisfiable — partial file is invalid or already complete.
          // Delete it and restart from 0 on the next retry.
          if (res.statusCode === 416) {
            res.resume();
            try { fs.unlinkSync(partPath); } catch { /* best effort */ }
            fail(new Error('Resume failed (416) — restarting download from the beginning.'));
            return;
          }

          // 200 = full file, 206 = partial content (resume accepted)
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            fail(new Error(`Server returned HTTP ${res.statusCode}`));
            return;
          }

          // Server ignored our Range header and sent the full file — reset progress
          if (res.statusCode === 200 && resumeFrom > 0) {
            downloaded = 0;
            resumeFrom = 0;
            try { fs.unlinkSync(partPath); } catch { /* best effort */ }
          }

          const contentLength = parseInt(res.headers['content-length']) || 0;
          const total = res.statusCode === 206
            ? resumeFrom + contentLength
            : contentLength || modelDef.downloadSizeBytes;
          progress.totalBytes = total;

          const file = fs.createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' });

          res.on('data', (chunk) => {
            if (cancelled) return;
            resetStallTimer();
            downloaded += chunk.length;

            const elapsed = (Date.now() - startMs) / 1000;
            const bytesSinceStart = downloaded - resumeFrom;
            const speed = elapsed > 0 ? bytesSinceStart / elapsed : 0;
            const eta   = speed > 0 ? Math.round((total - downloaded) / speed) : null;

            progress.downloadedBytes           = downloaded;
            progress.percentage                = Math.min(99, Math.floor((downloaded / total) * 100));
            progress.speedBytesPerSecond       = Math.round(speed);
            progress.estimatedSecondsRemaining = eta;

            if (onProgress) onProgress({ ...progress });
          });

          res.pipe(file);

          file.on('finish', () => {
            file.close(() => {
              cleanupTimer();
              if (cancelled) {
                try { fs.unlinkSync(partPath); } catch { /* best effort */ }
                this._active = null;
                const err = new Error('Download cancelled');
                err.cancelled = true;
                reject(err);
                return;
              }

              if (Number.isFinite(total) && total > 0 && downloaded !== total) {
                this._active = null;
                reject(new Error(`Incomplete download: expected ${total} bytes, received ${downloaded}.`));
                return;
              }

              progress.downloadedBytes = downloaded;
              progress.percentage      = 100;
              if (onProgress) onProgress({ ...progress });

              settled = true;
              this._active = null;
              resolve(partPath);
            });
          });

          file.on('error', fail);
          res.on('error',  fail);
        });

        req.on('error', (e) => {
          if (cancelled) {
            const err = new Error('Download cancelled');
            err.cancelled = true;
            fail(err);
            return;
          }
          fail(e);
        });
      };

      doRequest(modelDef.downloadUrl);
    });
  }
}

module.exports = { ModelDownloader };

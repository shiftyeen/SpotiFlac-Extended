/**
 * bridge-worker.cjs — WaveX Extension Runtime Worker
 *
 * Runs inside a Worker thread so that synchronous extension operations
 * (like Atomics.wait for HTTP requests) do not block Node's async event loop.
 */

'use strict';

const { isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (isMainThread) {
  throw new Error('bridge-worker.cjs must be loaded as a Worker thread');
}

const { sharedBuf, extPath, settings, debug } = workerData;

const STATE = new Int32Array(sharedBuf, 0, 1);
const LEN = new Uint32Array(sharedBuf, 4, 1);
const DOFF = 8;

let _currentCallId = null;
let _callDeadlineAt = 0;
let _cancelledAt = 0;
let _cancelled = false;
const CANCEL_CACHE_MS = 200;

const BRIDGE_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;
const TRANSFER_METHODS = new Set(['file.download', 'file.downloadSegments']);

function bridgeCall(method, args) {
  const payload = Buffer.from(
    JSON.stringify({ method, args, callId: _currentCallId }),
    'utf8'
  );

  if (DOFF + payload.length > sharedBuf.byteLength) {
    throw new Error(`Bridge payload too large: ${payload.length} bytes`);
  }

  payload.copy(Buffer.from(sharedBuf), DOFF);
  LEN[0] = payload.length;

  Atomics.store(STATE, 0, 1);
  parentPort.postMessage({ type: 'bridge_request' });

  const limit = TRANSFER_METHODS.has(method) ? TRANSFER_TIMEOUT_MS : BRIDGE_TIMEOUT_MS;
  let waited = 0;
  while (Atomics.load(STATE, 0) !== 2) {
    Atomics.wait(STATE, 0, 1, 100);
    waited += 100;
    if (waited > limit) throw new Error(`Bridge timeout for ${method}`);
  }

  const len = LEN[0];
  const resp = JSON.parse(Buffer.from(sharedBuf, DOFF, len).toString('utf8'));
  Atomics.store(STATE, 0, 0);

  if (resp.error) throw new Error(resp.error);
  return resp.result;
}

// Memory storage
const _mem = {};

function requestHeaders(arg) {
  if (!arg || typeof arg !== 'object') return {};
  const keys = Object.keys(arg);
  if (keys.length === 1 && keys[0] === 'headers' && arg.headers && typeof arg.headers === 'object') {
    return arg.headers;
  }
  return arg;
}

function methodCall(method, url, body, headers) {
  return bridgeCall('http.request', {
    url,
    method,
    body: body === undefined ? null : body,
    headers: requestHeaders(headers),
  });
}

global.http = {
  get: (url, headers) => bridgeCall('http.get', { url, headers: requestHeaders(headers) }),
  post: (url, body, headers) => bridgeCall('http.post', { url, body, headers: requestHeaders(headers) }),
  request: (url, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    return methodCall(String(o.method || 'GET').toUpperCase(), url, o.body, o.headers && typeof o.headers === 'object' ? o.headers : {});
  },
  put: (url, body, headers) => methodCall('PUT', url, body, headers),
  patch: (url, body, headers) => methodCall('PATCH', url, body, headers),
  delete: (url, headers) => methodCall('DELETE', url, null, headers),
};

global.fetch = function (url, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  const resp = bridgeCall('http.request', {
    url,
    method,
    body: opts.body === undefined ? null : opts.body,
    headers: requestHeaders(opts.headers),
  });
  const bodyText = typeof resp?.body === 'string' ? resp.body : JSON.stringify(resp?.body || '');
  return {
    ok: resp?.ok || ((resp?.statusCode || resp?.status || 0) >= 200 && (resp?.statusCode || resp?.status || 0) < 300),
    status: resp?.statusCode || resp?.status || 200,
    statusText: resp?.ok ? 'OK' : 'Error',
    headers: {
      get: (h) => (resp?.headers && resp.headers[h.toLowerCase()]) || null,
      ...(resp?.headers || {}),
    },
    text: () => bodyText,
    json: () => {
      try {
        return JSON.parse(bodyText);
      } catch (e) {
        return null;
      }
    },
    body: bodyText,
  };
};

function levenshteinBytes(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

const MATCH_SUFFIXES = [
  ' (remastered)', ' (remaster)', ' - remastered', ' - remaster',
  ' (deluxe)', ' (deluxe edition)', ' - deluxe', ' - deluxe edition',
  ' (explicit)', ' (clean)', ' [explicit]', ' [clean]',
  ' (album version)', ' (single version)', ' (radio edit)',
  ' (feat.', ' (ft.', ' feat.', ' ft.',
];

global.matching = {
  compareStrings: function (a, b) {
    if (arguments.length < 2) return 0;
    const s1 = String(a).trim().toLowerCase();
    const s2 = String(b).trim().toLowerCase();
    if (s1 === s2) return 1;
    const b1 = Buffer.from(s1, 'utf8');
    const b2 = Buffer.from(s2, 'utf8');
    if (b1.length === 0 || b2.length === 0) return 0;
    return 1 - levenshteinBytes(b1, b2) / Math.max(b1.length, b2.length);
  },
  compareDuration: function (d1, d2, tolerance) {
    if (arguments.length < 2) return false;
    const tol = tolerance === undefined ? 3000 : (Math.trunc(Number(tolerance)) || 0);
    return Math.abs((Math.trunc(Number(d1)) || 0) - (Math.trunc(Number(d2)) || 0)) <= tol;
  },
  normalizeString: function (value) {
    if (arguments.length < 1) return '';
    let s = String(value).toLowerCase();
    for (const suffix of MATCH_SUFFIXES) {
      const idx = s.indexOf(suffix);
      if (idx !== -1) s = s.slice(0, idx);
    }
    return s.replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).join(' ').trim();
  },
};

global.storage = {
  get: (k) => (_mem[k] !== undefined ? _mem[k] : null),
  set: (k, v) => { _mem[k] = v; return true; },
  delete: (k) => { delete _mem[k]; return true; },
};

global.file = {
  download: (url, outputPath, opts) => bridgeCall('file.download', { url, outputPath, opts: opts || {} }),
  downloadSegments: (urls, outputPath, opts) => bridgeCall('file.downloadSegments', { urls: urls || [], outputPath, opts: opts || {} }),
  getSize: (filePath) => {
    try {
      const stats = fs.statSync(filePath);
      return { success: true, size: stats.size };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  readBytes: (filePath, opts) => {
    try {
      const offset = (opts && opts.offset) || 0;
      const length = (opts && opts.length) || 0;
      const encoding = (opts && opts.encoding) || 'base64';
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      if (bytesRead === 0) return { success: true, bytes_read: 0, data: '', eof: true };
      const data = buffer.subarray(0, bytesRead).toString(encoding);
      return { success: true, bytes_read: bytesRead, data: data, eof: bytesRead < length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  writeBytes: (filePath, dataB64, opts) => {
    try {
      const flag = (opts && opts.append) ? 'a' : 'w';
      const buffer = Buffer.from(dataB64, (opts && opts.encoding) || 'base64');
      fs.writeFileSync(filePath, buffer, { flag });
      return { success: true, path: filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  transformPatternedBlocks: (inputPath, outputPath, opts, onProgress) => {
    let inputFd = null;
    let outputFd = null;
    try {
      opts = opts || {};
      const operation = String(opts.operation || 'decrypt').toLowerCase();
      if (operation !== 'decrypt' && operation !== 'encrypt') {
        throw new Error('unsupported patterned transform operation: ' + operation);
      }
      const segmentSize = Math.max(8, Number(opts.segmentSize || 2048));
      const transformEvery = Math.max(1, Number(opts.transformEvery || 1));
      const transformOffset = Math.max(0, Number(opts.transformOffset || 0));
      const bufferSize = Math.max(segmentSize, 1024 * 1024);
      const transformPartial = opts.transformPartial === true;
      const inputStats = fs.statSync(inputPath);
      const totalSize = inputStats.size;
      const key = Buffer.from(String(opts.key || ''), opts.keyEncoding || 'hex');
      const iv = Buffer.from(String(opts.iv || ''), opts.ivEncoding || 'hex');
      if (!key.length || iv.length !== 8) throw new Error('invalid Blowfish key or IV');

      inputFd = fs.openSync(inputPath, 'r');
      outputFd = fs.openSync(outputPath, 'w');
      const buffer = Buffer.alloc(bufferSize);
      let position = 0;

      while (position < totalSize) {
        const length = Math.min(buffer.length, totalSize - position);
        const bytesRead = fs.readSync(inputFd, buffer, 0, length, position);
        if (!bytesRead) break;

        let offset = 0;
        while (offset < bytesRead) {
          const absolutePosition = position + offset;
          const segmentIndex = Math.floor(absolutePosition / segmentSize);
          const segmentOffset = absolutePosition % segmentSize;
          const chunkLength = Math.min(segmentSize - segmentOffset, bytesRead - offset);
          const isPatterned = segmentIndex >= transformOffset && (segmentIndex - transformOffset) % transformEvery === 0;
          const canTransform = chunkLength === segmentSize || transformPartial;
          let chunk = buffer.subarray(offset, offset + chunkLength);

          if (isPatterned && canTransform) {
            if (chunk.length % 8 !== 0) throw new Error('Blowfish block is not a multiple of 8 bytes');
            const cipher = operation === 'decrypt'
              ? crypto.createDecipheriv('bf-cbc', key, iv)
              : crypto.createCipheriv('bf-cbc', key, iv);
            cipher.setAutoPadding(false);
            chunk = Buffer.concat([cipher.update(chunk), cipher.final()]);
          }

          fs.writeSync(outputFd, chunk, 0, chunk.length, absolutePosition);
          offset += chunkLength;
        }

        position += bytesRead;
        if (typeof onProgress === 'function' && totalSize > 0) {
          onProgress(position, totalSize);
        }
      }

      return { success: true, path: outputPath };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      try { if (inputFd !== null) fs.closeSync(inputFd); } catch (_) {}
      try { if (outputFd !== null) fs.closeSync(outputFd); } catch (_) {}
    }
  },
  delete: (filePath) => {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      return false;
    }
  }
};

global.log = {
  info: (...a) => parentPort.postMessage({ type: 'log', level: 'info', msg: a.join(' ') }),
  debug: (...a) => {
    if (debug) parentPort.postMessage({ type: 'log', level: 'debug', msg: a.join(' ') });
  },
  warn: (...a) => parentPort.postMessage({ type: 'log', level: 'warn', msg: a.join(' ') }),
  error: (...a) => parentPort.postMessage({ type: 'log', level: 'error', msg: a.join(' ') }),
};

function hmacInput(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Array.isArray(value)) return Buffer.from(value.map((n) => Number(n) & 0xff));
  return null;
}

global.utils = {
  randomUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  appUserAgent: () => 'WaveX/1.0.0',
  sleep: (ms) => {
    const duration = Math.max(0, Math.floor(Number(ms) || 0));
    if (duration > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
    }
    return true;
  },
  getResolutionRemainingMs: () => {
    if (!_callDeadlineAt) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, _callDeadlineAt - Date.now());
  },
  isDownloadCancelled: () => {
    const now = Date.now();
    if (now - _cancelledAt < CANCEL_CACHE_MS) return _cancelled;
    try {
      _cancelled = bridgeCall('host.isCancelled', {}) === true;
    } catch (e) {
      _cancelled = false;
    }
    _cancelledAt = now;
    return _cancelled;
  },
  isRequestCancelled: () => global.utils.isDownloadCancelled(),
  hmacSHA1: (key, message) => {
    const k = hmacInput(key);
    const m = hmacInput(message);
    if (!k || !m) return [];
    return Array.from(crypto.createHmac('sha1', k).update(m).digest());
  },
  getLocalTime: () => {
    const now = new Date();
    let timezone = 'Local';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local'; } catch (e) {}
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
      weekday: now.getDay(),
      offsetMinutes: now.getTimezoneOffset(),
      timezone,
      timestamp: Math.floor(now.getTime() / 1000),
    };
  },
  sha256: (input) => crypto.createHash('sha256').update(String(input), 'utf8').digest('hex'),
  md5: (input) => crypto.createHash('md5').update(String(input), 'utf8').digest('hex'),
  decryptBlockCipher: (dataB64, opts) => {
    try {
      opts = opts || {};
      const key = Buffer.from(opts.key, opts.keyEncoding || 'hex');
      const iv = Buffer.from(opts.iv, opts.ivEncoding || 'hex');
      const input = Buffer.from(dataB64, opts.inputEncoding || 'base64');
      const decipher = crypto.createDecipheriv('bf-cbc', key, iv);
      if (opts.padding === 'none') decipher.setAutoPadding(false);
      const output = Buffer.concat([decipher.update(input), decipher.final()]);
      return { success: true, data: output.toString(opts.outputEncoding || 'base64') };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};

global.gobackend = global.utils;

global.session = {
  signedFetch: (method, path, body, headers) =>
    bridgeCall('session.signedFetch', {
      method: method || 'GET',
      path: path || '',
      body: body === undefined ? null : body,
      headers: headers || {},
    }),
  completeGrant: () => bridgeCall('session.completeGrant', {}),
};

global.ffmpeg = {
  convert: (input, output, opts) => bridgeCall('ffmpeg.convert', { input, output, opts: opts || {} }),
};

let _ext = null;
global.registerExtension = (obj) => { _ext = obj; };

try {
  const code = fs.readFileSync(extPath, 'utf8');
  eval(code); // eslint-disable-line no-eval

  if (!_ext) throw new Error('Extension did not call registerExtension()');
  if (typeof _ext.initialize === 'function') {
    _ext.initialize(settings || {});
  }

  parentPort.postMessage({ type: 'ready' });
} catch (e) {
  parentPort.postMessage({ type: 'init_error', error: e.message });
}

parentPort.on('message', ({ id, call, args, budgetMs }) => {
  if (id === undefined) return;
  _currentCallId = id;
  const budget = Number(budgetMs) || 0;
  _callDeadlineAt = budget > 0 ? Date.now() + budget : 0;
  _cancelledAt = 0;
  _cancelled = false;

  try {
    const fn = _ext && _ext[call];
    if (typeof fn !== 'function') {
      parentPort.postMessage({ id, error: `Method not implemented: ${call}` });
      return;
    }

    const finalArgs = (args || []).map((a) =>
      a === '__progress__'
        ? (v) => {
            parentPort.postMessage({ type: 'progress', callId: id, value: v });
          }
        : a
    );

    const result = fn(...finalArgs);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  } finally {
    _currentCallId = null;
    _callDeadlineAt = 0;
  }
});

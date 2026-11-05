import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { SignedSessionClient } from './signed-session.js';

export interface DownloadProgressEvent {
  filePath: string;
  fileName: string;
  bytesReceived: number;
  totalBytes: number;
  percent: number;
  speedMBps: number;
  status: 'downloading' | 'tagging' | 'completed' | 'error';
  error?: string;
}

class ProgressEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  public emitProgress(evt: DownloadProgressEvent): void {
    this.emit('progress', evt);
  }
}

export const DownloadProgressBus = new ProgressEventBus();

export class LiveStreamEmitter extends EventEmitter {
  public totalBytes: number = 0;
  public contentLength: number = 0;
  public mimeType: string = '';
  public actualPath: string = '';
  public headersReady: boolean = false;
  public isDone: boolean = false;
  public error: any = null;
  public buffer: Buffer[] = [];
  public keyPath: string = '';

  constructor(keyPath: string = '') {
    super();
    this.keyPath = keyPath;
    this.setMaxListeners(50);
  }

  setHeaders(contentLength: number, mimeType: string, actualPath: string = '') {
    this.contentLength = contentLength;
    this.mimeType = mimeType;
    if (actualPath) this.actualPath = actualPath;
    this.headersReady = true;
    this.emit('headers', { contentLength, mimeType, actualPath: this.actualPath });
  }

  waitForHeaders(timeoutMs: number = 15000): Promise<{ contentLength: number; mimeType: string; actualPath: string }> {
    if (this.headersReady || this.isDone) {
      return Promise.resolve({
        contentLength: this.contentLength || this.totalBytes,
        mimeType: this.mimeType,
        actualPath: this.actualPath,
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ contentLength: this.contentLength, mimeType: this.mimeType, actualPath: this.actualPath });
      }, timeoutMs);
      const onDone = () => {
        cleanup();
        resolve({ contentLength: this.contentLength || this.totalBytes, mimeType: this.mimeType, actualPath: this.actualPath });
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('headers', onDone);
        this.off('end', onDone);
        this.off('error', onDone);
      };
      this.once('headers', onDone);
      this.once('end', onDone);
      this.once('error', onDone);
    });
  }

  getFullBuffer(): Buffer {
    return Buffer.concat(this.buffer);
  }

  pushChunk(chunk: Buffer) {
    this.buffer.push(chunk);
    this.totalBytes += chunk.length;
    this.emit('chunk', chunk);
  }

  finish() {
    this.isDone = true;
    if (!this.contentLength && this.totalBytes > 0) {
      this.contentLength = this.totalBytes;
    }
    this.emit('end');
    // Free RAM buffer and unregister once file is safely flushed on disk
    setTimeout(() => {
      this.buffer = [];
      if (this.keyPath) {
        LiveStreamRegistry.unregister(this.keyPath);
      }
    }, 8000);
  }

  fail(err: any) {
    this.error = err;
    this.emit('error', err);
    setTimeout(() => {
      this.buffer = [];
      if (this.keyPath) {
        LiveStreamRegistry.unregister(this.keyPath);
      }
    }, 2000);
  }
}

export class LiveStreamRegistry {
  private static registry = new Map<string, LiveStreamEmitter>();

  private static norm(p: string): string {
    return path.normalize(p).toLowerCase().replace(/\\/g, '/');
  }

  public static register(keyPath: string): LiveStreamEmitter {
    const k = this.norm(keyPath);
    let emitter = this.registry.get(k);
    if (!emitter) {
      emitter = new LiveStreamEmitter(keyPath);
      this.registry.set(k, emitter);
    }
    return emitter;
  }

  public static get(keyPath: string): LiveStreamEmitter | undefined {
    return this.registry.get(this.norm(keyPath));
  }

  public static find(actualPath: string): LiveStreamEmitter | undefined {
    const normActual = this.norm(actualPath);
    // Never stream intermediate encrypted .part/.enc files directly to browser audio element
    if (normActual.endsWith('.part') || normActual.endsWith('.enc') || normActual.endsWith('.tmp')) {
      return undefined;
    }
    if (this.registry.has(normActual)) {
      return this.registry.get(normActual);
    }
    for (const [k, emitter] of this.registry.entries()) {
      const baseK = k.replace(/\.[^./\\]+$/, '');
      const baseActual = normActual.replace(/\.[^./\\]+$/, '');
      if (baseActual === baseK) {
        return emitter;
      }
    }
    return undefined;
  }

  public static unregister(keyPath: string) {
    this.registry.delete(this.norm(keyPath));
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RunnerOptions {
  extPath: string;
  manifest?: any;
  settings?: Record<string, unknown>;
  debug?: boolean;
}

interface WorkerSlot {
  worker: Worker;
  sharedBuf: SharedArrayBuffer;
  state: Int32Array;
  len: Uint32Array;
  isReady: boolean;
  readyPromise: Promise<void>;
  activeCalls: number;
  pendingCalls: Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>;
  onProgressCallbacks: Map<number, (progress: number) => void>;
}

export class ExtensionRunner {
  private doff = 8;
  private callSeq = 0;
  private signedClient: SignedSessionClient | null = null;
  private workerPath: string;
  private primarySlot!: WorkerSlot;
  private downloadPool: WorkerSlot[] = [];
  private maxDownloadWorkers = 2;

  constructor(private options: RunnerOptions) {
    let wp = path.resolve(__dirname, 'bridge-worker.cjs');
    if (!fs.existsSync(wp)) {
      wp = path.resolve(process.cwd(), 'src', 'runtime', 'bridge-worker.cjs');
    }
    this.workerPath = wp;

    // Initialize signedSession client if declared in manifest
    const signedConfig = options.manifest?.signedSession || this.loadManifestSignedConfig();
    if (signedConfig) {
      try {
        this.signedClient = new SignedSessionClient(signedConfig);
      } catch (e) {
        console.warn(`[Runner] Could not init SignedSessionClient for ${options.extPath}:`, e);
      }
    }

    this.primarySlot = this.createWorkerSlot('primary');
  }

  private createWorkerSlot(role: string): WorkerSlot {
    const bufSize = 8 + 16 * 1024 * 1024;
    const sharedBuf = new SharedArrayBuffer(bufSize);
    const state = new Int32Array(sharedBuf, 0, 1);
    const len = new Uint32Array(sharedBuf, 4, 1);

    const slot: WorkerSlot = {
      worker: null as any,
      sharedBuf,
      state,
      len,
      isReady: false,
      readyPromise: Promise.resolve(),
      activeCalls: 0,
      pendingCalls: new Map(),
      onProgressCallbacks: new Map(),
    };

    slot.readyPromise = new Promise((resolve, reject) => {
      const w = new Worker(this.workerPath, {
        workerData: {
          sharedBuf,
          extPath: this.options.extPath,
          settings: this.options.settings || {},
          debug: this.options.debug || false,
        },
      });
      slot.worker = w;

      w.on('message', async (msg) => {
        if (msg.type === 'ready') {
          slot.isReady = true;
          resolve();
        } else if (msg.type === 'init_error') {
          reject(new Error(msg.error));
        } else if (msg.type === 'bridge_request') {
          await this.handleBridgeRequest(slot);
        } else if (msg.type === 'log') {
          if (this.options.debug || msg.level === 'error' || msg.level === 'warn') {
            console.log(`[Ext:${path.basename(path.dirname(this.options.extPath))}] [${msg.level.toUpperCase()}] ${msg.msg}`);
          }
        } else if (msg.type === 'progress') {
          const cb = slot.onProgressCallbacks.get(msg.callId);
          if (cb) cb(msg.value);
        } else if (msg.id !== undefined) {
          const pending = slot.pendingCalls.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            slot.pendingCalls.delete(msg.id);
            slot.onProgressCallbacks.delete(msg.id);
            slot.activeCalls = Math.max(0, slot.activeCalls - 1);
            if (msg.error) pending.reject(new Error(msg.error));
            else pending.resolve(msg.result);
          }
        }
      });

      w.on('error', (err) => {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        console.error(`[Runner:${role}] Extension Worker error:`, errorObj);
        this.failAllPending(slot, errorObj);
        if (!slot.isReady) reject(errorObj);
      });

      w.on('exit', (code) => {
        if (code !== 0) {
          this.failAllPending(slot, new Error(`Worker exited with code ${code}`));
          if (slot === this.primarySlot) {
            console.warn(`[Runner] Respawning primary worker for ${path.basename(path.dirname(this.options.extPath))}...`);
            this.primarySlot = this.createWorkerSlot('primary');
          }
        }
      });
    });

    return slot;
  }

  private failAllPending(slot: WorkerSlot, err: Error) {
    for (const [, p] of slot.pendingCalls.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    slot.pendingCalls.clear();
    slot.onProgressCallbacks.clear();
    slot.activeCalls = 0;
  }

  private async acquireDownloadSlot(): Promise<WorkerSlot> {
    // 1. Find an idle download worker
    for (const slot of this.downloadPool) {
      if (slot.activeCalls === 0) {
        await slot.readyPromise;
        return slot;
      }
    }
    // 2. Spawn a new download worker if pool isn't full
    if (this.downloadPool.length < this.maxDownloadWorkers) {
      const newSlot = this.createWorkerSlot(`dl-${this.downloadPool.length + 1}`);
      this.downloadPool.push(newSlot);
      await newSlot.readyPromise;
      return newSlot;
    }
    // 3. Pick the least busy download worker
    this.downloadPool.sort((a, b) => a.activeCalls - b.activeCalls);
    const chosen = this.downloadPool[0];
    await chosen.readyPromise;
    return chosen;
  }

  private loadManifestSignedConfig(): any {
    try {
      const mfPath = path.join(path.dirname(this.options.extPath), 'manifest.json');
      if (fs.existsSync(mfPath)) {
        const parsed = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
        return parsed.signedSession;
      }
    } catch {}
    return null;
  }

  public async waitReady(): Promise<void> {
    return this.primarySlot.readyPromise;
  }

  public getSignedClient(): SignedSessionClient | null {
    return this.signedClient;
  }

  public async call<T = any>(
    call: string,
    args: any[] = [],
    budgetMs: number = 60000,
    onProgress?: (progress: number) => void
  ): Promise<T> {
    // Route heavy download tasks to the dedicated Download Pool so metadata/search is NEVER blocked
    const isHeavyDownload = call === 'download';
    const slot = isHeavyDownload ? await this.acquireDownloadSlot() : this.primarySlot;
    await slot.readyPromise;

    const id = ++this.callSeq;
    slot.activeCalls++;

    const rawResult = await new Promise<T>((resolve, reject) => {
      if (onProgress) {
        slot.onProgressCallbacks.set(id, onProgress);
      }

      const timer = setTimeout(() => {
        if (slot.pendingCalls.has(id)) {
          slot.pendingCalls.delete(id);
          slot.onProgressCallbacks.delete(id);
          slot.activeCalls = Math.max(0, slot.activeCalls - 1);
          reject(new Error(`Extension call '${call}' timed out after ${budgetMs}ms`));
        }
      }, budgetMs + 2000);

      slot.pendingCalls.set(id, {
        resolve,
        reject,
        timer,
      });

      slot.worker.postMessage({ id, call, args, budgetMs });
    });

    // Universal Post-Download Decryption (e.g. Amazon Music Zarz AES DRM encrypted streams)
    if (call === 'download' && rawResult && typeof rawResult === 'object') {
      const res: any = rawResult;
      const key = (res.decryption_key || res.decryption?.key || '').trim();
      const filePath = res.file_path || res.path || (args[2] as string);
      if (key && filePath && fs.existsSync(filePath)) {
        try {
          const tempClean = `${filePath}.decrypted${path.extname(filePath)}`;
          const ext = path.extname(filePath).toLowerCase();
          const extraFlags = ext === '.m4a' || ext === '.mp4' ? '-f mp4 -strict experimental' : '';
          await new Promise<void>((resolve, reject) => {
            exec(`ffmpeg -y -v error -decryption_key ${key} -i "${filePath}" -c copy ${extraFlags} "${tempClean}"`, (err, _stdout, stderr) => {
              if (!err && fs.existsSync(tempClean) && fs.statSync(tempClean).size > 1024) {
                try {
                  fs.unlinkSync(filePath);
                  fs.renameSync(tempClean, filePath);
                  res.decrypted = true;
                  resolve();
                } catch (e: any) {
                  reject(e);
                }
              } else {
                reject(err || new Error(`Decryption failed: ${stderr}`));
              }
            });
          });
        } catch (decryptErr: any) {
          console.warn('[Runner] Auto-decryption error:', decryptErr.message);
        }
      }
    }

    return rawResult;
  }

  public async destroy(): Promise<void> {
    try {
      await this.primarySlot.worker.terminate();
    } catch {}
    for (const dl of this.downloadPool) {
      try {
        await dl.worker.terminate();
      } catch {}
    }
    this.downloadPool = [];
  }

  private async handleBridgeRequest(slot: WorkerSlot): Promise<void> {
    if (Atomics.load(slot.state, 0) !== 1) return;

    const len = slot.len[0];
    const rawReq = Buffer.from(slot.sharedBuf, this.doff, len).toString('utf8');
    const req = JSON.parse(rawReq);

    let result: any = null;
    let error: string | null = null;

    try {
      const { method, args } = req;
      if (method === 'http.get') {
        result = await this.httpRequest('GET', args.url, null, args.headers);
      } else if (method === 'http.post') {
        result = await this.httpRequest('POST', args.url, args.body, args.headers);
      } else if (method === 'http.request') {
        result = await this.httpRequest(args.method || 'GET', args.url, args.body, args.headers);
      } else if (method === 'file.download') {
        result = await this.fileDownload(args.url, args.outputPath, args.opts);
      } else if (method === 'file.downloadSegments') {
        result = await this.fileDownloadSegments(args.urls, args.outputPath, args.opts);
      } else if (method === 'session.signedFetch') {
        if (!this.signedClient) {
          const config = this.options.manifest?.signedSession || this.loadManifestSignedConfig();
          if (config) {
            this.signedClient = new SignedSessionClient(config);
          }
        }
        if (this.signedClient) {
          result = await this.signedClient.fetch(args.method, args.path, args.body, args.headers);
        } else {
          result = {
            statusCode: 500,
            status: 500,
            ok: false,
            error: 'Extension does not support signedSession (no signedSession config in manifest)',
          };
        }
      } else if (method === 'session.completeGrant') {
        if (!this.signedClient) {
          const config = this.options.manifest?.signedSession || this.loadManifestSignedConfig();
          if (config) {
            this.signedClient = new SignedSessionClient(config);
          }
        }
        if (this.signedClient) {
          result = { success: this.signedClient.isAuthenticated() };
        } else {
          result = { success: false, error: 'No signedClient available' };
        }
      } else if (method === 'ffmpeg.convert') {
        result = await this.ffmpegConvert(args.input, args.output, args.opts);
      } else if (method === 'host.isCancelled') {
        result = false;
      } else {
        error = `Unknown bridge method: ${method}`;
      }
    } catch (e: any) {
      error = e?.message || String(e);
    }

    const resp = Buffer.from(JSON.stringify({ result, error }), 'utf8');
    resp.copy(Buffer.from(slot.sharedBuf), this.doff);
    slot.len[0] = resp.length;

    Atomics.store(slot.state, 0, 2);
    Atomics.notify(slot.state, 0, 1);
  }

  private httpRequest(method: string, rawUrl: string, body: any, headers: Record<string, string>): Promise<any> {
    return new Promise((resolve) => {
      let u: URL;
      try {
        u = new URL(rawUrl);
      } catch {
        resolve({ statusCode: 0, status: 0, ok: false, body: '', error: `Invalid URL: ${rawUrl}` });
        return;
      }

      const client = u.protocol === 'https:' ? https : http;
      const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) : null;

      const reqHeaders = { ...headers };
      if (bodyBuf && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
        reqHeaders['Content-Length'] = String(bodyBuf.length);
      }

      const req = client.request(
        rawUrl,
        {
          method,
          headers: reqHeaders,
          timeout: 30000,
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
            const nextUrl = new URL(res.headers.location, rawUrl).toString();
            resolve(this.httpRequest(method === 'POST' ? 'GET' : method, nextUrl, null, headers));
            return;
          }

          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            const statusCode = res.statusCode || 0;
            resolve({
              statusCode,
              status: statusCode,
              ok: statusCode >= 200 && statusCode < 300,
              body: data,
              headers: res.headers,
              url: rawUrl,
              error: null,
            });
          });
        }
      );

      req.on('error', (e) => {
        resolve({ statusCode: 0, status: 0, ok: false, body: '', error: e.message, url: rawUrl });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ statusCode: 0, status: 0, ok: false, body: '', error: 'timeout', url: rawUrl });
      });

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  private resolveMimeFromPath(filePath: string, fallback: string = ''): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.mp4': 'audio/mp4',
      '.mp3': 'audio/mpeg',
      '.opus': 'audio/ogg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.eac3': 'audio/eac3',
      '.ec3': 'audio/eac3',
    };
    return map[ext] || fallback || 'audio/flac';
  }

  private async fileDownload(rawUrl: string, outputPath: string, opts: any = {}): Promise<any> {
    const isEncryptedProvider = this.options.extPath.toLowerCase().includes('amazon') || Boolean(opts && opts.isEncrypted);
    const liveEmitter = isEncryptedProvider ? null : LiveStreamRegistry.find(outputPath);
    const fileName = path.basename(outputPath);
    const startTime = Date.now();
    let bytesReceived = 0;
    let lastEmitTime = 0;
    const isIntermediate = /\.(part|enc|tmp)$/i.test(outputPath);
    const writeTarget = isIntermediate ? outputPath : `${outputPath}.part`;

    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const res = await fetch(rawUrl, {
        headers: opts.headers || {},
        redirect: 'follow',
      });

      if (!res.ok) {
        if (liveEmitter) liveEmitter.fail(new Error(`HTTP ${res.status}`));
        return { success: false, error: `HTTP ${res.status}` };
      }

      const contentLength = Number(res.headers.get('content-length') || 0);
      const upstreamMime = this.resolveMimeFromPath(outputPath, res.headers.get('content-type') || '');
      if (liveEmitter) {
        liveEmitter.setHeaders(contentLength, upstreamMime, outputPath);
      }

      const fileStream = fs.createWriteStream(writeTarget);
      const stream = Readable.fromWeb(res.body as any);

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytesReceived += buf.length;

          if (liveEmitter) {
            liveEmitter.pushChunk(buf);
          }

          const now = Date.now();
          if (now - lastEmitTime >= 120) {
            lastEmitTime = now;
            const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
            const speedMBps = Number((bytesReceived / (1024 * 1024) / elapsedSec).toFixed(2));
            const percent = contentLength > 0 ? Math.min(99, Math.round((bytesReceived / contentLength) * 100)) : 50;
            DownloadProgressBus.emitProgress({
              filePath: outputPath,
              fileName,
              bytesReceived,
              totalBytes: contentLength,
              percent,
              speedMBps,
              status: 'downloading',
            });
          }
        });

        stream.pipe(fileStream);

        fileStream.on('finish', () => {
          try {
            if (writeTarget !== outputPath && fs.existsSync(writeTarget)) {
              if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
              fs.renameSync(writeTarget, outputPath);
            }
          } catch {}
          if (liveEmitter) liveEmitter.finish();
          const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
          const speedMBps = Number((bytesReceived / (1024 * 1024) / elapsedSec).toFixed(2));
          DownloadProgressBus.emitProgress({
            filePath: outputPath,
            fileName,
            bytesReceived,
            totalBytes: contentLength || bytesReceived,
            percent: 100,
            speedMBps,
            status: 'completed',
          });
          resolve();
        });
        fileStream.on('error', (err) => {
          if (liveEmitter) liveEmitter.fail(err);
          reject(err);
        });
        stream.on('error', (err) => {
          if (liveEmitter) liveEmitter.fail(err);
          reject(err);
        });
      });

      const sz = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : bytesReceived;
      return { success: true, path: outputPath, size: sz };
    } catch (e: any) {
      try {
        if (writeTarget !== outputPath && fs.existsSync(writeTarget)) fs.unlinkSync(writeTarget);
      } catch {}
      if (liveEmitter) liveEmitter.fail(e);
      DownloadProgressBus.emitProgress({
        filePath: outputPath,
        fileName,
        bytesReceived,
        totalBytes: 0,
        percent: 0,
        speedMBps: 0,
        status: 'error',
        error: e.message,
      });
      return { success: false, error: e.message };
    }
  }

  private async fileDownloadSegments(urls: any[], outputPath: string, opts: any = {}): Promise<any> {
    const isEncryptedProvider = this.options.extPath.toLowerCase().includes('amazon') || Boolean(opts && opts.isEncrypted);
    const liveEmitter = isEncryptedProvider ? null : LiveStreamRegistry.find(outputPath);
    const fileName = path.basename(outputPath);
    const startTime = Date.now();
    let bytesReceived = 0;

    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const outputStream = fs.createWriteStream(outputPath);

      const list = (urls || [])
        .map((u) => (typeof u === 'string' ? u : (u && u.url ? String(u.url) : '')))
        .filter(Boolean);

      if (!list.length) {
        const err = new Error('no segment URLs given');
        if (liveEmitter) liveEmitter.fail(err);
        return { success: false, error: 'no segment URLs given' };
      }

      for (let idx = 0; idx < list.length; idx++) {
        const segUrl = list[idx];
        const res = await fetch(segUrl, {
          headers: opts.headers || {},
          redirect: 'follow',
        });
        if (!res.ok) {
          outputStream.close();
          const err = new Error(`Segment failed with HTTP ${res.status}`);
          if (liveEmitter) liveEmitter.fail(err);
          throw err;
        }
        const stream = Readable.fromWeb(res.body as any);
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytesReceived += buf.length;
            if (liveEmitter) {
              liveEmitter.pushChunk(buf);
            }
          });
          stream.pipe(outputStream, { end: false });
          stream.on('end', () => resolve());
          stream.on('error', (err) => {
            if (liveEmitter) liveEmitter.fail(err);
            reject(err);
          });
        });

        const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
        const speedMBps = Number((bytesReceived / (1024 * 1024) / elapsedSec).toFixed(2));
        const percent = Math.min(99, Math.round(((idx + 1) / list.length) * 100));
        DownloadProgressBus.emitProgress({
          filePath: outputPath,
          fileName,
          bytesReceived,
          totalBytes: 0,
          percent,
          speedMBps,
          status: 'downloading',
        });
      }

      outputStream.end();
      if (liveEmitter) liveEmitter.finish();
      const stats = fs.statSync(outputPath);
      const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
      DownloadProgressBus.emitProgress({
        filePath: outputPath,
        fileName,
        bytesReceived: stats.size,
        totalBytes: stats.size,
        percent: 100,
        speedMBps: Number((stats.size / (1024 * 1024) / elapsedSec).toFixed(2)),
        status: 'completed',
      });
      return { success: true, path: outputPath, size: stats.size };
    } catch (e: any) {
      if (liveEmitter) liveEmitter.fail(e);
      return { success: false, error: e.message };
    }
  }

  private ffmpegConvert(input: string, output: string, opts: any = {}): Promise<any> {
    return new Promise((resolve) => {
      import('node:child_process').then(({ execFile }) => {
        try {
          fs.mkdirSync(path.dirname(output), { recursive: true });
        } catch {}

        const codec = opts.codec || 'copy';
        const args = ['-y', '-i', input, '-c:a', codec, output];
        execFile('ffmpeg', args, (err) => {
          if (err) {
            try {
              if (fs.existsSync(input)) {
                fs.copyFileSync(input, output);
                resolve({ success: true, path: output });
                return;
              }
            } catch {}
            resolve({ success: false, error: err.message });
            return;
          }
          resolve({ success: true, path: output });
        });
      });
    });
  }
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { exec, spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import type { ExtensionManager } from '../manager.js';
import { AlbumMatcher } from '../services/album-matcher.js';
import { LinkResolver } from '../services/link-resolver.js';
import { SignedSessionClient } from '../runtime/signed-session.js';
import { AutoTurnstileSolver } from '../runtime/auto-solver.js';
import { LiveStreamRegistry, DownloadProgressBus } from '../runtime/runner.js';
import { PersistentCacheDB } from '../services/db-cache.js';
import { AudioProcessor } from '../services/audio-processor.js';
import { MetadataResolver } from '../services/metadata-resolver.js';
import { RetentionCleaner } from '../services/retention-cleaner.js';

const authEvents = new EventEmitter();
authEvents.setMaxListeners(100);

function syncSessionAcrossNamespace(manager: ExtensionManager, sourceClient: SignedSessionClient) {
  try {
    const srcConfig = sourceClient.getConfig();
    const srcData = sourceClient.getSessionData();
    if (!srcData.session_id) return;

    const installed = manager.getInstalled();
    for (const ext of installed) {
      const runner = manager.getRunner(ext.id);
      const runnerClient = runner?.getSignedClient();
      if (runnerClient) {
        const cfg = runnerClient.getConfig();
        if (cfg.namespace === srcConfig.namespace && cfg.baseUrl === srcConfig.baseUrl) {
          runnerClient.setSessionData(srcData);
        }
      }
    }
  } catch (e) {
    console.warn('[SyncSession] Failed to sync session across namespace:', e);
  }
}

function findChromiumExecutable(): string | null {
  const envBin = process.env.CHROMIUM_PATH || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envBin && fs.existsSync(envBin)) return envBin;

  const targetNames = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : (process.platform === 'darwin' ? ['Google Chrome for Testing', 'Chromium'] : ['chrome', 'chromium', 'chromium-browser']);

  // 1. Search inside project-local .chromium directory and ~/.cache/puppeteer
  const searchDirs = [
    path.resolve(process.cwd(), '.chromium'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ];
  for (const baseDir of searchDirs) {
    if (!fs.existsSync(baseDir)) continue;
    const stack = [baseDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
          } else if (targetNames.includes(entry.name)) {
            return full;
          }
        }
      } catch {}
    }
  }

  // 2. Check common system Chromium / Chrome paths
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
    : [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let chromiumInstallPromise: Promise<string | null> | null = null;

async function ensureChromiumExecutable(): Promise<string | null> {
  const existing = findChromiumExecutable();
  if (existing) return existing;

  if (!chromiumInstallPromise) {
    chromiumInstallPromise = new Promise<string | null>((resolve) => {
      const cacheDir = path.resolve(process.cwd(), '.chromium');
      console.log(`[BrowserLaunch] Chromium no encontrado. Instalando automáticamente en ${cacheDir}...`);
      exec(
        `npx --yes @puppeteer/browsers install chrome@stable --path "${cacheDir}"`,
        { timeout: 180000 },
        (err) => {
          if (err) {
            console.warn(`[BrowserLaunch] No se pudo autoinstalar Chromium con @puppeteer/browsers:`, err.message);
          }
          resolve(findChromiumExecutable());
        }
      );
    }).finally(() => {
      chromiumInstallPromise = null;
    });
  }
  return chromiumInstallPromise;
}

export async function launchSystemBrowser(url: string): Promise<boolean> {
  const chromiumBin = await ensureChromiumExecutable();
  if (chromiumBin) {
    try {
      const env = { ...process.env };
      if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
        env.DISPLAY = ':0';
      }
      console.log(`[BrowserLaunch] Abriendo Chromium (${chromiumBin}) -> ${url}`);
      const child = spawn(
        chromiumBin,
        [`--app=${url}`, '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu'],
        { detached: true, stdio: 'ignore', env }
      );
      const stayedAlive = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), 1500);
        child.once('error', (err) => {
          clearTimeout(timer);
          console.warn(`[BrowserLaunch] Error al iniciar Chromium:`, err.message);
          resolve(false);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code && code !== 0) {
            console.warn(`[BrowserLaunch] Chromium se cerró con código ${code} (posiblemente falta entorno gráfico X11/DISPLAY en la VM). Abre este link en tu navegador: ${url}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
      child.unref();
      if (stayedAlive) return true;
    } catch (e: any) {
      console.warn(`[BrowserLaunch] Falló lanzamiento directo de Chromium:`, e.message);
    }
  }

  let cmd: string;
  if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  return new Promise<boolean>((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        console.warn(`[BrowserLaunch] No se pudo abrir navegador en el servidor (${err.message}). Abre este enlace en tu navegador: ${url}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// High-Speed L1 Memory + L2 SQLite Persistent Caches
interface CacheItem<T> {
  data: T;
  expires: number;
}
const searchCache = new Map<string, CacheItem<any>>();
const enrichTrackCache = new Map<string, CacheItem<any>>();
const providerResolveCache = new Map<string, CacheItem<any>>();

function getNamespaceForMap(map: Map<string, any>): string {
  if (map === searchCache) return 'search';
  if (map === enrichTrackCache) return 'enrich';
  if (map === providerResolveCache) return 'resolve_providers';
  return 'general';
}

function getCached<T>(map: Map<string, CacheItem<T>>, key: string): T | null {
  const item = map.get(key);
  if (item) {
    if (Date.now() <= item.expires) return item.data;
    map.delete(key);
  }
  const ns = getNamespaceForMap(map);
  const fromDb = PersistentCacheDB.get<T>(ns, key);
  if (fromDb !== null) {
    map.set(key, { data: fromDb, expires: Date.now() + 10 * 60 * 1000 });
    return fromDb;
  }
  return null;
}

function setCached<T>(map: Map<string, CacheItem<T>>, key: string, data: T, ttlMs: number): void {
  if (map.size > 2000) {
    const keys = Array.from(map.keys()).slice(0, 200);
    for (const k of keys) map.delete(k);
  }
  map.set(key, { data, expires: Date.now() + ttlMs });
  const ns = getNamespaceForMap(map);
  PersistentCacheDB.set<T>(ns, key, data, ttlMs);
}

export function registerRoutes(app: FastifyInstance, manager: ExtensionManager) {
  // Favicon handler
  app.get('/favicon.ico', async (_req, reply) => {
    return reply.status(204).send();
  });

  function resolveSignedClient(providerName?: string): { client: SignedSessionClient | null; provider: string } {
    const p = providerName || 'tidal-web';
    let runner = manager.getRunner(p);
    let client = runner?.getSignedClient();
    if (client) return { client, provider: p };

    let manifest = manager.getManifest(p) as any;
    if (manifest?.signedSession) {
      return { client: new SignedSessionClient(manifest.signedSession), provider: p };
    }

    const installed = manager.getInstalled();
    for (const ext of installed) {
      const m = manager.getManifest(ext.id) as any;
      if (m?.signedSession) {
        if (ext.id === p || m.signedSession.appVersion === p || m.displayName?.toLowerCase() === p.toLowerCase()) {
          const r = manager.getRunner(ext.id);
          const c = r?.getSignedClient() || new SignedSessionClient(m.signedSession);
          return { client: c, provider: ext.id };
        }
      }
    }

    return { client: null, provider: p };
  }

  // Turnstile Challenge URL Generator (Multi-provider)
  app.get('/api/auth/turnstile/url', async (
    req: FastifyRequest<{ Querystring: { provider?: string } }>,
    reply: FastifyReply
  ) => {
    let reqProvider = (req.query.provider || '').trim();
    if (!reqProvider || reqProvider === 'undefined' || reqProvider === 'null') {
      reqProvider = 'tidal-web';
    }
    const { client, provider } = resolveSignedClient(reqProvider);

    if (!client) {
      return reply.status(500).send({ success: false, error: `No hay cliente de sesión firmada para '${reqProvider}'` });
    }

    if (client.isAuthenticated()) {
      return { success: true, isAuthenticated: true, provider, message: `La sesión para ${provider} ya está autenticada y activa` };
    }

    const host = req.headers.host || '127.0.0.1:3000';
    const callbackBase = `http://${host}`;
    const result = await client.getChallengeUrl(callbackBase, provider);

    if (!result) {
      return { success: true, isAuthenticated: client.isAuthenticated(), provider, message: 'Sesión activa' };
    }

    return {
      success: true,
      isAuthenticated: false,
      provider,
      challengeUrl: result.challengeUrl,
      challengeId: result.challengeId,
    };
  });

  // Launch OS Browser directly with Turnstile challenge
  app.post('/api/auth/turnstile/open', async (
    req: FastifyRequest<{ Body?: { provider?: string }; Querystring?: { provider?: string } }>,
    reply: FastifyReply
  ) => {
    let reqProvider = ((req.body?.provider || req.query?.provider || '') as string).trim();
    if (!reqProvider || reqProvider === 'undefined' || reqProvider === 'null') {
      reqProvider = 'amazon';
    }
    const { client, provider } = resolveSignedClient(reqProvider);

    if (!client) {
      return reply.status(500).send({ success: false, error: `No hay cliente de sesión firmada para '${reqProvider}'` });
    }

    if (client.isAuthenticated()) {
      return { success: true, isAuthenticated: true, provider, message: `La sesión para ${provider} ya está activa` };
    }

    const host = req.headers.host || '127.0.0.1:3000';
    const callbackBase = `http://${host}`;
    const result = await client.getChallengeUrl(callbackBase, provider);

    if (!result) {
      return { success: true, isAuthenticated: client.isAuthenticated(), provider, message: 'Sesión activa' };
    }

    launchSystemBrowser(result.challengeUrl);

    return {
      success: true,
      opened: true,
      provider,
      challengeUrl: result.challengeUrl,
      challengeId: result.challengeId,
      message: `Navegador abierto automáticamente para verificar ${provider}`,
    };
  });

  // Wait for verification completion (Long-poll)
  app.get('/api/auth/turnstile/wait', async (
    req: FastifyRequest<{ Querystring: { provider?: string; timeout?: string } }>,
    reply: FastifyReply
  ) => {
    let reqProvider = (req.query.provider || '').trim();
    if (!reqProvider || reqProvider === 'undefined' || reqProvider === 'null') {
      reqProvider = 'amazon';
    }
    const timeoutMs = Math.min(Math.max(parseInt(req.query.timeout || '60000', 10), 3000), 120000);
    const { client, provider } = resolveSignedClient(reqProvider);

    if (client && client.isAuthenticated()) {
      return { success: true, verified: true, provider, message: 'Sesión ya activa' };
    }

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onVerified = (data: any) => {
        if (!data || data.provider === provider || data.provider === reqProvider) {
          if (timer) clearTimeout(timer);
          authEvents.removeListener('verified', onVerified);
          resolve({ success: true, verified: true, provider, message: 'Verificación completada exitosamente' });
        }
      };

      authEvents.on('verified', onVerified);

      timer = setTimeout(() => {
        authEvents.removeListener('verified', onVerified);
        const isAuth = client ? client.isAuthenticated() : false;
        resolve({
          success: isAuth,
          verified: isAuth,
          provider,
          timeout: true,
          message: isAuth ? 'Sesión verificada' : 'Tiempo de espera agotado para la verificación',
        });
      }, timeoutMs);
    });
  });

  // Turnstile Callback Route (Multi-provider)
  app.get('/api/auth/turnstile/callback', async (
    req: FastifyRequest<{ Querystring: { grant?: string; state?: string; provider?: string } }>,
    reply: FastifyReply
  ) => {
    const { grant } = req.query;
    let queryProvider = (req.query.provider || '').trim();
    if (!queryProvider || queryProvider === 'undefined' || queryProvider === 'null') {
      queryProvider = 'tidal-web';
    }
    if (!grant) {
      return reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head><title>WaveX - Error Turnstile</title><style>body{font-family:sans-serif;background:#0f172a;color:#f87171;text-align:center;padding:50px;}</style></head>
        <body>
          <h2>❌ No se recibió el grant de verificación.</h2>
          <p>Por favor vuelve a intentar resolver el captcha.</p>
        </body>
        </html>
      `);
    }

    const { client, provider } = resolveSignedClient(queryProvider || 'tidal-web');
    if (client) {
      try {
        await client.exchangeGrant(grant);
        syncSessionAcrossNamespace(manager, client);
        authEvents.emit('verified', { provider, timestamp: Date.now() });
        authEvents.emit(`verified:${provider}`, { provider, timestamp: Date.now() });
      } catch (err: any) {
        return reply.type('text/html').send(`
          <!DOCTYPE html>
          <html>
          <head><title>WaveX - Error</title><style>body{font-family:sans-serif;background:#0f172a;color:#f87171;text-align:center;padding:50px;}</style></head>
          <body>
            <h2>❌ Error al canjear el token: ${err.message}</h2>
          </body>
          </html>
        `);
      }
    }

    const displayProv = provider ? provider.toUpperCase() : 'PROVEEDOR';
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WaveX - Sesión Verificada</title>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(52, 211, 153, 0.3); border-radius: 20px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); backdrop-filter: blur(16px); }
          .icon { font-size: 54px; margin-bottom: 16px; }
          h2 { margin: 0 0 12px 0; color: #34d399; font-size: 24px; }
          p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
          .badge { display: inline-block; background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid #34d399; border-radius: 8px; padding: 4px 12px; font-size: 12px; font-weight: 700; margin-bottom: 16px; }
          button { background: linear-gradient(135deg, #059669, #10b981); color: white; border: none; border-radius: 12px; padding: 12px 24px; font-weight: 700; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🎉</div>
          <div class="badge">VERIFICACIÓN EXITOSA</div>
          <h2>¡Turnstile Verificado!</h2>
          <p>La sesión para <strong>${displayProv}</strong> ha sido autorizada y guardada exitosamente en WaveX.<br><br><span id="timerText">Esta pestaña se cerrará automáticamente en 2 segundos...</span></p>
          <button onclick="window.close()">Cerrar Pestaña</button>
        </div>
        <script>
          let seconds = 2;
          const timerEl = document.getElementById('timerText');
          const interval = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
              clearInterval(interval);
              window.close();
              if (timerEl) timerEl.innerText = 'Puedes cerrar esta pestaña y volver a tu app.';
            } else if (timerEl) {
              timerEl.innerText = 'Esta pestaña se cerrará automáticamente en ' + seconds + ' segundo...';
            }
          }, 1000);
          setTimeout(() => { window.close(); }, 1500);
        </script>
      </body>
      </html>
    `);
  });

  // Direct Turnstile Grant Exchange Route (from frontend postMessage or manual paste)
  app.post('/api/auth/turnstile/exchange', async (
    req: FastifyRequest<{ Body: { provider?: string; grant?: string } }>,
    reply: FastifyReply
  ) => {
    const body = (req.body || {}) as any;
    let reqProvider = ((body.provider || '') as string).trim();
    if (!reqProvider || reqProvider === 'undefined' || reqProvider === 'null') {
      reqProvider = 'qobuz-web';
    }
    const rawGrant = ((body.grant || '') as string).trim();
    const grantMatch = rawGrant.match(/grant=([a-zA-Z0-9_-]+)/);
    const grant = grantMatch ? grantMatch[1] : rawGrant;

    if (!grant) {
      return reply.status(400).send({ success: false, error: 'Falta el token de verificación (grant)' });
    }

    const { client, provider } = resolveSignedClient(reqProvider);
    if (!client) {
      return reply.status(404).send({ success: false, error: `No se encontró cliente de sesión para '${reqProvider}'` });
    }

    try {
      await client.exchangeGrant(grant);
      syncSessionAcrossNamespace(manager, client);

      authEvents.emit('verified', { provider, timestamp: Date.now() });
      authEvents.emit(`verified:${provider}`, { provider, timestamp: Date.now() });

      return {
        success: true,
        verified: true,
        provider,
        message: `Sesión de ${provider} canjeada y guardada exitosamente`,
      };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: `Error canjeando token: ${err.message}` });
    }
  });

  // Automated Background Solver Route (via Mornye-Python solver)
  app.post('/api/auth/turnstile/solve-auto', async (
    req: FastifyRequest<{ Body: { provider?: string } }>,
    reply: FastifyReply
  ) => {
    const body = (req.body || {}) as any;
    let reqProvider = ((body.provider || '') as string).trim();
    if (!reqProvider || reqProvider === 'undefined' || reqProvider === 'null') {
      reqProvider = 'qobuz-web';
    }
    const { client, provider } = resolveSignedClient(reqProvider);
    if (!client) {
      return reply.status(404).send({ success: false, error: `No se encontró cliente de sesión para '${reqProvider}'` });
    }

    if (client.isAuthenticated()) {
      return { success: true, verified: true, provider, message: 'La sesión ya está autenticada y activa' };
    }

    if (!AutoTurnstileSolver.isAvailable()) {
      return reply.status(400).send({ success: false, error: 'El solver automático de Mornye-Python no está disponible en este sistema' });
    }

    try {
      const result = await AutoTurnstileSolver.solveAndAuthenticate(client);
      if (result.success) {
        syncSessionAcrossNamespace(manager, client);
        authEvents.emit('verified', { provider, timestamp: Date.now() });
        authEvents.emit(`verified:${provider}`, { provider, timestamp: Date.now() });

        return {
          success: true,
          verified: true,
          provider,
          message: `Sesión de ${provider} resuelta automáticamente en segundo plano`,
        };
      } else {
        return reply.status(500).send({ success: false, error: result.error || 'No se pudo resolver Turnstile automáticamente' });
      }
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // Status & Health
  app.get('/api/status', async () => {
    return {
      name: 'WaveX API',
      version: '1.0.0',
      status: 'online',
      installedCount: manager.getInstalled().length,
      installedExtensions: manager.getInstalled().map((e) => ({
        id: e.id,
        name: e.manifest.displayName || e.manifest.name,
        version: e.manifest.version,
        types: e.manifest.type,
      })),
    };
  });

  // Registry
  app.get('/registry', async (req: FastifyRequest<{ Querystring: { force?: string } }>, reply: FastifyReply) => {
    try {
      const data = await manager.fetchRegistry(req.query.force === 'true');
      return data;
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // List Installed
  app.get('/installed', async () => {
    return { installed: manager.getInstalled() };
  });

  // Install extension by ID
  app.post('/install/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    try {
      const manifest = await manager.installExtension(id);
      return { success: true, message: `Extension ${id} installed and loaded`, manifest };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Trigger Auto-Update for all extensions
  app.post('/api/extensions/auto-update', async (_req, reply) => {
    try {
      const results = await manager.autoUpdateAll();
      return { success: true, count: results.length, updates: results };
    } catch (e: any) {
      reply.status(500).send({ success: false, error: e.message });
    }
  });

  // -------------------------------------------------------------
  // OCTAVE STREAMING SEARCH & SUGGEST
  // -------------------------------------------------------------

  // Octave Streaming Search
  app.get('/api/octave/search', async (
    req: FastifyRequest<{ Querystring: { q: string; limit?: string } }>,
    reply: FastifyReply
  ) => {
    const { q, limit = '30' } = req.query;
    if (!q) return reply.status(400).send({ error: "Query param 'q' is required" });

    const cacheKey = `octave_search_${q.trim().toLowerCase()}_limit${limit}`;
    const cached = getCached(searchCache, cacheKey);
    if (cached) return cached;

    try {
      const url = `https://api.octavestreaming.com/api/search/page?query=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Octave search failed: HTTP ${res.status}`);
      const data = await res.json();
      setCached(searchCache, cacheKey, data, 60 * 60 * 1000);
      return data;
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Octave Streaming Suggest / Autocomplete
  app.get('/api/octave/suggest', async (
    req: FastifyRequest<{ Querystring: { q: string; limit?: string } }>,
    reply: FastifyReply
  ) => {
    const { q, limit = '6' } = req.query;
    if (!q) return reply.status(400).send({ error: "Query param 'q' is required" });

    const cacheKey = `octave_suggest_${q.trim().toLowerCase()}_limit${limit}`;
    const cached = getCached(searchCache, cacheKey);
    if (cached) return cached;

    try {
      const url = `https://api.octavestreaming.com/api/suggest?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Octave suggest failed: HTTP ${res.status}`);
      const data = await res.json();
      setCached(searchCache, cacheKey, data, 60 * 60 * 1000);
      return data;
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Octave Streaming Search WITH Apple Music Metadata Enrichment (High-Speed Cached)
  app.get('/api/octave/search-enriched', async (
    req: FastifyRequest<{ Querystring: { q: string; limit?: string; enrichLimit?: string } }>,
    reply: FastifyReply
  ) => {
    const { q, limit = '24' } = req.query;
    if (!q) return reply.status(400).send({ error: "Query param 'q' is required" });

    const cacheKey = `octave_enriched_${q.trim().toLowerCase()}_limit${limit}`;
    const cachedSearch = getCached(searchCache, cacheKey);
    if (cachedSearch) {
      return cachedSearch;
    }

    try {
      const octaveUrl = `https://api.octavestreaming.com/api/search/page?query=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
      const octaveRes = await fetch(octaveUrl);
      if (!octaveRes.ok) throw new Error(`Octave search failed: HTTP ${octaveRes.status}`);
      const octaveData: any = await octaveRes.json();

      // Immediately attach any already cached Apple Music metadata from memory (0ms cost)
      if (octaveData.tracks && Array.isArray(octaveData.tracks)) {
        octaveData.tracks = octaveData.tracks.map((t: any) => {
          const trackKey = `${(t.isrc || '').trim() || (t.title || '').toLowerCase() + ':' + (t.artist?.name || t.artist || '').toLowerCase()}`;
          const cachedMeta = getCached(enrichTrackCache, trackKey);
          if (cachedMeta) {
            return {
              ...t,
              apple_music: cachedMeta,
              is_enriched: true,
            };
          }
          return {
            ...t,
            is_enriched: false,
          };
        });
      }

      // Non-blocking background pre-enrichment into memory cache
      const appleRunner = manager.getRunner('apple-music');
      if (appleRunner && octaveData.tracks && Array.isArray(octaveData.tracks)) {
        Promise.all(
          octaveData.tracks.slice(0, 3).map(async (t: any) => {
            const trackKey = `${(t.isrc || '').trim() || (t.title || '').toLowerCase() + ':' + (t.artist?.name || t.artist || '').toLowerCase()}`;
            if (getCached(enrichTrackCache, trackKey)) return;
            try {
              const artistName = typeof t.artist === 'string' ? t.artist : (t.artist?.name || '');
              const albumTitle = typeof t.album === 'string' ? t.album : (t.album?.title || '');
              const appleMeta = await appleRunner.call('enrichTrack', [{
                name: t.title,
                artists: artistName,
                album_name: albumTitle,
                isrc: t.isrc || '',
                duration: t.duration || 0,
              }], 3000);
              if (appleMeta) {
                setCached(enrichTrackCache, trackKey, appleMeta, 60 * 60 * 1000);
              }
            } catch {}
          })
        ).catch(() => {});
      }

      setCached(searchCache, cacheKey, octaveData, 60 * 60 * 1000);
      return octaveData;
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Octave Album with Apple Music Cross-Match (UPC + ISRC)
  app.get('/api/octave/album/:id', async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = req.params;
    try {
      const albumMatcher = new AlbumMatcher(manager);
      const matchResult = await albumMatcher.matchOctaveAlbum(id);

      // Fetch the raw octave album too for track listing
      const octaveRes = await fetch(`https://api.octavestreaming.com/api/album/${id}`);
      const octaveData: any = await octaveRes.json();

      return {
        success: true,
        album: octaveData.album,
        apple_match: matchResult,
      };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Dedicated Album Matcher Endpoint (Deezer/Octave ID -> Apple Music ID)
  app.get('/api/match/album/:id', async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = req.params;
    try {
      const albumMatcher = new AlbumMatcher(manager);
      const matchResult = await albumMatcher.matchOctaveAlbum(id);
      return matchResult;
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Dedicated Apple Music Track Enrichment Endpoint
  app.post('/api/enrich/apple-music', async (
    req: FastifyRequest<{
      Body: {
        name: string;
        artists?: string;
        album_name?: string;
        isrc?: string;
        duration?: number;
      };
    }>,
    reply: FastifyReply
  ) => {
    const { name, artists = '', album_name = '', isrc = '', duration = 0 } = req.body || {};
    if (!name) return reply.status(400).send({ error: "'name' is required in request body" });

    const appleRunner = manager.getRunner('apple-music');
    if (!appleRunner) return reply.status(503).send({ error: "Apple Music extension is not installed/loaded" });

    try {
      const enriched = await appleRunner.call('enrichTrack', [{
        name,
        artists,
        album_name,
        isrc,
        duration,
      }], 20000);

      return { success: true, enriched };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // -------------------------------------------------------------
  // GENERIC PROVIDER ROUTES (Spotify, Apple Music, Deezer, etc.)
  // -------------------------------------------------------------

  // Search
  app.get('/api/:provider/search', async (
    req: FastifyRequest<{
      Params: { provider: string };
      Querystring: { q: string; limit?: string; type?: string };
    }>,
    reply: FastifyReply
  ) => {
    const { provider } = req.params;
    const { q, limit, type } = req.query;

    if (!q) return reply.status(400).send({ error: "Query parameter 'q' is required" });

    const runner = manager.getRunner(provider);
    if (!runner) return reply.status(404).send({ error: `Provider '${provider}' not found or not installed` });

    try {
      const parsedLimit = limit ? parseInt(limit, 10) : 20;
      let result;
      try {
        if (type && type !== 'tracks') {
          result = await runner.call('customSearch', [q, { filter: type, limit: parsedLimit }]);
        } else {
          result = await runner.call('searchTracks', [q, parsedLimit]);
        }
      } catch {
        result = await runner.call('customSearch', [q, { filter: type || 'tracks', limit: parsedLimit }]);
      }
      return { success: true, provider, query: q, result };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Get Track
  app.get('/api/:provider/track/:id', async (
    req: FastifyRequest<{ Params: { provider: string; id: string } }>,
    reply: FastifyReply
  ) => {
    const { provider, id } = req.params;
    const runner = manager.getRunner(provider);
    if (!runner) return reply.status(404).send({ error: `Provider '${provider}' not installed` });

    try {
      const track = await runner.call('getTrack', [id]);
      return { success: true, provider, track };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Get Album
  app.get('/api/:provider/album/:id', async (
    req: FastifyRequest<{ Params: { provider: string; id: string } }>,
    reply: FastifyReply
  ) => {
    const { provider, id } = req.params;
    const runner = manager.getRunner(provider);
    if (!runner) return reply.status(404).send({ error: `Provider '${provider}' not installed` });

    try {
      const album = await runner.call('getAlbum', [id]);
      return { success: true, provider, album };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Get Artist
  app.get('/api/:provider/artist/:id', async (
    req: FastifyRequest<{ Params: { provider: string; id: string } }>,
    reply: FastifyReply
  ) => {
    const { provider, id } = req.params;
    const runner = manager.getRunner(provider);
    if (!runner) return reply.status(404).send({ error: `Provider '${provider}' not installed` });

    try {
      const artist = await runner.call('getArtist', [id]);
      return { success: true, provider, artist };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Home Feed
  app.get('/api/:provider/feed', async (
    req: FastifyRequest<{ Params: { provider: string } }>,
    reply: FastifyReply
  ) => {
    const { provider } = req.params;
    const runner = manager.getRunner(provider);
    if (!runner) return reply.status(404).send({ error: `Provider '${provider}' not installed` });

    try {
      const feed = await runner.call('getHomeFeed', []);
      return { success: true, provider, feed };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // Resolve arbitrary URL
  app.get('/api/resolve', async (
    req: FastifyRequest<{ Querystring: { url: string; provider?: string } }>,
    reply: FastifyReply
  ) => {
    const { url, provider: reqProvider } = req.query;
    if (!url) return reply.status(400).send({ error: "Query param 'url' is required" });

    const provider = reqProvider || manager.findProviderForUrl(url);
    if (!provider) {
      return reply.status(400).send({ error: `Could not determine provider for URL: ${url}. Specify ?provider=...` });
    }

    const runner = manager.getRunner(provider);
    if (!runner) return reply.status(404).send({ error: `Provider '${provider}' is not loaded` });

    try {
      const result = await runner.call('handleUrl', [url]);
      return { success: true, provider, result };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  // -------------------------------------------------------------
  // MULTI-PROVIDER RESOLUTION & DOWNLOAD
  // -------------------------------------------------------------

  // Helper to normalize provider quality aliases (e.g. 'HI_RES_MAX', 'hi-res', '24bit' -> 'HI_RES_LOSSLESS')
  function normalizeProviderQuality(provider?: string, rawQuality?: string): string {
    const p = (provider || 'qobuz-web').toLowerCase().trim();
    const q = (rawQuality || '').trim();

    if (!q) {
      if (p.includes('qobuz')) return 'HI_RES_LOSSLESS';
      if (p.includes('tidal')) return 'HI_RES_LOSSLESS';
      if (p.includes('amazon')) return 'best';
      if (p.includes('deezer')) return 'flac';
      return 'best';
    }

    const clean = q.replace(/[\s\-_]+/g, '').toUpperCase();

    if (p.includes('qobuz')) {
      if (clean.includes('MAX') || clean.includes('HIRESLOSSLESS') || clean.includes('24BIT') || clean === 'BEST') {
        return 'HI_RES_LOSSLESS';
      }
      if (clean === 'HIRES' || clean === '24') {
        return 'HI_RES';
      }
      if (clean.includes('LOSSLESS') || clean === 'FLAC' || clean === '16' || clean === 'CD') {
        return 'LOSSLESS';
      }
      return q;
    }

    if (p.includes('tidal')) {
      if (clean.includes('ATMOS') || clean.includes('SPATIAL')) {
        return 'DOLBY_ATMOS';
      }
      if (clean.includes('MAX') || clean.includes('HIRES') || clean.includes('24') || clean === 'BEST') {
        return 'HI_RES_LOSSLESS';
      }
      if (clean.includes('LOSSLESS') || clean === 'FLAC' || clean === '16') {
        return 'LOSSLESS';
      }
      if (clean.includes('HIGH') || clean === '320' || clean.includes('AAC')) {
        return 'HIGH';
      }
      if (clean.includes('LOW') || clean === '96') {
        return 'LOW';
      }
      return q;
    }

    if (p.includes('amazon')) {
      if (clean.includes('ATMOS') || clean.includes('EAC3') || clean.includes('EC3')) return 'eac3';
      if (clean.includes('AC4')) return 'ac4';
      if (clean.includes('FLAC') || clean.includes('LOSSLESS') || clean.includes('HIRES') || clean.includes('MAX') || clean === 'BEST') return 'best';
      if (clean.includes('OPUS') || clean === '320') return 'opus';
      return q.toLowerCase();
    }

    if (p.includes('deezer')) {
      if (clean.includes('FLAC') || clean.includes('LOSSLESS') || clean.includes('HIRES') || clean === 'BEST') return 'flac';
      if (clean === '320' || clean.includes('320')) return 'mp3_320';
      if (clean === '128' || clean.includes('128')) return 'mp3_128';
      return q.toLowerCase();
    }

    return q;
  }

  // Get all providers, their capabilities and exact quality options
  const getProvidersHandler = async () => {
    const list = manager.getInstalled();
    const providersList: any[] = [];

    for (const item of list) {
      const manifest = item.manifest;
      const runner = manager.getRunner(item.id);
      const signedClient = runner?.getSignedClient();
      const isAuth = signedClient ? signedClient.isAuthenticated() : undefined;

      const rawQualities = manifest.qualityOptions || [
        { id: 'best', label: 'Mejor Calidad Disponible', description: 'Calidad nativa recomendada', kind: 'lossless' }
      ];

      const qualities = rawQualities.map((qo: any) => ({
        id: qo.id,
        label: qo.label || qo.id,
        description: qo.description || '',
        kind: qo.kind || 'lossless',
      }));

      const defaultQuality = qualities[0]?.id || 'best';

      providersList.push({
        id: item.id,
        name: manifest.displayName || manifest.name,
        version: manifest.version,
        description: manifest.description,
        type: manifest.type || [],
        isDownloadProvider: Boolean(manifest.type?.includes('download_provider')),
        isMetadataProvider: Boolean(manifest.type?.includes('metadata_provider')),
        requiresAuth: Boolean((manifest as any).signedSession),
        isAuthenticated: isAuth,
        defaultQuality,
        qualities,
        capabilities: manifest.capabilities || {},
        exampleStreamUrl: `/api/stream/live?title=Agora%20Hills&artist=Doja%20Cat&provider=${item.id}&quality=${defaultQuality}`,
      });
    }

    return {
      success: true,
      count: providersList.length,
      providers: providersList,
    };
  };

  app.get('/api/providers', getProvidersHandler);
  app.get('/api/providers/all', getProvidersHandler);

  // Get all download-capable providers and their quality options (backwards compatibility)
  app.get('/api/providers/download-options', async () => {
    const res = await getProvidersHandler();
    return {
      providers: res.providers
        .filter((p) => p.isDownloadProvider || p.qualities.length > 0)
        .map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          qualities: p.qualities,
        })),
    };
  });

  // ---- Track existence verification helpers ----
  function normText(s: any): string {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\(\[][^\)\]]*(feat|ft\.|with|prod)[^\)\]]*[\)\]]/g, ' ')
      .replace(/\b(feat|ft)\.?\s.*$/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** True only if a provider search result really is the requested track (ISRC match, or title + artist match). */
  function matchesTrack(candidate: any, title: string, artist: string, isrc?: string): { ok: boolean; by: string } {
    if (!candidate) return { ok: false, by: '' };
    const cIsrc = String(candidate.isrc || '').toUpperCase();
    if (isrc && cIsrc && cIsrc === isrc.toUpperCase()) return { ok: true, by: 'isrc' };

    const cTitle = normText(candidate.name || candidate.title);
    const wTitle = normText(title);
    if (!cTitle || !wTitle) return { ok: false, by: '' };
    const titleOk = cTitle === wTitle ||
      ((cTitle.includes(wTitle) || wTitle.includes(cTitle)) && Math.min(cTitle.length, wTitle.length) / Math.max(cTitle.length, wTitle.length) >= 0.7);
    if (!titleOk) return { ok: false, by: '' };

    const wArtist = normText(artist);
    if (!wArtist) return { ok: true, by: 'title' };
    const cArtistRaw = candidate.artists ?? candidate.artist ?? candidate.performer?.name ?? candidate.performer;
    const cArtist = normText(Array.isArray(cArtistRaw) ? cArtistRaw.map((a: any) => a?.name || a).join(' ') : (cArtistRaw?.name || cArtistRaw));
    if (!cArtist) return { ok: false, by: '' };
    const wTokens = wArtist.split(' ').filter((t) => t.length > 1);
    const artistOk = cArtist.includes(wArtist) || wArtist.includes(cArtist) || wTokens.some((t) => cArtist.split(' ').includes(t));
    return artistOk ? { ok: true, by: 'title+artist' } : { ok: false, by: '' };
  }

  // Helper function replicating Mornye _provider_match_options
  function buildMornyeOptions(
    provider: string,
    title: string,
    artist: string,
    durationMs: number = 0,
    isrc?: string,
    resolvedLinks?: any
  ): Record<string, any> {
    const options: Record<string, any> = {
      duration_ms: durationMs,
      isrc: isrc || '',
      track: {
        name: title,
        artists: artist,
        album_name: '',
        duration_ms: durationMs,
        isrc: isrc || '',
      },
    };

    if (resolvedLinks) {
      if (resolvedLinks.isrc && !options.isrc) {
        options.isrc = resolvedLinks.isrc;
        options.track.isrc = resolvedLinks.isrc;
      }
      if (resolvedLinks.spotify) {
        options.spotify_url = resolvedLinks.spotify;
        const spM = resolvedLinks.spotify.match(/\/track\/([A-Za-z0-9]{22})/i);
        if (spM) options.spotify_id = spM[1];
      }
      if (resolvedLinks.tidal) options.tidal_url = resolvedLinks.tidal;
      if (resolvedLinks.deezer) options.deezer_url = resolvedLinks.deezer;
      if (resolvedLinks.qobuz) options.qobuz_url = resolvedLinks.qobuz;
      if (resolvedLinks.amazonMusic) options.amazon_url = resolvedLinks.amazonMusic;
      if (resolvedLinks.youtubeMusic) options.youtube_url = resolvedLinks.youtubeMusic;

      if (resolvedLinks.nativeIds?.tidalId) options.tidal_id = resolvedLinks.nativeIds.tidalId;
      if (resolvedLinks.nativeIds?.deezerId) options.deezer_id = resolvedLinks.nativeIds.deezerId;
      if (resolvedLinks.nativeIds?.qobuzId) options.qobuz_id = resolvedLinks.nativeIds.qobuzId;
      if (resolvedLinks.nativeIds?.amazonAsin) {
        options.amazon_id = resolvedLinks.nativeIds.amazonAsin;
      }
      if (resolvedLinks.nativeIds?.youtubeVideoId) {
        options.youtube_video_id = resolvedLinks.nativeIds.youtubeVideoId;
      }
    }

    return options;
  }

  // Resolve a track across all download providers using Mornye's LinkResolver + checkAvailability
  app.get('/api/resolve-track-providers', async (
    req: FastifyRequest<{
      Querystring: { title: string; artist: string; isrc?: string };
    }>,
    reply: FastifyReply
  ) => {
    const { title, artist, isrc } = req.query;
    const qExtra: any = req.query || {};
    const strict = !(qExtra.strict === '0' || qExtra.strict === 'false');
    let ytHintId = String(qExtra.videoId || '').trim();
    if (!ytHintId && qExtra.url) {
      const m = String(qExtra.url).match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
      if (m) ytHintId = m[1];
    }
    if (!title) return reply.status(400).send({ error: "Query param 'title' is required" });

    const cacheKey = `${(title || '').toLowerCase()}_${(artist || '').toLowerCase()}_${isrc || ''}_${strict ? 's' : 'a'}_${ytHintId}`;
    const cached = getCached(providerResolveCache, cacheKey);
    if (cached) {
      return cached;
    }

    const searchQuery = `${title} ${artist || ''}`.trim();
    const installed = manager.getInstalled();
    const downloadProviders = installed.filter((i) => i.manifest.type?.includes('download_provider'));

    // 1. Resolve cross-platform links via LinkResolver with a fast 4s timeout
    let resolvedLinks: any = null;
    try {
      resolvedLinks = await Promise.race([
        LinkResolver.resolveByMetadata(title, artist || '', isrc, manager),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
    } catch {}

    // The metadata resolver takes the first Spotify hit blindly, so an unknown song can come back with the ISRC of an
    // UNRELATED track. Only trust the ISRC/links if the user gave the ISRC, or the resolved ISRC really is this song.
    let isrcTrusted = Boolean(isrc);
    if (!isrcTrusted && resolvedLinks?.isrc) {
      try {
        const dzRes = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(resolvedLinks.isrc)}`, { signal: AbortSignal.timeout(3500) });
        if (dzRes.ok) {
          const dz: any = await dzRes.json();
          if (dz && !dz.error && matchesTrack({ title: dz.title, artist: dz.artist?.name }, title, artist || '').ok) isrcTrusted = true;
        }
      } catch {}
    }
    if (!isrcTrusted) resolvedLinks = null;

    const effectiveIsrc = isrc || resolvedLinks?.isrc || '';
    const primaryArtist = (artist || '').split(/[,;&]|\b(?:feat|ft|with)\.?\b/i)[0].trim();
    const shortSearchQuery = primaryArtist ? `${title} ${primaryArtist}`.trim() : searchQuery;
    const available: any[] = [];

    await Promise.allSettled(
      downloadProviders.map(async ({ id: providerId, manifest }) => {
        const runner = manager.getRunner(providerId);
        if (!runner || !manifest) return;

        let trackId: string | null = null;
        let preparedContext: any = null;
        let verifiedBy = '';
        const isYtm = providerId === 'ytmusic-spotiflac';

        // Resolver IDs are only a HINT (ISRC based). They are trusted for ISRC-keyed catalogs only.
        let hintId = '';
        if (resolvedLinks?.nativeIds && effectiveIsrc) {
          if (providerId === 'qobuz-web') hintId = String(resolvedLinks.nativeIds.qobuzId || '');
          else if (providerId === 'tidal-web') hintId = String(resolvedLinks.nativeIds.tidalId || '');
          else if (providerId === 'deezer') hintId = String(resolvedLinks.nativeIds.deezerId || '');
        }

        try {
          const options = buildMornyeOptions(providerId, title, artist || '', 0, effectiveIsrc, resolvedLinks);

          // 1) Provider-native availability check (only meaningful with a trusted ISRC / links)
          try {
            const check = isrcTrusted ? await runner.call('checkAvailability', [effectiveIsrc, title, artist || '', options], 3500) : null;
            if (check && check.available && check.track_id) {
              trackId = String(check.track_id).replace(/^(?:qobuz|tidal|deezer|spotify:track):/i, '');
              preparedContext = check.prepared_context || null;
              verifiedBy = 'checkAvailability';
            }
          } catch {}

          // 2) ISRC-keyed hint from the resolver (Qobuz/Tidal/Deezer) if already resolved
          if (!trackId && hintId) {
            trackId = hintId;
            verifiedBy = 'resolver:isrc';
          }

          // 3) Search the provider and require a REAL match (ISRC or title+artist), never just result[0]
          if (!trackId) {
            try {
              const q = effectiveIsrc && !isYtm ? effectiveIsrc : shortSearchQuery;
              let results: any = await runner.call('customSearch', [q, { filter: 'tracks', limit: 6 }], 3500);
              if ((!Array.isArray(results) || !results.length) && q !== shortSearchQuery) {
                results = await runner.call('customSearch', [shortSearchQuery, { filter: 'tracks', limit: 6 }], 3500);
              }
              if (Array.isArray(results)) {
                for (const r of results) {
                  const m = matchesTrack(r, title, artist || '', effectiveIsrc);
                  if (m.ok && r.id) {
                    trackId = String(r.id).replace(/^(?:qobuz|tidal|deezer|spotify:track):/i, '');
                    verifiedBy = 'search:' + m.by;
                    break;
                  }
                }
              }
            } catch {}
          }

          // 3b) Direct public Qobuz API fallback if qobuz-web worker timed out or was busy
          if (!trackId && providerId === 'qobuz-web') {
            try {
              const qbzQuery = effectiveIsrc || shortSearchQuery;
              const qbzRes = await fetch(
                `https://www.qobuz.com/api.json/0.2/track/search?query=${encodeURIComponent(qbzQuery)}&limit=6`,
                { headers: { 'X-App-Id': '735532640', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3000) }
              );
              if (qbzRes.ok) {
                const qbzData: any = await qbzRes.json();
                let items: any[] = qbzData?.tracks?.items || [];
                if (!items.length && qbzQuery !== shortSearchQuery) {
                  const qbzRes2 = await fetch(
                    `https://www.qobuz.com/api.json/0.2/track/search?query=${encodeURIComponent(shortSearchQuery)}&limit=6`,
                    { headers: { 'X-App-Id': '735532640', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3000) }
                  );
                  if (qbzRes2.ok) {
                    const qbzData2: any = await qbzRes2.json();
                    items = qbzData2?.tracks?.items || [];
                  }
                }
                for (const r of items) {
                  const m = matchesTrack(r, title, artist || '', effectiveIsrc);
                  if (m.ok && r.id) {
                    trackId = String(r.id);
                    verifiedBy = 'qobuz-public:' + m.by;
                    break;
                  }
                }
              }
            } catch {}
          }

          // 4) YouTube link given by the user: that exact video is, by definition, on YT Music
          if (isYtm && ytHintId) { trackId = ytHintId; verifiedBy = 'user-youtube-link'; }
        } catch (_) {}

        // Strict mode: only list providers where the song really exists. YT Music is always kept as the final option.
        if (strict && !trackId && !isYtm) return;

        let resolvedId = trackId || '';
        if (!resolvedId && isYtm) resolvedId = effectiveIsrc || title;
        if (!resolvedId) resolvedId = effectiveIsrc || title;

        const requiresSigned = ((manifest as any).requiredRuntimeFeatures || []).some((f: string) => f.startsWith('signedSession'));

        available.push({
          provider: providerId,
          displayName: manifest.displayName || manifest.name,
          trackId: String(resolvedId),
          verified: Boolean(verifiedBy),
          verifiedBy: verifiedBy || undefined,
          preparedContext,
          name: title,
          artists: artist || '',
          cover: '',
          duration: 0,
          requiresSignedSession: requiresSigned,
          qualities: manifest.qualityOptions || [
            { id: 'best', label: 'Mejor Calidad', description: 'Audio extraído vía extensión', kind: 'lossless' }
          ],
        });
      })
    );

    // Prioritize providers: Qobuz and YTMusic first, then non-signed, then signed
    const priorityOrder = ['qobuz-web', 'ytmusic-spotiflac', 'soundcloud', 'jiosaavn', 'deezer', 'tidal-web', 'amazon'];
    available.sort((a, b) => {
      const idxA = priorityOrder.indexOf(a.provider);
      const idxB = priorityOrder.indexOf(b.provider);
      return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
    });

    const response = {
      query: searchQuery,
      availableProviders: available,
      resolvedLinks,
    };

    setCached(providerResolveCache, cacheKey, response, 15 * 60 * 1000);
    return response;
  });

  // Download a track with selected provider and quality via extension
  app.post('/api/:provider/download', async (
    req: FastifyRequest<{
      Params: { provider: string };
      Body: {
        trackId: string;
        quality?: string;
        filename?: string;
        title?: string;
        artist?: string;
        album?: string;
        coverUrl?: string;
        isrc?: string;
        format?: 'mp3_320' | 'flac' | 'alac' | 'aac' | 'wav';
        preparedContext?: any;
      };
    }>,
    reply: FastifyReply
  ) => {
    const { provider } = req.params;
    const { trackId, quality: rawQuality, filename, title, artist, album, coverUrl, isrc, format, preparedContext } = req.body || {};
    const quality = normalizeProviderQuality(provider, rawQuality);

    if (!trackId) return reply.status(400).send({ success: false, error: "'trackId' is required" });

    const runner = manager.getRunner(provider);
    const manifest = manager.getManifest(provider);
    if (!runner) return reply.status(404).send({ success: false, error: `Provider '${provider}' not found` });

    const downloadsDir = path.resolve(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    // Clean base name for the downloaded file
    const safeBaseName = `${(filename || `${artist ? `${artist} - ` : ''}${title || trackId}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 90)} [${provider}-${quality}]`;
    const isAtmos = /atmos|eac3|ec3/i.test(quality);
    const isLossless = /flac|lossless|hi_res|best|24bit/i.test(quality) && !provider.includes('ytmusic');
    const guessedExt = isAtmos ? '.eac3' : (isLossless ? '.flac' : '.m4a');
    const targetPath = path.join(downloadsDir, `${safeBaseName}${guessedExt}`);

    // If already downloaded previously from this provider and quality, return it with the REAL provider attribution and specs
    const existingMatch = fs.readdirSync(downloadsDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.tmp') && !f.endsWith('.lrc'));
    if (existingMatch) {
      const finalExisting = path.join(downloadsDir, existingMatch);
      const sizeBytes = fs.statSync(finalExisting).size;
      const audioSpecs = await AudioProcessor.probeAudioFile(finalExisting);
      return {
        success: true,
        cached: true,
        provider,
        displayName: manifest?.displayName || provider,
        trackId,
        quality,
        outputPath: finalExisting,
        fileName: existingMatch,
        sizeBytes,
        audioSpecs,
        streamUrl: `/downloads/${encodeURIComponent(existingMatch)}`,
      };
    }

    try {
      let effectiveTrackId = trackId;

      // Ensure native provider IDs if an ISRC or title string was passed
      if (provider === 'qobuz-web' && !/^\d+$/.test(effectiveTrackId)) {
        console.log(`[Download] Resolving native Qobuz track ID for '${effectiveTrackId}'...`);
        try {
          const resolved = await LinkResolver.resolveByMetadata(title || '', artist || '', isrc || effectiveTrackId, manager);
          if (resolved?.nativeIds?.qobuzId) {
            effectiveTrackId = resolved.nativeIds.qobuzId;
            console.log(`[Download] Successfully mapped Qobuz track ID -> ${effectiveTrackId}`);
          }
        } catch {}
      } else if (provider === 'tidal-web' && !/^\d+$/.test(effectiveTrackId)) {
        try {
          const resolved = await LinkResolver.resolveByMetadata(title || '', artist || '', isrc || effectiveTrackId, manager);
          if (resolved?.nativeIds?.tidalId) {
            effectiveTrackId = resolved.nativeIds.tidalId;
            console.log(`[Download] Successfully mapped Tidal track ID -> ${effectiveTrackId}`);
          }
        } catch {}
      } else if (provider === 'deezer' && !/^\d+$/.test(effectiveTrackId)) {
        try {
          const resolved = await LinkResolver.resolveByMetadata(title || '', artist || '', isrc || effectiveTrackId, manager);
          if (resolved?.nativeIds?.deezerId) {
            effectiveTrackId = resolved.nativeIds.deezerId;
            console.log(`[Download] Successfully mapped Deezer track ID -> ${effectiveTrackId}`);
          }
        } catch {}
      } else if (provider === 'amazon' && !/^B[0-9A-Z]{9}$/i.test(effectiveTrackId)) {
        try {
          const resolved = await LinkResolver.resolveByMetadata(title || '', artist || '', isrc || effectiveTrackId, manager);
          if (resolved?.nativeIds?.amazonAsin) {
            effectiveTrackId = resolved.nativeIds.amazonAsin;
            console.log(`[Download] Successfully mapped Amazon ASIN -> ${effectiveTrackId}`);
          }
        } catch {}
      }

      console.log(`[Download] ${provider} track=${effectiveTrackId} (orig=${trackId}) quality=${quality} -> ${targetPath}`);

      // Prepare Mornye download options
      let downloadOptions: any = {
        duration_ms: 0,
        isrc: isrc || '',
        track: {
          name: title || '',
          artists: artist || '',
          album_name: '',
          duration_ms: 0,
          isrc: isrc || '',
        },
      };

      if (preparedContext) {
        downloadOptions.preparedContext = preparedContext;
      } else {
        const isNativeTrackId =
          (provider === 'qobuz-web' && /^\d+$/.test(effectiveTrackId)) ||
          (provider === 'tidal-web' && /^\d+$/.test(effectiveTrackId)) ||
          (provider === 'deezer' && /^\d+$/.test(effectiveTrackId)) ||
          (provider === 'amazon' && /^B[0-9A-Z]{9}$/i.test(effectiveTrackId)) ||
          (provider === 'ytmusic-spotiflac' && /^[A-Za-z0-9_-]{11}$/.test(effectiveTrackId));

        if (!isNativeTrackId) {
          try {
            const resolvedLinks = await LinkResolver.resolveByMetadata(title || '', artist || '', isrc, manager);
            const mornyeOpts = buildMornyeOptions(provider, title || '', artist || '', 0, isrc, resolvedLinks);
            const check = await runner.call('checkAvailability', [isrc || '', title || '', artist || '', mornyeOpts], 6000);
            if (check) {
              if (check.track_id) {
                effectiveTrackId = String(check.track_id).trim();
                console.log(`[Download] checkAvailability matched ${provider} native track_id -> ${effectiveTrackId}`);
              }
              if (check.prepared_context) {
                downloadOptions = { ...mornyeOpts, preparedContext: check.prepared_context };
              }
            }
          } catch {}
        }
      }

      let downloadResult: any = await runner.call(
        'download',
        [effectiveTrackId, quality, targetPath, '__progress__', downloadOptions],
        300000
      );

      let isVerification = downloadResult && downloadResult.success === false && (
        downloadResult.error_type === 'verification_required' ||
        /verify[_\s-]?required|turnstile|session.*expir|challenge/i.test(downloadResult.error_message || downloadResult.error || '')
      );

      let challengeUrl: string | undefined;
      let challengeId: string | undefined;

      if (isVerification) {
        const { client } = resolveSignedClient(provider);
        const host = req.headers.host || '127.0.0.1:3000';
        const chal = client ? await client.getChallengeUrl(`http://${host}`, provider).catch(() => null) : null;
        challengeUrl = chal?.challengeUrl;
        challengeId = chal?.challengeId;
        console.log(`[Download] ${provider} requiere verificación Turnstile. Challenge URL: ${challengeUrl || 'N/A'}`);

        const rawAutoPrompt = (req.body as any)?.autoPrompt ?? (req.query as any)?.autoPrompt;
        const autoPrompt = rawAutoPrompt === undefined ? true : (rawAutoPrompt !== false && rawAutoPrompt !== 'false' && rawAutoPrompt !== '0');

        if (isVerification && autoPrompt && client && challengeUrl) {
          console.log(`[Download] Intentando abrir Chromium para verificar Turnstile...`);
          const opened = await launchSystemBrowser(challengeUrl);
          if (opened) {
            const verified = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                authEvents.removeListener('verified', onV);
                resolve(client.isAuthenticated());
              }, 75000);
              const onV = (data: any) => {
                if (!data || data.provider === provider) {
                  clearTimeout(timer);
                  authEvents.removeListener('verified', onV);
                  resolve(true);
                }
              };
              authEvents.on('verified', onV);
            });

            if (verified) {
              console.log(`[Download] ${provider} verificación confirmada. Reintentando descarga...`);
              downloadResult = await runner.call(
                'download',
                [effectiveTrackId, quality, targetPath, '__progress__', downloadOptions],
                300000
              );
              isVerification = downloadResult && downloadResult.success === false && (
                downloadResult.error_type === 'verification_required' ||
                /verify[_\s-]?required|turnstile|session.*expir|challenge/i.test(downloadResult.error_message || downloadResult.error || '')
              );
            }
          }
        }
      }

      if (downloadResult && downloadResult.success === false) {
        const msg = downloadResult.error_message || downloadResult.error || 'Download failed';
        console.warn(`[Download] ${provider} failed: ${msg}`);
        return reply.status(200).send({
          success: false,
          error: msg,
          error_type: isVerification ? 'verification_required' : downloadResult.error_type,
          needsVerification: isVerification,
          provider,
          quality,
          challengeUrl,
          challengeId,
        });
      }

      let finalPath: string | null = null;
      const reported = downloadResult?.file_path || downloadResult?.path || downloadResult?.output_path;
      if (reported && fs.existsSync(reported)) finalPath = reported;
      if (!finalPath && fs.existsSync(targetPath)) finalPath = targetPath;
      if (!finalPath) {
        const match = fs.readdirSync(downloadsDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.lrc'));
        if (match) finalPath = path.join(downloadsDir, match);
      }

      if (!finalPath) {
        return reply.status(200).send({
          success: false,
          error: 'La extensión terminó pero no se encontró el archivo de audio descargado',
          provider,
          result: downloadResult,
        });
      }

      // Optional on-the-fly format conversion if requested by client app
      if (format) {
        const converted = await AudioProcessor.convertAudioFormat(finalPath, format);
        if (converted) finalPath = converted;
      }

      // Probe exact audio specs and embed ID3v2 / Vorbis tags + 3000x3000 Cover + Synced Lyrics (.lrc)
      const audioSpecs = await AudioProcessor.probeAudioFile(finalPath);
      const tagRes = await AudioProcessor.embedMetadataAndArtwork(finalPath, {
        title: title || trackId,
        artist: artist || '',
        album: album || title || '',
        isrc: isrc || '',
        coverUrl: coverUrl || downloadResult?.cover_url || '',
        durationSec: audioSpecs?.durationSec,
      });

      const sizeBytes = fs.statSync(finalPath).size;
      const fileName = path.basename(finalPath);

      PersistentCacheDB.recordDownload({
        title: title || fileName,
        artist: artist || '',
        album: album || '',
        isrc: isrc || '',
        provider,
        quality,
        fileName,
        filePath: finalPath,
        sizeBytes,
        codec: audioSpecs?.codec,
        sampleRate: audioSpecs?.sampleRate,
        bitsPerSample: audioSpecs?.bitsPerSample,
        bitrateKbps: audioSpecs?.bitrateKbps,
        channels: audioSpecs?.channels,
        durationSec: audioSpecs?.durationSec,
        hasLyrics: tagRes.hasLyrics,
        createdAt: Date.now(),
      });

      return {
        success: true,
        cached: false,
        provider,
        displayName: manifest?.displayName || provider,
        trackId,
        quality,
        outputPath: finalPath,
        fileName,
        sizeBytes,
        audioSpecs,
        tagged: tagRes.tagged,
        hasLyrics: tagRes.hasLyrics,
        lrcFile: tagRes.lrcPath ? path.basename(tagRes.lrcPath) : null,
        result: downloadResult,
        streamUrl: `/downloads/${encodeURIComponent(fileName)}`,
      };
    } catch (e: any) {
      console.error(`[Download] ${provider} error:`, e);
      const isSignedErr = /signed|turnstile|session|401|428/i.test(e.message || '');
      return reply.status(200).send({
        success: false,
        error: isSignedErr
          ? `La extensión '${provider}' requiere una sesión activa con verificación Turnstile en api.zarz.moe. Te recomendamos usar Qobuz o YouTube Music para descargar y escuchar sin restricciones.`
          : e.message || String(e),
        error_type: isSignedErr ? 'session_verification_required' : 'download_error',
        provider,
      });
    }
  });

  function pruneStreamCache(dir: string, maxFiles: number = 12) {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir)
        .filter((f) => !f.endsWith('.part') && !f.endsWith('.tmp'))
        .map((f) => {
          const fp = path.join(dir, f);
          return { name: f, path: fp, mtime: fs.statSync(fp).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > maxFiles) {
        files.slice(maxFiles).forEach((f) => {
          try { fs.unlinkSync(f.path); } catch {}
        });
      }
    } catch {}
  }

  async function stripVideoIfPresent(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) return filePath;
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.m4a' && ext !== '.mp4') return filePath;

    try {
      const hasVideo = await new Promise<boolean>((resolve) => {
        exec(`ffprobe -v error -select_streams v -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, (err, stdout) => {
          resolve(!err && Boolean(stdout && stdout.trim()));
        });
      });

      if (hasVideo) {
        const purePath = `${filePath}.pure.m4a`;
        await new Promise<void>((resolve) => {
          exec(`ffmpeg -y -v quiet -i "${filePath}" -vn -c:a copy "${purePath}"`, (err) => {
            if (!err && fs.existsSync(purePath) && fs.statSync(purePath).size > 1024) {
              try {
                fs.unlinkSync(filePath);
                fs.renameSync(purePath, filePath);
              } catch {}
            }
            resolve();
          });
        });
      }
    } catch {}
    return filePath;
  }

  async function serveLocalRangeAudio(filePath: string, req: FastifyRequest, reply: FastifyReply) {
    filePath = await stripVideoIfPresent(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const isBrowserAudioTag = req.headers['sec-fetch-dest'] === 'audio' || (req.query as any)?.browser === '1';

    // Dolby Atmos (.eac3 / .ec3) real-time transcoding to 24-bit FLAC for web browsers that lack native E-AC-3 JOC decoding
    if ((ext === '.eac3' || ext === '.ec3') && isBrowserAudioTag) {
      reply.raw.setHeader('Content-Type', 'audio/flac');
      reply.raw.setHeader('Transfer-Encoding', 'chunked');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.writeHead(200);

      const ff = spawn('ffmpeg', [
        '-v', 'quiet',
        '-i', filePath,
        '-ac', '2',
        '-af', 'aresample=matrix_encoding=dplii',
        '-c:a', 'flac',
        '-f', 'flac',
        'pipe:1',
      ]);
      ff.stdout.pipe(reply.raw);
      req.raw.on('close', () => {
        try { ff.kill('SIGKILL'); } catch {}
      });
      return reply;
    }

    const mimeByExt: Record<string, string> = {
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
    const contentType = mimeByExt[ext] || 'application/octet-stream';
    const size = fs.statSync(filePath).size;
    const range = req.headers.range;

    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=86400');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start >= size) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(filePath));
  }

  const activeLiveStreams = new Set<string>();

  // Progressive Chunked Live Streaming with Full HTTP 206 Byte-Range Seeking Support
  app.get('/api/stream/live', async (
    req: FastifyRequest<{
      Querystring: {
        title: string;
        artist?: string;
        isrc?: string;
        provider?: string;
        trackId?: string;
        quality?: string;
        browser?: string;
      };
    }>,
    reply: FastifyReply
  ) => {
    const qObj: any = req.query as any || {};
    const { title, artist, isrc, provider: rawProvider, trackId: reqTrackId, quality: rawQuality } = qObj;
    if (!title) return reply.status(400).send({ error: "'title' query param is required" });

    const provider = rawProvider || 'qobuz-web';
    const quality = normalizeProviderQuality(provider, rawQuality);
    const wantJson = qObj.json === '1' || qObj.json === 'true' || qObj.format === 'json';
    const downloadsDir = path.resolve(process.cwd(), 'downloads');
    const streamCacheDir = path.resolve(process.cwd(), 'data', 'stream_cache');
    if (!fs.existsSync(streamCacheDir)) fs.mkdirSync(streamCacheDir, { recursive: true });
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    const safeBaseName = `${(artist ? `${artist} - ` : '')}${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) + ` [${provider}-${quality}]`;

    // 1. Check if complete file already exists in streamCache or downloads
    const existingCache = fs.readdirSync(streamCacheDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.tmp'));
    const existingDownload = fs.readdirSync(downloadsDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.tmp') && !f.endsWith('.lrc'));
    const existingFile = existingCache ? path.join(streamCacheDir, existingCache) : (existingDownload ? path.join(downloadsDir, existingDownload) : null);

    if (wantJson) {
      const isAtmos = /atmos|eac3|ec3/i.test(quality);
      const isLossless = /flac|lossless|hi_res|best|24bit/i.test(quality) && !provider.includes('ytmusic');
      const guessedExt = isAtmos ? 'eac3' : (isLossless ? 'flac' : (provider.includes('ytmusic') ? 'm4a' : 'flac'));
      const meta = await MetadataResolver.resolveRichTrack({
        title,
        artist,
        isrc,
        trackId: reqTrackId,
        provider,
      }, manager);

      let specs: any = null;
      let sizeBytes: number | undefined;
      if (existingFile) {
        sizeBytes = fs.statSync(existingFile).size;
        specs = await AudioProcessor.probeAudioFile(existingFile);
      }

      return {
        success: true,
        cached: Boolean(existingFile),
        provider,
        quality,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        isrc: meta.isrc,
        coverUrl: meta.coverUrl,
        durationSec: meta.durationSec || specs?.durationSec,
        durationMs: meta.durationMs || (specs?.durationSec ? Math.round(specs.durationSec * 1000) : undefined),
        releaseDate: meta.releaseDate,
        year: meta.year,
        sizeBytes,
        audioSpecs: specs || {
          codec: guessedExt,
          sampleRate: isLossless ? 96000 : 44100,
          bitDepth: isLossless ? 24 : 16,
        },
        streamUrl: `/api/stream/live?title=${encodeURIComponent(meta.title)}&artist=${encodeURIComponent(meta.artist)}&provider=${encodeURIComponent(provider)}&quality=${encodeURIComponent(quality)}`,
        fastStreamUrl: meta.fastStreamUrl,
        lyricsUrl: meta.lyricsUrl,
        queueUrl: meta.queueUrl,
        relatedUrl: meta.relatedUrl,
      };
    }

    if (existingFile) {
      return serveLocalRangeAudio(existingFile, req, reply);
    }

    // 2. Prepare progressive stream with Range-capable LiveStreamEmitter
    const isAtmos = /atmos|eac3|ec3/i.test(quality);
    const isLossless = /flac|lossless|hi_res|best|24bit/i.test(quality) && !provider.includes('ytmusic');
    const guessedExt = isAtmos ? '.eac3' : (isLossless ? '.flac' : (provider.includes('ytmusic') ? '.m4a' : '.flac'));
    const targetPath = path.join(streamCacheDir, `${safeBaseName}${guessedExt}`);

    const mimeByExt: Record<string, string> = {
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.mp4': 'audio/mp4',
      '.mp3': 'audio/mpeg',
      '.opus': 'audio/ogg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.eac3': 'audio/eac3',
    };

    const emitter = LiveStreamRegistry.register(targetPath);

    // 3. Launch provider download in background with Smart Fallback & Parallel Resolution
    if (!activeLiveStreams.has(targetPath)) {
      activeLiveStreams.add(targetPath);
      (async () => {
        const fallbackChain = [...new Set([provider, 'qobuz-web', 'ytmusic-spotiflac', 'soundcloud', 'tidal-web', 'deezer'])];

        for (const candidateProv of fallbackChain) {
          try {
            const runner = manager.getRunner(candidateProv);
            if (!runner) continue;

            let targetTrackId = candidateProv === provider && reqTrackId ? reqTrackId : undefined;
            let preparedContext: any = null;
            let resolvedLinks: any = null;

            const isValidNativeId =
              targetTrackId &&
              ((candidateProv === 'qobuz-web' && /^\d+$/.test(targetTrackId)) ||
               (candidateProv === 'tidal-web' && /^\d+$/.test(targetTrackId)) ||
               (candidateProv === 'deezer' && /^\d+$/.test(targetTrackId)) ||
               (candidateProv === 'amazon' && /^B[0-9A-Z]{9}$/i.test(targetTrackId)) ||
               (candidateProv === 'ytmusic-spotiflac' && /^[A-Za-z0-9_-]{11}$/.test(targetTrackId)));

            if (!isValidNativeId) {
              targetTrackId = undefined;
              const baseOpts = buildMornyeOptions(candidateProv, title, artist || '', 0, isrc, null);
              const [linkRes, availRes] = await Promise.allSettled([
                LinkResolver.resolveByMetadata(title, artist || '', isrc, manager),
                runner.call('checkAvailability', [isrc || '', title, artist || '', baseOpts], 3500),
              ]);

              if (linkRes.status === 'fulfilled' && linkRes.value) {
                resolvedLinks = linkRes.value;
              }
              if (availRes.status === 'fulfilled' && availRes.value?.available && availRes.value?.track_id) {
                targetTrackId = String(availRes.value.track_id);
                preparedContext = availRes.value.prepared_context || null;
              }

              if (!targetTrackId && resolvedLinks?.nativeIds) {
                if (candidateProv === 'qobuz-web' && resolvedLinks.nativeIds.qobuzId) targetTrackId = String(resolvedLinks.nativeIds.qobuzId);
                else if (candidateProv === 'tidal-web' && resolvedLinks.nativeIds.tidalId) targetTrackId = String(resolvedLinks.nativeIds.tidalId);
                else if (candidateProv === 'deezer' && resolvedLinks.nativeIds.deezerId) targetTrackId = String(resolvedLinks.nativeIds.deezerId);
                else if (candidateProv === 'amazon' && resolvedLinks.nativeIds.amazonAsin) targetTrackId = String(resolvedLinks.nativeIds.amazonAsin);
                else if (candidateProv === 'ytmusic-spotiflac' && resolvedLinks.nativeIds.youtubeVideoId) targetTrackId = String(resolvedLinks.nativeIds.youtubeVideoId);
              }

              if (!targetTrackId) {
                const searchQuery = `${title} ${artist || ''}`.trim();
                try {
                  const res = await runner.call('customSearch', [searchQuery, { filter: 'tracks', limit: 2 }], 3500);
                  if (res && Array.isArray(res) && res.length > 0 && res[0].id) {
                    targetTrackId = String(res[0].id);
                  }
                } catch {}
              }
            }

            if (!targetTrackId) continue;

            // The metadata resolver takes the first Spotify hit blindly, so an unknown song can come back with the ISRC of an
    // UNRELATED track. Only trust the ISRC/links if the user gave the ISRC, or the resolved ISRC really is this song.
    let isrcTrusted = Boolean(isrc);
    if (!isrcTrusted && resolvedLinks?.isrc) {
      try {
        const dzRes = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(resolvedLinks.isrc)}`, { signal: AbortSignal.timeout(3500) });
        if (dzRes.ok) {
          const dz: any = await dzRes.json();
          if (dz && !dz.error && matchesTrack({ title: dz.title, artist: dz.artist?.name }, title, artist || '').ok) isrcTrusted = true;
        }
      } catch {}
    }
    if (!isrcTrusted) resolvedLinks = null;

    const effectiveIsrc = isrc || resolvedLinks?.isrc || '';
            const mornyeOpts = buildMornyeOptions(candidateProv, title, artist || '', 0, effectiveIsrc, resolvedLinks);
            const downloadOptions = {
              ...mornyeOpts,
              ...(preparedContext ? { preparedContext } : {}),
            };

            const effQuality = candidateProv === provider ? quality : 'best';
            console.log(`[StreamLive] Streaming chunks via ${candidateProv} trackId=${targetTrackId} quality=${effQuality}...`);
            let dlResult: any = await runner.call('download', [targetTrackId, effQuality, targetPath, '__progress__', downloadOptions], 180000);

            const isVerification = dlResult && dlResult.success === false && (
              dlResult.error_type === 'verification_required' ||
              /verify[_\s-]?required|turnstile|session.*expir|challenge/i.test(dlResult.error_message || dlResult.error || '')
            );

            if (isVerification) {
              const { client } = resolveSignedClient(candidateProv);
              if (client && AutoTurnstileSolver.isAvailable()) {
                const autoRes = await AutoTurnstileSolver.solveAndAuthenticate(client);
                if (autoRes.success) {
                  syncSessionAcrossNamespace(manager, client);
                  dlResult = await runner.call('download', [targetTrackId, effQuality, targetPath, '__progress__', downloadOptions], 180000);
                }
              }
            }

            if (dlResult && dlResult.success !== false) {
              await stripVideoIfPresent(targetPath);
              if (!emitter.isDone) emitter.finish();
              pruneStreamCache(streamCacheDir, 15);
              activeLiveStreams.delete(targetPath);
              return;
            }
          } catch (err: any) {
            console.warn(`[StreamLive] Candidate ${candidateProv} failed:`, err.message);
          }
        }

        emitter.fail(new Error('No se pudo obtener el stream de ningún proveedor disponible'));
        activeLiveStreams.delete(targetPath);
      })();
    }

    // 4. Wait for upstream headers (Content-Length & real MIME type) so we can reply with 206 Partial Content + Accept-Ranges: bytes!
    const hdr = await emitter.waitForHeaders(18000);

    // If download already completed on disk while waiting for headers, serve via full Range file handler
    const completedCache = fs.readdirSync(streamCacheDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.tmp'));
    if (completedCache && emitter.isDone) {
      return serveLocalRangeAudio(path.join(streamCacheDir, completedCache), req, reply);
    }

    const actualExt = hdr.actualPath ? path.extname(hdr.actualPath).toLowerCase() : guessedExt;
    const contentType = mimeByExt[actualExt] || hdr.mimeType || mimeByExt[guessedExt] || 'audio/flac';
    const totalSize = hdr.contentLength || emitter.contentLength || 0;
    const range = req.headers.range;

    reply.raw.setHeader('Content-Type', contentType);
    reply.raw.setHeader('Accept-Ranges', 'bytes');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Cache-Control', 'public, max-age=3600');
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');

    if (totalSize > 0) {
      let start = 0;
      let end = totalSize - 1;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m && m[1]) start = parseInt(m[1], 10);
        if (m && m[2]) end = parseInt(m[2], 10);
        if (isNaN(start) || start >= totalSize) start = 0;
        if (isNaN(end) || end >= totalSize) end = totalSize - 1;
        reply.raw.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        reply.raw.setHeader('Content-Length', String(end - start + 1));
        reply.raw.writeHead(206);
      } else {
        reply.raw.setHeader('Content-Length', String(totalSize));
        reply.raw.writeHead(200);
      }

      let streamOffset = 0;
      let bytesSent = 0;
      const maxBytesToSend = end - start + 1;

      const writeSlice = (chunk: Buffer) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        const chunkStart = streamOffset;
        const chunkEnd = streamOffset + chunk.length;
        streamOffset = chunkEnd;

        if (chunkEnd <= start || chunkStart > end) return;
        const sliceFrom = Math.max(0, start - chunkStart);
        const sliceTo = Math.min(chunk.length, end + 1 - chunkStart);
        if (sliceTo > sliceFrom) {
          const sub = chunk.subarray(sliceFrom, sliceTo);
          reply.raw.write(sub);
          bytesSent += sub.length;
          if (bytesSent >= maxBytesToSend) {
            reply.raw.end();
          }
        }
      };

      for (const chunk of emitter.buffer) {
        writeSlice(chunk);
      }

      if (emitter.isDone || bytesSent >= maxBytesToSend) {
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }

      const onChunk = (chunk: Buffer) => writeSlice(chunk);
      const onEnd = () => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      const onError = (err: any) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.destroy(err);
      };

      emitter.on('chunk', onChunk);
      emitter.once('end', onEnd);
      emitter.once('error', onError);

      req.raw.on('close', () => {
        emitter.off('chunk', onChunk);
        emitter.off('end', onEnd);
        emitter.off('error', onError);
      });
      return;
    }

    // Fallback if upstream did not report Content-Length
    reply.raw.setHeader('Transfer-Encoding', 'chunked');
    reply.raw.writeHead(200);

    for (const chunk of emitter.buffer) {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(chunk);
      }
    }

    if (emitter.isDone) {
      reply.raw.end();
      return;
    }

    const onChunk = (chunk: Buffer) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(chunk);
    };
    const onEnd = () => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    };
    const onError = (err: any) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.destroy(err);
    };

    emitter.on('chunk', onChunk);
    emitter.once('end', onEnd);
    emitter.once('error', onError);

    req.raw.on('close', () => {
      emitter.off('chunk', onChunk);
      emitter.off('end', onEnd);
      emitter.off('error', onError);
    });
  });

  // Map of active progressive fast live streams to avoid duplicate downloads
  const activeFastStreams = new Set<string>();

  // ============================================================================
  // /fast-streaming (and /api/fast-streaming)
  // Priority: YouTube Music (First) -> Amazon Music "opus" 320 kbps (Fallback)
  // Mode: Progressive chunked streaming for immediate playback ("por pedacitos")
  // ============================================================================
  const handleFastStreaming = async (req: FastifyRequest, reply: FastifyReply) => {
    const qObj: any = { ...(req.query as any || {}), ...(req.body as any || {}) };
    const rawQuery = (qObj.q || qObj.query || qObj.search || qObj.s || '').trim();
    const rawTitle = (qObj.title || '').trim();
    const rawArtist = (qObj.artist || '').trim();
    const rawTrackId = (qObj.trackId || qObj.id || qObj.videoId || qObj.asin || '').trim();
    let rawIsrc = (qObj.isrc || '').trim();
    const rawUrl = (qObj.url || '').trim();
    const wantJson = qObj.json === '1' || qObj.json === 'true' || qObj.format === 'json';

    if (!rawQuery && !rawTitle && !rawTrackId && !rawIsrc && !rawUrl) {
      return reply.status(400).send({
        success: false,
        error: "Debes proporcionar un término de búsqueda ('q'), título ('title'), 'trackId' o enlace ('url').",
        examples: {
          searchByQuery: '/fast-streaming?q=Doja%20Cat%20Agora%20Hills',
          searchByTitleAndArtist: '/fast-streaming?title=Agora%20Hills&artist=Doja%20Cat',
          youtubeUrl: '/fast-streaming?url=https://www.youtube.com/watch?v=0QO5_QGS5ds',
          getMetadataJson: '/fast-streaming?q=Agora%20Hills&json=1',
        },
      });
    }

    const streamCacheDir = path.resolve(process.cwd(), 'data', 'stream_cache');
    if (!fs.existsSync(streamCacheDir)) fs.mkdirSync(streamCacheDir, { recursive: true });

    let resolvedTitle = rawTitle || rawQuery;
    let resolvedArtist = rawArtist || '';
    let ytVideoId = '';
    let amazonAsin = '';
    let isYouTubeInput = false;

    // 1. Detect if input is a YouTube URL or YouTube Video ID
    if (rawUrl) {
      const ytMatch = rawUrl.match(/(?:v=|youtu\.be\/|music\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
      if (ytMatch) {
        isYouTubeInput = true;
        ytVideoId = ytMatch[1];
      }
    } else if (/^[A-Za-z0-9_-]{11}$/.test(rawTrackId) && !/^B[0-9A-Z]{9}$/i.test(rawTrackId)) {
      isYouTubeInput = true;
      ytVideoId = rawTrackId;
    } else if (/^B[0-9A-Z]{9}$/i.test(rawTrackId)) {
      amazonAsin = rawTrackId;
    }

    // 2. If it's a YouTube input, extract clean title and artist via YouTube oEmbed (30ms)
    if (isYouTubeInput && ytVideoId) {
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytVideoId}&format=json`, {
          signal: AbortSignal.timeout(3000),
        });
        if (oembedRes.ok) {
          const oembed: any = await oembedRes.json();
          let rawOembedTitle = (oembed.title || '')
            .replace(/\s*\(Official (?:Music )?Video\)/gi, '')
            .replace(/\s*\(Audio\)/gi, '')
            .replace(/\s*\(Lyrics?\)/gi, '')
            .replace(/\s*\[Official Video\]/gi, '')
            .replace(/\s*\[Audio\]/gi, '')
            .trim();
          let rawAuthor = (oembed.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();

          if (rawOembedTitle.includes(' - ')) {
            const parts = rawOembedTitle.split(' - ');
            if (!resolvedArtist) resolvedArtist = parts[0].trim();
            if (!resolvedTitle) resolvedTitle = parts.slice(1).join(' - ').trim();
          } else {
            if (!resolvedTitle) resolvedTitle = rawOembedTitle;
            if (!resolvedArtist) resolvedArtist = rawAuthor;
          }
        }
      } catch {}
    }

    // Also support Spotify / Apple Music / generic URLs via LinkResolver
    if (rawUrl && !isYouTubeInput) {
      try {
        const linkData: any = await LinkResolver.resolveByUrl(rawUrl);
        // NOTE: resolver YouTube/Amazon IDs can point to unrelated tracks; resolve by title+artist+ISRC instead.
        if (linkData?.title && !resolvedTitle) resolvedTitle = linkData.title;
        if (linkData?.artist && !resolvedArtist) resolvedArtist = linkData.artist;
        if (linkData?.isrc && !rawIsrc) rawIsrc = linkData.isrc;

        // Resolver gives no title/artist: read them from the Deezer API (or ISRC lookup), which is reliable.
        if (!resolvedTitle || !resolvedArtist) {
          const dzId = linkData?.nativeIds?.deezerId;
          const dzUrl = dzId ? `https://api.deezer.com/track/${dzId}` : (linkData?.isrc ? `https://api.deezer.com/track/isrc:${linkData.isrc}` : '');
          if (dzUrl) {
            try {
              const dzRes = await fetch(dzUrl, { signal: AbortSignal.timeout(3500) });
              if (dzRes.ok) {
                const dz: any = await dzRes.json();
                if (dz && !dz.error) {
                  if (!resolvedTitle && dz.title) resolvedTitle = dz.title_short || dz.title;
                  if (!resolvedArtist) {
                    const names = [dz.artist?.name, ...(Array.isArray(dz.contributors) ? dz.contributors.map((c: any) => c.name) : [])].filter(Boolean);
                    resolvedArtist = dz.artist?.name || names[0] || '';
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}

      // The resolver only returns cross-platform links, so read real title/artist from the source page.
      if (!resolvedTitle || !resolvedArtist) {
        try {
          const target = rawUrl.includes('spotify.com') ? rawUrl : (rawUrl);
          const pageRes = await fetch(target, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
            signal: AbortSignal.timeout(4000),
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const og = (p: string) => (html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i')) || [])[1] || '';
            const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
            const ogTitle = decode(og('og:title'));
            const ogDesc = decode(og('og:description'));
            if (rawUrl.includes('spotify.com')) {
              // og:description => "Tila Tsoli, BJ Lips · Song · 2021" ; og:title => track name
              if (!resolvedTitle && ogTitle) resolvedTitle = ogTitle.replace(/\s*\|\s*Spotify$/i, '').trim();
              if (!resolvedArtist && ogDesc) resolvedArtist = ogDesc.split('·')[0].trim();
            } else {
              const t = ogTitle.replace(/\s*[|\-–]\s*(Apple Music|Deezer|TIDAL|Amazon Music|SoundCloud).*$/i, '').trim();
              if (!resolvedTitle && t) resolvedTitle = t;
              if (!resolvedArtist && ogDesc) resolvedArtist = ogDesc.split('·')[0].replace(/^Song by\s+/i, '').trim();
            }
          }
        } catch {}
      }
    }

    const ytmRunner = manager.getRunner('ytmusic-spotiflac');
    const amzRunner = manager.getRunner('amazon');

    // If an Amazon ASIN was provided with missing/unknown metadata, enrich title & artist from Amazon first
    if (amazonAsin && (!resolvedTitle || resolvedTitle === 'Unknown Track' || !resolvedArtist) && amzRunner) {
      try {
        const amzTrack: any = await amzRunner.call('getTrack', [amazonAsin], 3000);
        if (amzTrack?.title && (resolvedTitle === 'Unknown Track' || !resolvedTitle)) resolvedTitle = amzTrack.title;
        if (amzTrack?.artist && !resolvedArtist) resolvedArtist = amzTrack.artist;
      } catch {}
    }

    if (!resolvedTitle) resolvedTitle = rawQuery || (ytVideoId || amazonAsin ? '' : rawTrackId);
    if (!resolvedTitle && !ytVideoId && !amazonAsin) {
      return reply.status(404).send({ success: false, error: 'No se pudo resolver el título/artista de la entrada proporcionada.' });
    }

    // 3. Resolve YouTube Music Track (First Choice)

    if (!ytVideoId && (resolvedTitle || resolvedArtist)) {
      const cacheLookupKey = `${rawIsrc}|${resolvedTitle.toLowerCase()}|${resolvedArtist.toLowerCase()}`;
      const cachedVid = PersistentCacheDB.get<{ videoId: string }>('fast_ytm320', cacheLookupKey);
      if (cachedVid?.videoId) {
        ytVideoId = cachedVid.videoId;
      } else if (ytmRunner) {
        try {
          const searchStr = `${resolvedArtist ? `${resolvedArtist} ` : ''}${resolvedTitle}`.trim();
          const searchRes: any = await ytmRunner.call('customSearch', [searchStr, { filter: 'tracks', limit: 1 }], 3500);
          if (Array.isArray(searchRes) && searchRes.length > 0 && searchRes[0].id) {
            ytVideoId = String(searchRes[0].id);
            PersistentCacheDB.set('fast_ytm320', cacheLookupKey, { videoId: ytVideoId }, 14 * 24 * 60 * 60 * 1000);
          }
        } catch {}
      }
    }

    const safeLabel = `${resolvedArtist ? `${resolvedArtist} - ` : ''}${resolvedTitle}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 75);
    const targetPath = path.join(streamCacheDir, `${safeLabel} [fast-streaming-${ytVideoId || amazonAsin || 'audio'}].m4a`);

    // Helper to build JSON response
    const buildFastJsonReply = async (isCached: boolean) => {
      let specs = null;
      if (fs.existsSync(targetPath)) {
        specs = await AudioProcessor.probeAudioFile(targetPath);
      }
      const meta = await MetadataResolver.resolveRichTrack({
        title: resolvedTitle,
        artist: resolvedArtist,
        isrc: rawIsrc,
        videoId: ytVideoId,
        provider: 'ytmusic-spotiflac',
      }, manager);

      const finalTitle = meta.title || resolvedTitle;
      const finalArtist = meta.artist || resolvedArtist;
      const sizeBytes = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;

      return {
        success: true,
        cached: isCached,
        provider: 'ytmusic-spotiflac',
        fallbackProvider: 'amazon',
        displayName: 'YouTube Music (Primary 320k) / Amazon Music Opus (Fallback)',
        videoId: ytVideoId || undefined,
        trackId: ytVideoId || amazonAsin || undefined,
        id: ytVideoId || amazonAsin || undefined,
        title: finalTitle,
        artist: finalArtist,
        album: meta.album,
        isrc: meta.isrc,
        coverUrl: meta.coverUrl,
        durationSec: meta.durationSec || specs?.durationSec,
        durationMs: meta.durationMs || (specs?.durationSec ? Math.round(specs.durationSec * 1000) : undefined),
        releaseDate: meta.releaseDate,
        year: meta.year,
        bitrate: '320 kbps',
        codec: 'opus/aac',
        sizeBytes,
        audioSpecs: specs || {
          bitrate: '320 kbps',
          codec: 'opus',
          sampleRate: 48000,
          channels: 2,
          badgeText: '48 kHz · 320 kbps · YouTube / Amazon Opus',
        },
        streamUrl: `/fast-streaming?trackId=${encodeURIComponent(ytVideoId || amazonAsin || '')}&title=${encodeURIComponent(finalTitle)}&artist=${encodeURIComponent(finalArtist)}`,
        fastStreamUrl: `/fast-streaming?trackId=${encodeURIComponent(ytVideoId || amazonAsin || '')}&title=${encodeURIComponent(finalTitle)}&artist=${encodeURIComponent(finalArtist)}`,
        liveStreamUrl: `/api/stream/live?title=${encodeURIComponent(finalTitle)}&artist=${encodeURIComponent(finalArtist)}`,
        lyricsUrl: meta.lyricsUrl,
        queueUrl: `/api/queue?title=${encodeURIComponent(finalTitle)}&artist=${encodeURIComponent(finalArtist)}`,
        relatedUrl: `/api/track/related?title=${encodeURIComponent(finalTitle)}&artist=${encodeURIComponent(finalArtist)}`,
      };
    };

    const isCachedOnDisk = fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1024;

    // 4. Return JSON immediately (30-50ms) without waiting for full download!
    if (wantJson) {
      return await buildFastJsonReply(isCachedOnDisk);
    }

    // 5. If already cached on disk, serve immediately with HTTP 206 Range Support!
    if (isCachedOnDisk) {
      reply.header('X-Fast-Streaming-Provider', 'ytmusic-spotiflac');
      reply.header('X-Audio-Bitrate', '320kbps');
      return serveLocalRangeAudio(targetPath, req, reply);
    }

    // 6. Progressive Chunked Live Streaming via LiveStreamRegistry ("por pedacitos para comenzar reproducción inmediata")
    const emitter = LiveStreamRegistry.register(targetPath);

    if (!activeFastStreams.has(targetPath)) {
      activeFastStreams.add(targetPath);
      (async () => {
        let streamDelivered = false;

        // --- STEP 1: YouTube Music (First Choice) ---
        if (ytmRunner && ytVideoId) {
          try {
            console.log(`[FastStreaming] (1/2) Intentando YouTube Music id=${ytVideoId}...`);
            const ytResult: any = await ytmRunner.call('download', [ytVideoId, 'best', targetPath, '__progress__', {}], 120000);
            if (ytResult && ytResult.success !== false && fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1024) {
              await stripVideoIfPresent(targetPath);
              if (!emitter.isDone) emitter.finish();
              pruneStreamCache(streamCacheDir, 15);
              streamDelivered = true;
              activeFastStreams.delete(targetPath);
              return;
            }
            console.warn(`[FastStreaming] YouTube Music falló o tiene restricción (+18): ${ytResult?.error_message || 'Descarga fallida'}`);
          } catch (ytErr: any) {
            console.warn(`[FastStreaming] YouTube Music error: ${ytErr.message}`);
          }
        }

        // --- STEP 2: Amazon Music "opus" (Fallback) ---
        if (!streamDelivered && amzRunner) {
          try {
            console.log(`[FastStreaming] (2/2) Activando fallback a Amazon Music (Opus 320 kbps) para "${resolvedTitle}"...`);

            // Clear any partial data from previous failed attempt
            emitter.buffer = [];
            if (fs.existsSync(targetPath)) {
              try { fs.unlinkSync(targetPath); } catch {}
            }

            // Resolve Amazon ASIN if not yet resolved
            if (!amazonAsin) {
              const cacheKey = `amz_fast_${(resolvedTitle + ':' + resolvedArtist).toLowerCase()}`;
              amazonAsin = PersistentCacheDB.get<string>('fast_amz_asin', cacheKey) || '';
              if (!amazonAsin) {
                try {
                  const linkMatch = await LinkResolver.resolveByMetadata(resolvedTitle, resolvedArtist, rawIsrc, manager);
                  if (linkMatch?.nativeIds?.amazonAsin) amazonAsin = linkMatch.nativeIds.amazonAsin;
                } catch {}
              }
              if (!amazonAsin) {
                try {
                  const searchStr = `${resolvedTitle} ${resolvedArtist}`.trim();
                  const searchRes: any = await amzRunner.call('customSearch', [searchStr, { filter: 'songs', limit: 6 }], 3500);
                  if (Array.isArray(searchRes)) {
                    const hit = searchRes.find((r: any) => r?.id && matchesTrack(r, resolvedTitle, resolvedArtist, rawIsrc).ok);
                    if (hit) {
                      amazonAsin = String(hit.id);
                      PersistentCacheDB.set('fast_amz_asin', cacheKey, amazonAsin, 14 * 24 * 60 * 60 * 1000);
                    }
                  }
                } catch {}
              }
            }

            if (amazonAsin) {
              let amzResult: any = await amzRunner.call('download', [amazonAsin, 'opus', targetPath, '__progress__', {}], 120000);

              // Auto-solve Turnstile challenge for Amazon if needed
              const isVerification = amzResult && amzResult.success === false && (
                amzResult.error_type === 'verification_required' ||
                /verify[_\s-]?required|turnstile|session.*expir|challenge/i.test(amzResult.error_message || amzResult.error || '')
              );

              if (isVerification) {
                const { client } = resolveSignedClient('amazon');
                if (client && AutoTurnstileSolver.isAvailable()) {
                  console.log('[FastStreaming] Resolviendo challenge de Amazon automáticamente...');
                  const autoRes = await AutoTurnstileSolver.solveAndAuthenticate(client);
                  if (autoRes.success) {
                    syncSessionAcrossNamespace(manager, client);
                    amzResult = await amzRunner.call('download', [amazonAsin, 'opus', targetPath, '__progress__', {}], 120000);
                  }
                }
              }

              if (amzResult && amzResult.success !== false) {
                await stripVideoIfPresent(targetPath);
                if (!emitter.isDone) emitter.finish();
                pruneStreamCache(streamCacheDir, 15);
                streamDelivered = true;
                activeFastStreams.delete(targetPath);
                return;
              }
            }
          } catch (amzErr: any) {
            console.warn(`[FastStreaming] Amazon Music fallback error: ${amzErr.message}`);
          }
        }

        if (!streamDelivered) {
          emitter.fail(new Error('No se pudo reproducir la canción ni en YouTube Music ni en Amazon Music (Opus 320 kbps).'));
        }
        activeFastStreams.delete(targetPath);
      })();
    }

    // 7. Wait for upstream first chunk / headers and pipe chunks progressively!
    const hdr = await emitter.waitForHeaders(14000);

    const completedCache = fs.readdirSync(streamCacheDir).find((f) => f.startsWith(`${safeLabel} [fast-streaming`) && !f.endsWith('.part') && !f.endsWith('.tmp'));
    if (completedCache && emitter.isDone) {
      return serveLocalRangeAudio(path.join(streamCacheDir, completedCache), req, reply);
    }

    const contentType = hdr.mimeType || 'audio/mp4';
    const totalSize = hdr.contentLength || emitter.contentLength || 0;
    const range = req.headers.range;

    reply.raw.setHeader('Content-Type', contentType);
    reply.raw.setHeader('Accept-Ranges', 'bytes');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Cache-Control', 'public, max-age=3600');
    reply.raw.setHeader('X-Fast-Streaming-Provider', 'ytmusic-spotiflac');
    reply.raw.setHeader('X-Fast-Streaming-Fallback', 'amazon-opus');
    reply.raw.setHeader('X-Audio-Bitrate', '320kbps');

    if (totalSize > 0) {
      let start = 0;
      let end = totalSize - 1;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m && m[1]) start = parseInt(m[1], 10);
        if (m && m[2]) end = parseInt(m[2], 10);
        if (isNaN(start) || start >= totalSize) start = 0;
        if (isNaN(end) || end >= totalSize) end = totalSize - 1;
        reply.raw.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        reply.raw.setHeader('Content-Length', String(end - start + 1));
        reply.raw.writeHead(206);
      } else {
        reply.raw.setHeader('Content-Length', String(totalSize));
        reply.raw.writeHead(200);
      }

      let streamOffset = 0;
      let bytesSent = 0;
      const maxBytesToSend = end - start + 1;

      const writeSlice = (chunk: Buffer) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        const chunkStart = streamOffset;
        const chunkEnd = streamOffset + chunk.length;
        streamOffset = chunkEnd;

        if (chunkEnd <= start || chunkStart > end) return;
        const sliceFrom = Math.max(0, start - chunkStart);
        const sliceTo = Math.min(chunk.length, end + 1 - chunkStart);
        if (sliceTo > sliceFrom) {
          const sub = chunk.subarray(sliceFrom, sliceTo);
          reply.raw.write(sub);
          bytesSent += sub.length;
          if (bytesSent >= maxBytesToSend) {
            reply.raw.end();
          }
        }
      };

      for (const chunk of emitter.buffer) {
        writeSlice(chunk);
      }

      if (emitter.isDone || bytesSent >= maxBytesToSend) {
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }

      const onChunk = (chunk: Buffer) => writeSlice(chunk);
      const onEnd = () => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      const onError = (err: any) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.destroy(err);
      };

      emitter.on('chunk', onChunk);
      emitter.once('end', onEnd);
      emitter.once('error', onError);

      req.raw.on('close', () => {
        emitter.off('chunk', onChunk);
        emitter.off('end', onEnd);
        emitter.off('error', onError);
      });
      return;
    }

    // Chunked Transfer-Encoding fallback if total length is pending
    reply.raw.setHeader('Transfer-Encoding', 'chunked');
    reply.raw.writeHead(200);

    for (const chunk of emitter.buffer) {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(chunk);
      }
    }

    if (emitter.isDone) {
      reply.raw.end();
      return;
    }

    const onChunk = (chunk: Buffer) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(chunk);
    };
    const onEnd = () => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    };
    const onError = (err: any) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.destroy(err);
    };

    emitter.on('chunk', onChunk);
    emitter.once('end', onEnd);
    emitter.once('error', onError);

    req.raw.on('close', () => {
      emitter.off('chunk', onChunk);
      emitter.off('end', onEnd);
      emitter.off('error', onError);
    });
  };

  app.get('/fast-streaming', handleFastStreaming);
  app.post('/fast-streaming', handleFastStreaming);
  app.get('/api/fast-streaming', handleFastStreaming);
  app.post('/api/fast-streaming', handleFastStreaming);

  // Full API Documentation Endpoint (serves API_DOCUMENTATION.md as Markdown or JSON)
  app.get('/api/docs', async (req: FastifyRequest<{ Querystring: { format?: string } }>, reply: FastifyReply) => {
    const docPath = path.resolve(process.cwd(), 'API_DOCUMENTATION.md');
    const md = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '# WaveX API Documentation';
    if (req.query.format === 'markdown' || req.query.format === 'raw') {
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      return reply.send(md);
    }
    return {
      success: true,
      version: '2.0.0',
      title: 'WaveX Universal Music & Audiophile Streaming API',
      markdown: md,
    };
  });

  // ============================================================================
  // Bot Queue & Recommendations Endpoint (/api/queue and /api/track/related)
  // ============================================================================
  const handleTrackRelated = async (
    req: FastifyRequest<{
      Querystring: {
        videoId?: string;
        trackId?: string;
        id?: string;
        title?: string;
        artist?: string;
        isrc?: string;
        q?: string;
        limit?: string;
      };
    }>,
    reply: FastifyReply
  ) => {
    const qObj: any = { ...(req.query as any || {}) };
    let videoId = (qObj.videoId || qObj.trackId || qObj.id || '').trim();
    let title = (qObj.title || qObj.q || '').trim();
    let artist = (qObj.artist || '').trim();
    let isrc = (qObj.isrc || '').trim();
    const limit = Math.max(1, Math.min(50, Number(qObj.limit) || 15));

    const ytmRunner = manager.getRunner('ytmusic-spotiflac');

    // If videoId is not given, resolve it via title/artist or customSearch
    if (!videoId && (title || artist)) {
      if (ytmRunner) {
        try {
          const searchStr = `${artist ? `${artist} ` : ''}${title}`.trim();
          const searchRes = await ytmRunner.call('customSearch', [searchStr, { filter: 'tracks', limit: 1 }], 4000);
          if (Array.isArray(searchRes) && searchRes.length > 0 && searchRes[0].id) {
            videoId = String(searchRes[0].id);
            if (!title) title = searchRes[0].title || searchRes[0].name;
            if (!artist) artist = searchRes[0].artist || searchRes[0].artists;
          }
        } catch {}
      }
    }

    let relatedList: any[] = [];

    // 1. Curated Musical Similarity via Deezer Related Artists
    // (Prevents unauthenticated YouTube Music from dumping regional trending charts like Fuerza Regida when playing niche/indie songs)
    if (artist || title) {
      try {
        const seedQuery = `${artist ? `${artist} ` : ''}${title}`.trim();
        const dzSearchRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(seedQuery)}&limit=1`, {
          signal: AbortSignal.timeout(3500),
        });
        if (dzSearchRes.ok) {
          const dzSearchData: any = await dzSearchRes.json();
          const firstTrack = dzSearchData?.data?.[0];
          const artistId = firstTrack?.artist?.id;
          if (artistId) {
            const relArtistsRes = await fetch(`https://api.deezer.com/artist/${artistId}/related`, {
              signal: AbortSignal.timeout(3500),
            });
            if (relArtistsRes.ok) {
              const relArtistsData: any = await relArtistsRes.json();
              const relArtists = Array.isArray(relArtistsData?.data) ? relArtistsData.data : [];
              if (relArtists.length > 0) {
                const candidateArtists = relArtists.slice(0, Math.min(limit, 15));
                const topTrackPromises = candidateArtists.map(async (a: any) => {
                  try {
                    const topRes = await fetch(`https://api.deezer.com/artist/${a.id}/top?limit=1`, {
                      signal: AbortSignal.timeout(3000),
                    });
                    if (!topRes.ok) return null;
                    const topData: any = await topRes.json();
                    return topData?.data?.[0] || null;
                  } catch {
                    return null;
                  }
                });
                const fetchedTracks = (await Promise.all(topTrackPromises)).filter(Boolean);
                if (fetchedTracks.length > 0) {
                  relatedList = fetchedTracks.map((t: any) => {
                    const tTitle = t.title || 'Unknown Title';
                    const tArtist = t.artist?.name || 'Unknown Artist';
                    const durSec = Number(t.duration) || 0;
                    return {
                      id: String(t.id),
                      videoId: undefined,
                      title: tTitle,
                      artist: tArtist,
                      album: t.album?.title || '',
                      coverUrl: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || '',
                      durationSec: durSec,
                      durationMs: durSec * 1000,
                      isrc: t.isrc || undefined,
                      fastStreamUrl: `/fast-streaming?title=${encodeURIComponent(tTitle)}&artist=${encodeURIComponent(tArtist)}`,
                      streamUrl: `/api/stream/live?title=${encodeURIComponent(tTitle)}&artist=${encodeURIComponent(tArtist)}`,
                      lyricsUrl: `/api/lyrics?title=${encodeURIComponent(tTitle)}&artist=${encodeURIComponent(tArtist)}${durSec ? `&duration=${durSec}` : ''}`,
                    };
                  });
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.warn('[Queue/Related] Deezer curated similarity error:', err.message);
      }
    }

    // 2. If Deezer has no related artists, fallback to YouTube Music getRelatedTracks
    if (relatedList.length === 0 && videoId && ytmRunner) {
      try {
        const seed = [{ id: videoId, provider_id: 'ytmusic-spotiflac', title, artist, isrc }];
        const res = await ytmRunner.call('getRelatedTracks', [seed, { limit }], 8000);
        if (Array.isArray(res) && res.length > 0) {
          relatedList = res.map((t: any) => {
            const vid = String(t.id || '');
            const tTitle = t.name || t.title || 'Unknown Title';
            const tArtist = t.artists || t.artist || 'Unknown Artist';
            const tAlbum = t.album_name || t.album || '';
            const durSec = t.duration_ms ? Math.round(Number(t.duration_ms) / 1000) : (t.duration ? Number(t.duration) : 0);
            const cover = t.cover_url || t.thumbnail || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');

            return {
              id: vid,
              videoId: vid,
              title: tTitle,
              artist: tArtist,
              album: tAlbum,
              coverUrl: cover,
              durationSec: durSec,
              durationMs: durSec * 1000,
              isrc: t.isrc || undefined,
              fastStreamUrl: `/fast-streaming?trackId=${encodeURIComponent(vid)}&title=${encodeURIComponent(tTitle)}&artist=${encodeURIComponent(tArtist)}`,
              streamUrl: `/api/stream/live?title=${encodeURIComponent(tTitle)}&artist=${encodeURIComponent(tArtist)}`,
              lyricsUrl: `/api/lyrics?title=${encodeURIComponent(tTitle)}&artist=${encodeURIComponent(tArtist)}${durSec ? `&duration=${durSec}` : ''}`,
            };
          });
        }
      } catch (err: any) {
        console.warn('[Queue/Related] YTM getRelatedTracks error:', err.message);
      }
    }

    // 3. Fallback to Deezer search if needed
    if (relatedList.length === 0 && (artist || title)) {
      try {
        const query = `${artist ? `${artist} ` : ''}${title}`.trim();
        const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
          signal: AbortSignal.timeout(3500),
        });
        if (dzRes.ok) {
          const dzData: any = await dzRes.json();
          if (Array.isArray(dzData?.data)) {
            relatedList = dzData.data.map((t: any) => ({
              id: String(t.id),
              videoId: undefined,
              title: t.title,
              artist: t.artist?.name || 'Unknown Artist',
              album: t.album?.title || '',
              coverUrl: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || '',
              durationSec: Number(t.duration) || 0,
              durationMs: (Number(t.duration) || 0) * 1000,
              isrc: t.isrc || undefined,
              fastStreamUrl: `/fast-streaming?q=${encodeURIComponent(t.title + ' ' + (t.artist?.name || ''))}`,
              streamUrl: `/api/stream/live?title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artist?.name || '')}`,
              lyricsUrl: `/api/lyrics?title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artist?.name || '')}`,
            }));
          }
        }
      } catch {}
    }

    return {
      success: true,
      seed: {
        videoId: videoId || undefined,
        title: title || undefined,
        artist: artist || undefined,
      },
      count: relatedList.length,
      queue: relatedList,
      tracks: relatedList,
    };
  };

  app.get('/api/queue', handleTrackRelated);
  app.get('/api/track/related', handleTrackRelated);

  // Complete Track Info Endpoint
  app.get('/api/track/info', async (
    req: FastifyRequest<{
      Querystring: {
        title?: string;
        artist?: string;
        isrc?: string;
        trackId?: string;
        videoId?: string;
        url?: string;
        provider?: string;
      };
    }>
  ) => {
    const qObj: any = req.query as any || {};
    let url = (qObj.url || '').trim();
    let title = (qObj.title || '').trim();
    let artist = (qObj.artist || '').trim();
    let isrc = (qObj.isrc || '').trim();
    let videoId = (qObj.videoId || qObj.trackId || '').trim();

    if (url) {
      const resolved = await LinkResolver.resolveByUrl(url);
      if (resolved) {
        if (resolved.isrc) isrc = resolved.isrc;
        if (resolved.nativeIds?.youtubeVideoId) videoId = resolved.nativeIds.youtubeVideoId;
      }
    }

    const meta = await MetadataResolver.resolveRichTrack({
      title,
      artist,
      isrc,
      videoId,
      provider: qObj.provider,
    }, manager);

    const platformLinks = await LinkResolver.resolveByMetadata(meta.title, meta.artist, meta.isrc, manager);

    return {
      success: true,
      ...meta,
      platformLinks: platformLinks || undefined,
    };
  });

  // Maintenance: Purge files older than 24h from downloads and stream_cache
  const handlePurgeExpired = async () => {
    const result = RetentionCleaner.cleanExpired(24 * 60 * 60 * 1000);
    return {
      success: true,
      message: `Se eliminaron ${result.deletedFiles.length} archivo(s) expirados (>24h).`,
      freedBytes: result.freedBytes,
      freedMb: Number((result.freedBytes / (1024 * 1024)).toFixed(2)),
      deletedFiles: result.deletedFiles,
      errors: result.errors,
    };
  };

  app.post('/api/maintenance/purge-expired', handlePurgeExpired);
  app.get('/api/maintenance/purge-expired', handlePurgeExpired);

  // Pre-fetch / Pre-resolve endpoint for Gapless Playback & Hover Pre-warming
  app.get('/api/stream/prefetch', async (
    req: FastifyRequest<{
      Querystring: { title: string; artist?: string; isrc?: string; provider?: string; quality?: string; warmAudio?: string };
    }>
  ) => {
    const { title, artist, isrc, provider = 'qobuz-web', quality = 'HI_RES_LOSSLESS', warmAudio } = req.query;
    if (!title) return { success: false };

    const resolved = await LinkResolver.resolveByMetadata(title, artist || '', isrc, manager);
    if (warmAudio === '1') {
      // Trigger background stream cache warm-up silently
      const port = process.env.PORT || 3000;
      fetch(`http://127.0.0.1:${port}/api/stream/live?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist || '')}&isrc=${encodeURIComponent(isrc || '')}&provider=${encodeURIComponent(provider)}&quality=${encodeURIComponent(quality)}`)
        .then((r) => {
          // Consume stream in background so it caches to disk
          if (r.body) {
            const reader = (r.body as any).getReader();
            const pump = (): any => reader.read().then(({ done }: any) => (!done ? pump() : null)).catch(() => {});
            pump();
          }
        })
        .catch(() => {});
    }

    return {
      success: true,
      resolvedLinks: resolved,
    };
  });

  // Real-Time Download & Batch Progress via Server-Sent Events (SSE)
  app.get('/api/events/progress', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.writeHead(200);

    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    const onProgress = (evt: any) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'download_progress', ...evt })}\n\n`);
      }
    };

    DownloadProgressBus.on('progress', onProgress);

    req.raw.on('close', () => {
      DownloadProgressBus.off('progress', onProgress);
    });
  });

  // Synced Lyrics (.lrc) and Plain Lyrics Endpoint
  app.get('/api/lyrics', async (
    req: FastifyRequest<{
      Querystring: { title: string; artist?: string; album?: string; duration?: string };
    }>,
    reply: FastifyReply
  ) => {
    const { title, artist, album, duration } = req.query;
    if (!title) return reply.status(400).send({ found: false, error: "'title' is required" });
    const durSec = duration ? Number(duration) : undefined;
    return await AudioProcessor.fetchSyncedLyrics(title, artist || '', album, durSec);
  });

  // Real Audiophile Specs Endpoint (via ffprobe)
  app.get('/api/audio/specs', async (
    req: FastifyRequest<{
      Querystring: { fileName?: string; title?: string; artist?: string; provider?: string; quality?: string };
    }>
  ) => {
    const { fileName, title, artist, provider, quality } = req.query;
    const downloadsDir = path.resolve(process.cwd(), 'downloads');
    const streamCacheDir = path.resolve(process.cwd(), 'data', 'stream_cache');

    let targetFile: string | null = null;

    if (fileName) {
      const base = path.basename(fileName);
      if (fs.existsSync(path.join(downloadsDir, base))) targetFile = path.join(downloadsDir, base);
      else if (fs.existsSync(path.join(streamCacheDir, base))) targetFile = path.join(streamCacheDir, base);
    }

    if (!targetFile && title) {
      const prefix = `${(artist ? `${artist} - ` : '')}${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90);
      const fullPrefix = provider && quality ? `${prefix} [${provider}-${quality}]` : prefix;
      for (const dir of [streamCacheDir, downloadsDir]) {
        if (!fs.existsSync(dir)) continue;
        const found = fs.readdirSync(dir).find((f) => f.startsWith(fullPrefix) && !f.endsWith('.part') && !f.endsWith('.lrc'));
        if (found) {
          targetFile = path.join(dir, found);
          break;
        }
      }
    }

    if (!targetFile) return { found: false, specs: null };
    const specs = await AudioProcessor.probeAudioFile(targetFile);
    return { found: Boolean(specs), fileName: path.basename(targetFile), specs };
  });

  // Persistent Download History Endpoint
  app.get('/api/downloads/history', async (
    req: FastifyRequest<{ Querystring: { limit?: string } }>
  ) => {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    return {
      success: true,
      history: PersistentCacheDB.getDownloadHistory(limit),
    };
  });

  // Batch Album / Playlist Downloader with Concurrency & ZIP Export
  interface BatchJob {
    jobId: string;
    title: string;
    provider: string;
    quality: string;
    total: number;
    completed: number;
    failed: number;
    status: 'running' | 'completed';
    files: Array<{ title: string; artist: string; fileName?: string; filePath?: string; status: string; error?: string; specs?: any }>;
    createdAt: number;
  }
  const batchJobs = new Map<string, BatchJob>();

  app.post('/api/batch/download', async (
    req: FastifyRequest<{
      Body: {
        albumTitle?: string;
        provider?: string;
        quality?: string;
        tracks: Array<{ title: string; artist: string; album?: string; isrc?: string; trackId?: string; coverUrl?: string }>;
      };
    }>,
    reply: FastifyReply
  ) => {
    const { albumTitle = 'WaveX Batch', provider = 'qobuz-web', quality = 'HI_RES_LOSSLESS', tracks = [] } = req.body || {};
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return reply.status(400).send({ success: false, error: 'Se requiere un arreglo de tracks' });
    }

    const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: BatchJob = {
      jobId,
      title: albumTitle,
      provider,
      quality,
      total: tracks.length,
      completed: 0,
      failed: 0,
      status: 'running',
      files: tracks.map((t) => ({ title: t.title, artist: t.artist, status: 'pending' })),
      createdAt: Date.now(),
    };
    batchJobs.set(jobId, job);

    // Process queue with 2x concurrency in background
    (async () => {
      const concurrency = 2;
      let idx = 0;
      const port = process.env.PORT || 3000;

      const worker = async () => {
        while (idx < tracks.length) {
          const curIdx = idx++;
          const track = tracks[curIdx];
          job.files[curIdx].status = 'downloading';
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/${encodeURIComponent(provider)}/download`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                trackId: track.trackId || track.isrc || track.title,
                quality,
                title: track.title,
                artist: track.artist,
                album: track.album || albumTitle,
                isrc: track.isrc || '',
                coverUrl: track.coverUrl || '',
              }),
            });
            const data: any = await res.json();
            if (data && data.success) {
              job.files[curIdx].status = 'completed';
              job.files[curIdx].fileName = data.fileName;
              job.files[curIdx].filePath = data.outputPath;
              job.files[curIdx].specs = data.audioSpecs;
              job.completed++;
            } else {
              job.files[curIdx].status = 'failed';
              job.files[curIdx].error = data?.error || 'Error';
              job.failed++;
            }
          } catch (e: any) {
            job.files[curIdx].status = 'failed';
            job.files[curIdx].error = e.message;
            job.failed++;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, () => worker()));
      job.status = 'completed';
    })();

    return {
      success: true,
      jobId,
      statusUrl: `/api/batch/${jobId}`,
      zipUrl: `/api/batch/${jobId}/zip`,
    };
  });

  app.get('/api/batch/:jobId', async (
    req: FastifyRequest<{ Params: { jobId: string } }>,
    reply: FastifyReply
  ) => {
    const job = batchJobs.get(req.params.jobId);
    if (!job) return reply.status(404).send({ error: 'Batch job not found' });
    return job;
  });

  app.get('/api/batch/:jobId/zip', async (
    req: FastifyRequest<{ Params: { jobId: string } }>,
    reply: FastifyReply
  ) => {
    const job = batchJobs.get(req.params.jobId);
    if (!job) return reply.status(404).send({ error: 'Batch job not found' });

    const zip = new AdmZip();
    for (const f of job.files) {
      if (f.filePath && fs.existsSync(f.filePath)) {
        zip.addLocalFile(f.filePath);
        const lrc = f.filePath.replace(/\.[^/.]+$/, '.lrc');
        if (fs.existsSync(lrc)) zip.addLocalFile(lrc);
      }
    }

    const zipBuf = zip.toBuffer();
    const safeZipName = `${job.title.replace(/[\\/:*?"<>|]/g, '_')}.zip`;
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${safeZipName}"`);
    return reply.send(zipBuf);
  });

  // Stream Full Track (uses dedicated data/stream_cache, never poluting downloads/)
  app.post('/api/stream-full', async (
    req: FastifyRequest<{
      Body: {
        title: string;
        artist: string;
        isrc?: string;
        provider?: string;
        trackId?: string;
        quality?: string;
      };
    }>,
    reply: FastifyReply
  ) => {
    const { title, artist, isrc, provider: reqProvider, trackId: reqTrackId, quality: rawQuality } = req.body || {};
    const quality = normalizeProviderQuality(reqProvider, rawQuality);
    if (!title) return reply.status(400).send({ success: false, error: "'title' is required" });

    const downloadsDir = path.resolve(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    const streamCacheDir = path.resolve(process.cwd(), 'data', 'stream_cache');
    if (!fs.existsSync(streamCacheDir)) fs.mkdirSync(streamCacheDir, { recursive: true });

    // 1. Resolve cross-platform links via LinkResolver only if provider or trackId not already known
    let resolvedLinks: any = null;
    if (!reqProvider || !reqTrackId) {
      try {
        resolvedLinks = await LinkResolver.resolveByMetadata(title, artist || '', isrc, manager);
      } catch {}
    }

    // The metadata resolver takes the first Spotify hit blindly, so an unknown song can come back with the ISRC of an
    // UNRELATED track. Only trust the ISRC/links if the user gave the ISRC, or the resolved ISRC really is this song.
    let isrcTrusted = Boolean(isrc);
    if (!isrcTrusted && resolvedLinks?.isrc) {
      try {
        const dzRes = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(resolvedLinks.isrc)}`, { signal: AbortSignal.timeout(3500) });
        if (dzRes.ok) {
          const dz: any = await dzRes.json();
          if (dz && !dz.error && matchesTrack({ title: dz.title, artist: dz.artist?.name }, title, artist || '').ok) isrcTrusted = true;
        }
      } catch {}
    }
    if (!isrcTrusted) resolvedLinks = null;

    const effectiveIsrc = isrc || resolvedLinks?.isrc || '';

    // 2. Candidate download providers list:
    const priorityCandidates = reqProvider
      ? [reqProvider, 'qobuz-web', 'ytmusic-spotiflac', 'soundcloud', 'jiosaavn']
      : ['qobuz-web', 'ytmusic-spotiflac', 'soundcloud', 'jiosaavn', 'tidal-web', 'deezer'];

    const uniqueCandidates = [...new Set(priorityCandidates)];

    let lastError = '';

    for (const provider of uniqueCandidates) {
      const runner = manager.getRunner(provider);
      const manifest = manager.getManifest(provider);
      if (!runner || !manifest) continue;

      const safeBaseName = `${(artist ? `${artist} - ` : '')}${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) + ` [${provider}-${quality}]`;

      // 1. Check if user already has it in downloads/ from a prior manual download
      const existingDownload = fs.readdirSync(downloadsDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.tmp'));
      if (existingDownload) {
        const finalExisting = path.join(downloadsDir, existingDownload);
        const sizeBytes = fs.statSync(finalExisting).size;
        return {
          success: true,
          cached: true,
          provider,
          displayName: manifest.displayName || provider,
          quality,
          fileName: existingDownload,
          sizeBytes,
          streamUrl: `/api/stream/audio/${encodeURIComponent(existingDownload)}?source=downloads`,
        };
      }

      // 2. Check if already in ephemeral stream cache
      const existingStream = fs.readdirSync(streamCacheDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part') && !f.endsWith('.tmp'));
      if (existingStream) {
        const finalStream = path.join(streamCacheDir, existingStream);
        const sizeBytes = fs.statSync(finalStream).size;
        return {
          success: true,
          cached: true,
          provider,
          displayName: manifest.displayName || provider,
          quality,
          fileName: existingStream,
          sizeBytes,
          streamUrl: `/api/stream/audio/${encodeURIComponent(existingStream)}`,
        };
      }

      // Check availability and get trackId & preparedContext
      const mornyeOpts = buildMornyeOptions(provider, title, artist || '', 0, effectiveIsrc, resolvedLinks);

      let targetTrackId = reqProvider === provider && reqTrackId ? reqTrackId : null;
      let preparedContext: any = null;

      // Ensure native provider IDs if an ISRC or title string was passed
      if (provider === 'qobuz-web' && targetTrackId && !/^\d+$/.test(targetTrackId)) {
        try {
          const check = await runner.call('checkAvailability', [effectiveIsrc, title, artist || '', mornyeOpts], 6000);
          if (check && check.available && check.track_id) {
            targetTrackId = String(check.track_id);
            preparedContext = check.prepared_context || null;
          }
        } catch {}
      } else if (!targetTrackId) {
        try {
          const check = await runner.call('checkAvailability', [effectiveIsrc, title, artist || '', mornyeOpts], 6000);
          if (check && check.available && check.track_id) {
            targetTrackId = String(check.track_id);
            preparedContext = check.prepared_context || null;
          }
        } catch {}
      }

      // Fallback to customSearch if checkAvailability didn't find direct match
      if (!targetTrackId) {
        const searchQuery = `${title} ${artist || ''}`.trim();
        try {
          const res = await runner.call('customSearch', [searchQuery, { filter: 'tracks', limit: 3 }], 6000);
          if (res && Array.isArray(res) && res.length > 0 && res[0].id) {
            targetTrackId = String(res[0].id);
          }
        } catch {}
      }

      if (!targetTrackId) {
        lastError = `No se encontró la canción en ${manifest.displayName || provider}`;
        continue;
      }

      const isLossless = /flac|lossless|hi_res|best|24bit/i.test(quality);
      const guessedExt = isLossless ? '.flac' : '.m4a';
      // STREAMING: Download to streamCacheDir, NEVER downloadsDir!
      const targetPath = path.join(streamCacheDir, `${safeBaseName}${guessedExt}`);

      const downloadOptions = {
        ...mornyeOpts,
        ...(preparedContext ? { preparedContext } : {}),
      };

      try {
        console.log(`[StreamFull] Caching stream from ${provider} (${manifest.displayName}) trackId=${targetTrackId}...`);
        let dlResult: any = await runner.call('download', [targetTrackId, quality, targetPath, '__progress__', downloadOptions], 180000);

        // Turnstile Auto-solving in streaming
        let isVerification = dlResult && dlResult.success === false && (
          dlResult.error_type === 'verification_required' ||
          /verify[_\s-]?required|turnstile|session.*expir|challenge/i.test(dlResult.error_message || dlResult.error || '')
        );

        if (isVerification) {
          console.log(`[StreamFull] ${provider} requiere verificación Turnstile. Intentando resolución automática...`);
          const { client } = resolveSignedClient(provider);
          if (client && AutoTurnstileSolver.isAvailable()) {
            try {
              const autoRes = await AutoTurnstileSolver.solveAndAuthenticate(client);
              if (autoRes.success) {
                console.log(`[StreamFull] AutoTurnstileSolver resolvió la sesión para ${provider}. Reintentando stream...`);
                syncSessionAcrossNamespace(manager, client);
                dlResult = await runner.call('download', [targetTrackId, quality, targetPath, '__progress__', downloadOptions], 180000);
              }
            } catch {}
          }
        }

        if (dlResult && dlResult.success === false) {
          lastError = dlResult.error_message || 'Download returned false';
          console.warn(`[StreamFull] ${provider} stream cache failed:`, lastError);
          continue;
        }

        let finalPath: string | null = null;
        const reported = dlResult?.file_path || dlResult?.path || dlResult?.output_path;
        if (reported && fs.existsSync(reported)) finalPath = reported;
        if (!finalPath && fs.existsSync(targetPath)) finalPath = targetPath;
        if (!finalPath) {
          const match = fs.readdirSync(streamCacheDir).find((f) => f.startsWith(safeBaseName) && !f.endsWith('.part'));
          if (match) finalPath = path.join(streamCacheDir, match);
        }

        if (finalPath && fs.existsSync(finalPath)) {
          pruneStreamCache(streamCacheDir, 8);
          const fileName = path.basename(finalPath);
          const sizeBytes = fs.statSync(finalPath).size;
          return {
            success: true,
            cached: false,
            provider,
            displayName: manifest.displayName || provider,
            quality,
            fileName,
            sizeBytes,
            streamUrl: `/api/stream/audio/${encodeURIComponent(fileName)}`,
          };
        }
      } catch (dlErr: any) {
        lastError = dlErr.message;
        console.warn(`[StreamFull] Exception downloading from ${provider}:`, dlErr.message);
        continue;
      }
    }

    return reply.status(200).send({
      success: false,
      error: `No se pudo obtener el audio de las extensiones: ${lastError}`,
    });
  });

  // Serve streaming audio with HTTP Range support from ephemeral stream cache (or downloads fallback)
  app.get('/api/stream/audio/:filename', async (
    req: FastifyRequest<{ Params: { filename: string }; Querystring: { source?: string } }>,
    reply: FastifyReply
  ) => {
    const filename = path.basename(decodeURIComponent(req.params.filename));
    const streamCacheDir = path.resolve(process.cwd(), 'data', 'stream_cache');
    const downloadsDir = path.resolve(process.cwd(), 'downloads');

    let filePath = req.query.source === 'downloads'
      ? path.join(downloadsDir, filename)
      : path.join(streamCacheDir, filename);

    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(path.join(streamCacheDir, filename))) {
        filePath = path.join(streamCacheDir, filename);
      } else if (fs.existsSync(path.join(downloadsDir, filename))) {
        filePath = path.join(downloadsDir, filename);
      } else {
        return reply.status(404).send({ error: 'Audio stream file not found' });
      }
    }

    const mimeByExt: Record<string, string> = {
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
    const contentType = mimeByExt[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    const size = fs.statSync(filePath).size;
    const range = req.headers.range;

    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=86400');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start >= size) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(filePath));
  });

  // Serve downloaded audio with HTTP Range support for deliberate downloads
  app.get('/downloads/:filename', async (
    req: FastifyRequest<{ Params: { filename: string } }>,
    reply: FastifyReply
  ) => {
    const filename = path.basename(decodeURIComponent(req.params.filename));
    const filePath = path.join(process.cwd(), 'downloads', filename);

    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const mimeByExt: Record<string, string> = {
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
    const contentType = mimeByExt[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    const size = fs.statSync(filePath).size;
    const range = req.headers.range;

    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', 'bytes');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start >= size) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(filePath));
  });
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { SignedSessionClient } from './signed-session.js';
import type { ExtensionManager } from '../manager.js';

export interface AutoSolveResult {
  success: boolean;
  grant?: string;
  sessionData?: any;
  error?: string;
}

export class AutoTurnstileSolver {
  private static isSolving: boolean = false;
  private static solvePromise: Promise<AutoSolveResult> | null = null;
  private static keeperTimer: NodeJS.Timeout | null = null;

  public static getMornyePythonPath(): string | null {
    const candidates = [
      process.env.MORNYE_SOLVER_PATH || '',
      path.resolve(process.cwd(), 'scripts', 'mornye_solver'),
      path.resolve(process.cwd(), '..', 'Mornye-Python'),
      'C:\\Users\\oscar\\Desktop\\Mornye-Python',
      '/opt/Mornye-Python',
      path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'Mornye-Python'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'mornye', 'core', 'solver.py'))) {
        return candidate;
      }
    }
    return null;
  }

  public static isAvailable(): boolean {
    return this.getMornyePythonPath() !== null;
  }

  /**
   * Background SessionKeeper:
   * Periodically inspects all extensions with signed sessions, refreshes tokens before expiration,
   * and pre-authenticates any expired session in the background so users never wait on Turnstile.
   */
  public static startSessionKeeper(manager: ExtensionManager, intervalMinutes: number = 10): void {
    if (this.keeperTimer) clearInterval(this.keeperTimer);

    const checkAndMaintainSessions = async () => {
      try {
        const installed = manager.getInstalled();
        const checkedNamespaces = new Set<string>();

        for (const ext of installed) {
          const runner = manager.getRunner(ext.id);
          const client = runner?.getSignedClient();
          if (!client) continue;

          const cfg = client.getConfig();
          const nsKey = `${cfg.namespace}:${cfg.baseUrl}`;
          if (checkedNamespaces.has(nsKey)) continue;
          checkedNamespaces.add(nsKey);

          // 1. If authenticated, check if it needs proactive refresh
          if (client.isAuthenticated()) {
            if (client.needsRefresh()) {
              const refreshed = await client.refreshSession();
              if (refreshed) {
                this.syncClientAcrossManager(manager, client);
                continue;
              }
            } else {
              // Ensure all other runners in this namespace have the latest token
              this.syncClientAcrossManager(manager, client);
              continue;
            }
          }

          // 2. If not authenticated, try lightweight bootstrap first
          try {
            await client.bootstrap();
            if (client.isAuthenticated()) {
              this.syncClientAcrossManager(manager, client);
              continue;
            }
          } catch {}

          // 3. If still not authenticated and solver is available, solve quietly in background
          if (!client.isAuthenticated() && this.isAvailable() && !this.isSolving) {
            console.log(`[SessionKeeper] Pre-autenticando sesión firmada (${cfg.namespace}) en segundo plano...`);
            const res = await this.solveAndAuthenticate(client);
            if (res.success) {
              this.syncClientAcrossManager(manager, client);
              console.log(`[SessionKeeper] ✅ Sesión (${cfg.namespace}) lista y sincronizada.`);
            }
          }
        }
      } catch (e: any) {
        console.warn('[SessionKeeper] Aviso en ciclo de mantenimiento:', e.message);
      }
    };

    // Initial check 5s after server boot
    setTimeout(() => {
      checkAndMaintainSessions().catch(() => {});
    }, 5000);

    this.keeperTimer = setInterval(() => {
      checkAndMaintainSessions().catch(() => {});
    }, intervalMinutes * 60 * 1000);
  }

  public static syncClientAcrossManager(manager: ExtensionManager, sourceClient: SignedSessionClient): void {
    try {
      const srcConfig = sourceClient.getConfig();
      const srcData = sourceClient.getSessionData();
      if (!srcData.session_id) return;

      for (const ext of manager.getInstalled()) {
        const runner = manager.getRunner(ext.id);
        const runnerClient = runner?.getSignedClient();
        if (runnerClient) {
          const cfg = runnerClient.getConfig();
          if (cfg.namespace === srcConfig.namespace && cfg.baseUrl === srcConfig.baseUrl) {
            runnerClient.setSessionData(srcData);
          }
        }
      }
    } catch {}
  }

  /**
   * Solves Turnstile in background using Mornye's pydoll solver and exchanges the session
   */
  public static async solveAndAuthenticate(client: SignedSessionClient): Promise<AutoSolveResult> {
    if (this.isSolving && this.solvePromise) {
      return this.solvePromise;
    }

    this.isSolving = true;
    this.solvePromise = this.executeSolve(client)
      .finally(() => {
        this.isSolving = false;
        this.solvePromise = null;
      });

    return this.solvePromise;
  }

  private static async executeSolve(client: SignedSessionClient): Promise<AutoSolveResult> {
    const mornyeDir = this.getMornyePythonPath();
    if (!mornyeDir) {
      return { success: false, error: 'Mornye-Python no está disponible en las rutas configuradas' };
    }

    const config = client.getConfig();

    // 1. Bootstrap
    let boot: any;
    try {
      boot = await client.bootstrap();
    } catch (e: any) {
      return { success: false, error: `Bootstrap falló: ${e.message}` };
    }

    if (client.isAuthenticated()) {
      return { success: true, sessionData: client.getSessionData() };
    }

    if (!boot || !boot.challenge_id) {
      return { success: false, error: 'Bootstrap no devolvió un challenge_id válido' };
    }

    const challengeId = boot.challenge_id;
    const sitekey = boot.turnstile_site_key || '0x4AAAAAADIYiNDcnB6HDKKi';
    const challengeUrl = `${config.baseUrl}${config.endpoints?.challenge || '/challenge'}?id=${encodeURIComponent(challengeId)}&cb=mornye://session-grant`;

    console.log(`[AutoSolver] Iniciando resolución automática en segundo plano para ${config.appVersion}...`);

    // 2. Spawn python solver script
    const pyScript = `
import sys, json
sys.path.insert(0, r"${mornyeDir.replace(/\\/g, '\\\\')}")
from mornye.core.solver import solve_with_callback

sitekey = "${sitekey}"
challenge_url = "${challengeUrl}"

try:
    token, grant = solve_with_callback(sitekey, challenge_url, timeout=40)
    if grant:
        print(json.dumps({"ok": True, "grant": grant}))
    else:
        print(json.dumps({"ok": False, "error": "No grant captured"}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`;

    const grant = await new Promise<string | null>((resolve) => {
      const pyBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      const proc = spawn(pyBin, ['-u', '-c', pyScript], {
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.warn('[AutoSolver] Proceso de Python finalizó con código:', code, stderr);
        }
        try {
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('{') && line.endsWith('}')) {
              const parsed = JSON.parse(line);
              if (parsed.ok && parsed.grant) {
                return resolve(parsed.grant);
              }
            }
          }
        } catch (e) {
          console.warn('[AutoSolver] Error parseando salida de solver:', e);
        }
        resolve(null);
      });

      // Ceiling timeout 50s
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
        resolve(null);
      }, 50000);
    });

    if (!grant) {
      console.warn('[AutoSolver] No se pudo capturar el grant automáticamente.');
      return { success: false, error: 'No se pudo capturar el grant automáticamente' };
    }

    console.log(`[AutoSolver] ¡Grant capturado exitosamente!: ${grant}`);

    // 3. Exchange grant
    try {
      await client.exchangeGrant(grant);
      console.log(`[AutoSolver] Sesión autenticada y canjeada exitosamente.`);
      return { success: true, grant, sessionData: client.getSessionData() };
    } catch (err: any) {
      console.error('[AutoSolver] Error al canjear el grant capturado:', err);
      return { success: false, error: `Error al canjear grant: ${err.message}` };
    }
  }
}

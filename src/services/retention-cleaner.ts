import fs from 'node:fs';
import path from 'node:path';

export interface PurgeResult {
  deletedFiles: string[];
  freedBytes: number;
  errors: string[];
}

export class RetentionCleaner {
  private static timer: NodeJS.Timeout | null = null;

  public static getMonitoredDirectories(): string[] {
    const cwd = process.cwd();
    return [
      path.resolve(cwd, 'downloads'),
      path.resolve(cwd, 'data', 'stream_cache'),
    ];
  }

  public static cleanExpired(maxAgeMs: number = 24 * 60 * 60 * 1000): PurgeResult {
    const result: PurgeResult = {
      deletedFiles: [],
      freedBytes: 0,
      errors: [],
    };

    const now = Date.now();
    const directories = this.getMonitoredDirectories();
    const tmpMaxAgeMs = 30 * 60 * 1000; // 30 minutes for partial / orphan temp files

    for (const dir of directories) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry === '.gitkeep') continue;

          const fullPath = path.join(dir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;

            const isTemp = entry.endsWith('.part') || entry.endsWith('.tmp') || entry.includes('.part.');
            const fileAge = now - stat.mtimeMs;

            const shouldDelete = isTemp ? fileAge > tmpMaxAgeMs : fileAge > maxAgeMs;

            if (shouldDelete) {
              const fileSize = stat.size;
              fs.unlinkSync(fullPath);
              result.deletedFiles.push(entry);
              result.freedBytes += fileSize;
            }
          } catch (err: any) {
            result.errors.push(`${entry}: ${err.message}`);
          }
        }
      } catch (dirErr: any) {
        result.errors.push(`Directory ${dir}: ${dirErr.message}`);
      }
    }

    if (result.deletedFiles.length > 0) {
      const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[RetentionCleaner] Auto-purged ${result.deletedFiles.length} expired file(s) (>24h). Freed ${freedMb} MB.`);
    }

    return result;
  }

  public static startAutoPurge(intervalMs: number = 30 * 60 * 1000, maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    // Run once immediately at startup
    try {
      this.cleanExpired(maxAgeMs);
    } catch (e: any) {
      console.warn('[RetentionCleaner] Initial cleanup error:', e.message);
    }

    // Recurring check
    this.timer = setInterval(() => {
      try {
        this.cleanExpired(maxAgeMs);
      } catch (e: any) {
        console.warn('[RetentionCleaner] Periodic cleanup error:', e.message);
      }
    }, intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public static stopAutoPurge(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}


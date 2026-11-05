import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export interface TrackMappingRow {
  cacheKey: string;
  isrc?: string;
  title: string;
  artist: string;
  qobuzId?: string;
  tidalId?: string;
  amazonAsin?: string;
  deezerId?: string;
  youtubeVideoId?: string;
  resolvedJson: string;
  updatedAt: number;
}

export interface DownloadHistoryEntry {
  id?: number;
  title: string;
  artist: string;
  album?: string;
  isrc?: string;
  provider: string;
  quality: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  codec?: string;
  sampleRate?: number;
  bitsPerSample?: number;
  bitrateKbps?: number;
  channels?: number;
  durationSec?: number;
  hasLyrics?: boolean;
  createdAt: number;
}

export class PersistentCacheDB {
  private static db: DatabaseSync | null = null;
  private static l1Cache = new Map<string, { data: any; expires: number }>();

  private static getDB(): DatabaseSync {
    if (this.db) return this.db;

    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'wavex_cache.sqlite');
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS kv_cache (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, cache_key)
      );

      CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_cache(expires_at);

      CREATE TABLE IF NOT EXISTS track_mappings (
        cache_key TEXT PRIMARY KEY,
        isrc TEXT,
        title TEXT,
        artist TEXT,
        qobuz_id TEXT,
        tidal_id TEXT,
        amazon_asin TEXT,
        deezer_id TEXT,
        youtube_video_id TEXT,
        resolved_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_track_mappings_isrc ON track_mappings(isrc);

      CREATE TABLE IF NOT EXISTS download_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        isrc TEXT,
        provider TEXT NOT NULL,
        quality TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        codec TEXT,
        sample_rate INTEGER,
        bits_per_sample INTEGER,
        bitrate_kbps INTEGER,
        channels INTEGER,
        duration_sec REAL,
        has_lyrics INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    return this.db;
  }

  public static get<T = any>(namespace: string, key: string): T | null {
    const composite = `${namespace}:${key}`;
    const now = Date.now();

    // 1. Check L1 RAM cache
    const mem = this.l1Cache.get(composite);
    if (mem) {
      if (now <= mem.expires) return mem.data as T;
      this.l1Cache.delete(composite);
    }

    // 2. Check L2 SQLite cache
    try {
      const db = this.getDB();
      const stmt = db.prepare(
        'SELECT value_json, expires_at FROM kv_cache WHERE namespace = ? AND cache_key = ?'
      );
      const row = stmt.get(namespace, key) as { value_json: string; expires_at: number } | undefined;
      if (!row) return null;

      if (now > row.expires_at) {
        db.prepare('DELETE FROM kv_cache WHERE namespace = ? AND cache_key = ?').run(namespace, key);
        return null;
      }

      const parsed = JSON.parse(row.value_json) as T;
      this.l1Cache.set(composite, { data: parsed, expires: row.expires_at });
      return parsed;
    } catch {
      return null;
    }
  }

  public static set<T = any>(namespace: string, key: string, data: T, ttlMs: number): void {
    const composite = `${namespace}:${key}`;
    const expires = Date.now() + ttlMs;

    if (this.l1Cache.size > 4000) {
      const oldestKeys = Array.from(this.l1Cache.keys()).slice(0, 500);
      for (const k of oldestKeys) this.l1Cache.delete(k);
    }
    this.l1Cache.set(composite, { data, expires });

    try {
      const db = this.getDB();
      const stmt = db.prepare(`
        INSERT INTO kv_cache (namespace, cache_key, value_json, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(namespace, cache_key) DO UPDATE SET
          value_json = excluded.value_json,
          expires_at = excluded.expires_at
      `);
      stmt.run(namespace, key, JSON.stringify(data), expires);
    } catch {}
  }

  public static saveTrackMapping(
    cacheKey: string,
    title: string,
    artist: string,
    isrc: string | undefined,
    resolved: any
  ): void {
    try {
      const db = this.getDB();
      const native = resolved?.nativeIds || {};
      const stmt = db.prepare(`
        INSERT INTO track_mappings (
          cache_key, isrc, title, artist, qobuz_id, tidal_id, amazon_asin, deezer_id, youtube_video_id, resolved_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          isrc = COALESCE(excluded.isrc, track_mappings.isrc),
          qobuz_id = COALESCE(excluded.qobuz_id, track_mappings.qobuz_id),
          tidal_id = COALESCE(excluded.tidal_id, track_mappings.tidal_id),
          amazon_asin = COALESCE(excluded.amazon_asin, track_mappings.amazon_asin),
          deezer_id = COALESCE(excluded.deezer_id, track_mappings.deezer_id),
          youtube_video_id = COALESCE(excluded.youtube_video_id, track_mappings.youtube_video_id),
          resolved_json = excluded.resolved_json,
          updated_at = excluded.updated_at
      `);
      stmt.run(
        cacheKey,
        isrc || resolved?.isrc || null,
        title || '',
        artist || '',
        native.qobuzId || null,
        native.tidalId || null,
        native.amazonAsin || null,
        native.deezerId || null,
        native.youtubeVideoId || null,
        JSON.stringify(resolved),
        Date.now()
      );
    } catch {}
  }

  public static getTrackMapping(cacheKey: string, isrc?: string): any | null {
    try {
      const db = this.getDB();
      let row = db
        .prepare('SELECT resolved_json FROM track_mappings WHERE cache_key = ?')
        .get(cacheKey) as { resolved_json: string } | undefined;

      if (!row && isrc) {
        row = db
          .prepare('SELECT resolved_json FROM track_mappings WHERE isrc = ? ORDER BY updated_at DESC LIMIT 1')
          .get(isrc) as { resolved_json: string } | undefined;
      }

      if (row && row.resolved_json) {
        return JSON.parse(row.resolved_json);
      }
    } catch {}
    return null;
  }

  public static recordDownload(entry: DownloadHistoryEntry): void {
    try {
      const db = this.getDB();
      const stmt = db.prepare(`
        INSERT INTO download_history (
          title, artist, album, isrc, provider, quality, file_name, file_path, size_bytes,
          codec, sample_rate, bits_per_sample, bitrate_kbps, channels, duration_sec, has_lyrics, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          codec = excluded.codec,
          sample_rate = excluded.sample_rate,
          bits_per_sample = excluded.bits_per_sample,
          bitrate_kbps = excluded.bitrate_kbps,
          channels = excluded.channels,
          duration_sec = excluded.duration_sec,
          has_lyrics = excluded.has_lyrics,
          created_at = excluded.created_at
      `);
      stmt.run(
        entry.title,
        entry.artist,
        entry.album || null,
        entry.isrc || null,
        entry.provider,
        entry.quality,
        entry.fileName,
        entry.filePath,
        entry.sizeBytes,
        entry.codec || null,
        entry.sampleRate || null,
        entry.bitsPerSample || null,
        entry.bitrateKbps || null,
        entry.channels || null,
        entry.durationSec || null,
        entry.hasLyrics ? 1 : 0,
        entry.createdAt || Date.now()
      );
    } catch {}
  }

  public static getDownloadHistory(limit: number = 50): DownloadHistoryEntry[] {
    try {
      const db = this.getDB();
      const rows = db
        .prepare('SELECT * FROM download_history ORDER BY created_at DESC LIMIT ?')
        .all(limit) as any[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        album: r.album,
        isrc: r.isrc,
        provider: r.provider,
        quality: r.quality,
        fileName: r.file_name,
        filePath: r.file_path,
        sizeBytes: r.size_bytes,
        codec: r.codec,
        sampleRate: r.sample_rate,
        bitsPerSample: r.bits_per_sample,
        bitrateKbps: r.bitrate_kbps,
        channels: r.channels,
        durationSec: r.duration_sec,
        hasLyrics: Boolean(r.has_lyrics),
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }
}


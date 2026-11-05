import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistentCacheDB } from './db-cache.js';

export interface AudioSpecs {
  codec: string;
  codecLongName?: string;
  sampleRate: number;
  bitsPerSample: number;
  bitrateKbps: number;
  channels: number;
  channelLayout?: string;
  durationSec: number;
  sizeBytes: number;
  container: string;
  isLossless: boolean;
  isHiRes: boolean;
  isAtmosOrSurround: boolean;
  badgeText: string;
}

export interface LyricsResult {
  found: boolean;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  source?: string;
}

export interface TagMetadata {
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number | string;
  discNumber?: number | string;
  releaseDate?: string;
  isrc?: string;
  genre?: string;
  copyright?: string;
  coverUrl?: string;
  lyrics?: string;
  durationSec?: number;
}

export class AudioProcessor {
  /**
   * Probes an audio file using ffprobe to extract exact audiophile specifications
   */
  public static async probeAudioFile(filePath: string): Promise<AudioSpecs | null> {
    if (!fs.existsSync(filePath)) return null;

    const cached = PersistentCacheDB.get<AudioSpecs>('audio_specs', filePath);
    if (cached) return cached;

    return new Promise((resolve) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ];

      execFile('ffprobe', args, { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          const streams: any[] = parsed.streams || [];
          const audioStream = streams.find((s) => s.codec_type === 'audio') || streams[0] || {};
          const format = parsed.format || {};

          const codec = String(audioStream.codec_name || path.extname(filePath).replace('.', '')).toLowerCase();
          const sampleRate = Number(audioStream.sample_rate || 44100);
          const rawBits = Number(
            audioStream.bits_per_raw_sample ||
            audioStream.bits_per_sample ||
            (codec === 'flac' || codec === 'alac' ? 16 : 0)
          );
          const sizeBytes = Number(format.size || fs.statSync(filePath).size || 0);
          const durationSec = Number(format.duration || audioStream.duration || 0);
          const rawBitrate = Number(audioStream.bit_rate || format.bit_rate || 0);
          const bitrateKbps = rawBitrate > 0
            ? Math.round(rawBitrate / 1000)
            : (durationSec > 0 ? Math.round((sizeBytes * 8) / durationSec / 1000) : 0);

          const channels = Number(audioStream.channels || 2);
          const channelLayout = String(audioStream.channel_layout || (channels > 2 ? `${channels}ch` : 'stereo'));

          const isLossless = ['flac', 'alac', 'wav', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'ape', 'wv'].includes(codec);
          const isHiRes = isLossless && (rawBits > 16 || sampleRate > 48000);
          const isAtmosOrSurround = codec.includes('eac3') || codec.includes('ac3') || codec.includes('truehd') || channels > 2;

          const khz = (sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1);
          let badgeParts: string[] = [];
          if (isAtmosOrSurround) {
            badgeParts.push('Dolby Atmos / E-AC-3');
            if (channels > 2) badgeParts.push(`${channels}ch`);
          } else if (rawBits > 0) {
            badgeParts.push(`${rawBits}-bit / ${khz} kHz`);
          } else {
            badgeParts.push(`${khz} kHz`);
          }
          if (bitrateKbps > 0) badgeParts.push(`${bitrateKbps} kbps`);
          badgeParts.push(codec.toUpperCase());

          const specs: AudioSpecs = {
            codec,
            codecLongName: audioStream.codec_long_name,
            sampleRate,
            bitsPerSample: rawBits,
            bitrateKbps,
            channels,
            channelLayout,
            durationSec,
            sizeBytes,
            container: path.extname(filePath).replace('.', '').toLowerCase(),
            isLossless,
            isHiRes,
            isAtmosOrSurround,
            badgeText: badgeParts.join(' · '),
          };

          PersistentCacheDB.set('audio_specs', filePath, specs, 24 * 60 * 60 * 1000);
          resolve(specs);
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Fetches synced (.lrc) and plain lyrics from LRCLIB
   */
  public static async fetchSyncedLyrics(
    title: string,
    artist: string,
    album?: string,
    durationSec?: number
  ): Promise<LyricsResult> {
    const cleanTitle = (title || '').trim();
    const cleanArtist = (artist || '').trim();
    if (!cleanTitle) return { found: false, syncedLyrics: null, plainLyrics: null };

    const cacheKey = `${cleanTitle.toLowerCase()}|${cleanArtist.toLowerCase()}`;
    const cached = PersistentCacheDB.get<LyricsResult>('lyrics', cacheKey);
    if (cached) return cached;

    try {
      // 1. Direct match if artist is provided
      if (cleanArtist) {
        const params = new URLSearchParams({
          track_name: cleanTitle,
          artist_name: cleanArtist,
        });
        if (album) params.set('album_name', album);
        if (durationSec && durationSec > 0) params.set('duration', String(Math.round(durationSec)));

        const getRes = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
          headers: { 'User-Agent': 'WaveX-Audiophile-Engine/2.0' },
          signal: AbortSignal.timeout(4000),
        });
        if (getRes.ok) {
          const item: any = await getRes.json();
          if (item && (item.syncedLyrics || item.plainLyrics)) {
            const result: LyricsResult = {
              found: true,
              syncedLyrics: item.syncedLyrics || null,
              plainLyrics: item.plainLyrics || null,
              source: 'LRCLIB Direct',
            };
            PersistentCacheDB.set('lyrics', cacheKey, result, 7 * 24 * 60 * 60 * 1000);
            return result;
          }
        }
      }

      // 2. Search fallback
      const q = `${cleanTitle} ${cleanArtist}`.trim();
      const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': 'WaveX-Audiophile-Engine/2.0' },
        signal: AbortSignal.timeout(4500),
      });
      if (searchRes.ok) {
        const list: any[] = (await searchRes.json()) as any[];
        if (Array.isArray(list) && list.length > 0) {
          const withSynced = list.find((item) => item.syncedLyrics) || list.find((item) => item.plainLyrics);
          if (withSynced) {
            const result: LyricsResult = {
              found: true,
              syncedLyrics: withSynced.syncedLyrics || null,
              plainLyrics: withSynced.plainLyrics || null,
              source: 'LRCLIB Search',
            };
            PersistentCacheDB.set('lyrics', cacheKey, result, 7 * 24 * 60 * 60 * 1000);
            return result;
          }
        }
      }
    } catch {}

    const empty: LyricsResult = { found: false, syncedLyrics: null, plainLyrics: null };
    PersistentCacheDB.set('lyrics', cacheKey, empty, 30 * 60 * 1000);
    return empty;
  }

  /**
   * Embeds ID3v2 / Vorbis / MP4 tags, 3000x3000 artwork, and synced lyrics (.lrc) into the audio file
   */
  public static async embedMetadataAndArtwork(
    filePath: string,
    meta: TagMetadata
  ): Promise<{ tagged: boolean; hasLyrics: boolean; lrcPath?: string }> {
    if (!fs.existsSync(filePath)) return { tagged: false, hasLyrics: false };

    const ext = path.extname(filePath).toLowerCase();
    // Skip raw Atmos bitstream (.eac3) from container picture muxing if not wrapped in mp4/m4a
    const supportsTagging = ['.flac', '.m4a', '.mp4', '.mp3', '.ogg', '.opus'].includes(ext);

    let lrcPath: string | undefined;
    let hasLyrics = false;
    let lyricsText = meta.lyrics || '';

    // 1. Fetch Synced Lyrics if not provided
    if (!lyricsText && meta.title) {
      try {
        const lrcData = await this.fetchSyncedLyrics(meta.title, meta.artist, meta.album, meta.durationSec);
        if (lrcData.syncedLyrics || lrcData.plainLyrics) {
          lyricsText = (lrcData.syncedLyrics || lrcData.plainLyrics) as string;
          hasLyrics = true;
          // Save companion .lrc file alongside the audio file if it's in downloads/
          if (lrcData.syncedLyrics && filePath.includes('downloads')) {
            lrcPath = filePath.replace(/\.[^/.]+$/, '.lrc');
            try {
              fs.writeFileSync(lrcPath, lrcData.syncedLyrics, 'utf8');
            } catch {}
          }
        }
      } catch {}
    } else if (lyricsText) {
      hasLyrics = true;
    }

    if (!supportsTagging) {
      return { tagged: false, hasLyrics, lrcPath };
    }

    // 2. Download high-res cover image (up to 3000x3000) to temp file
    let tempCoverPath: string | null = null;
    if (meta.coverUrl) {
      try {
        const hiResUrl = meta.coverUrl.replace(/\d+x\d+bb\.jpg/i, '1500x1500bb.jpg');
        const imgRes = await fetch(hiResUrl, { signal: AbortSignal.timeout(6000) });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (buf.length > 512) {
            tempCoverPath = path.join(os.tmpdir(), `wavex_cover_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
            fs.writeFileSync(tempCoverPath, buf);
          }
        }
      } catch {}
    }

    const tempOutPath = `${filePath}.tagged${ext}`;

    return new Promise((resolve) => {
      const args: string[] = ['-y', '-i', filePath];

      const canEmbedPicture = tempCoverPath && ['.flac', '.m4a', '.mp4', '.mp3'].includes(ext);
      if (canEmbedPicture && tempCoverPath) {
        args.push('-i', tempCoverPath);
        args.push('-map', '0:a:0', '-map', '1:v:0');
        args.push('-c:a', 'copy', '-c:v', 'mjpeg');
        args.push('-disposition:v:0', 'attached_pic');
        if (ext === '.mp3') {
          args.push('-id3v2_version', '3');
        }
      } else {
        args.push('-map', '0:a:0', '-c:a', 'copy');
      }

      const addMeta = (key: string, val?: string | number) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          args.push('-metadata', `${key}=${String(val).trim()}`);
        }
      };

      addMeta('title', meta.title);
      addMeta('artist', meta.artist);
      addMeta('album', meta.album || meta.title);
      addMeta('album_artist', meta.albumArtist || meta.artist);
      addMeta('track', meta.trackNumber);
      addMeta('disc', meta.discNumber);
      addMeta('date', meta.releaseDate);
      addMeta('isrc', meta.isrc);
      addMeta('genre', meta.genre);
      addMeta('copyright', meta.copyright);
      addMeta('comment', 'Downloaded via WaveX Audiophile Engine');
      if (lyricsText) {
        addMeta('lyrics', lyricsText);
        addMeta('LYRICS', lyricsText);
      }

      args.push(tempOutPath);

      execFile('ffmpeg', args, { timeout: 25000 }, (err) => {
        if (tempCoverPath) {
          try { fs.unlinkSync(tempCoverPath); } catch {}
        }

        if (!err && fs.existsSync(tempOutPath) && fs.statSync(tempOutPath).size > 1024) {
          try {
            fs.renameSync(tempOutPath, filePath);
            resolve({ tagged: true, hasLyrics, lrcPath });
            return;
          } catch {}
        }

        try {
          if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath);
        } catch {}
        resolve({ tagged: false, hasLyrics, lrcPath });
      });
    });
  }

  /**
   * Optional on-the-fly format converter for client apps requesting a specific output format
   */
  public static async convertAudioFormat(
    inputPath: string,
    targetFormat: 'mp3_320' | 'flac' | 'alac' | 'aac' | 'wav'
  ): Promise<string | null> {
    if (!fs.existsSync(inputPath)) return null;

    const formatMap: Record<string, { ext: string; codecArgs: string[] }> = {
      mp3_320: { ext: '.mp3', codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3'] },
      flac: { ext: '.flac', codecArgs: ['-c:a', 'flac', '-compression_level', '8'] },
      alac: { ext: '.m4a', codecArgs: ['-c:a', 'alac'] },
      aac: { ext: '.m4a', codecArgs: ['-c:a', 'aac', '-b:a', '256k'] },
      wav: { ext: '.wav', codecArgs: ['-c:a', 'pcm_s24le'] },
    };

    const cfg = formatMap[targetFormat];
    if (!cfg) return null;

    const outPath = inputPath.replace(/\.[^/.]+$/, '') + cfg.ext;
    if (outPath === inputPath) return inputPath;

    return new Promise((resolve) => {
      const args = ['-y', '-i', inputPath, ...cfg.codecArgs, outPath];
      execFile('ffmpeg', args, { timeout: 60000 }, (err) => {
        if (!err && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
          resolve(outPath);
        } else {
          resolve(null);
        }
      });
    });
  }
}


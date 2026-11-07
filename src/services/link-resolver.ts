import crypto from 'node:crypto';
import type { ExtensionManager } from '../manager.js';
import { PersistentCacheDB } from './db-cache.js';

export interface ResolvedLinks {
  isrc?: string;
  spotify?: string;
  deezer?: string;
  tidal?: string;
  appleMusic?: string;
  amazonMusic?: string;
  soundCloud?: string;
  qobuz?: string;
  youtubeMusic?: string;
  youtube?: string;
  nativeIds: {
    deezerId?: string;
    tidalId?: string;
    qobuzId?: string;
    amazonAsin?: string;
    youtubeVideoId?: string;
  };
}

const RESOLVE_API_URL = 'https://api.zarz.moe/v1/resolve';

export class LinkResolver {
  private static cache = new Map<string, ResolvedLinks>();

  public static async resolveByUrl(url: string): Promise<ResolvedLinks | null> {
    const cached = this.cache.get(url) || PersistentCacheDB.getTrackMapping(`url:${url}`);
    if (cached) {
      this.cache.set(url, cached);
      return cached;
    }

    try {
      const res = await fetch(RESOLVE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data || !data.success || !data.songUrls) return null;

      const links: ResolvedLinks = {
        isrc: data.isrc,
        spotify: data.songUrls.Spotify || undefined,
        deezer: data.songUrls.Deezer || undefined,
        tidal: data.songUrls.Tidal || undefined,
        appleMusic: data.songUrls.AppleMusic || undefined,
        amazonMusic: data.songUrls.AmazonMusic || undefined,
        soundCloud: data.songUrls.SoundCloud || undefined,
        qobuz: data.songUrls.Qobuz || undefined,
        youtubeMusic: data.songUrls.YouTubeMusic || undefined,
        youtube: data.songUrls.YouTube || undefined,
        nativeIds: {},
      };

      // Extract native IDs
      if (links.deezer) {
        const m = links.deezer.match(/\/track\/(\d+)/i);
        if (m) links.nativeIds.deezerId = m[1];
      }
      if (links.tidal) {
        const m = links.tidal.match(/\/track\/(\d+)/i);
        if (m) links.nativeIds.tidalId = m[1];
      }
      if (links.qobuz) {
        const m = links.qobuz.match(/(?:track\/|trackId=|\/item\/)(\d+)/i) || links.qobuz.match(/\/(\d+)(?:[/?#]|$)/);
        if (m) links.nativeIds.qobuzId = m[1];
      }
      if (links.amazonMusic) {
        const m = links.amazonMusic.match(/trackAsin=([A-Z0-9]{10})/i) || links.amazonMusic.match(/\/tracks\/(B[0-9A-Z]{9})/i);
        if (m) links.nativeIds.amazonAsin = m[1];
      }
      if (links.youtubeMusic || links.youtube) {
        const yt = links.youtubeMusic || links.youtube || '';
        const m = yt.match(/[?&]v=([A-Za-z0-9_-]{11})/i) || yt.match(/\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/i);
        if (m) links.nativeIds.youtubeVideoId = m[1];
      }

      this.cache.set(url, links);
      PersistentCacheDB.saveTrackMapping(`url:${url}`, '', '', links.isrc, links);
      return links;
    } catch (e) {
      console.warn('[LinkResolver] Failed to resolve URL:', url, e);
      return null;
    }
  }

  public static async resolveByMetadata(
    title: string,
    artist: string,
    isrc?: string,
    manager?: ExtensionManager
  ): Promise<ResolvedLinks | null> {
    const metaCacheKey = `meta:${(title || '').toLowerCase()}|${(artist || '').toLowerCase()}|${isrc || ''}`;
    const cached = this.cache.get(metaCacheKey) || PersistentCacheDB.getTrackMapping(metaCacheKey, isrc);
    if (cached) {
      this.cache.set(metaCacheKey, cached);
      return cached;
    }

    let spotifyUrl: string | null = null;

    // 1. If ExtensionManager is supplied, use spotify-web extension to find canonical Spotify track ID
    if (manager) {
      const spRunner = manager.getRunner('spotify-web');
      if (spRunner) {
        try {
          const query = (isrc ? `isrc:${isrc.trim()}` : `${title} ${artist}`).trim();
          const spTracks = await spRunner.call('customSearch', [query, { filter: 'tracks', limit: 1 }], 2500);
          if (spTracks && Array.isArray(spTracks) && spTracks.length > 0 && spTracks[0].id) {
            const rawId = String(spTracks[0].id).replace(/^spotify:track:/, '');
            spotifyUrl = `https://open.spotify.com/track/${rawId}`;
          }
        } catch {}
      }
    }

    // 2. If Spotify URL was found, resolve all platform links using Zarz multi-provider resolver
    if (spotifyUrl) {
      const resolved = await this.resolveByUrl(spotifyUrl);
      if (resolved) {
        this.cache.set(metaCacheKey, resolved);
        PersistentCacheDB.saveTrackMapping(metaCacheKey, title, artist, isrc || resolved.isrc, resolved);
        return resolved;
      }
    }

    // 3. Fallback: Resolve directly via Deezer API (by ISRC or search) -> Zarz multi-provider resolver
    try {
      let dzTrack: any = null;
      if (isrc) {
        const dzRes = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc.trim())}`, { signal: AbortSignal.timeout(3000) });
        if (dzRes.ok) {
          const dzData: any = await dzRes.json();
          if (dzData && !dzData.error && dzData.id) dzTrack = dzData;
        }
      }
      if (!dzTrack && title) {
        const primaryArtist = (artist || '').split(/[,;&]|\b(?:feat|ft|with)\.?\b/i)[0].trim();
        const q = `${title} ${primaryArtist}`.trim();
        const dzSearch = await fetch(`https://api.deezer.com/search/track?q=${encodeURIComponent(q)}&limit=3`, { signal: AbortSignal.timeout(3000) });
        if (dzSearch.ok) {
          const dzList: any = await dzSearch.json();
          if (Array.isArray(dzList?.data) && dzList.data.length > 0) {
            dzTrack = dzList.data[0];
          }
        }
      }
      if (dzTrack && dzTrack.id) {
        const deezerUrl = dzTrack.link || `https://www.deezer.com/track/${dzTrack.id}`;
        const res = await this.resolveByUrl(deezerUrl);
        if (res) {
          if (!res.isrc && (isrc || dzTrack.isrc)) res.isrc = isrc || dzTrack.isrc;
          if (!res.deezer) res.deezer = deezerUrl;
          if (res.nativeIds && !res.nativeIds.deezerId) res.nativeIds.deezerId = String(dzTrack.id);
          this.cache.set(metaCacheKey, res);
          PersistentCacheDB.saveTrackMapping(metaCacheKey, title, artist, isrc || res.isrc, res);
          return res;
        }
      }
    } catch {}

    return null;
  }
}

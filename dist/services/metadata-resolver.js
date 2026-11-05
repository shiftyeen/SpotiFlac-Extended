import { PersistentCacheDB } from './db-cache.js';
export class MetadataResolver {
    static memoryCache = new Map();
    static async resolveRichTrack(params, manager) {
        const rawTitle = (params.title || '').trim();
        const rawArtist = (params.artist || '').trim();
        const rawIsrc = (params.isrc || '').trim().toUpperCase();
        const videoId = (params.videoId || params.trackId || '').trim();
        const cacheKey = `${rawIsrc}|${rawTitle.toLowerCase()}|${rawArtist.toLowerCase()}|${videoId}`;
        // 1. Check memory cache
        const mem = this.memoryCache.get(cacheKey);
        if (mem && Date.now() < mem.expires) {
            return mem.data;
        }
        // 2. Check SQLite persistent cache
        const dbCached = PersistentCacheDB.get('track_rich_meta', cacheKey);
        if (dbCached) {
            this.memoryCache.set(cacheKey, { data: dbCached, expires: Date.now() + 60 * 60 * 1000 });
            return dbCached;
        }
        let resolvedTitle = rawTitle;
        let resolvedArtist = rawArtist;
        let resolvedAlbum = '';
        let resolvedIsrc = rawIsrc;
        let resolvedCover = '';
        let resolvedDurationSec;
        let resolvedReleaseDate = '';
        // 3. Try Deezer public API first (high speed, 1000x1000 cover, ISRC, release date)
        try {
            let dzUrl = '';
            if (rawIsrc) {
                dzUrl = `https://api.deezer.com/track/isrc:${encodeURIComponent(rawIsrc)}`;
            }
            else if (rawTitle) {
                const q = `${rawArtist ? `${rawArtist} ` : ''}${rawTitle}`.trim();
                dzUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`;
            }
            if (dzUrl) {
                const res = await fetch(dzUrl, {
                    headers: { 'User-Agent': 'WaveX-Bot/1.0' },
                    signal: AbortSignal.timeout(3000),
                });
                if (res.ok) {
                    const data = await res.json();
                    const item = Array.isArray(data?.data) ? data.data[0] : (data?.id ? data : null);
                    if (item) {
                        resolvedTitle = item.title || resolvedTitle;
                        if (item.artist?.name)
                            resolvedArtist = item.artist.name;
                        if (item.album?.title)
                            resolvedAlbum = item.album.title;
                        if (item.album?.cover_xl || item.album?.cover_big || item.album?.cover) {
                            resolvedCover = item.album.cover_xl || item.album.cover_big || item.album.cover;
                        }
                        if (item.isrc)
                            resolvedIsrc = item.isrc;
                        if (item.duration)
                            resolvedDurationSec = Number(item.duration);
                        if (item.release_date)
                            resolvedReleaseDate = String(item.release_date);
                    }
                }
            }
        }
        catch { }
        // 4. If cover or album is missing, try YouTube Music extension
        if ((!resolvedCover || !resolvedAlbum) && manager) {
            const ytmRunner = manager.getRunner('ytmusic-spotiflac');
            if (ytmRunner) {
                try {
                    if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
                        const track = await ytmRunner.call('getTrack', [videoId], 3500);
                        if (track) {
                            if (!resolvedTitle)
                                resolvedTitle = track.name || track.title;
                            if (!resolvedArtist)
                                resolvedArtist = track.artists || track.artist;
                            if (!resolvedAlbum && (track.album_name || track.album)) {
                                resolvedAlbum = track.album_name || track.album;
                            }
                            if (!resolvedCover && (track.cover_url || track.thumbnail)) {
                                resolvedCover = track.cover_url || track.thumbnail;
                            }
                            if (!resolvedDurationSec && track.duration_ms) {
                                resolvedDurationSec = Math.round(Number(track.duration_ms) / 1000);
                            }
                            if (!resolvedIsrc && track.isrc) {
                                resolvedIsrc = track.isrc;
                            }
                            if (!resolvedReleaseDate && track.release_date) {
                                resolvedReleaseDate = track.release_date;
                            }
                        }
                    }
                }
                catch { }
            }
        }
        // 5. Fallback cover for YouTube Video ID
        if (!resolvedCover && videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            resolvedCover = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        }
        const durationMs = resolvedDurationSec ? resolvedDurationSec * 1000 : undefined;
        let year = '';
        if (resolvedReleaseDate) {
            const m = resolvedReleaseDate.match(/^(\d{4})/);
            if (m)
                year = m[1];
        }
        const encodedTitle = encodeURIComponent(resolvedTitle || '');
        const encodedArtist = encodeURIComponent(resolvedArtist || '');
        const encodedVideoId = encodeURIComponent(videoId || '');
        const lyricsUrl = `/api/lyrics?title=${encodedTitle}&artist=${encodedArtist}${resolvedAlbum ? `&album=${encodeURIComponent(resolvedAlbum)}` : ''}${resolvedDurationSec ? `&duration=${resolvedDurationSec}` : ''}`;
        const queueUrl = `/api/queue?${videoId ? `videoId=${encodedVideoId}&` : ''}title=${encodedTitle}&artist=${encodedArtist}`;
        const relatedUrl = `/api/track/related?${videoId ? `videoId=${encodedVideoId}&` : ''}title=${encodedTitle}&artist=${encodedArtist}`;
        const fastStreamUrl = `/fast-streaming?${videoId ? `trackId=${encodedVideoId}&` : ''}title=${encodedTitle}&artist=${encodedArtist}`;
        const streamUrl = `/api/stream/live?title=${encodedTitle}&artist=${encodedArtist}${params.provider ? `&provider=${encodeURIComponent(params.provider)}` : ''}`;
        const metadata = {
            title: resolvedTitle || 'Unknown Title',
            artist: resolvedArtist || 'Unknown Artist',
            album: resolvedAlbum || '',
            isrc: resolvedIsrc || undefined,
            coverUrl: resolvedCover || undefined,
            durationSec: resolvedDurationSec,
            durationMs,
            releaseDate: resolvedReleaseDate || undefined,
            year: year || undefined,
            lyricsUrl,
            relatedUrl,
            queueUrl,
            streamUrl,
            fastStreamUrl,
        };
        // Store in cache for 7 days
        this.memoryCache.set(cacheKey, { data: metadata, expires: Date.now() + 60 * 60 * 1000 });
        PersistentCacheDB.set('track_rich_meta', cacheKey, metadata, 7 * 24 * 60 * 60 * 1000);
        return metadata;
    }
}

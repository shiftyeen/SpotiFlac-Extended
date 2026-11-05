import type { ExtensionManager } from '../manager.js';

export interface AlbumMatchResult {
  matched: boolean;
  confidence: number; // 0 - 100
  matchStrategy: 'upc_and_isrc' | 'upc' | 'isrc' | 'text' | 'none';
  deezer: {
    id: string;
    title: string;
    artist?: string;
    upc?: string;
    trackCount?: number;
    url?: string;
  };
  apple: {
    id?: string;
    title?: string;
    artist?: string;
    upc?: string;
    trackCount?: number;
    releaseDate?: string;
    artwork?: string;
    url?: string;
    copyright?: string;
    label?: string;
    genre?: string;
  } | null;
  sampleIsrcMatches?: Array<{ isrc: string; title: string; appleTrackId?: string; appleAlbumId?: string }>;
}

export class AlbumMatcher {
  constructor(private manager: ExtensionManager) {}

  public async matchOctaveAlbum(octaveAlbumId: string): Promise<AlbumMatchResult> {
    const url = `https://api.octavestreaming.com/api/album/${octaveAlbumId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch Octave album: HTTP ${res.status}`);
    const data: any = await res.json();
    const album = data.album;

    if (!album) {
      throw new Error(`Album ${octaveAlbumId} not found in Octave response`);
    }

    const title = album.title || '';
    const artistName = typeof album.artist === 'string' ? album.artist : (album.artist?.name || '');
    const upc = album.upc || '';
    const tracks = album.tracks || [];
    const trackCount = tracks.length;

    const deezerInfo = {
      id: String(album.id || octaveAlbumId),
      title,
      artist: artistName,
      upc,
      trackCount,
      url: `https://www.deezer.com/album/${album.id || octaveAlbumId}`,
    };

    let appleCandidate: any = null;
    let upcMatched = false;
    let isrcMatched = false;
    const sampleIsrcMatches: Array<{ isrc: string; title: string; appleTrackId?: string; appleAlbumId?: string }> = [];

    // Strategy 1: Match by UPC
    if (upc) {
      try {
        const itunesRes = await fetch(`https://itunes.apple.com/lookup?upc=${encodeURIComponent(upc)}&entity=album`);
        if (itunesRes.ok) {
          const itunesData: any = await itunesRes.json();
          if (itunesData.results && itunesData.results.length > 0) {
            // Rank results: exact track count + title similarity
            const ranked = itunesData.results.map((r: any) => {
              let score = 0;
              if (r.trackCount === trackCount) score += 50;
              if (r.collectionName && title && r.collectionName.toLowerCase() === title.toLowerCase()) score += 50;
              else if (r.collectionName && title && r.collectionName.toLowerCase().includes(title.toLowerCase())) score += 30;
              return { ...r, matchScore: score };
            }).sort((a: any, b: any) => b.matchScore - a.matchScore);

            appleCandidate = ranked[0];
            upcMatched = true;
          }
        }
      } catch (err: any) {
        console.warn(`[AlbumMatcher] UPC lookup failed for ${upc}:`, err.message);
      }
    }

    // Strategy 2: Cross-check with ISRC of the first 2 tracks
    const appleRunner = this.manager.getRunner('apple-music');
    if (appleRunner && tracks.length > 0) {
      const sampleTracks = tracks.slice(0, 2);
      for (const t of sampleTracks) {
        if (!t.isrc) continue;
        try {
          const enriched = await appleRunner.call('enrichTrack', [{
            name: t.title,
            artists: artistName,
            album_name: title,
            isrc: t.isrc,
            duration: t.duration || 0,
          }], 10000);

          if (enriched && enriched.album_id) {
            sampleIsrcMatches.push({
              isrc: t.isrc,
              title: t.title,
              appleTrackId: String(enriched.id || enriched.apple_music_id || ''),
              appleAlbumId: String(enriched.album_id || ''),
            });

            // If we didn't have a UPC candidate, use the album ID from ISRC
            if (!appleCandidate) {
              appleCandidate = {
                collectionId: enriched.album_id,
                collectionName: enriched.album_name,
                artistName: enriched.artists,
                artworkUrl100: enriched.cover_url,
                collectionViewUrl: enriched.album_url || enriched.external_links?.apple_music_album,
                copyright: enriched.copyright,
                primaryGenreName: enriched.genre,
                trackCount: enriched.total_tracks || trackCount,
              };
              isrcMatched = true;
            } else if (String(appleCandidate.collectionId) === String(enriched.album_id)) {
              isrcMatched = true;
            }
          }
        } catch (_) {}
      }
    }

    if (!appleCandidate) {
      return {
        matched: false,
        confidence: 0,
        matchStrategy: 'none',
        deezer: deezerInfo,
        apple: null,
      };
    }

    // Determine confidence and strategy
    let confidence = 70;
    let strategy: 'upc_and_isrc' | 'upc' | 'isrc' | 'text' = 'upc';

    if (upcMatched && isrcMatched) {
      confidence = 100;
      strategy = 'upc_and_isrc';
    } else if (upcMatched) {
      confidence = appleCandidate.trackCount === trackCount ? 95 : 85;
      strategy = 'upc';
    } else if (isrcMatched) {
      confidence = 90;
      strategy = 'isrc';
    }

    // Normalize artwork to high-res (3000x3000bb.jpg)
    let artworkHighRes = appleCandidate.artworkUrl100 || '';
    if (artworkHighRes.includes('100x100bb.jpg')) {
      artworkHighRes = artworkHighRes.replace('100x100bb.jpg', '3000x3000bb.jpg');
    }

    return {
      matched: true,
      confidence,
      matchStrategy: strategy,
      deezer: deezerInfo,
      apple: {
        id: String(appleCandidate.collectionId || appleCandidate.id || ''),
        title: appleCandidate.collectionName || appleCandidate.name || title,
        artist: appleCandidate.artistName || artistName,
        upc: upc,
        trackCount: appleCandidate.trackCount || trackCount,
        releaseDate: appleCandidate.releaseDate,
        artwork: artworkHighRes,
        url: appleCandidate.collectionViewUrl || `https://music.apple.com/us/album/${appleCandidate.collectionId}`,
        copyright: appleCandidate.copyright,
        label: appleCandidate.label || album.label,
        genre: appleCandidate.primaryGenreName,
      },
      sampleIsrcMatches,
    };
  }
}

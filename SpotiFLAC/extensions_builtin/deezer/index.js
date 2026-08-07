var CONFIG = {
  resolverBaseURL: "https://api.zarz.moe",
  resolverDownloadPath: "/dl/dzr",
  deezerBaseURL: "https://www.deezer.com",
  apiBaseURL: "https://api.deezer.com",
  blowfishSecret: "g4el58wc0zvf9na1",
  blowfishIVHex: "0001020304050607",
  chunkSize: 2048,
  maxCollectionTracks: 200,
  maxArtistAlbums: 100,
  maxArtistTopTracks: 20
};

function initialize(settings) {
  settings = settings || {};
  var configuredBase = String(settings.apiBaseUrl || "").trim();
  if (configuredBase) {
    CONFIG.resolverBaseURL = configuredBase.replace(/\/+$/, "");
  }
  return true;
}

function cleanup() {
  return true;
}

function mergeHeaders(base, extra) {
  var merged = {};
  var key;
  base = base || {};
  extra = extra || {};

  for (key in base) {
    if (base.hasOwnProperty(key)) {
      merged[key] = base[key];
    }
  }
  for (key in extra) {
    if (extra.hasOwnProperty(key)) {
      merged[key] = extra[key];
    }
  }
  return merged;
}

function appUserAgent() {
  if (utils && typeof utils.appUserAgent === "function") {
    return String(utils.appUserAgent() || "").trim() || "SpotiFLAC-Mobile";
  }
  return "SpotiFLAC-Mobile";
}

function userAgentForURL(url) {
  var text = String(url || "").trim().toLowerCase();
  if (text.indexOf("https://api.zarz.moe") === 0 || text.indexOf("http://api.zarz.moe") === 0) {
    return appUserAgent();
  }
  return utils.randomUserAgent();
}

function getJSON(url, headers) {
  var response = http.get(url, headers || {});
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return JSON.parse(response.body);
}

function postJSON(url, body, headers) {
  var response = http.post(url, JSON.stringify(body), mergeHeaders({
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": userAgentForURL(url)
  }, headers));
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return JSON.parse(response.body);
}

function signedJSON(method, path, body, headers) {
  if (typeof session === "undefined" || !session || typeof session.signedFetch !== "function") {
    throw new Error("signed session runtime is not available");
  }
  var response = session.signedFetch(method, path, body || null, headers || {});
  if (!response || response.error || response.needsVerification) {
    var error = response && response.error ? response.error : "signed request failed";
    throw new Error(error);
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + path);
  }
  return JSON.parse(response.body || "{}");
}

function signedTicket(provider, type, id) {
  var resourceHash = utils.sha256(provider + ":" + (type || "track") + ":" + String(id || "").toLowerCase());
  var payload = signedJSON("POST", "/tickets", {
    capability: "download_ticket",
    provider: provider,
    resource_hash: resourceHash
  });
  var ticketID = String(payload.ticket_id || payload.ticket || "").trim();
  if (!ticketID) {
    throw new Error("signed ticket response missing ticket_id");
  }
  return ticketID;
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    var normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function ensureLeadingDot(ext) {
  ext = String(ext || "").trim();
  if (!ext) return "";
  return ext.charAt(0) === "." ? ext : "." + ext;
}

function ensureOutputExtension(outputPath, extension) {
  var normalizedExt = ensureLeadingDot(extension);
  if (!normalizedExt) return outputPath;

  var currentDot = outputPath.lastIndexOf(".");
  if (currentDot < 0) {
    return outputPath + normalizedExt;
  }
  if (outputPath.substring(currentDot).toLowerCase() === normalizedExt.toLowerCase()) {
    return outputPath;
  }
  return outputPath.substring(0, currentDot) + normalizedExt;
}

function buildEncryptedTempPath(outputPath) {
  var dotIndex = outputPath.lastIndexOf(".");
  if (dotIndex < 0) return outputPath + ".encrypted";
  return outputPath.substring(0, dotIndex) + ".encrypted" + outputPath.substring(dotIndex);
}

function hexByte(value) {
  var hex = (value & 0xff).toString(16);
  return hex.length === 1 ? "0" + hex : hex;
}

function generateBlowfishKeyHex(trackID) {
  var md5hex = utils.md5(String(trackID || "").trim());
  var out = "";
  for (var i = 0; i < 16; i++) {
    var value = md5hex.charCodeAt(i) ^ md5hex.charCodeAt(i + 16) ^ CONFIG.blowfishSecret.charCodeAt(i);
    out += hexByte(value);
  }
  return out;
}

function normalizedUserAgent() {
  return {
    "User-Agent": userAgentForURL(CONFIG.resolverBaseURL),
    "Accept": "application/json"
  };
}

function normalizeDate(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (text.length >= 10) return text.substring(0, 10);
  return text;
}

function withPrefix(id) {
  var raw = String(id || "").trim();
  if (!raw) return "";
  return raw.indexOf("deezer:") === 0 ? raw : "deezer:" + raw;
}

function stripPrefix(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  return raw.indexOf("deezer:") === 0 ? raw.substring("deezer:".length) : raw;
}

function parseNumericID(value, resourceType) {
  var raw = String(value || "").trim();
  if (!raw) return "";

  var direct = raw.match(/^\d+$/);
  if (direct) return direct[0];

  var prefixed = raw.match(/^deezer:(\d+)$/i);
  if (prefixed) return prefixed[1];

  var pattern = new RegExp(resourceType + "\\/(\\d+)", "i");
  var match = raw.match(pattern);
  if (match) return match[1];

  return "";
}

function parseTrackID(value) {
  return parseNumericID(value, "track");
}

function parseAlbumID(value) {
  return parseNumericID(value, "album");
}

function parseArtistID(value) {
  return parseNumericID(value, "artist");
}

function parsePlaylistID(value) {
  return parseNumericID(value, "playlist");
}

function normalizeArtists(trackData) {
  if (!trackData) return "";

  if (trackData.contributors && trackData.contributors.length) {
    var names = [];
    var seen = {};
    for (var i = 0; i < trackData.contributors.length; i++) {
      var contributor = trackData.contributors[i];
      var name = contributor && contributor.name ? String(contributor.name).trim() : "";
      if (!name || seen[name]) continue;
      seen[name] = true;
      names.push(name);
    }
    if (names.length) {
      return names.join(", ");
    }
  }

  if (trackData.artist && trackData.artist.name) {
    return String(trackData.artist.name);
  }

  return "";
}

function coverFromAlbum(album) {
  if (!album) return "";
  return String(
    album.cover_xl ||
    album.cover_big ||
    album.cover_medium ||
    album.cover ||
    album.picture_xl ||
    album.picture_big ||
    album.picture_medium ||
    album.picture ||
    ""
  );
}

function coverFromArtist(artist) {
  if (!artist) return "";
  return String(
    artist.picture_xl ||
    artist.picture_big ||
    artist.picture_medium ||
    artist.picture ||
    artist.cover_xl ||
    artist.cover_big ||
    artist.cover_medium ||
    artist.cover ||
    ""
  );
}

function albumTypeFromRecordType(value) {
  var normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "album";
  switch (normalized) {
    case "ep":
    case "single":
    case "compilation":
    case "album":
      return normalized;
    default:
      return "album";
  }
}

function deezerGet(pathOrURL) {
  var url = String(pathOrURL || "").trim();
  if (!url) {
    throw new Error("missing Deezer API URL");
  }

  if (!/^https?:\/\//i.test(url)) {
    if (url.charAt(0) !== "/") {
      url = "/" + url;
    }
    url = CONFIG.apiBaseURL + url;
  }

  return getJSON(url, normalizedUserAgent());
}

function collectPaginatedItems(container, limit) {
  var items = [];
  var nextURL = "";
  var source = container;
  var remaining = typeof limit === "number" && limit > 0 ? limit : 0;

  while (source) {
    var pageItems = source.data || [];
    for (var i = 0; i < pageItems.length; i++) {
      items.push(pageItems[i]);
      if (remaining > 0 && items.length >= remaining) {
        return items;
      }
    }

    nextURL = source.next || "";
    if (!nextURL) break;
    source = deezerGet(nextURL);
  }

  return items;
}

function fetchTrackData(trackID) {
  return deezerGet("/track/" + encodeURIComponent(trackID));
}

function fetchAlbumData(albumID) {
  return deezerGet("/album/" + encodeURIComponent(albumID));
}

function fetchArtistData(artistID) {
  return deezerGet("/artist/" + encodeURIComponent(artistID));
}

function fetchPlaylistData(playlistID) {
  return deezerGet("/playlist/" + encodeURIComponent(playlistID));
}

function fetchArtistAlbums(artistID) {
  var result = deezerGet("/artist/" + encodeURIComponent(artistID) + "/albums?limit=100");
  return collectPaginatedItems(result, CONFIG.maxArtistAlbums);
}

function fetchArtistTopTracks(artistID) {
  var result = deezerGet("/artist/" + encodeURIComponent(artistID) + "/top?limit=" + CONFIG.maxArtistTopTracks);
  return collectPaginatedItems(result, CONFIG.maxArtistTopTracks);
}

function fetchCollectionTracks(container) {
  return collectPaginatedItems(container, CONFIG.maxCollectionTracks);
}

function formatTrack(trackData, context) {
  if (!trackData || !trackData.id) return null;
  context = context || {};

  var albumData = context.album || trackData.album || null;
  var artistData = context.artist || trackData.artist || null;
  var artistName = normalizeArtists(trackData);
  if (!artistName && context.albumArtist) {
    artistName = context.albumArtist;
  }
  if (!artistName && artistData && artistData.name) {
    artistName = String(artistData.name);
  }

  var albumName = context.albumName || (albumData && albumData.title) || "";
  var albumArtist = context.albumArtist || (albumData && albumData.artist && albumData.artist.name) || (artistData && artistData.name) || artistName;
  var coverURL = context.coverURL || coverFromAlbum(albumData) || coverFromArtist(artistData);
  var releaseDate = context.releaseDate || trackData.release_date || (albumData && albumData.release_date) || "";
  var totalTracks = context.totalTracks || (albumData && albumData.nb_tracks) || 0;
  var itemID = withPrefix(trackData.id);
  var albumID = context.albumID || (albumData && albumData.id ? withPrefix(albumData.id) : "");
  var artistID = context.artistID || (artistData && artistData.id ? withPrefix(artistData.id) : "");

  return {
    id: itemID,
    spotify_id: itemID,
    deezer_id: String(trackData.id),
    name: String(trackData.title || trackData.title_short || ""),
    artists: artistName,
    album_name: String(albumName),
    album_artist: String(albumArtist || ""),
    artist_id: artistID,
    album_id: albumID,
    duration_ms: Number(trackData.duration || 0) * 1000,
    preview_url: String(trackData.preview || ""),
    cover_url: coverURL,
    images: coverURL,
    release_date: normalizeDate(releaseDate),
    track_number: Number(trackData.track_position || context.trackNumber || 0),
    total_tracks: Number(totalTracks || 0),
    disc_number: Number(trackData.disk_number || context.discNumber || 0),
    total_discs: Number(context.totalDiscs || 0),
    isrc: String(trackData.isrc || ""),
    provider_id: "deezer",
    item_type: "track",
    album_type: albumTypeFromRecordType(context.albumType || (albumData && albumData.record_type)),
    label: String((albumData && albumData.label) || ""),
    copyright: String((albumData && albumData.copyright) || ""),
    genre: String(context.genre || ""),
    composer: String(trackData.composer || ""),
    audio_quality: "16bit/44.1kHz"
  };
}

function formatAlbum(albumData) {
  if (!albumData || !albumData.id) return null;

  var coverURL = coverFromAlbum(albumData);
  return {
    id: withPrefix(albumData.id),
    name: String(albumData.title || ""),
    artists: String((albumData.artist && albumData.artist.name) || ""),
    artist_id: albumData.artist && albumData.artist.id ? withPrefix(albumData.artist.id) : "",
    cover_url: coverURL,
    images: coverURL,
    release_date: normalizeDate(albumData.release_date),
    total_tracks: Number(albumData.nb_tracks || 0),
    album_type: albumTypeFromRecordType(albumData.record_type),
    provider_id: "deezer",
    item_type: "album",
    label: String(albumData.label || ""),
    copyright: String(albumData.copyright || ""),
    audio_traits: ["lossless"]
  };
}

function formatArtist(artistData) {
  if (!artistData || !artistData.id) return null;

  var imageURL = coverFromArtist(artistData);
  return {
    id: withPrefix(artistData.id),
    name: String(artistData.name || ""),
    image_url: imageURL,
    images: imageURL,
    header_image: imageURL,
    listeners: Number(artistData.nb_fan || 0),
    provider_id: "deezer",
    item_type: "artist"
  };
}

function formatPlaylist(playlistData) {
  if (!playlistData || !playlistData.id) return null;

  var coverURL = String(
    playlistData.picture_xl ||
    playlistData.picture_big ||
    playlistData.picture_medium ||
    playlistData.picture ||
    ""
  );

  return {
    id: withPrefix(playlistData.id),
    name: String(playlistData.title || ""),
    owner: String((playlistData.creator && playlistData.creator.name) || ""),
    cover_url: coverURL,
    images: coverURL,
    total_tracks: Number(playlistData.nb_tracks || 0),
    provider_id: "deezer",
    item_type: "playlist"
  };
}

function extractPrimaryGenre(albumData) {
  if (!albumData || !albumData.genres || !albumData.genres.data || !albumData.genres.data.length) {
    return "";
  }
  var first = albumData.genres.data[0];
  return first && first.name ? String(first.name) : "";
}

function fetchTrack(trackID) {
  var rawID = parseTrackID(trackID);
  if (!rawID) throw new Error("invalid Deezer track ID");
  var trackData = fetchTrackData(rawID);
  var albumData = null;

  if (trackData && trackData.album && trackData.album.id) {
    try {
      albumData = fetchAlbumData(trackData.album.id);
    } catch (e) {
      log.debug("[DeezerExt] Album fetch for track failed:", e.message);
    }
  }

  var formatted = formatTrack(trackData, {
    album: albumData || trackData.album,
    albumName: albumData && albumData.title ? albumData.title : trackData.album && trackData.album.title,
    albumArtist: albumData && albumData.artist && albumData.artist.name ? albumData.artist.name : trackData.artist && trackData.artist.name,
    albumID: albumData && albumData.id ? withPrefix(albumData.id) : trackData.album && trackData.album.id ? withPrefix(trackData.album.id) : "",
    artistID: trackData.artist && trackData.artist.id ? withPrefix(trackData.artist.id) : "",
    releaseDate: albumData && albumData.release_date ? albumData.release_date : trackData.release_date,
    totalTracks: albumData && albumData.nb_tracks ? albumData.nb_tracks : 0,
    totalDiscs: albumData && albumData.nb_disk ? albumData.nb_disk : 0,
    albumType: albumData && albumData.record_type ? albumData.record_type : "",
    coverURL: albumData ? coverFromAlbum(albumData) : coverFromAlbum(trackData.album),
    genre: extractPrimaryGenre(albumData)
  });

  return {
    track: formatted,
    album: albumData ? formatAlbum(albumData) : null
  };
}

function fetchAlbum(albumID) {
  var rawID = parseAlbumID(albumID);
  if (!rawID) throw new Error("invalid Deezer album ID");
  var albumData = fetchAlbumData(rawID);
  var info = formatAlbum(albumData);
  var genre = extractPrimaryGenre(albumData);
  var trackItems = fetchCollectionTracks(albumData.tracks || {});
  var tracks = [];

  for (var i = 0; i < trackItems.length; i++) {
    var formatted = formatTrack(trackItems[i], {
      album: albumData,
      albumName: albumData.title,
      albumArtist: albumData.artist && albumData.artist.name ? albumData.artist.name : "",
      albumID: info.id,
      artistID: trackItems[i].artist && trackItems[i].artist.id ? withPrefix(trackItems[i].artist.id) : info.artist_id,
      releaseDate: albumData.release_date,
      totalTracks: albumData.nb_tracks,
      totalDiscs: albumData.nb_disk,
      albumType: albumData.record_type,
      coverURL: info.cover_url,
      genre: genre
    });
    if (formatted) tracks.push(formatted);
  }

  info.tracks = tracks;
  return info;
}

function fetchArtist(artistID) {
  var rawID = parseArtistID(artistID);
  if (!rawID) throw new Error("invalid Deezer artist ID");

  var artistData = fetchArtistData(rawID);
  var artistInfo = formatArtist(artistData);
  var albumItems = fetchArtistAlbums(rawID);
  var topTrackItems = fetchArtistTopTracks(rawID);
  var albums = [];
  var topTracks = [];

  for (var i = 0; i < albumItems.length; i++) {
    var albumInfo = formatAlbum(albumItems[i]);
    if (albumInfo) albums.push(albumInfo);
  }

  for (var j = 0; j < topTrackItems.length; j++) {
    var trackInfo = formatTrack(topTrackItems[j], {
      artist: artistData,
      artistID: artistInfo.id,
      coverURL: coverFromAlbum(topTrackItems[j].album),
      albumID: topTrackItems[j].album && topTrackItems[j].album.id ? withPrefix(topTrackItems[j].album.id) : "",
      albumName: topTrackItems[j].album && topTrackItems[j].album.title ? topTrackItems[j].album.title : "",
      albumArtist: artistInfo.name
    });
    if (trackInfo) topTracks.push(trackInfo);
  }

  artistInfo.albums = albums;
  artistInfo.top_tracks = topTracks;
  return artistInfo;
}

function fetchPlaylist(playlistID) {
  var rawID = parsePlaylistID(playlistID);
  if (!rawID) throw new Error("invalid Deezer playlist ID");

  var playlistData = fetchPlaylistData(rawID);
  var playlistInfo = formatPlaylist(playlistData);
  var trackItems = fetchCollectionTracks(playlistData.tracks || {});
  var tracks = [];

  for (var i = 0; i < trackItems.length; i++) {
    var formatted = formatTrack(trackItems[i], {
      album: trackItems[i].album,
      albumName: trackItems[i].album && trackItems[i].album.title ? trackItems[i].album.title : "",
      albumArtist: trackItems[i].artist && trackItems[i].artist.name ? trackItems[i].artist.name : "",
      albumID: trackItems[i].album && trackItems[i].album.id ? withPrefix(trackItems[i].album.id) : "",
      artistID: trackItems[i].artist && trackItems[i].artist.id ? withPrefix(trackItems[i].artist.id) : "",
      coverURL: coverFromAlbum(trackItems[i].album) || playlistInfo.cover_url,
      trackNumber: i + 1
    });
    if (formatted) tracks.push(formatted);
  }

  playlistInfo.tracks = tracks;
  return playlistInfo;
}

function resolveURLTarget(url) {
  var resolved = String(url || "").trim();
  if (!resolved) return "";

  if (resolved.indexOf("deezer.page.link") === -1 && resolved.indexOf("link.deezer.com") === -1) {
    return resolved;
  }

  try {
    var response = http.get(resolved, {
      "User-Agent": userAgentForURL(resolved),
      "Accept-Encoding": "identity"
    });

    if (response && response.url && response.url.indexOf("deezer.") !== -1 && response.url.indexOf("page.link") === -1) {
      return response.url;
    }

    if (response && response.headers) {
      var location = response.headers.Location || response.headers.location;
      if (location && String(location).indexOf("deezer.") !== -1) {
        return String(location);
      }
    }

    if (response && response.body) {
      var body = response.body;
      var canonicalMatch = body.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
      if (!canonicalMatch) {
        canonicalMatch = body.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
      }
      if (canonicalMatch && canonicalMatch[1]) {
        return canonicalMatch[1];
      }
    }
  } catch (e) {
    log.debug("[DeezerExt] URL resolve failed:", e.message);
  }

  return resolved;
}

function parseURL(url) {
  var resolved = resolveURLTarget(url);
  var trackID = parseTrackID(resolved);
  if (trackID) return { type: "track", id: trackID };

  var albumID = parseAlbumID(resolved);
  if (albumID) return { type: "album", id: albumID };

  var artistID = parseArtistID(resolved);
  if (artistID) return { type: "artist", id: artistID };

  var playlistID = parsePlaylistID(resolved);
  if (playlistID) return { type: "playlist", id: playlistID };

  return null;
}

function handleURL(url) {
  try {
    var parsed = parseURL(url);
    if (!parsed) {
      return {
        success: false,
        error: "Unsupported Deezer URL"
      };
    }

    switch (parsed.type) {
      case "track":
        var trackResult = fetchTrack(parsed.id);
        return {
          type: "track",
          track: trackResult.track
        };
      case "album":
        var albumResult = fetchAlbum(parsed.id);
        return {
          type: "album",
          name: albumResult.name,
          cover_url: albumResult.cover_url,
          album: albumResult,
          tracks: albumResult.tracks
        };
      case "artist":
        return {
          type: "artist",
          artist: fetchArtist(parsed.id)
        };
      case "playlist":
        var playlistResult = fetchPlaylist(parsed.id);
        return {
          type: "playlist",
          name: playlistResult.name,
          cover_url: playlistResult.cover_url,
          tracks: playlistResult.tracks
        };
      default:
        return {
          success: false,
          error: "Unsupported Deezer URL type"
        };
    }
  } catch (e) {
    log.error("[DeezerExt] handleURL failed:", e.message);
    return {
      success: false,
      error: e.message || "Failed to fetch Deezer URL metadata"
    };
  }
}

function searchEndpointForFilter(filter) {
  switch (String(filter || "").trim().toLowerCase()) {
    case "track":
      return { path: "/search", type: "track" };
    case "album":
      return { path: "/search/album", type: "album" };
    case "artist":
      return { path: "/search/artist", type: "artist" };
    case "playlist":
      return { path: "/search/playlist", type: "playlist" };
    default:
      return null;
  }
}

function formatSearchItem(item, itemType) {
  switch (itemType) {
    case "track":
      return formatTrack(item, {
        album: item.album,
        albumName: item.album && item.album.title ? item.album.title : "",
        albumID: item.album && item.album.id ? withPrefix(item.album.id) : "",
        artistID: item.artist && item.artist.id ? withPrefix(item.artist.id) : "",
        coverURL: coverFromAlbum(item.album)
      });
    case "album":
      return formatAlbum(item);
    case "artist":
      return formatArtist(item);
    case "playlist":
      return formatPlaylist(item);
    default:
      return null;
  }
}

function searchOne(query, filter, limit) {
  var endpoint = searchEndpointForFilter(filter);
  if (!endpoint) return [];

  var data = deezerGet(endpoint.path + "?q=" + encodeURIComponent(query) + "&limit=" + encodeURIComponent(limit));
  var items = data && data.data ? data.data : [];
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var formatted = formatSearchItem(items[i], endpoint.type);
    if (formatted) results.push(formatted);
  }

  return results;
}

function customSearch(query, options) {
  query = String(query || "").trim();
  if (!query) return [];

  options = options || {};
  var limit = Number(options.limit || 20);
  if (!limit || limit <= 0) limit = 20;
  if (limit > 50) limit = 50;

  var filter = String(options.filter || "").trim().toLowerCase();
  if (!filter || filter === "all") {
    filter = "";
  }

  if (filter) {
    return searchOne(query, filter, limit);
  }

  var results = [];
  var trackResults = searchOne(query, "track", limit);
  var artistResults = searchOne(query, "artist", 5);
  var albumResults = searchOne(query, "album", 5);
  var playlistResults = searchOne(query, "playlist", 5);

  results = results.concat(trackResults, artistResults, albumResults, playlistResults);
  return results;
}

function getTrack(trackID) {
  try {
    return fetchTrack(trackID).track;
  } catch (e) {
    log.error("[DeezerExt] getTrack failed:", e.message);
    return null;
  }
}

function getAlbum(albumID) {
  try {
    return fetchAlbum(albumID);
  } catch (e) {
    log.error("[DeezerExt] getAlbum failed:", e.message);
    return null;
  }
}

function getArtist(artistID) {
  try {
    return fetchArtist(artistID);
  } catch (e) {
    log.error("[DeezerExt] getArtist failed:", e.message);
    return null;
  }
}

function getPlaylist(playlistID) {
  try {
    return fetchPlaylist(playlistID);
  } catch (e) {
    log.error("[DeezerExt] getPlaylist failed:", e.message);
    return null;
  }
}

function resolveTrackIDFromISRC(isrc) {
  if (!isrc) return "";
  try {
    var track = deezerGet("/track/isrc:" + encodeURIComponent(isrc));
    return track && track.id ? String(track.id) : "";
  } catch (e) {
    log.debug("[DeezerExt] ISRC resolve failed:", e.message);
    return "";
  }
}

function findBestSearchMatch(tracks, trackName, artistName) {
  if (!tracks || !tracks.length) return null;

  var normalizedTrack = matching.normalizeString(trackName || "");
  var normalizedArtist = matching.normalizeString(artistName || "");
  var best = null;
  var bestScore = 0;

  for (var i = 0; i < tracks.length; i++) {
    var track = tracks[i];
    if (!track || !track.id) continue;

    var score = 0;
    var title = track.title || "";
    var artist = track.artist && track.artist.name ? track.artist.name : "";

    if (normalizedTrack) {
      score += matching.compareStrings(normalizedTrack, matching.normalizeString(title)) * 70;
    }
    if (normalizedArtist) {
      score += matching.compareStrings(normalizedArtist, matching.normalizeString(artist)) * 30;
    }

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (bestScore < 55) return null;
  return best;
}

function resolveTrackIDBySearch(trackName, artistName) {
  var query = String(trackName || "").trim();
  if (artistName) {
    query += " " + String(artistName).trim();
  }
  query = query.trim();
  if (!query) return "";

  try {
    var data = deezerGet("/search?q=" + encodeURIComponent(query) + "&limit=10");
    var best = findBestSearchMatch(data && data.data ? data.data : [], trackName, artistName);
    return best && best.id ? String(best.id) : "";
  } catch (e) {
    log.debug("[DeezerExt] search resolve failed:", e.message);
    return "";
  }
}

function resolveTrackID(isrc, trackName, artistName, options) {
  options = options || {};

  var deezerID = parseTrackID(options.deezer_id || options.track_id || options.url || "");
  if (deezerID) return deezerID;

  if (isrc) {
    deezerID = resolveTrackIDFromISRC(isrc);
    if (deezerID) return deezerID;
  }

  return resolveTrackIDBySearch(trackName, artistName);
}

function checkAvailability(isrc, trackName, artistName, options) {
  var trackID = resolveTrackID(isrc, trackName, artistName, options || {});
  if (!trackID) {
    return {
      available: false,
      reason: "No Deezer track match found"
    };
  }

  return {
    available: true,
    track_id: trackID
  };
}

function resolveDownloadDescriptor(trackID) {
  var trackURL = CONFIG.deezerBaseURL + "/track/" + encodeURIComponent(trackID);
  var ticketID = signedTicket("dzr", "track", trackURL);
  return signedJSON("POST", CONFIG.resolverDownloadPath, {
    id: String(trackID || ""),
    type: "track",
    platform: "deezer",
    url: trackURL
  }, {
    "X-Zarz-Ticket": ticketID
  });
}

function resolveDescriptorDownloadURL(descriptor) {
  if (!descriptor) return "";

  var isDirectDownloadable = parseBoolean(descriptor.direct_downloadable, null);
  if (isDirectDownloadable === true && descriptor.direct_download_url) {
    return String(descriptor.direct_download_url);
  }

  if (descriptor.download_url) {
    return String(descriptor.download_url);
  }

  if (descriptor.direct_download_url) {
    return String(descriptor.direct_download_url);
  }

  return "";
}

function descriptorRequiresClientDecryption(descriptor) {
  if (!descriptor) return false;

  var explicit = parseBoolean(descriptor.requires_client_decryption, null);
  if (explicit !== null) {
    return explicit;
  }

  var directDownloadable = parseBoolean(descriptor.direct_downloadable, null);
  if (directDownloadable !== null) {
    return !directDownloadable;
  }

  return parseBoolean(descriptor.deezer_encrypted, false);
}

function writeChunk(outputPath, dataB64, firstChunk) {
  var writeResult = file.writeBytes(outputPath, dataB64, {
    encoding: "base64",
    truncate: firstChunk,
    append: !firstChunk
  });
  if (!writeResult || !writeResult.success) {
    throw new Error(writeResult && writeResult.error ? writeResult.error : "failed to write chunk");
  }
  return writeResult.path || outputPath;
}

function decryptDownloadedFile(encryptedPath, outputPath, trackID, onProgress) {
  var keyHex = generateBlowfishKeyHex(trackID);
  var sizeResult = file.getSize(encryptedPath);
  if (!sizeResult || !sizeResult.success) {
    throw new Error(sizeResult && sizeResult.error ? sizeResult.error : "failed to stat encrypted file");
  }

  var totalSize = Number(sizeResult.size || 0);
  var processed = 0;
  var chunkIndex = 0;
  var resolvedOutputPath = outputPath;

  while (processed < totalSize) {
    var readResult = file.readBytes(encryptedPath, {
      offset: processed,
      length: CONFIG.chunkSize,
      encoding: "base64"
    });
    if (!readResult || !readResult.success) {
      throw new Error(readResult && readResult.error ? readResult.error : "failed to read encrypted chunk");
    }

    var bytesRead = Number(readResult.bytes_read || 0);
    if (bytesRead <= 0) break;

    var chunkB64 = readResult.data || "";
    if (bytesRead === CONFIG.chunkSize && chunkIndex % 3 === 0) {
      var decryptResult = utils.decryptBlockCipher(chunkB64, {
        algorithm: "blowfish",
        mode: "cbc",
        key: keyHex,
        keyEncoding: "hex",
        iv: CONFIG.blowfishIVHex,
        ivEncoding: "hex",
        inputEncoding: "base64",
        outputEncoding: "base64",
        padding: "none"
      });
      if (!decryptResult || !decryptResult.success) {
        throw new Error(decryptResult && decryptResult.error ? decryptResult.error : "failed to decrypt chunk");
      }
      chunkB64 = decryptResult.data || "";
    }

    resolvedOutputPath = writeChunk(outputPath, chunkB64, processed === 0);

    processed += bytesRead;
    chunkIndex++;

    if (typeof onProgress === "function" && totalSize > 0) {
      var percent = 35 + Math.floor((processed / totalSize) * 65);
      if (percent > 100) percent = 100;
      onProgress(percent);
    }

    if (readResult.eof) break;
  }

  return resolvedOutputPath;
}

function download(trackID, quality, outputPath, onProgress) {
  var resolvedTrackID = parseTrackID(trackID);
  if (!resolvedTrackID) {
    return {
      success: false,
      error_message: "Invalid Deezer track ID",
      error_type: "invalid_track"
    };
  }

  var metadata = null;
  var albumData = null;
  try {
    metadata = fetchTrackData(resolvedTrackID);
    if (metadata && metadata.album && metadata.album.id) {
      try {
        albumData = fetchAlbumData(metadata.album.id);
      } catch (albumErr) {
        log.debug("[DeezerExt] Album fetch during download failed:", albumErr.message);
      }
    }
  } catch (e) {
    log.debug("[DeezerExt] Track metadata fetch failed:", e.message);
  }

  var descriptor;
  try {
    descriptor = resolveDownloadDescriptor(resolvedTrackID);
  } catch (e2) {
    var resolveError = e2 && e2.message ? e2.message : String(e2);
    return {
      success: false,
      error_message: "Failed to resolve Deezer download: " + resolveError,
      error_type: resolveError.indexOf("VERIFY_REQUIRED") >= 0 ? "verification_required" : "api_error"
    };
  }

  var downloadURL = resolveDescriptorDownloadURL(descriptor);
  if (!descriptor || descriptor.success !== true || !downloadURL) {
    return {
      success: false,
      error_message: descriptor && descriptor.message ? descriptor.message : "Resolver did not return a download URL",
      error_type: "api_error"
    };
  }

  var requiresClientDecryption = descriptorRequiresClientDecryption(descriptor);
  var normalizedOutputPath = ensureOutputExtension(outputPath, (descriptor.deezer_format || "flac").toLowerCase());
  var encryptedPath = requiresClientDecryption ? buildEncryptedTempPath(normalizedOutputPath) : normalizedOutputPath;

  if (typeof onProgress === "function") {
    onProgress(5);
  }

  var downloadResult = file.download(downloadURL, encryptedPath, {
    headers: {
      "User-Agent": userAgentForURL(downloadURL)
    }
  });
  if (!downloadResult || !downloadResult.success) {
    return {
      success: false,
      error_message: "Failed to download Deezer stream: " + (downloadResult && downloadResult.error ? downloadResult.error : "unknown error"),
      error_type: "download_error"
    };
  }

  var actualOutputPath = downloadResult.path || normalizedOutputPath;

  try {
    if (requiresClientDecryption) {
      var encryptedLocalPath = downloadResult.path || encryptedPath;
      actualOutputPath = decryptDownloadedFile(encryptedLocalPath, normalizedOutputPath, resolvedTrackID, onProgress);
      file.delete(encryptedLocalPath);
    }
  } catch (e3) {
    try { file.delete(downloadResult.path || encryptedPath); } catch (_) {}
    try { file.delete(actualOutputPath); } catch (_) {}
    return {
      success: false,
      error_message: "Failed to decrypt Deezer stream: " + e3.message,
      error_type: "decrypt_error"
    };
  }

  if (typeof onProgress === "function") {
    onProgress(100);
  }

  return {
    success: true,
    file_path: actualOutputPath,
    title: metadata && metadata.title ? metadata.title : (descriptor.title || ""),
    artist: metadata ? normalizeArtists(metadata) : (descriptor.artist || ""),
    album: albumData && albumData.title ? albumData.title : "",
    album_artist: albumData && albumData.artist && albumData.artist.name ? albumData.artist.name : "",
    track_number: metadata && metadata.track_position ? metadata.track_position : 0,
    disc_number: metadata && metadata.disk_number ? metadata.disk_number : 0,
    release_date: albumData && albumData.release_date ? albumData.release_date : (metadata && metadata.release_date ? metadata.release_date : ""),
    cover_url: albumData ? coverFromAlbum(albumData) : (metadata && metadata.album ? coverFromAlbum(metadata.album) : ""),
    isrc: metadata && metadata.isrc ? metadata.isrc : "",
    bit_depth: 16,
    sample_rate: 44100
  };
}

function searchTracks(query, limit) {
  return customSearch(query, {
    limit: limit || 20,
    filter: "track"
  });
}

function completeGrant() {
  if (typeof session === "undefined" || !session || typeof session.completeGrant !== "function") {
    return { success: false, error: "signed session runtime is not available" };
  }
  return session.completeGrant();
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  completeGrant: completeGrant,
  customSearch: customSearch,
  handleUrl: handleURL,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getArtist: getArtist,
  getPlaylist: getPlaylist,
  searchTracks: searchTracks,
  checkAvailability: checkAvailability,
  download: download,
  getDownloadUrl: function () { return null; }
});

log.info("[DeezerExt] Deezer metadata and download extension loaded");

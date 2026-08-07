var CONFIG = {
  apiBaseURL: "https://tidal.com/v1",
  resourceBaseURL: "https://resources.tidal.com",
  downloadAPIURL: "/dl/tid",
  publicToken: "49YxDN9a2aFV6RTG",
  countryCode: "US",
  locale: "en_US",
  deviceType: "BROWSER",
  mirrorBaseURLs: [],
  maxArtistAlbums: 100,
  maxPlaylistTracks: 500,
  pageSize: 50
};

function initialize(settings) {
  settings = settings || {};
  var publicToken = String(settings.publicToken || "").trim();
  if (publicToken) {
    CONFIG.publicToken = publicToken;
  }

  var downloadAPIURL = normalizeMirrorBaseURL(settings.downloadApiUrl);
  if (downloadAPIURL.indexOf("https://api.zarz.moe/") === 0) {
    downloadAPIURL = CONFIG.downloadAPIURL;
  }
  if (downloadAPIURL) {
    CONFIG.downloadAPIURL = downloadAPIURL;
  }

  var countryCode = String(settings.countryCode || "").trim().toUpperCase();
  if (countryCode) {
    CONFIG.countryCode = countryCode;
  }

  var locale = String(settings.locale || "").trim();
  if (locale) {
    CONFIG.locale = locale;
  }

  var deviceType = String(settings.deviceType || "").trim().toUpperCase();
  if (deviceType) {
    CONFIG.deviceType = deviceType;
  }

  return true;
}

function cleanup() {
  return true;
}

function parseMirrorBaseURLs(value) {
  var text = String(value || "").trim();
  if (!text) return [];

  var rawParts = text.split(/[\r\n,]+/);
  var results = [];
  var seen = {};
  for (var i = 0; i < rawParts.length; i++) {
    var normalized = normalizeMirrorBaseURL(rawParts[i]);
    if (!normalized || seen[normalized]) continue;
    seen[normalized] = true;
    results.push(normalized);
  }
  return results;
}

function normalizeMirrorBaseURL(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (text.indexOf("http://") === 0) {
    text = "https://" + text.substring("http://".length);
  }
  return text.replace(/\/+$/, "");
}

function appUserAgent() {
  if (utils && typeof utils.appUserAgent === "function") {
    return String(utils.appUserAgent() || "").trim() || "SpotiFLAC-Mobile";
  }
  return "SpotiFLAC-Mobile";
}

function requestUserAgent() {
  if (utils && typeof utils.randomUserAgent === "function") {
    return String(utils.randomUserAgent() || "").trim() || appUserAgent();
  }
  return appUserAgent();
}

function downloadAPIUserAgent() {
  var ua = appUserAgent();
  if (ua.indexOf("/") > 0) {
    return ua;
  }

  var version = "";
  if (utils && typeof utils.appVersion === "function") {
    version = String(utils.appVersion() || "").trim();
  }
  return "SpotiFLAC-Mobile/" + (version || "1.0");
}

function firstNonEmpty() {
  for (var i = 0; i < arguments.length; i++) {
    var value = String(arguments[i] || "").trim();
    if (value) return value;
  }
  return "";
}

function ensureHTTPS(url) {
  var text = String(url || "").trim();
  if (!text) return "";
  if (text.indexOf("http://") === 0) {
    return "https://" + text.substring("http://".length);
  }
  return text;
}

function withPrefix(id) {
  var raw = String(id || "").trim();
  if (!raw) return "";
  return raw.indexOf("tidal:") === 0 ? raw : "tidal:" + raw;
}

function stripPrefix(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  return raw.indexOf("tidal:") === 0 ? raw.substring("tidal:".length) : raw;
}

function normalizeDate(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (text.length >= 10) return text.substring(0, 10);
  return text;
}

function imageURL(imageID, size) {
  var normalizedID = String(imageID || "").trim();
  var normalizedSize = String(size || "").trim();
  if (!normalizedID || !normalizedSize) return "";
  return CONFIG.resourceBaseURL + "/images/" + normalizedID.replace(/-/g, "/") + "/" + normalizedSize + ".jpg";
}

function joinArtistNames(artists) {
  if (!artists || !artists.length) return "";

  var names = [];
  for (var i = 0; i < artists.length; i++) {
    var artist = artists[i] || {};
    var name = String(artist.name || "").trim();
    if (!name) continue;
    names.push(name);
  }
  return names.join(", ");
}

function albumArtistNames(track) {
  if (!track) return "";

  var artists = track.artists || [];
  var names = [];
  for (var i = 0; i < artists.length; i++) {
    var artist = artists[i] || {};
    if (String(artist.type || "").toUpperCase() !== "MAIN") continue;
    var name = String(artist.name || "").trim();
    if (!name) continue;
    names.push(name);
  }
  if (names.length) return names.join(", ");
  return String(track.artist && track.artist.name || "").trim();
}

function requestHeaders() {
  return {
    "Accept": "application/json",
    "User-Agent": requestUserAgent(),
    "x-tidal-token": CONFIG.publicToken
  };
}

function mergeHeaders(base, extra) {
  var merged = {};
  var key;
  base = base || {};
  extra = extra || {};

  for (key in base) {
    if (!base.hasOwnProperty(key)) continue;
    merged[key] = base[key];
  }
  for (key in extra) {
    if (!extra.hasOwnProperty(key)) continue;
    merged[key] = extra[key];
  }
  return merged;
}

function buildMetadataURL(path, extraQuery) {
  var normalizedPath = String(path || "").trim().replace(/^\/+/, "");
  var query = [];
  extraQuery = extraQuery || {};

  query.push("countryCode=" + encodeURIComponent(CONFIG.countryCode));
  query.push("locale=" + encodeURIComponent(CONFIG.locale));
  query.push("deviceType=" + encodeURIComponent(CONFIG.deviceType));

  for (var key in extraQuery) {
    if (!extraQuery.hasOwnProperty(key)) continue;
    var value = extraQuery[key];
    if (value === null || value === undefined || value === "") continue;
    query.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }

  if (!query.length) {
    return CONFIG.apiBaseURL + "/" + normalizedPath;
  }

  var separator = "?";
  if (normalizedPath.indexOf("?") !== -1) {
    separator = /[?&]$/.test(normalizedPath) ? "" : "&";
  }

  return CONFIG.apiBaseURL + "/" + normalizedPath + separator + query.join("&");
}

function getJSON(url) {
  var response = http.get(url, requestHeaders());
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return JSON.parse(response.body);
}

function postJSON(url, body, headers) {
  var response = http.post(
    url,
    JSON.stringify(body || {}),
    mergeHeaders(
      {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": requestUserAgent()
      },
      headers
    )
  );
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    var preview = String(response.body || "").replace(/\s+/g, " ").trim();
    if (preview.length > 160) {
      preview = preview.substring(0, 160) + "...";
    }
    throw new Error(
      "HTTP " + response.statusCode + " for " + url +
        (preview ? " | " + preview : "")
    );
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

function isVerificationRequiredError(error) {
  var message = String(error && error.message || error || "");
  return message.indexOf("VERIFY_REQUIRED") >= 0 || message.indexOf("verification_required") >= 0;
}

function fetchText(url, headers) {
  var response = http.get(
    url,
    mergeHeaders(
      {
        "Accept": "application/dash+xml,text/xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": requestUserAgent()
      },
      headers
    )
  );
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return String(response.body || "");
}

function parseNumericID(value, resourceType) {
  var raw = String(value || "").trim();
  if (!raw) return "";

  var direct = raw.match(/^\d+$/);
  if (direct) return direct[0];

  var prefixed = raw.match(/^tidal:(\d+)$/i);
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
  var raw = String(value || "").trim();
  if (!raw) return "";

  var direct = raw.match(/^[0-9a-f-]{36}$/i);
  if (direct) return direct[0];

  var pattern = raw.match(/playlist\/([0-9a-f-]{36})/i);
  if (pattern) return pattern[1];

  return "";
}

function parseURL(url) {
  var text = String(url || "").trim();
  if (!text) return null;

  var prefixed = text.match(/^tidal:(track|album|artist|playlist):([^?#/]+)$/i);
  if (prefixed) {
    return { type: prefixed[1].toLowerCase(), id: prefixed[2] };
  }

  var deepLink = text.match(/^tidal:\/\/\/?(track|album|artist|playlist)\/([^?#/]+)$/i);
  if (deepLink) {
    return { type: deepLink[1].toLowerCase(), id: deepLink[2] };
  }

  var normalized = text;
  if (normalized.indexOf("http://") !== 0 && normalized.indexOf("https://") !== 0) {
    normalized = "https://" + normalized;
  }

  var hostMatch = normalized.match(/^https?:\/\/([^\/?#]+)/i);
  if (!hostMatch) return null;
  var host = String(hostMatch[1] || "").toLowerCase();
  if (host !== "tidal.com" && host !== "www.tidal.com" && host !== "listen.tidal.com") {
    return null;
  }

  var pathMatch = normalized.match(/^https?:\/\/[^\/?#]+\/([^?#]+)/i);
  if (!pathMatch) return null;
  var path = String(pathMatch[1] || "").replace(/^\/+|\/+$/g, "");
  if (!path) return null;

  var parts = path.split("/");
  if (parts.length > 0 && parts[0] === "browse") {
    parts.shift();
  }
  if (parts.length < 2) return null;

  var resourceType = String(parts[0] || "").toLowerCase();
  var resourceID = String(parts[1] || "").trim();
  if (!resourceID) return null;

  if (resourceType === "track" || resourceType === "album" || resourceType === "artist" || resourceType === "playlist") {
    return { type: resourceType, id: resourceID };
  }
  return null;
}

function normalizeSearchText(value) {
  return removeDiacritics(String(value || ""))
    .toLowerCase()
    .replace(/[&]/g, " and ")
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeDiacritics(value) {
  var text = String(value || "");
  try {
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (e) {
  }
  return text
    .replace(/[đĐ]/g, "dj")
    .replace(/[ßẞ]/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .replace(/[œŒ]/g, "oe");
}

function isLatinScript(value) {
  var text = String(value || "").trim();
  if (!text) return true;
  return !(/[^\u0000-\u024f]/.test(text));
}

function hasAlphaNumericChars(value) {
  return /[a-z0-9]/i.test(String(value || ""));
}

function normalizeLooseTitle(value) {
  return removeDiacritics(String(value || ""))
    .toLowerCase()
    .replace(/[\/\\_\-|.&+]/g, " ")
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSymbolOnlyTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[a-z0-9\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gi, "")
    .replace(/[\u0300-\u036f]/g, "");
}

function extractCoreTitle(value) {
  return String(value || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/\s+-\s+.*$/, "")
    .trim();
}

function cleanTitle(value) {
  var cleaned = String(value || "");
  var patterns = [
    "remaster", "remastered", "deluxe", "bonus", "single",
    "album version", "radio edit", "original mix", "extended",
    "club mix", "remix", "live", "acoustic", "demo"
  ];
  var changed = true;
  while (changed) {
    changed = false;
    cleaned = cleaned.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, function(match, paren, bracket) {
      var content = String(paren || bracket || "").toLowerCase();
      for (var i = 0; i < patterns.length; i++) {
        if (content.indexOf(patterns[i]) >= 0) {
          changed = true;
          return " ";
        }
      }
      return match;
    });
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

function splitArtists(value) {
  var normalized = normalizeSearchText(value)
    .replace(/\bfeat\b/g, "|")
    .replace(/\bfeaturing\b/g, "|")
    .replace(/\bft\b/g, "|")
    .replace(/\band\b/g, "|")
    .replace(/,/g, "|")
    .replace(/\bx\b/g, "|");
  var parts = normalized.split("|");
  var results = [];
  for (var i = 0; i < parts.length; i++) {
    var part = String(parts[i] || "").trim();
    if (part) results.push(part);
  }
  return results;
}

function sameWordsUnordered(a, b) {
  var wordsA = String(a || "").trim().split(/\s+/).filter(Boolean).sort();
  var wordsB = String(b || "").trim().split(/\s+/).filter(Boolean).sort();
  if (!wordsA.length || wordsA.length !== wordsB.length) return false;
  for (var i = 0; i < wordsA.length; i++) {
    if (wordsA[i] !== wordsB[i]) return false;
  }
  return true;
}

function titlesMatch(expected, found) {
  var rawA = String(expected || "").trim();
  var rawB = String(found || "").trim();
  var a = normalizeSearchText(rawA);
  var b = normalizeSearchText(rawB);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;

  var cleanA = cleanTitle(a);
  var cleanB = cleanTitle(b);
  if (cleanA && cleanB) {
    if (cleanA === cleanB) return true;
    if (cleanA.indexOf(cleanB) >= 0 || cleanB.indexOf(cleanA) >= 0) return true;
  }

  var coreA = extractCoreTitle(a);
  var coreB = extractCoreTitle(b);
  if (coreA && coreB && coreA === coreB) return true;

  var looseA = normalizeLooseTitle(rawA);
  var looseB = normalizeLooseTitle(rawB);
  if (looseA && looseB) {
    if (looseA === looseB) return true;
    if (looseA.indexOf(looseB) >= 0 || looseB.indexOf(looseA) >= 0) return true;
  }

  if ((!hasAlphaNumericChars(rawA) || !hasAlphaNumericChars(rawB)) && rawA && rawB) {
    var symbolsA = normalizeSymbolOnlyTitle(rawA);
    var symbolsB = normalizeSymbolOnlyTitle(rawB);
    if (symbolsA && symbolsB && symbolsA === symbolsB) return true;
    return false;
  }

  if (isLatinScript(rawA) !== isLatinScript(rawB)) return true;
  return false;
}

function artistTokenCount(value) {
  var trimmed = String(value || "").trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

// Containment is only trustworthy when the contained name has at least two
// tokens; a single common word (e.g. "rock") must not match a longer name
// like "one ok rock".
function artistContainmentMatch(a, b) {
  if (!a || !b) return false;
  var shorter = a.length <= b.length ? a : b;
  var longer = a.length <= b.length ? b : a;
  if (artistTokenCount(shorter) < 2) return false;
  return longer.indexOf(shorter) >= 0;
}

function artistNamesMatch(expected, found) {
  var a = normalizeSearchText(expected);
  var b = normalizeSearchText(found);
  if (!a || !b) return false;
  if (a === b) return true;
  if (artistContainmentMatch(a, b)) return true;

  var aParts = splitArtists(expected);
  var bParts = splitArtists(found);
  for (var i = 0; i < aParts.length; i++) {
    for (var j = 0; j < bParts.length; j++) {
      if (!aParts[i] || !bParts[j]) continue;
      if (aParts[i] === bParts[j]) return true;
      if (artistContainmentMatch(aParts[i], bParts[j])) return true;
      if (sameWordsUnordered(aParts[i], bParts[j])) return true;
    }
  }

  if (isLatinScript(expected) !== isLatinScript(found)) return true;
  return false;
}

function trackDurationMs(track) {
  var durationMs = Number(track && track.duration_ms || 0);
  if (durationMs > 0) return durationMs;
  var durationSec = Number(track && track.duration || 0);
  if (durationSec > 0) return durationSec * 1000;
  return 0;
}

function durationMatches(expectedDurationMs, foundDurationMs) {
  var expected = Math.round(Number(expectedDurationMs || 0) / 1000);
  var found = Math.round(Number(foundDurationMs || 0) / 1000);
  if (expected <= 0 || found <= 0) return true;
  return Math.abs(expected - found) <= 10;
}

function tidalTrackMatchesRequest(track, isrc, trackName, artistName, expectedDurationMs) {
  if (!track) return false;

  var expectedISRC = String(isrc || "").trim().toUpperCase();
  var foundISRC = String(track.isrc || "").trim().toUpperCase();
  var exactISRCMatch = !!expectedISRC && !!foundISRC && expectedISRC === foundISRC;

  if (!exactISRCMatch) {
    if (trackName && !titlesMatch(trackName, track.name || "")) {
      return false;
    }
    if (artistName && !artistNamesMatch(artistName, track.artists || "")) {
      return false;
    }
  }

  if (!durationMatches(expectedDurationMs, trackDurationMs(track))) {
    return false;
  }

  return true;
}

function parentDirectory(path) {
  var text = String(path || "").trim();
  if (!text) return "";
  var forwardSlash = text.lastIndexOf("/");
  var backwardSlash = text.lastIndexOf("\\");
  var index = Math.max(forwardSlash, backwardSlash);
  if (index <= 0) return "";
  return text.substring(0, index);
}

function fileExtension(path) {
  var text = String(path || "").trim();
  if (!text) return "";
  var slashIndex = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  var dotIndex = text.lastIndexOf(".");
  if (dotIndex <= slashIndex) return "";
  return text.substring(dotIndex).toLowerCase();
}

function ensureOutputExtension(path, extension) {
  var text = String(path || "").trim();
  var ext = String(extension || "").trim().toLowerCase();
  if (!text || !ext) return text;
  if (ext.charAt(0) !== ".") ext = "." + ext;

  var currentExt = fileExtension(text);
  if (!currentExt) return text + ext;
  return text.substring(0, text.length - currentExt.length) + ext;
}

function normalizeDownloadQuality(value) {
  var normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "LOSSLESS";
  if (normalized === "DOLBY" || normalized === "ATMOS" || normalized === "DOLBY ATMOS") {
    return "DOLBY_ATMOS";
  }
  if (normalized === "EAC3" || normalized === "EC3" || normalized === "EAC3_JOC") {
    return "DOLBY_ATMOS";
  }
  if (normalized === "HIRES" || normalized === "HI_RES" || normalized === "MASTER") {
    return "HI_RES_LOSSLESS";
  }
  if (normalized === "FLAC") return "LOSSLESS";
  return normalized;
}

function isLikelyM4AQuality(quality) {
  var normalized = normalizeDownloadQuality(quality);
  return normalized === "HIGH" || normalized === "LOW" || normalized === "DOLBY_ATMOS";
}

function normalizeAudioCodec(value) {
  var normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "ec_3") return "eac3";
  if (normalized === "ac_3") return "ac3";
  if (normalized === "ac_4") return "ac4";
  if (normalized === "mp4a") return "aac";
  return normalized;
}

function isLossyAudioCodec(codec) {
  codec = normalizeAudioCodec(codec);
  return codec === "aac" ||
    codec === "eac3" ||
    codec === "ac3" ||
    codec === "ac4" ||
    codec === "mp3" ||
    codec === "opus";
}

function inferOutputExtension(downloadInfo, quality) {
  var mimeType = String(downloadInfo && downloadInfo.manifestMimeType || "").toLowerCase();
  if (mimeType.indexOf("dash+xml") !== -1) return ".m4a";
  if (mimeType.indexOf("mp4") !== -1 || mimeType.indexOf("m4a") !== -1) return ".m4a";
  if (downloadInfo && downloadInfo.kind === "manifest") return ".m4a";
  if (isLikelyM4AQuality(quality)) return ".m4a";
  return ".flac";
}

function progressPercent(onProgress, percent) {
  if (typeof onProgress !== "function") return;
  var normalized = Number(percent || 0);
  if (normalized < 0) normalized = 0;
  if (normalized > 100) normalized = 100;
  onProgress(Math.round(normalized));
}

function decodeManifestText(manifestB64) {
  var decoded = utils && typeof utils.base64Decode === "function"
    ? utils.base64Decode(String(manifestB64 || ""))
    : atob(String(manifestB64 || ""));
  decoded = String(decoded || "");
  if (!decoded) {
    throw new Error("Mirror manifest payload was empty");
  }
  return decoded;
}

function replaceAmpEntities(value) {
  return String(value || "").replace(/&amp;/g, "&");
}

function parseManifestText(manifestText) {
  manifestText = String(manifestText || "");
  if (/^\s*\{/.test(manifestText)) {
    var btsManifest = JSON.parse(manifestText);
    if (!btsManifest.urls || !btsManifest.urls.length || !btsManifest.urls[0]) {
      throw new Error("Mirror BTS manifest did not contain a direct URL");
    }
    return {
      kind: "direct",
      directURL: String(btsManifest.urls[0] || ""),
      manifestMimeType: String(btsManifest.mimeType || "audio/flac")
    };
  }

  var initMatch = manifestText.match(/initialization=\"([^\"]+)\"/i);
  var mediaMatch = manifestText.match(/media=\"([^\"]+)\"/i);
  if (!initMatch || !mediaMatch) {
    throw new Error("Mirror MPD manifest did not contain initialization/media templates");
  }

  var sampleRateMatch = manifestText.match(/audioSamplingRate=\"(\d+)\"/i);

  var segmentCount = 0;
  var segmentRegex = /<S\s+[^>]*d=\"(\d+)\"(?:\s+r=\"(-?\d+)\")?[^>]*\/?>/gi;
  var match;
  while ((match = segmentRegex.exec(manifestText)) !== null) {
    var repeatCount = parseInt(match[2] || "0", 10);
    if (!isFinite(repeatCount) || repeatCount < 0) repeatCount = 0;
    segmentCount += repeatCount + 1;
  }
  if (segmentCount <= 0) {
    throw new Error("Mirror MPD manifest did not list any media segments");
  }

  var mediaTemplate = replaceAmpEntities(mediaMatch[1]);
  var mediaURLs = [];
  for (var i = 1; i <= segmentCount; i++) {
    mediaURLs.push(mediaTemplate.replace(/\$Number\$/g, String(i)));
  }

  return {
    kind: "manifest",
    initURL: replaceAmpEntities(initMatch[1]),
    mediaURLs: mediaURLs,
    manifestMimeType: "application/dash+xml",
    sampleRate: Number(sampleRateMatch && sampleRateMatch[1] || 0)
  };
}

function parseManifestPayload(manifestB64) {
  return parseManifestText(decodeManifestText(manifestB64));
}

function isDolbyAtmosInfo(downloadInfo) {
  var audioMode = String(downloadInfo && downloadInfo.audioMode || "").toUpperCase();
  var audioQuality = String(downloadInfo && downloadInfo.audioQuality || "").toUpperCase();
  return audioMode === "DOLBY_ATMOS" || audioQuality === "DOLBY_ATMOS";
}

function isHiResInfo(downloadInfo) {
  var audioQuality = String(downloadInfo && downloadInfo.audioQuality || "").toUpperCase();
  var bitDepth = Number(downloadInfo && downloadInfo.bitDepth || 0);
  var sampleRate = Number(downloadInfo && downloadInfo.sampleRate || 0);
  return audioQuality === "HI_RES" ||
    audioQuality === "HI_RES_LOSSLESS" ||
    bitDepth > 16 ||
    sampleRate > 44100;
}

function isLosslessInfo(downloadInfo) {
  var audioQuality = String(downloadInfo && downloadInfo.audioQuality || "").toUpperCase();
  var mimeType = String(downloadInfo && downloadInfo.manifestMimeType || "").toLowerCase();
  return isHiResInfo(downloadInfo) ||
    audioQuality === "LOSSLESS" ||
    mimeType.indexOf("audio/flac") >= 0;
}

function isCDLosslessInfo(downloadInfo) {
  if (isHiResInfo(downloadInfo)) return false;

  var audioQuality = String(downloadInfo && downloadInfo.audioQuality || "").toUpperCase();
  var mimeType = String(downloadInfo && downloadInfo.manifestMimeType || "").toLowerCase();
  var bitDepth = Number(downloadInfo && downloadInfo.bitDepth || 0);
  var sampleRate = Number(downloadInfo && downloadInfo.sampleRate || 0);

  if (bitDepth > 16) return false;
  if (sampleRate > 48000) return false;
  if (audioQuality === "LOSSLESS") return true;
  if (mimeType.indexOf("audio/flac") >= 0 && bitDepth <= 16) return true;
  return false;
}

function satisfiesQuality(downloadInfo, quality) {
  var normalized = normalizeDownloadQuality(quality);
  if (normalized === "DOLBY_ATMOS") return isDolbyAtmosInfo(downloadInfo);
  if (normalized === "HI_RES_LOSSLESS") return isHiResInfo(downloadInfo);
  if (normalized === "LOSSLESS") return isCDLosslessInfo(downloadInfo);
  return true;
}

function buildFallbackQualities(quality) {
  var normalized = normalizeDownloadQuality(quality);
  if (normalized === "DOLBY_ATMOS") {
    return ["DOLBY_ATMOS", "HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
  }
  if (normalized === "HI_RES_LOSSLESS") {
    return ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
  }
  if (normalized === "LOSSLESS") {
    return ["LOSSLESS", "HIGH", "LOW"];
  }
  if (normalized === "HIGH") {
    return ["HIGH", "LOW"];
  }
  return [normalized || "LOSSLESS"];
}

function postDownloadAPI(body) {
  var trackID = String(body && body.id || "").trim();
  var ticketID = signedTicket("tid", "track", trackID);
  return signedJSON("POST", CONFIG.downloadAPIURL, body, {
    "X-Zarz-Ticket": ticketID
  });
}

function fetchAtmosManifestPayload(trackID) {
  var payload = postDownloadAPI({
    id: String(trackID || ""),
    endpoint: "manifests",
    formats: ["EAC3_JOC"]
  });
  var attributes = payload &&
    payload.data &&
    payload.data.data &&
    payload.data.data.attributes
      ? payload.data.data.attributes
      : null;
  if (!attributes) {
    throw new Error("Atmos manifest payload missing attributes");
  }

  var formats = Array.isArray(attributes.formats) ? attributes.formats : [];
  var hasAtmos = false;
  for (var i = 0; i < formats.length; i++) {
    if (String(formats[i] || "").toUpperCase() === "EAC3_JOC") {
      hasAtmos = true;
      break;
    }
  }
  if (!hasAtmos) {
    throw new Error("TIDAL API did not report EAC3_JOC for this track");
  }

  var manifestURL = String(attributes.uri || "").trim();
  if (!manifestURL) {
    throw new Error("Atmos manifest URI was empty");
  }
  return {
    uri: manifestURL,
    hash: String(attributes.hash || "")
  };
}

function fetchAPIDownloadInfo(trackID, quality) {
  var normalizedQuality = normalizeDownloadQuality(quality);
  if (normalizedQuality === "DOLBY_ATMOS") {
    var manifestPayload = fetchAtmosManifestPayload(trackID);
    var manifestText = fetchText(manifestPayload.uri, null);
    var parsedAtmosManifest = parseManifestText(manifestText);
    parsedAtmosManifest.audioMode = "DOLBY_ATMOS";
    parsedAtmosManifest.audioQuality = "DOLBY_ATMOS";
    if (!parsedAtmosManifest.sampleRate || parsedAtmosManifest.sampleRate <= 0) {
      parsedAtmosManifest.sampleRate = 48000;
    }
    parsedAtmosManifest.apiURL = CONFIG.downloadAPIURL;
    return parsedAtmosManifest;
  }

  var payload = postDownloadAPI({
    id: String(trackID || ""),
    quality: normalizedQuality
  });
  var data = payload && payload.data ? payload.data : null;
  if (!data) {
    throw new Error("Download API returned no data");
  }
  if (String(data.assetPresentation || "").toUpperCase() === "PREVIEW") {
    throw new Error("Download API returned PREVIEW asset");
  }
  if (!data.manifest) {
    throw new Error("Download API payload missing manifest");
  }

  var parsedManifest = parseManifestPayload(data.manifest);
  parsedManifest.audioMode = String(data.audioMode || "");
  parsedManifest.audioQuality = String(data.audioQuality || "");
  parsedManifest.bitDepth = Number(data.bitDepth || 0);
  parsedManifest.sampleRate = Number(data.sampleRate || parsedManifest.sampleRate || 0);
  parsedManifest.manifestMimeType = parsedManifest.manifestMimeType || String(data.manifestMimeType || "");
  parsedManifest.apiURL = CONFIG.downloadAPIURL;
  return parsedManifest;
}

function mirrorRequestURL(baseURL, trackID, quality) {
  return normalizeMirrorBaseURL(baseURL) +
    "/track/?id=" + encodeURIComponent(String(trackID || "")) +
    "&quality=" + encodeURIComponent(normalizeDownloadQuality(quality));
}

function sourceCandidateKey(source, id, quality) {
  return String(source || "") + ":" + String(id || "") + "@" + normalizeDownloadQuality(quality);
}

function fetchMirrorDownloadInfo(trackID, quality, rejectedCandidates) {
  var mirrors = CONFIG.mirrorBaseURLs || [];
  var lastError = "";
  rejectedCandidates = rejectedCandidates || {};

  for (var i = 0; i < mirrors.length; i++) {
    var baseURL = normalizeMirrorBaseURL(mirrors[i]);
    if (!baseURL) continue;
    var candidateKey = sourceCandidateKey("mirror", baseURL, quality);
    if (rejectedCandidates[candidateKey]) {
      lastError = "skipped rejected mirror candidate";
      continue;
    }

    try {
      var response = http.get(mirrorRequestURL(baseURL, trackID, quality), {
        "User-Agent": requestUserAgent(),
        "Accept": "application/json"
      });
      if (!response || response.error) {
        lastError = response && response.error ? response.error : "request failed";
        continue;
      }
      if (response.statusCode !== 200) {
        lastError = "HTTP " + response.statusCode;
        continue;
      }

      var payload = JSON.parse(response.body);
      if (Array.isArray(payload)) {
        for (var j = 0; j < payload.length; j++) {
          var directURL = String(payload[j] && payload[j].OriginalTrackUrl || "");
          if (directURL) {
            return {
              mirrorBaseURL: baseURL,
              candidateKey: candidateKey,
              kind: "direct",
              directURL: directURL,
              bitDepth: 16,
              sampleRate: 44100,
              manifestMimeType: "audio/flac"
            };
          }
        }
      }

      var data = payload && payload.data ? payload.data : null;
      if (!data) {
        lastError = "missing download payload";
        continue;
      }
      if (String(data.assetPresentation || "").toUpperCase() === "PREVIEW") {
        lastError = "mirror returned PREVIEW asset";
        continue;
      }
      if (!data.manifest) {
        lastError = "mirror payload missing manifest";
        continue;
      }

      var parsedManifest = parseManifestPayload(data.manifest);
      parsedManifest.mirrorBaseURL = baseURL;
      parsedManifest.candidateKey = candidateKey;
      parsedManifest.bitDepth = Number(data.bitDepth || 0);
      parsedManifest.sampleRate = Number(data.sampleRate || 0);
      parsedManifest.audioQuality = String(data.audioQuality || "");
      parsedManifest.manifestMimeType = parsedManifest.manifestMimeType || String(data.manifestMimeType || "");
      return parsedManifest;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }

  throw new Error("No TIDAL mirror returned a usable download payload" + (lastError ? ": " + lastError : ""));
}

function isDeterministicDownloadError(message) {
  var text = String(message || "");
  if (!text) return false;
  // These outcomes are properties of the track/catalog, not transient network
  // failures, so retrying the same request returns the same result. We fall
  // straight through to the next quality tier instead of burning retries.
  return /EAC3_JOC|did not report|PREVIEW asset|Invalid TIDAL|assetPresentation|missing manifest|returned no data/i.test(text);
}

function fetchDownloadInfo(trackID, quality, rejectedCandidates) {
  var fallbacks = buildFallbackQualities(quality);
  var allErrors = [];
  var maxRetries = 3;
  var hasMirrors = !!(CONFIG.mirrorBaseURLs && CONFIG.mirrorBaseURLs.length);
  var candidate;
  var i;
  rejectedCandidates = rejectedCandidates || {};

  for (i = 0; i < fallbacks.length; i++) {
    candidate = fallbacks[i];
    var qualityErrors = [];

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      // deterministic = the source gave a consistent answer (wrong tier, no
      // Atmos, preview-only, ...). Retrying it just wastes round-trips.
      var deterministic = false;
      var apiCandidateKey = sourceCandidateKey("api", CONFIG.downloadAPIURL, candidate);
      if (!rejectedCandidates[apiCandidateKey]) {
        try {
          var apiDownloadInfo = fetchAPIDownloadInfo(trackID, candidate);
          if (satisfiesQuality(apiDownloadInfo, candidate)) {
            apiDownloadInfo.resolvedQuality = candidate;
            apiDownloadInfo.requestedQuality = normalizeDownloadQuality(quality);
            apiDownloadInfo.candidateKey = apiCandidateKey;
            return apiDownloadInfo;
          }
          qualityErrors.push(candidate + " API attempt " + (attempt + 1) + ": returned lower tier than requested");
          deterministic = true;
        } catch (apiError) {
          if (isVerificationRequiredError(apiError)) throw apiError;
          var apiMessage = apiError && apiError.message ? apiError.message : String(apiError);
          qualityErrors.push(candidate + " API attempt " + (attempt + 1) + ": " + apiMessage);
          deterministic = isDeterministicDownloadError(apiMessage);
        }
      }

      if (candidate !== "DOLBY_ATMOS") {
        try {
          var mirrorDownloadInfo = fetchMirrorDownloadInfo(trackID, candidate, rejectedCandidates);
          if (satisfiesQuality(mirrorDownloadInfo, candidate)) {
            mirrorDownloadInfo.resolvedQuality = candidate;
            mirrorDownloadInfo.requestedQuality = normalizeDownloadQuality(quality);
            return mirrorDownloadInfo;
          }
          qualityErrors.push(candidate + " mirror attempt " + (attempt + 1) + ": returned lower tier than requested");
        } catch (mirrorError) {
          // Mirror failures may be transient (separate hosts), so they do not
          // mark the attempt deterministic on their own.
          qualityErrors.push(candidate + " mirror attempt " + (attempt + 1) + ": " + (mirrorError && mirrorError.message ? mirrorError.message : String(mirrorError)));
        }
      }

      // A deterministic API result will not change on retry, and with no mirror
      // source to differ either, move on to the next quality tier immediately.
      if (deterministic && !hasMirrors) {
        break;
      }
    }

    allErrors = allErrors.concat(qualityErrors);
    log.debug("[TidalWeb] Quality " + candidate + " exhausted, falling back");
  }

  throw new Error(
    "No TIDAL download source returned a usable payload | " + allErrors.join("; ")
  );
}

function buildSegmentTempPath(outputPath, suffix) {
  var ext = fileExtension(outputPath);
  var base = ext ? outputPath.substring(0, outputPath.length - ext.length) : outputPath;
  return base + "." + suffix + ".part";
}

function deleteQuietly(path) {
  try {
    if (path && file.exists(path)) {
      file.delete(path);
    }
  } catch (e) {
  }
}

function appendTempDownloadToFile(tempPath, destinationPath, truncate) {
  var readResult = file.readBytes(tempPath, { encoding: "base64" });
  if (!readResult || readResult.success !== true) {
    throw new Error(readResult && readResult.error ? readResult.error : "failed to read downloaded segment");
  }

  var writeResult = file.writeBytes(destinationPath, readResult.data, {
    encoding: "base64",
    truncate: !!truncate,
    append: !truncate
  });
  if (!writeResult || writeResult.success !== true) {
    throw new Error(writeResult && writeResult.error ? writeResult.error : "failed to append downloaded segment");
  }
}

function downloadDirectFile(downloadURL, outputPath, onProgress, progressStart, progressSpan, trackItemBytes) {
  return file.download(downloadURL, outputPath, {
    headers: {
      "User-Agent": requestUserAgent()
    },
    trackItemBytes: trackItemBytes !== false,
    onProgress: function(written, total) {
      if (!total || total <= 0) return;
      var ratio = written / total;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;
      progressPercent(onProgress, progressStart + Math.round(ratio * progressSpan));
    }
  });
}

function readDownloadedAudioQuality(path) {
  if (!gobackend || typeof gobackend.getAudioQuality !== "function") {
    return null;
  }
  var qualityInfo = gobackend.getAudioQuality(path);
  if (!qualityInfo || qualityInfo.error) {
    return null;
  }
  return qualityInfo;
}

function audioDurationSeconds(qualityInfo) {
  var duration = Number(qualityInfo && qualityInfo.duration || 0);
  if (duration > 0) return Math.round(duration);

  var sampleRate = Number(qualityInfo && qualityInfo.sampleRate || 0);
  var totalSamples = Number(qualityInfo && qualityInfo.totalSamples || 0);
  if (sampleRate > 0 && totalSamples > 0) {
    return Math.round(totalSamples / sampleRate);
  }
  return 0;
}

function validateDownloadedDuration(expectedDurationMs, actualDurationSec) {
  var expectedSec = Math.round(Number(expectedDurationMs || 0) / 1000);
  var actualSec = Math.round(Number(actualDurationSec || 0));
  if (expectedSec <= 0 || actualSec <= 0) {
    return { valid: true, preview: false, message: "" };
  }

  var diff = Math.abs(expectedSec - actualSec);
  if (diff <= 10) {
    return { valid: true, preview: false, message: "" };
  }

  var preview = actualSec <= 35 && expectedSec > 45;
  return {
    valid: false,
    preview: preview,
    message: "Downloaded audio duration mismatch: expected " + expectedSec + "s, got " + actualSec + "s"
  };
}

function rememberRejectedDownloadCandidate(rejectedCandidates, downloadInfo) {
  if (!rejectedCandidates || !downloadInfo) return;
  if (downloadInfo.candidateKey) {
    rejectedCandidates[String(downloadInfo.candidateKey)] = true;
  }
  if (downloadInfo.directURL) {
    rejectedCandidates["url:" + String(downloadInfo.directURL)] = true;
  }
  if (downloadInfo.initURL) {
    rejectedCandidates["url:" + String(downloadInfo.initURL)] = true;
  }
}

function downloadManifestSegments(downloadInfo, outputPath, onProgress) {
  var urls = [downloadInfo.initURL].concat(downloadInfo.mediaURLs || []);
  for (var i = 0; i < urls.length; i++) {
    if (utils && typeof utils.isDownloadCancelled === "function" && utils.isDownloadCancelled()) {
      return {
        success: false,
        error: "download cancelled"
      };
    }

    var tempPath = buildSegmentTempPath(outputPath, i === 0 ? "init" : ("seg" + i));
    try {
      deleteQuietly(tempPath);
      var segmentResult = downloadDirectFile(
        urls[i],
        tempPath,
        onProgress,
        10 + Math.round((i / urls.length) * 80),
        Math.max(1, Math.round(80 / urls.length)),
        false
      );
      if (!segmentResult || !segmentResult.success) {
        return {
          success: false,
          error: segmentResult && segmentResult.error ? segmentResult.error : "failed to download manifest segment"
        };
      }

      appendTempDownloadToFile(tempPath, outputPath, i === 0);
    } finally {
      deleteQuietly(tempPath);
    }
  }

  return {
    success: true,
    path: outputPath
  };
}

function tryFetchLyricsLRC(track) {
  if (!gobackend || typeof gobackend.getLyricsLRC !== "function" || !track) {
    return "";
  }

  var payload = gobackend.getLyricsLRC(
    String(track.spotify_id || ""),
    String(track.name || ""),
    String(track.artists || ""),
    "",
    Number(track.duration_ms || 0)
  );
  if (!payload || payload.error) {
    return "";
  }
  return String(payload.lyrics || "");
}

function selectBestSearchTrack(tracks, isrc, trackName, artistName, expectedDurationMs, requestedQuality) {
  if (!tracks || !tracks.length) return null;

  var isAtmosRequested = String(requestedQuality || "").toUpperCase() === "DOLBY_ATMOS";
  if (isAtmosRequested) {
    for (var a = 0; a < tracks.length; a++) {
      var candidateAtmos = tracks[a];
      if (tidalAudioModes(candidateAtmos) === "DOLBY_ATMOS" || (candidateAtmos.audio_modes && candidateAtmos.audio_modes === "DOLBY_ATMOS")) {
        if (tidalTrackMatchesRequest(candidateAtmos, isrc, trackName, artistName, expectedDurationMs)) {
          log.info("[TidalWeb] Prioritizing Dolby Atmos track candidate: " + candidateAtmos.id);
          return candidateAtmos;
        }
      }
    }
  }

  var normalizedISRC = String(isrc || "").trim().toUpperCase();
  if (normalizedISRC) {
    for (var i = 0; i < tracks.length; i++) {
      if (tidalTrackMatchesRequest(tracks[i], normalizedISRC, trackName, artistName, expectedDurationMs)) {
        return tracks[i];
      }
    }
  }

  if (!String(trackName || "").trim()) {
    return null;
  }

  for (var j = 0; j < tracks.length; j++) {
    var candidate = tracks[j];
    if (tidalTrackMatchesRequest(candidate, isrc, trackName, artistName, expectedDurationMs)) {
      return candidate;
    }
  }

  return null;
}

function externalTrackURL(track) {
  if (!track) return "";
  if (track.url) return ensureHTTPS(track.url);
  if (track.id) return "https://tidal.com/browse/track/" + track.id;
  return "";
}

function externalAlbumURL(album) {
  if (!album) return "";
  if (album.url) return ensureHTTPS(album.url);
  if (album.id) return "https://tidal.com/browse/album/" + album.id;
  return "";
}

function albumArtistsDisplay(album) {
  if (!album) return "";
  return joinArtistNames(album.artists || []);
}

function trackArtistID(track) {
  if (track && track.artist && track.artist.id) {
    return withPrefix(track.artist.id);
  }
  if (track && track.artists && track.artists.length && track.artists[0].id) {
    return withPrefix(track.artists[0].id);
  }
  return "";
}

// Returns a comma-separated list of artist IDs aligned positionally with the
// names produced by joinArtistNames, so the app can map each artist name to
// its own ID (not just the primary artist). Artists with a name but no ID get
// an empty slot to preserve alignment.
function joinArtistIDs(artists) {
  if (!artists || !artists.length) return "";
  var ids = [];
  for (var i = 0; i < artists.length; i++) {
    var artist = artists[i] || {};
    var name = String(artist.name || "").trim();
    if (!name) continue;
    ids.push(artist.id ? withPrefix(artist.id) : "");
  }
  return ids.join(",");
}

function trackArtistIDs(track) {
  var artists = (track && track.artists && track.artists.length)
    ? track.artists
    : (track && track.artist ? [track.artist] : []);
  var joined = joinArtistIDs(artists);
  if (joined.replace(/,/g, "").length) return joined;
  return trackArtistID(track);
}

function tidalMediaTags(track) {
  var meta = track.mediaMetadata;
  if (!meta || !meta.tags || !Array.isArray(meta.tags)) return [];
  var tags = [];
  for (var i = 0; i < meta.tags.length; i++) {
    tags.push(String(meta.tags[i] || "").toUpperCase());
  }
  return tags;
}

function tidalHasTag(tags, tag) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i] === tag) return true;
  }
  return false;
}

function tidalAudioQualityLabel(track) {
  var tags = tidalMediaTags(track);

  if (tidalHasTag(tags, "HIRES_LOSSLESS") || tidalHasTag(tags, "HI_RES_LOSSLESS")) {
    return "24bit";
  }
  if (tidalHasTag(tags, "MQA")) {
    return "MQA";
  }
  if (tidalHasTag(tags, "LOSSLESS")) {
    return "16bit/44.1kHz";
  }

  var quality = String(track.audioQuality || "").toUpperCase();
  switch (quality) {
    case "HI_RES_LOSSLESS":
      return "24bit";
    case "HI_RES":
      return "MQA";
    case "LOSSLESS":
      return "16bit/44.1kHz";
    case "HIGH":
      return "320kbps";
    case "LOW":
      return "96kbps";
    default:
      return "";
  }
}

function tidalAudioModes(track) {
  var tags = tidalMediaTags(track);
  if (tidalHasTag(tags, "DOLBY_ATMOS")) return "DOLBY_ATMOS";

  var modes = track.audioModes || [];
  if (!Array.isArray(modes)) return "";
  for (var i = 0; i < modes.length; i++) {
    if (String(modes[i] || "").toUpperCase() === "DOLBY_ATMOS") {
      return "DOLBY_ATMOS";
    }
  }
  return "";
}

function tidalTrackTitle(track) {
  if (!track) return "";

  var title = String(track.title || "").trim();
  var version = String(track.version || "").trim();
  if (!title || !version) return title;

  var normalizedTitle = title.toLowerCase();
  var normalizedVersion = version.toLowerCase();
  if (normalizedTitle.indexOf("(" + normalizedVersion + ")") >= 0 ||
      normalizedTitle.indexOf("[" + normalizedVersion + "]") >= 0 ||
      normalizedTitle.indexOf(" - " + normalizedVersion) >= 0 ||
      normalizedTitle === normalizedVersion) {
    return title;
  }

  return title + " (" + version + ")";
}

function formatTrack(track) {
  if (!track || !track.id) return null;

  var resolvedReleaseDate = firstNonEmpty(
    track.album && track.album.releaseDate,
    track.releaseDate,
    track.streamStartDate,
    track.album && track.album.streamStartDate
  );

  return {
    id: withPrefix(track.id),
    spotify_id: withPrefix(track.id),
    tidal_id: String(track.id),
    name: tidalTrackTitle(track),
    artists: joinArtistNames(track.artists || []),
    album_name: String(track.album && track.album.title || ""),
    album_artist: albumArtistNames(track),
    artist_id: trackArtistIDs(track),
    album_id: withPrefix(track.album && track.album.id || ""),
    duration_ms: Number(track.duration || 0) * 1000,
    cover_url: imageURL(track.album && track.album.cover || "", "1280x1280"),
    images: imageURL(track.album && track.album.cover || "", "1280x1280"),
    release_date: normalizeDate(resolvedReleaseDate),
    track_number: Number(track.trackNumber || 0),
    disc_number: Number(track.volumeNumber || 0),
    isrc: String(track.isrc || ""),
    provider_id: "tidal-web",
    item_type: "track",
    external_urls: externalTrackURL(track),
    copyright: String(track.copyright || ""),
    audio_quality: tidalAudioQualityLabel(track),
    audio_modes: tidalAudioModes(track)
  };
}

function formatAlbumTrack(track, albumInfo) {
  var formatted = formatTrack(track);
  if (!formatted) return null;

  albumInfo = albumInfo || {};
  if (albumInfo.id) formatted.album_id = withPrefix(albumInfo.id);
  if (albumInfo.title) formatted.album_name = String(albumInfo.title);
  if (albumInfo.cover) {
    formatted.cover_url = imageURL(albumInfo.cover, "1280x1280");
    formatted.images = formatted.cover_url;
  }
  if (albumInfo.releaseDate) {
    formatted.release_date = normalizeDate(albumInfo.releaseDate);
  }
  if (albumInfo.url) {
    formatted.album_url = ensureHTTPS(albumInfo.url);
  }
  return formatted;
}

function formatAlbumInfo(album) {
  if (!album || !album.id) return null;

  var albumType = String(album.type || "").trim().toLowerCase();
  if (!albumType) albumType = "album";

  return {
    id: withPrefix(album.id),
    name: String(album.title || ""),
    artists: albumArtistsDisplay(album),
    artist_id: album.artists && album.artists.length ? withPrefix(album.artists[0].id) : "",
    cover_url: imageURL(album.cover || "", "1280x1280"),
    images: imageURL(album.cover || "", "1280x1280"),
    release_date: normalizeDate(album.releaseDate || ""),
    total_tracks: Number(album.numberOfTracks || 0),
    album_type: albumType,
    provider_id: "tidal-web",
    item_type: "album",
    copyright: String(album.copyright || "")
  };
}

function albumBelongsToArtist(album, targetID) {
  if (!album) return false;
  var target = String(targetID || "");
  if (!target) return true;
  var hasArtistInfo = false;
  if (album.artist && album.artist.id !== undefined && album.artist.id !== null && String(album.artist.id) !== "") {
    hasArtistInfo = true;
    if (String(album.artist.id) === target) return true;
  }
  var artists = album.artists || [];
  for (var i = 0; i < artists.length; i++) {
    var a = artists[i] || {};
    if (a.id === undefined || a.id === null || String(a.id) === "") continue;
    hasArtistInfo = true;
    var type = String(a.type || "MAIN").toUpperCase();
    if (type === "MAIN" && String(a.id) === target) return true;
  }
  return !hasArtistInfo;
}

function formatArtistAlbum(album, fallbackType) {
  if (!album || !album.id) return null;

  var albumType = String(album.type || "").trim().toLowerCase();
  if (!albumType) albumType = String(fallbackType || "").trim().toLowerCase();
  if (!albumType) albumType = "album";

  return {
    id: withPrefix(album.id),
    name: String(album.title || ""),
    artists: albumArtistsDisplay(album),
    cover_url: imageURL(album.cover || "", "1280x1280"),
    images: imageURL(album.cover || "", "1280x1280"),
    release_date: normalizeDate(album.releaseDate || ""),
    total_tracks: Number(album.numberOfTracks || 0),
    album_type: albumType,
    provider_id: "tidal-web",
    item_type: "album"
  };
}

function formatArtistInfo(artist) {
  if (!artist || !artist.id) return null;

  var image = imageURL(artist.picture || "", "750x750");
  return {
    id: withPrefix(artist.id),
    name: String(artist.name || ""),
    image_url: image,
    images: image,
    header_image: image,
    listeners: 0,
    provider_id: "tidal-web",
    item_type: "artist"
  };
}

function formatPlaylistInfo(playlist) {
  if (!playlist || !playlist.uuid) return null;

  var coverURL = imageURL(firstNonEmpty(playlist.squareImage, playlist.image), "origin");
  return {
    id: String(playlist.uuid),
    name: String(playlist.title || ""),
    artists: String(playlist.creator && playlist.creator.name || "TIDAL"),
    cover_url: coverURL,
    images: coverURL,
    total_tracks: Number(playlist.numberOfTracks || 0),
    provider_id: "tidal-web",
    item_type: "playlist"
  };
}

function findModule(page, moduleType) {
  if (!page || !page.rows) return null;

  for (var i = 0; i < page.rows.length; i++) {
    var row = page.rows[i] || {};
    var modules = row.modules || [];
    for (var j = 0; j < modules.length; j++) {
      var module = modules[j] || {};
      if (module.type === moduleType) {
        return module;
      }
    }
  }
  return null;
}

function artistAlbumTypeFromModuleTitle(title) {
  var normalized = String(title || "").trim().toLowerCase();
  if (normalized === "albums" || normalized === "compilations" || normalized === "appears on") {
    return "album";
  }
  if (normalized === "ep & singles" || normalized === "eps & singles" || normalized === "singles" || normalized === "ep" || normalized === "eps") {
    return "single";
  }
  return "";
}

function fetchTrack(trackID) {
  var id = parseTrackID(trackID);
  if (!id) throw new Error("Invalid TIDAL track ID: " + trackID);
  return getJSON(buildMetadataURL("tracks/" + encodeURIComponent(id), null));
}

function fetchAlbumPage(albumID) {
  var id = parseAlbumID(albumID);
  if (!id) throw new Error("Invalid TIDAL album ID: " + albumID);
  return getJSON(buildMetadataURL("pages/album", { albumId: id }));
}

function fetchArtistPage(artistID) {
  var id = parseArtistID(artistID);
  if (!id) throw new Error("Invalid TIDAL artist ID: " + artistID);
  return getJSON(buildMetadataURL("pages/artist", { artistId: id }));
}

function fetchArtistAlbumsPage(dataAPIPath, offset, limit) {
  return getJSON(buildMetadataURL(dataAPIPath, {
    offset: offset,
    limit: limit
  }));
}

function fetchPlaylist(playlistID) {
  var id = parsePlaylistID(playlistID);
  if (!id) throw new Error("Invalid TIDAL playlist ID: " + playlistID);
  return getJSON(buildMetadataURL("playlists/" + encodeURIComponent(id), null));
}

function fetchPlaylistItemsPage(playlistID, offset, limit) {
  var id = parsePlaylistID(playlistID);
  if (!id) throw new Error("Invalid TIDAL playlist ID: " + playlistID);
  return getJSON(buildMetadataURL("playlists/" + encodeURIComponent(id) + "/items", {
    offset: offset,
    limit: limit
  }));
}

function searchEndpoint(kind, query, limit) {
  return getJSON(buildMetadataURL("search/" + kind, {
    query: query,
    limit: limit,
    offset: 0
  }));
}

function getTrack(trackID) {
  try {
    return formatTrack(fetchTrack(trackID));
  } catch (e) {
    log.error("[TidalWeb] getTrack failed:", e.message);
    return null;
  }
}

function getAlbum(albumID) {
  try {
    var page = fetchAlbumPage(albumID);
    var headerModule = findModule(page, "ALBUM_HEADER");
    var itemsModule = findModule(page, "ALBUM_ITEMS");
    if (!headerModule || !headerModule.album) {
      throw new Error("TIDAL album page missing album header");
    }
    if (!itemsModule || !itemsModule.pagedList || !itemsModule.pagedList.items) {
      throw new Error("TIDAL album page missing track list");
    }

    var album = formatAlbumInfo(headerModule.album);
    var tracks = [];
    var items = itemsModule.pagedList.items || [];
    var totalDiscs = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var track = item.item || {};
      if (i === 0) {
        log.info("[TidalWeb] album track[0] audioQuality=" + (track.audioQuality || "NONE") +
          " mediaMetadata=" + JSON.stringify(track.mediaMetadata || "NONE") +
          " audioModes=" + JSON.stringify(track.audioModes || "NONE"));
      }
      track.album = track.album || {};
      track.album.id = headerModule.album.id;
      track.album.title = headerModule.album.title;
      track.album.cover = headerModule.album.cover;
      track.album.releaseDate = headerModule.album.releaseDate;
      track.album.url = headerModule.album.url;
      if (Number(track.volumeNumber || 0) > totalDiscs) {
        totalDiscs = Number(track.volumeNumber || 0);
      }
      var formattedTrack = formatAlbumTrack(track, headerModule.album);
      if (formattedTrack) tracks.push(formattedTrack);
    }

    for (var j = 0; j < tracks.length; j++) {
      tracks[j].total_discs = totalDiscs;
      tracks[j].total_tracks = album.total_tracks;
      tracks[j].album_type = album.album_type;
      tracks[j].copyright = album.copyright || "";
    }

    album.tracks = tracks;
    return album;
  } catch (e) {
    log.error("[TidalWeb] getAlbum failed:", e.message);
    return null;
  }
}

function getArtist(artistID) {
  try {
    var page = fetchArtistPage(artistID);
    var headerModule = findModule(page, "ARTIST_HEADER");
    if (!headerModule || !headerModule.artist) {
      throw new Error("TIDAL artist page missing artist header");
    }

    var artistInfo = formatArtistInfo(headerModule.artist);
    var targetArtistID = String(headerModule.artist.id || "");
    var albums = [];
    var seen = {};

    if (page.rows) {
      for (var rowIndex = 0; rowIndex < page.rows.length; rowIndex++) {
        var row = page.rows[rowIndex] || {};
        var modules = row.modules || [];
        for (var moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
          var module = modules[moduleIndex] || {};
          if (module.type !== "ALBUM_LIST" || !module.pagedList) continue;

          var fallbackType = artistAlbumTypeFromModuleTitle(module.title);
          var items = module.pagedList.items || [];
          for (var i = 0; i < items.length; i++) {
            if (!albumBelongsToArtist(items[i], targetArtistID)) continue;
            var mapped = formatArtistAlbum(items[i], fallbackType);
            if (!mapped || !mapped.id || seen[mapped.id]) continue;
            seen[mapped.id] = true;
            albums.push(mapped);
          }

          var pageSize = Number(module.pagedList.limit || CONFIG.pageSize);
          if (!pageSize || pageSize <= 0) pageSize = CONFIG.pageSize;
          var offset = items.length;
          while (offset < Number(module.pagedList.totalNumberOfItems || 0) &&
              String(module.pagedList.dataApiPath || "").trim() &&
              albums.length < CONFIG.maxArtistAlbums) {
            var albumPage = fetchArtistAlbumsPage(module.pagedList.dataApiPath, offset, pageSize);
            var pageItems = albumPage.items || [];
            for (var j = 0; j < pageItems.length; j++) {
              if (!albumBelongsToArtist(pageItems[j], targetArtistID)) continue;
              var release = formatArtistAlbum(pageItems[j], fallbackType);
              if (!release || !release.id || seen[release.id]) continue;
              seen[release.id] = true;
              albums.push(release);
              if (albums.length >= CONFIG.maxArtistAlbums) break;
            }
            if (!pageItems.length || offset + pageItems.length >= Number(albumPage.totalNumberOfItems || 0)) {
              break;
            }
            offset += pageItems.length;
          }
        }
      }
    }

    artistInfo.albums = albums;
    return artistInfo;
  } catch (e) {
    log.error("[TidalWeb] getArtist failed:", e.message);
    return null;
  }
}

function getPlaylist(playlistID) {
  try {
    var playlist = fetchPlaylist(playlistID);
    var playlistInfo = formatPlaylistInfo(playlist);
    var tracks = [];
    var offset = 0;
    var totalTracks = Number(playlist.numberOfTracks || 0);

    while (offset < CONFIG.maxPlaylistTracks) {
      var page = fetchPlaylistItemsPage(playlistID, offset, CONFIG.pageSize);
      var items = page.items || [];
      if (!items.length) break;

      if (!totalTracks && Number(page.totalNumberOfItems || 0) > 0) {
        totalTracks = Number(page.totalNumberOfItems || 0);
      }

      for (var i = 0; i < items.length; i++) {
        var item = items[i] || {};
        if (item.type !== "track") continue;
        if (offset === 0 && i === 0) {
          var pTrack = item.item || {};
          log.info("[TidalWeb] playlist track[0] audioQuality=" + (pTrack.audioQuality || "NONE") +
            " mediaMetadata=" + JSON.stringify(pTrack.mediaMetadata || "NONE") +
            " audioModes=" + JSON.stringify(pTrack.audioModes || "NONE"));
        }
        var formattedTrack = formatTrack(item.item || {});
        if (formattedTrack) tracks.push(formattedTrack);
      }

      if (offset + items.length >= totalTracks || items.length < CONFIG.pageSize) {
        break;
      }
      offset += items.length;
    }

    playlistInfo.tracks = tracks;
    return playlistInfo;
  } catch (e) {
    log.error("[TidalWeb] getPlaylist failed:", e.message);
    return null;
  }
}

function formatSearchArtist(item) {
  if (!item || !item.id) return null;
  return {
    id: withPrefix(item.id),
    name: String(item.name || ""),
    images: imageURL(item.picture || "", "750x750"),
    provider_id: "tidal-web",
    item_type: "artist",
    followers: 0,
    popularity: Number(item.popularity || 0)
  };
}

function formatSearchAlbum(item) {
  return formatArtistAlbum(item, item && item.type);
}

function formatSearchPlaylist(item) {
  if (!item || !item.uuid) return null;
  return {
    id: String(item.uuid),
    name: String(item.title || ""),
    owner: String(item.creator && item.creator.name || "TIDAL"),
    images: imageURL(firstNonEmpty(item.squareImage, item.image), "origin"),
    cover_url: imageURL(firstNonEmpty(item.squareImage, item.image), "origin"),
    total_tracks: Number(item.numberOfTracks || 0),
    provider_id: "tidal-web",
    item_type: "playlist"
  };
}

function searchOne(query, filter, limit) {
  var response;
  var items;
  var results = [];
  query = String(query || "").trim();
  if (!query) return results;

  switch (String(filter || "").trim().toLowerCase()) {
    case "track":
      response = searchEndpoint("tracks", query, limit);
      items = response.items || [];
      for (var i = 0; i < items.length; i++) {
        var track = formatTrack(items[i]);
        if (track) results.push(track);
      }
      return results;
    case "artist":
      response = searchEndpoint("artists", query, limit);
      items = response.items || [];
      for (var j = 0; j < items.length; j++) {
        var artist = formatSearchArtist(items[j]);
        if (artist) results.push(artist);
      }
      return results;
    case "album":
      response = searchEndpoint("albums", query, limit);
      items = response.items || [];
      for (var k = 0; k < items.length; k++) {
        var album = formatSearchAlbum(items[k]);
        if (album) results.push(album);
      }
      return results;
    case "playlist":
      response = searchEndpoint("playlists", query, limit);
      items = response.items || [];
      for (var m = 0; m < items.length; m++) {
        var playlist = formatSearchPlaylist(items[m]);
        if (playlist) results.push(playlist);
      }
      return results;
    default:
      return results;
  }
}

function customSearch(query, options) {
  query = String(query || "").trim();
  if (!query) return [];

  options = options || {};
  var limit = Number(options.limit || 20);
  if (!limit || limit <= 0) limit = 20;
  if (limit > 50) limit = 50;

  var filter = String(options.filter || "").trim().toLowerCase();
  if (!filter || filter === "all") filter = "";

  try {
    if (filter) {
      return searchOne(query, filter, limit);
    }

    var results = [];
    results = results.concat(searchOne(query, "track", limit));
    results = results.concat(searchOne(query, "artist", 5));
    results = results.concat(searchOne(query, "album", 5));
    results = results.concat(searchOne(query, "playlist", 5));
    return results;
  } catch (e) {
    log.error("[TidalWeb] customSearch failed:", e.message);
    if (isVerificationRequiredError(e)) throw e;
    return [];
  }
}

function searchTracks(query, limit) {
  return searchOne(query, "track", limit || 20);
}

function checkAvailability(isrc, trackName, artistName, options) {
  try {
    options = options || {};
    var expectedDurationMs = Number(options.duration_ms || 0);
    var reqQuality = String(options.quality || "").trim();
    var directTrackId = String(options.tidal_id || "").trim();
    if (directTrackId) {
      try {
        var directTrack = formatTrack(fetchTrack(stripPrefix(directTrackId)));
        if (tidalTrackMatchesRequest(directTrack, isrc, trackName, artistName, expectedDurationMs)) {
          return {
            available: true,
            track_id: stripPrefix(directTrackId)
          };
        }
      } catch (directError) {
      }
    }

    var query = ((trackName || "") + " " + (artistName || "")).trim();
    if (!query && isrc) {
      query = String(isrc || "").trim();
    }
    if (!query) {
      return {
        available: false,
        reason: "No TIDAL search query available"
      };
    }

    var tracks = searchOne(query, "track", 12);
    var best = selectBestSearchTrack(tracks, isrc, trackName, artistName, expectedDurationMs, reqQuality);
    if (!best || !best.id) {
      return {
        available: false,
        reason: "No verified TIDAL track match found"
      };
    }

    return {
      available: true,
      track_id: stripPrefix(best.id)
    };
  } catch (e) {
    return {
      available: false,
      reason: e && e.message ? e.message : String(e)
    };
  }
}

function download(trackID, quality, outputPath, onProgress) {
  try {
    var rawTrack = fetchTrack(trackID);
    var formattedTrack = formatTrack(rawTrack);
    if (!formattedTrack) {
      return {
        success: false,
        error_message: "Track metadata was not available from TIDAL",
        error_type: "api_error"
      };
    }

    var outputDir = parentDirectory(outputPath);
    if (formattedTrack.isrc && outputDir && gobackend && typeof gobackend.checkISRCExists === "function") {
      var existing = gobackend.checkISRCExists(outputDir, formattedTrack.isrc);
      if (existing && existing.exists && existing.filePath) {
        return {
          success: true,
          already_exists: true,
          file_path: String(existing.filePath || ""),
          title: formattedTrack.name,
          artist: formattedTrack.artists,
          album: formattedTrack.album_name,
          album_artist: formattedTrack.album_artist,
          track_number: formattedTrack.track_number,
          disc_number: formattedTrack.disc_number,
          release_date: formattedTrack.release_date,
          cover_url: formattedTrack.cover_url,
          isrc: formattedTrack.isrc,
          copyright: formattedTrack.copyright || ""
        };
      }
    }

    progressPercent(onProgress, 5);

    var downloadInfo = null;
    var actualOutputPath = "";
    var qualityInfo = null;
    var validation = { valid: true, preview: false, message: "" };
    var rejectedCandidates = {};

    for (var attempt = 0; attempt < 2; attempt++) {
      downloadInfo = fetchDownloadInfo(trackID, quality, rejectedCandidates);
      actualOutputPath = ensureOutputExtension(
        outputPath,
        inferOutputExtension(downloadInfo, quality)
      );

      deleteQuietly(actualOutputPath);

      var downloadResult;
      if (downloadInfo.kind === "direct") {
        downloadResult = downloadDirectFile(downloadInfo.directURL, actualOutputPath, onProgress, 10, 80);
      } else {
        downloadResult = downloadManifestSegments(downloadInfo, actualOutputPath, onProgress);
      }

      if (!downloadResult || !downloadResult.success) {
        deleteQuietly(actualOutputPath);
        var errorMessage = downloadResult && downloadResult.error ? downloadResult.error : "TIDAL download failed";
        return {
          success: false,
          error_message: errorMessage,
          error_type: errorMessage === "download cancelled" ? "cancelled" : "download_error"
        };
      }

      qualityInfo = readDownloadedAudioQuality(actualOutputPath);
      validation = validateDownloadedDuration(
        formattedTrack.duration_ms,
        audioDurationSeconds(qualityInfo)
      );
      if (validation.valid) {
        break;
      }
      deleteQuietly(actualOutputPath);
      if (!validation.preview || attempt === 1) {
        return {
          success: false,
          error_message: validation.message,
          error_type: "duration_mismatch"
        };
      }
      rememberRejectedDownloadCandidate(rejectedCandidates, downloadInfo);
      log.warn("[TidalWeb] Preview-length download detected, retrying once: " + validation.message);
    }

    progressPercent(onProgress, 94);

    var bitDepth = Number(downloadInfo.bitDepth || 0);
    var sampleRate = Number(downloadInfo.sampleRate || 0);
    var audioCodec = "";
    if (qualityInfo) {
      if (Number(qualityInfo.bitDepth || 0) > 0) {
        bitDepth = Number(qualityInfo.bitDepth);
      }
      if (Number(qualityInfo.sampleRate || 0) > 0) {
        sampleRate = Number(qualityInfo.sampleRate);
      }
      audioCodec = normalizeAudioCodec(qualityInfo.codec || "");
    }

    var lyricsLRC = tryFetchLyricsLRC(formattedTrack);
    progressPercent(onProgress, 100);
    var actualExtension = inferOutputExtension(downloadInfo, quality);

    return {
      success: true,
      file_path: actualOutputPath,
      bit_depth: bitDepth,
      sample_rate: sampleRate,
      audio_codec: audioCodec,
      actual_extension: actualExtension,
      output_extension: actualExtension,
      requires_container_conversion: !isLossyAudioCodec(audioCodec) && actualExtension === ".m4a",
      title: formattedTrack.name,
      artist: formattedTrack.artists,
      album: formattedTrack.album_name,
      album_artist: formattedTrack.album_artist,
      track_number: formattedTrack.track_number,
      disc_number: formattedTrack.disc_number,
      release_date: formattedTrack.release_date,
      cover_url: formattedTrack.cover_url,
      isrc: formattedTrack.isrc,
      copyright: formattedTrack.copyright || "",
      lyrics_lrc: lyricsLRC
    };
  } catch (e) {
    var errorMessage = e && e.message ? e.message : String(e);
    return {
      success: false,
      error_message: errorMessage,
      error_type: errorMessage.indexOf("VERIFY_REQUIRED") >= 0 ? "verification_required" : "runtime_error"
    };
  }
}

function handleUrl(url) {
  try {
    var parsed = parseURL(url);
    if (!parsed) {
      return {
        success: false,
        error: "Unsupported TIDAL URL"
      };
    }

    if (parsed.type === "track") {
      return {
        type: "track",
        track: getTrack(parsed.id)
      };
    }

    if (parsed.type === "album") {
      var album = getAlbum(parsed.id);
      return {
        type: "album",
        name: album ? album.name : "",
        cover_url: album ? album.cover_url : "",
        album: album,
        tracks: album ? album.tracks : []
      };
    }

    if (parsed.type === "artist") {
      return {
        type: "artist",
        artist: getArtist(parsed.id)
      };
    }

    if (parsed.type === "playlist") {
      var playlist = getPlaylist(parsed.id);
      return {
        type: "playlist",
        name: playlist ? playlist.name : "",
        cover_url: playlist ? playlist.cover_url : "",
        tracks: playlist ? playlist.tracks : []
      };
    }

    return {
      success: false,
      error: "Unsupported TIDAL URL type"
    };
  } catch (e) {
    log.error("[TidalWeb] handleUrl failed:", e.message);
    return {
      success: false,
      error: e.message || "Failed to fetch TIDAL URL metadata"
    };
  }
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
  checkAvailability: checkAvailability,
  download: download,
  handleUrl: handleUrl,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getArtist: getArtist,
  getPlaylist: getPlaylist,
  searchTracks: searchTracks
});

log.info("[TidalWeb] TIDAL web metadata extension loaded");

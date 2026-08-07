var CONFIG = {
  apiBaseURL: "https://api.zarz.moe/v2/qbz",
  fallbackApiBaseURL: "",
  appID: "798273057",
  previewApiBaseURL: "https://www.qobuz.com",
  previewAppID: "712109809",
  previewAppSecret: "589be88e4538daea11f509d29e4a23b1",
  storeBaseURL: "https://www.qobuz.com/us-en",
  openBaseURL: "https://open.qobuz.com",
  playBaseURL: "https://play.qobuz.com",
  countryCode: "US",
  maxArtistAlbums: 100,
  pageSize: 50,
  downloadProviders: [
    { name: "zarz-v2", url: "/dl/qbz" }
  ]
};

var STORE_TRACK_ID_REGEX = /\/v4\/ajax\/popin-add-cart\/track\/([0-9]+)/g;
var LOCALE_SEGMENT_REGEX = /^[a-z]{2}-[a-z]{2}$/i;
var IMAGE_SIZE_REGEX = /_\d+\.jpg$/;

function md5(input) {
  function add32(a, b) {
    return (a + b) & 0xFFFFFFFF;
  }

  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }

  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }

  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }

  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }

  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | (~d)), a, b, x, s, t);
  }

  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];

    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }

  function md5blk(s) {
    var md5blks = [];
    for (var i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  function md51(s) {
    var n = s.length;
    var state = [1732584193, -271733879, -1732584194, 271733878];
    var i;
    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    var tail = [];
    for (i = 0; i < 16; i++) tail[i] = 0;
    for (i = 0; i < s.length; i++) {
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }

  function rhex(n) {
    var s = "";
    var hex = "0123456789abcdef";
    for (var j = 0; j < 4; j++) {
      s += hex.charAt((n >> (j * 8 + 4)) & 0x0F) + hex.charAt((n >> (j * 8)) & 0x0F);
    }
    return s;
  }

  var utf8 = unescape(encodeURIComponent(String(input || "")));
  var state = md51(utf8);
  return rhex(state[0]) + rhex(state[1]) + rhex(state[2]) + rhex(state[3]);
}

function initialize(settings) {
  settings = settings || {};

  // V2 metadata is signed and bound to the manifest baseUrl. Ignore persisted
  // V1 API URL settings so upgrades cannot silently fall back to /v1.

  var appID = String(settings.appId || "").trim();
  if (appID) {
    CONFIG.appID = appID;
  }

  var countryCode = String(settings.countryCode || "").trim().toUpperCase();
  if (countryCode) {
    CONFIG.countryCode = countryCode;
  }

  return true;
}

function cleanup() {
  return true;
}

function normalizeBaseURL(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (text.indexOf("http://") === 0) {
    text = "https://" + text.substring("http://".length);
  }
  return text.replace(/\/+$/, "");
}

function firstNonEmpty() {
  for (var i = 0; i < arguments.length; i++) {
    var value = String(arguments[i] || "").trim();
    if (value) return value;
  }
  return "";
}

function uniquePush(target, value, seen) {
  var text = String(value || "").trim();
  if (!text) return;
  var key = text.toLowerCase();
  if (seen[key]) return;
  seen[key] = true;
  target.push(text);
}

function appUserAgent() {
  if (utils && typeof utils.appUserAgent === "function") {
    return String(utils.appUserAgent() || "").trim() || "SpotiFLAC-Mobile";
  }
  return "SpotiFLAC-Mobile";
}

function requestUserAgent(url) {
  var text = String(url || "").trim().toLowerCase();
  if (text.indexOf("https://api.zarz.moe") === 0 || text.indexOf("http://api.zarz.moe") === 0) {
    return appUserAgent();
  }
  if (utils && typeof utils.randomUserAgent === "function") {
    return String(utils.randomUserAgent() || "").trim() || appUserAgent();
  }
  return appUserAgent();
}

function requestHeaders(url, extra) {
  var headers = {
    "Accept": "application/json",
    "User-Agent": requestUserAgent(url)
  };
  extra = extra || {};
  for (var key in extra) {
    if (extra.hasOwnProperty(key)) {
      headers[key] = extra[key];
    }
  }
  return headers;
}

function getHeaderValue(headers, name) {
  if (!headers) return "";
  var lower = String(name || "").toLowerCase();
  for (var key in headers) {
    if (!headers.hasOwnProperty(key)) continue;
    if (String(key).toLowerCase() === lower) {
      return String(headers[key] || "");
    }
  }
  return "";
}

function looksLikeHTML(body) {
  var text = String(body || "").trim();
  if (!text) return false;
  return text.indexOf("<!DOCTYPE html") === 0 || text.indexOf("<html") === 0;
}

function isCloudflareChallenge(body) {
  var text = String(body || "");
  return looksLikeHTML(text) && text.indexOf("Just a moment") >= 0;
}

function parseJSONResponse(response, url) {
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url + summarizeErrorBody(response.body));
  }
  if (isCloudflareChallenge(response.body)) {
    throw new Error("Cloudflare challenge for " + url);
  }
  if (looksLikeHTML(response.body)) {
    throw new Error("Unexpected HTML for " + url);
  }
  return JSON.parse(response.body);
}

function summarizeErrorBody(body) {
  var text = String(body || "").trim();
  if (!text) return "";
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      text = String(parsed.error || parsed.message || parsed.detail || JSON.stringify(parsed));
    }
  } catch (e) {
    // Keep the raw text.
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 180) {
    text = text.substring(0, 177) + "...";
  }
  return text ? ": " + text : "";
}

function getJSON(url, headers) {
  return parseJSONResponse(http.get(url, headers || requestHeaders(url)), url);
}

function postJSON(url, body, headers) {
  return parseJSONResponse(
    http.post(url, JSON.stringify(body), requestHeaders(url, headers || {
      "Content-Type": "application/json"
    })),
    url
  );
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
    throw new Error("HTTP " + response.statusCode + " for " + path + summarizeErrorBody(response.body));
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
  var response = http.get(url, headers || requestHeaders(url, {
    "Accept": "text/html,application/xhtml+xml"
  }));
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return String(response.body || "");
}

function trimPrefix(value, prefix) {
  var raw = String(value || "").trim();
  return raw.indexOf(prefix) === 0 ? raw.substring(prefix.length) : raw;
}

function withPrefix(id) {
  var raw = String(id || "").trim();
  if (!raw) return "";
  return raw.indexOf("qobuz:") === 0 ? raw : "qobuz:" + raw;
}

function stripPrefix(value) {
  return trimPrefix(value, "qobuz:");
}

function parseNumericID(value, resourceType) {
  var raw = String(value || "").trim();
  if (!raw) return "";

  var direct = raw.match(/^\d+$/);
  if (direct) return direct[0];

  var prefixed = raw.match(/^qobuz:(\d+)$/i);
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
  var raw = String(value || "").trim();
  if (!raw) return "";

  if (/^[A-Za-z0-9]+$/.test(raw) && !/^qobuz:/i.test(raw)) return raw;

  var prefixed = raw.match(/^qobuz:([A-Za-z0-9]+)$/i);
  if (prefixed) return prefixed[1];

  var match = raw.match(/album\/([^/?#]+)/i);
  if (match) return match[1];

  return "";
}

function parseArtistID(value) {
  return parseNumericID(value, "interpreter");
}

function parsePlaylistID(value) {
  return parseNumericID(value, "playlist");
}

function splitPathSegments(path) {
  var rawSegments = String(path || "").split("/");
  var segments = [];
  for (var i = 0; i < rawSegments.length; i++) {
    var segment = String(rawSegments[i] || "").trim();
    if (!segment) continue;
    segments.push(segment);
  }
  if (segments.length && LOCALE_SEGMENT_REGEX.test(segments[0])) {
    return segments.slice(1);
  }
  return segments;
}

function resourceTypeFromSegment(segment) {
  switch (String(segment || "").trim().toLowerCase()) {
    case "album":
      return "album";
    case "interpreter":
    case "artist":
      return "artist";
    case "playlist":
    case "playlists":
      return "playlist";
    case "track":
      return "track";
    default:
      return "";
  }
}

function parseURL(url) {
  var text = String(url || "").trim();
  if (!text) return null;

  var appMatch = text.match(/^qobuzapp:\/\/([^/]+)\/([^?#/]+)/i);
  if (appMatch) {
    var appType = resourceTypeFromSegment(appMatch[1]);
    if (!appType) return null;
    return { type: appType, id: appMatch[2] };
  }

  var prefixed = text.match(/^qobuz:(track|album|artist|playlist):([^?#/]+)$/i);
  if (prefixed) {
    return { type: prefixed[1].toLowerCase(), id: prefixed[2] };
  }

  var urlObj;
  try {
    urlObj = new URL(text.indexOf("://") >= 0 ? text : ("https://" + text));
  } catch (e) {
    return null;
  }

  var host = String(urlObj.host || "").toLowerCase();
  if (
    host !== "qobuz.com" &&
    host !== "www.qobuz.com" &&
    host !== "play.qobuz.com" &&
    host !== "open.qobuz.com"
  ) {
    return null;
  }

  var segments = splitPathSegments(urlObj.pathname || "");
  if (segments.length < 2) return null;

  var type = resourceTypeFromSegment(segments[0]);
  var id = String(segments[segments.length - 1] || "").trim();
  if (!type || !id) return null;

  return { type: type, id: id };
}

function normalizeDate(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (text.length >= 10) return text.substring(0, 10);
  return text;
}

function upscaleImageURL(url) {
  var text = String(url || "").trim();
  if (!text) return "";
  return text.replace(IMAGE_SIZE_REGEX, "_max.jpg");
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

function normalizeSearchText(value) {
  return removeDiacritics(String(value || ""))
    .toLowerCase()
    .replace(/[&]/g, " and ")
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    if (part) {
      results.push(part);
    }
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

function artistNamesMatch(expected, found) {
  var a = normalizeSearchText(expected);
  var b = normalizeSearchText(found);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;

  var aParts = splitArtists(expected);
  var bParts = splitArtists(found);
  for (var i = 0; i < aParts.length; i++) {
    for (var j = 0; j < bParts.length; j++) {
      if (!aParts[i] || !bParts[j]) continue;
      if (aParts[i] === bParts[j]) return true;
      if (aParts[i].indexOf(bParts[j]) >= 0 || bParts[j].indexOf(aParts[i]) >= 0) {
        return true;
      }
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

function qobuzTrackMatchesRequest(track, isrc, trackName, artistName, expectedDurationMs) {
  if (!track) return false;

  var expectedISRC = String(isrc || "").trim().toUpperCase();
  var foundISRC = String(track.isrc || "").trim().toUpperCase();
  var exactISRCMatch = !!expectedISRC && !!foundISRC && expectedISRC === foundISRC;

  if (!exactISRCMatch) {
    if (trackName && !titlesMatch(trackName, track.title || trackDisplayTitle(track))) {
      return false;
    }
    if (artistName && !artistNamesMatch(artistName, trackArtistName(track))) {
      return false;
    }
  }

  if (!durationMatches(expectedDurationMs, trackDurationMs(track))) {
    return false;
  }

  return true;
}

function scoreTrackCandidate(query, track) {
  var queryNorm = normalizeSearchText(query);
  if (!queryNorm || !track) return 0;

  var titleNorm = normalizeSearchText(track.title || "");
  var displayNorm = normalizeSearchText(trackDisplayTitle(track));
  var artistNorm = normalizeSearchText(trackArtistName(track));
  var albumNorm = normalizeSearchText(track.album && track.album.title || "");
  var score = 0;

  if (titlesMatch(query, track.title) || titlesMatch(query, trackDisplayTitle(track))) {
    score += 900;
  }

  if (queryNorm === titleNorm || queryNorm === displayNorm) {
    score += 1200;
  } else if (
    (titleNorm && titleNorm.indexOf(queryNorm) >= 0) ||
    (displayNorm && displayNorm.indexOf(queryNorm) >= 0)
  ) {
    score += 420;
  }

  if (artistNorm && queryNorm.indexOf(artistNorm) >= 0) score += 180;
  if (albumNorm && queryNorm.indexOf(albumNorm) >= 0) score += 100;
  if (String(track.isrc || "").trim()) score += 15;
  if (Number(track.maximum_bit_depth || 0) >= 24) score += 10;
  if (Number(track.maximum_sampling_rate || 0) >= 88.2) score += 10;

  return score;
}

function selectBestSearchTrack(tracks, isrc, trackName, artistName, expectedDurationMs) {
  if (!tracks || !tracks.length) return null;

  var normalizedISRC = String(isrc || "").trim().toUpperCase();
  if (normalizedISRC) {
    for (var i = 0; i < tracks.length; i++) {
      if (qobuzTrackMatchesRequest(tracks[i], normalizedISRC, trackName, artistName, expectedDurationMs)) {
        return tracks[i];
      }
    }
  }

  if (!String(trackName || "").trim()) {
    return null;
  }

  var matches = [];
  for (var j = 0; j < tracks.length; j++) {
    var candidate = tracks[j];
    if (qobuzTrackMatchesRequest(candidate, isrc, trackName, artistName, expectedDurationMs)) {
      matches.push(candidate);
    }
  }
  if (matches.length) {
    matches.sort(function(a, b) {
      if (Number(a.maximum_bit_depth || 0) !== Number(b.maximum_bit_depth || 0)) {
        return Number(b.maximum_bit_depth || 0) - Number(a.maximum_bit_depth || 0);
      }
      return Number(a.id || 0) - Number(b.id || 0);
    });
    return matches[0];
  }

  return null;
}

function ensureNotCancelled() {
  return !!(utils && typeof utils.isDownloadCancelled === "function" && utils.isDownloadCancelled());
}

function metadataURL(path, params, useFallback) {
  var base = useFallback ? CONFIG.fallbackApiBaseURL : CONFIG.apiBaseURL;
  var query = [];
  params = params || {};

  for (var key in params) {
    if (!params.hasOwnProperty(key)) continue;
    var value = params[key];
    if (value === null || value === undefined || value === "") continue;
    query.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }

  if (!useFallback && CONFIG.appID) {
    query.push("app_id=" + encodeURIComponent(CONFIG.appID));
  }

  return base + "/" + String(path || "").replace(/^\/+/, "") + (query.length ? ("?" + query.join("&")) : "");
}

function qobuzSignedURL(objectName, methodName, params) {
  var requestTS = String(Math.floor((new Date()).getTime() / 1000));
  var keys = [];
  var query = [];
  var raw = String(objectName || "") + String(methodName || "");
  params = params || {};

  for (var key in params) {
    if (!params.hasOwnProperty(key)) continue;
    keys.push(key);
  }
  keys.sort();

  for (var i = 0; i < keys.length; i++) {
    raw += keys[i] + String(params[keys[i]]);
  }
  raw += requestTS + CONFIG.previewAppSecret;

  for (var j = 0; j < keys.length; j++) {
    query.push(encodeURIComponent(keys[j]) + "=" + encodeURIComponent(String(params[keys[j]])));
  }
  query.push("request_ts=" + encodeURIComponent(requestTS));
  query.push("request_sig=" + encodeURIComponent(md5(raw)));

  return CONFIG.previewApiBaseURL + "/api.json/0.2/" + objectName + "/" + methodName + "?" + query.join("&");
}

function qobuzPreviewURL(track) {
  if (!track) return "";

  var trackID = String(track.id || "").trim();
  if (!trackID) return "";

  if (track.previewable === false && track.sampleable === false && track.streamable === false) {
    return "";
  }

  try {
    var url = qobuzSignedURL("track", "getFileUrl", {
      track_id: trackID,
      format_id: "5",
      intent: "stream"
    });
    var payload = getJSON(url, requestHeaders(url, {
      "X-App-Id": CONFIG.previewAppID
    }));
    var preview = String(payload && payload.url || "").trim();
    if (!preview) return "";
    if (payload.sample === false && Number(payload.duration || 0) > 45) return "";
    return preview;
  } catch (e) {
    log.warn("[QobuzWeb] Preview URL unavailable for track " + trackID + ": " + e.message);
    return "";
  }
}

function getMetadataJSON(path, params) {
  var primaryURL = metadataURL(path, params, false);
  var relative = primaryURL.replace(/^https:\/\/api\.zarz\.moe\/v2/i, "");
  return signedJSON("GET", relative, null, {});
}

function trackDisplayTitle(track) {
  if (!track) return "";
  var title = String(track.title || "").trim();
  var version = String(track.version || "").trim();
  if (!title || !version) return title;
  return title + " (" + version + ")";
}

function joinArtistNames(artists, fallback) {
  var names = [];
  var seen = {};
  artists = artists || [];
  for (var i = 0; i < artists.length; i++) {
    uniquePush(names, artists[i] && artists[i].name, seen);
  }
  if (names.length) return names.join(", ");
  return String(fallback || "").trim();
}

function trackArtistName(track) {
  if (!track) return "";
  return firstNonEmpty(track.performer && track.performer.name, track.album && track.album.artist && track.album.artist.name);
}

function trackAlbumArtist(track) {
  if (!track || !track.album) return "";
  return joinArtistNames(track.album.artists || [], track.album.artist && track.album.artist.name);
}

function albumTypeFromRelease(releaseType, productType, totalTracks) {
  var kind = String(releaseType || productType || "").trim().toLowerCase();
  switch (kind) {
    case "album":
    case "single":
    case "ep":
    case "compilation":
      return kind;
  }
  if (Number(totalTracks || 0) > 0 && Number(totalTracks || 0) <= 3) {
    return "single";
  }
  return "album";
}

function trackAlbumImage(track) {
  if (!track || !track.album) return "";
  return upscaleImageURL(firstNonEmpty(
    track.album.image && track.album.image.large,
    track.album.image && track.album.image.small,
    track.album.image && track.album.image.thumbnail
  ));
}

function albumImage(album) {
  if (!album) return "";
  return upscaleImageURL(firstNonEmpty(
    album.image && album.image.large,
    album.image && album.image.small,
    album.image && album.image.thumbnail
  ));
}

function artistImage(artist) {
  if (!artist) return "";
  return firstNonEmpty(
    artist.image && artist.image.large,
    artist.image && artist.image.small,
    artist.image && artist.image.thumbnail
  );
}

function computeTotalDiscs(tracks) {
  var maxDisc = 0;
  tracks = tracks || [];
  for (var i = 0; i < tracks.length; i++) {
    var disc = Number(tracks[i] && tracks[i].media_number || 0);
    if (disc > maxDisc) maxDisc = disc;
  }
  return maxDisc;
}

function qobuzAudioQualityLabel(track) {
  var bitDepth = Number(track.maximum_bit_depth || 0);
  var sampleRate = Number(track.maximum_sampling_rate || 0);
  if (bitDepth <= 0 || sampleRate <= 0) return "";
  var rateDisplay = sampleRate % 1 === 0 ? String(sampleRate) : sampleRate.toFixed(1);
  return bitDepth + "bit/" + rateDisplay + "kHz";
}

function formatTrack(track, totalDiscsOverride, options) {
  if (!track) return null;
  options = options || {};

  var totalTracks = Number(track.album && track.album.tracks_count || 0);
  var totalDiscs = Number(totalDiscsOverride || 0);
  if (!totalDiscs && track.album && track.album.total_discs) {
    totalDiscs = Number(track.album.total_discs || 0);
  }

  var formatted = {
    id: withPrefix(track.id),
    name: trackDisplayTitle(track),
    artists: trackArtistName(track),
    artist_id: withPrefix(firstNonEmpty(
      track.performer && track.performer.id,
      track.album && track.album.artist && track.album.artist.id
    )),
    album_name: String(track.album && track.album.title || "").trim(),
    album_artist: trackAlbumArtist(track),
    album_id: withPrefix(track.album && track.album.id || ""),
    duration_ms: Number(track.duration || 0) * 1000,
    cover_url: trackAlbumImage(track),
    release_date: normalizeDate(track.album && track.album.release_date_original || ""),
    track_number: Number(track.track_number || 0),
    total_tracks: totalTracks,
    disc_number: Number(track.media_number || 0),
    total_discs: totalDiscs,
    isrc: String(track.isrc || "").trim(),
    provider_id: "qobuz-web",
    item_type: "track",
    album_type: albumTypeFromRelease(
      track.album && track.album.release_type,
      track.album && track.album.product_type,
      totalTracks
    ),
    qobuz_id: String(track.id || "").trim(),
    external_links: {
      qobuz: CONFIG.playBaseURL + "/track/" + String(track.id || "").trim()
    },
    label: String(track.album && track.album.label && track.album.label.name || "").trim(),
    genre: String(track.album && track.album.genre && track.album.genre.name || "").trim(),
    copyright: String(track.album && track.album.copyright || "").trim(),
    composer: String(track.composer && track.composer.name || "").trim(),
    audio_quality: qobuzAudioQualityLabel(track)
  };

  if (options.includePreview) {
    var previewURL = qobuzPreviewURL(track);
    if (previewURL) formatted.preview_url = previewURL;
  }

  return formatted;
}

function formatAlbum(album) {
  if (!album) return null;

  var totalDiscs = computeTotalDiscs(album.tracks && album.tracks.items || []);
  var tracks = [];
  var items = album.tracks && album.tracks.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    item.album = item.album || {};
    item.album.id = album.id;
    item.album.qobuz_id = album.qobuz_id;
    item.album.title = album.title;
    item.album.release_date_original = album.release_date_original;
    item.album.tracks_count = album.tracks_count;
    item.album.product_type = album.product_type;
    item.album.release_type = album.release_type;
    item.album.artist = album.artist;
    item.album.artists = album.artists;
    item.album.image = album.image;
    item.album.label = album.label;
    item.album.genre = album.genre;
    item.album.copyright = album.copyright;
    item.album.total_discs = totalDiscs;
    var formattedTrack = formatTrack(item, totalDiscs);
    if (formattedTrack) {
      tracks.push(formattedTrack);
    }
  }

  return {
    id: withPrefix(album.id),
    name: String(album.title || "").trim(),
    artists: joinArtistNames(album.artists || [], album.artist && album.artist.name),
    artist_id: withPrefix(album.artist && album.artist.id || ""),
    cover_url: albumImage(album),
    images: albumImage(album),
    release_date: normalizeDate(album.release_date_original),
    total_tracks: Number(album.tracks_count || 0),
    album_type: albumTypeFromRelease(album.release_type, album.product_type, album.tracks_count),
    tracks: tracks,
    provider_id: "qobuz-web",
    item_type: "album"
  };
}

function formatArtistAlbum(album) {
  if (!album) return null;
  return {
    id: withPrefix(album.id),
    name: String(album.title || "").trim(),
    artists: joinArtistNames(album.artists || [], album.artist && album.artist.name),
    cover_url: albumImage(album),
    images: albumImage(album),
    release_date: normalizeDate(album.release_date_original),
    total_tracks: Number(album.tracks_count || 0),
    album_type: albumTypeFromRelease(album.release_type, album.product_type, album.tracks_count),
    tracks: [],
    provider_id: "qobuz-web",
    item_type: "album"
  };
}

function formatArtist(artist, albums) {
  albums = albums || [];
  var formattedAlbums = [];
  for (var i = 0; i < albums.length; i++) {
    var formattedAlbum = formatArtistAlbum(albums[i]);
    if (formattedAlbum) formattedAlbums.push(formattedAlbum);
  }

  return {
    id: withPrefix(artist && artist.id || ""),
    name: String(artist && artist.name || "").trim(),
    image_url: artistImage(artist),
    header_image: artistImage(artist),
    cover_url: artistImage(artist),
    images: artistImage(artist),
    albums: formattedAlbums,
    releases: formattedAlbums,
    provider_id: "qobuz-web",
    item_type: "artist"
  };
}

function formatPlaylist(rawPlaylist) {
  if (!rawPlaylist) return null;
  var tracks = [];
  var items = rawPlaylist.tracks && rawPlaylist.tracks.items || [];
  for (var i = 0; i < items.length; i++) {
    var formattedTrack = formatTrack(items[i], computeTotalDiscs(items));
    if (formattedTrack) tracks.push(formattedTrack);
  }

  return {
    id: withPrefix(rawPlaylist.id),
    name: String(rawPlaylist.name || "").trim(),
    artists: String(rawPlaylist.owner && rawPlaylist.owner.name || "").trim(),
    cover_url: firstNonEmpty(
      rawPlaylist.image_rectangle && rawPlaylist.image_rectangle[0],
      rawPlaylist.image_rectangle_mini && rawPlaylist.image_rectangle_mini[0]
    ),
    images: firstNonEmpty(
      rawPlaylist.image_rectangle && rawPlaylist.image_rectangle[0],
      rawPlaylist.image_rectangle_mini && rawPlaylist.image_rectangle_mini[0]
    ),
    tracks: tracks,
    provider_id: "qobuz-web",
    item_type: "playlist"
  };
}

function fetchTrackRaw(trackID) {
  var normalizedID = parseTrackID(trackID);
  if (!normalizedID) {
    throw new Error("Invalid Qobuz track ID");
  }
  return getMetadataJSON("track/get", {
    track_id: normalizedID
  });
}

function fetchAlbumRaw(albumID) {
  var normalizedID = parseAlbumID(albumID);
  if (!normalizedID) {
    throw new Error("Invalid Qobuz album ID");
  }
  return getMetadataJSON("album/get", {
    album_id: normalizedID
  });
}

function fetchPlaylistPage(playlistID, limit, offset) {
  var normalizedID = parsePlaylistID(playlistID);
  if (!normalizedID) {
    throw new Error("Invalid Qobuz playlist ID");
  }

  try {
    return getMetadataJSON("playlist/get", {
      playlist_id: normalizedID,
      extra: "tracks",
      limit: limit,
      offset: offset
    });
  } catch (primaryError) {
    log.warn("[QobuzWeb] playlist/get fallback failed, retrying without extra: " + primaryError.message);
    return getMetadataJSON("playlist/get", {
      playlist_id: normalizedID,
      limit: limit,
      offset: offset
    });
  }
}

function fetchArtistAlbums(artistID) {
  var normalizedID = parseArtistID(artistID);
  if (!normalizedID) {
    throw new Error("Invalid Qobuz artist ID");
  }
  var payload = getMetadataJSON("artist/get", {
    artist_id: normalizedID,
    extra: "albums",
    limit: CONFIG.maxArtistAlbums,
    offset: 0
  });
  var albums = (payload && payload.albums && payload.albums.items) || [];
  return {
    artist: payload,
    albums: albums
  };
}

function fetchPlaylistRaw(playlistID) {
  var offset = 0;
  var combined = null;

  while (true) {
    if (ensureNotCancelled()) {
      throw new Error("download cancelled");
    }

    var page = fetchPlaylistPage(playlistID, CONFIG.pageSize, offset);
    var pageTracks = page.tracks || {};
    var pageItems = pageTracks.items || [];

    if (!combined) {
      combined = page;
      // Reassign with a fresh tracks object so emptying the accumulator does
      // not also clear the just-fetched page's items (same reference).
      combined.tracks = {
        total: Number(pageTracks.total || 0),
        offset: 0,
        limit: CONFIG.pageSize,
        items: []
      };
    }

    for (var i = 0; i < pageItems.length; i++) {
      combined.tracks.items.push(pageItems[i]);
    }

    var total = Number(pageTracks.total || page.tracks_count || 0);
    if (!pageItems.length || offset + pageItems.length >= total || pageItems.length < CONFIG.pageSize) {
      break;
    }
    offset += pageItems.length;
  }

  return combined;
}

function getTrack(trackID) {
  return formatTrack(fetchTrackRaw(trackID));
}

function getAlbum(albumID) {
  return formatAlbum(fetchAlbumRaw(albumID));
}

function getArtist(artistID) {
  var payload = fetchArtistAlbums(artistID);
  return formatArtist(payload.artist, payload.albums);
}

function getPlaylist(playlistID) {
  return formatPlaylist(fetchPlaylistRaw(playlistID));
}

function extractTrackIDsFromStoreSearchHTML(html) {
  var ids = [];
  var seen = {};
  var match;
  STORE_TRACK_ID_REGEX.lastIndex = 0;
  while ((match = STORE_TRACK_ID_REGEX.exec(html)) !== null) {
    uniquePush(ids, match[1], seen);
  }
  return ids;
}

function searchTracksViaAPI(query, limit) {
  var payload = getMetadataJSON("track/search", {
    query: String(query || "").trim(),
    limit: limit
  });
  return payload && payload.tracks && payload.tracks.items ? payload.tracks.items : [];
}

function searchArtistsViaAPI(query, limit) {
  var payload = getMetadataJSON("artist/search", {
    query: String(query || "").trim(),
    limit: limit
  });
  return payload && payload.artists && payload.artists.items ? payload.artists.items : [];
}

function searchAlbumsViaAPI(query, limit) {
  var payload = getMetadataJSON("album/search", {
    query: String(query || "").trim(),
    limit: limit
  });
  return payload && payload.albums && payload.albums.items ? payload.albums.items : [];
}

function selectTracksFromAlbumSearch(query, summaries, limit) {
  var candidates = [];
  var seen = {};

  for (var i = 0; i < summaries.length; i++) {
    var albumID = String(summaries[i] && summaries[i].id || "").trim();
    if (!albumID) continue;

    var album;
    try {
      album = fetchAlbumRaw(albumID);
    } catch (e) {
      continue;
    }

    var items = album.tracks && album.tracks.items || [];
    for (var j = 0; j < items.length; j++) {
      var track = items[j];
      track.album = track.album || {};
      track.album.id = album.id;
      track.album.qobuz_id = album.qobuz_id;
      track.album.title = album.title;
      track.album.release_date_original = album.release_date_original;
      track.album.tracks_count = album.tracks_count;
      track.album.product_type = album.product_type;
      track.album.release_type = album.release_type;
      track.album.artist = album.artist;
      track.album.artists = album.artists;
      track.album.image = album.image;
      track.album.label = album.label;
      track.album.genre = album.genre;
      track.album.copyright = album.copyright;

      var key = String(track.id || "").trim();
      if (key && seen[key]) continue;
      seen[key] = true;

      var score = scoreTrackCandidate(query, track);
      if (score <= 0) continue;
      candidates.push({
        score: score,
        track: track
      });
    }
  }

  candidates.sort(function(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (Number(a.track.maximum_bit_depth || 0) !== Number(b.track.maximum_bit_depth || 0)) {
      return Number(b.track.maximum_bit_depth || 0) - Number(a.track.maximum_bit_depth || 0);
    }
    return Number(a.track.id || 0) - Number(b.track.id || 0);
  });

  var results = [];
  for (var k = 0; k < candidates.length; k++) {
    results.push(candidates[k].track);
    if (limit > 0 && results.length >= limit) break;
  }
  return results;
}

function searchTracksViaAlbumSearch(query, limit) {
  var albumLimit = limit;
  if (albumLimit < 3) albumLimit = 3;
  if (albumLimit > 8) albumLimit = 8;

  var summaries = searchAlbumsViaAPI(query, albumLimit);
  return selectTracksFromAlbumSearch(query, summaries, limit);
}

function searchTracksViaStore(query, limit) {
  var searchURL = CONFIG.storeBaseURL + "/search/tracks/" + encodeURIComponent(String(query || "").trim());
  var html = fetchText(searchURL, requestHeaders(searchURL, {
    "Accept": "text/html,application/xhtml+xml"
  }));
  var trackIDs = extractTrackIDsFromStoreSearchHTML(html);
  if (limit > 0 && trackIDs.length > limit) {
    trackIDs = trackIDs.slice(0, limit);
  }

  var tracks = [];
  for (var i = 0; i < trackIDs.length; i++) {
    try {
      tracks.push(fetchTrackRaw(trackIDs[i]));
    } catch (e) {
      log.warn("[QobuzWeb] Store hydration failed for track " + trackIDs[i] + ": " + e.message);
    }
  }
  return tracks;
}

function searchTracksWithFallback(query, limit) {
  var apiError = null;
  var tracks = [];

  try {
    tracks = searchTracksViaAPI(query, limit);
    if (tracks && tracks.length) return tracks;
  } catch (e) {
    apiError = e;
    if (isVerificationRequiredError(e)) throw e;
  }

  try {
    tracks = searchTracksViaAlbumSearch(query, limit);
    if (tracks && tracks.length) return tracks;
  } catch (albumError) {
    if (isVerificationRequiredError(albumError)) throw albumError;
    if (apiError) {
      log.warn("[QobuzWeb] Album search fallback failed after API error: " + albumError.message);
    }
  }

  tracks = searchTracksViaStore(query, limit);
  if (tracks && tracks.length) return tracks;

  if (apiError) throw apiError;
  throw new Error("No Qobuz track matches found");
}

function searchOne(query, filter, limit) {
  var cleanQuery = String(query || "").trim();
  var normalizedFilter = String(filter || "").trim().toLowerCase();
  if (!cleanQuery) return [];

  if (!limit || limit <= 0) {
    limit = normalizedFilter === "track" ? 20 : 10;
  }

  if (normalizedFilter === "track") {
    var rawTracks = searchTracksWithFallback(cleanQuery, limit);
    var trackResults = [];
    for (var i = 0; i < rawTracks.length; i++) {
      var formattedTrack = formatTrack(rawTracks[i], null, {
        includePreview: true
      });
      if (formattedTrack) trackResults.push(formattedTrack);
    }
    return trackResults;
  }

  if (normalizedFilter === "artist") {
    var artists = searchArtistsViaAPI(cleanQuery, limit);
    var artistResults = [];
    for (var j = 0; j < artists.length; j++) {
      artistResults.push({
        id: withPrefix(artists[j].id),
        name: String(artists[j].name || "").trim(),
        image_url: artistImage(artists[j]),
        header_image: artistImage(artists[j]),
        cover_url: artistImage(artists[j]),
        images: artistImage(artists[j]),
        provider_id: "qobuz-web",
        item_type: "artist"
      });
    }
    return artistResults;
  }

  if (normalizedFilter === "album") {
    var albums = searchAlbumsViaAPI(cleanQuery, limit);
    var albumResults = [];
    for (var k = 0; k < albums.length; k++) {
      albumResults.push({
        id: withPrefix(albums[k].id),
        name: String(albums[k].title || "").trim(),
        artists: joinArtistNames(albums[k].artists || [], albums[k].artist && albums[k].artist.name),
        artist_id: withPrefix(albums[k].artist && albums[k].artist.id || ""),
        cover_url: albumImage(albums[k]),
        images: albumImage(albums[k]),
        release_date: normalizeDate(albums[k].release_date_original),
        total_tracks: Number(albums[k].tracks_count || 0),
        album_type: albumTypeFromRelease(albums[k].release_type, albums[k].product_type, albums[k].tracks_count),
        tracks: [],
        provider_id: "qobuz-web",
        item_type: "album"
      });
    }
    return albumResults;
  }

  return [];
}

function customSearch(query, options) {
  options = options || {};
  try {
    var filter = String(options.filter || "").trim().toLowerCase();
    var limit = Number(options.limit || 20);
    if (!limit || limit <= 0) limit = 20;
    if (limit > 50) limit = 50;
    if (!filter || filter === "all") {
      filter = "";
    }

    if (filter) {
      return searchOne(query, filter, limit);
    }

    var results = [];
    results = results.concat(searchOne(query, "track", limit || 20));
    results = results.concat(searchOne(query, "artist", 5));
    results = results.concat(searchOne(query, "album", 5));
    return results;
  } catch (e) {
    log.error("[QobuzWeb] customSearch failed:", e.message);
    if (isVerificationRequiredError(e)) throw e;
    return [];
  }
}

function searchTracks(query, limit) {
  return searchOne(query, "track", limit || 20);
}

function parentDirectory(path) {
  var text = String(path || "").trim();
  if (!text) return "";
  var normalized = text.replace(/\\/g, "/");
  var idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.substring(0, idx);
}

function ensureOutputExtension(outputPath, extension) {
  var text = String(outputPath || "").trim();
  var ext = String(extension || "").trim();
  if (!text || !ext) return text;
  if (ext.charAt(0) !== ".") ext = "." + ext;

  var dot = text.lastIndexOf(".");
  if (dot < 0) return text + ext;
  if (text.substring(dot).toLowerCase() === ext.toLowerCase()) return text;
  return text.substring(0, dot) + ext;
}

function deleteQuietly(path) {
  var text = String(path || "").trim();
  if (!text || !file || typeof file.delete !== "function") return;
  try {
    file.delete(text);
  } catch (e) {}
}

function progressPercent(onProgress, percent) {
  if (typeof onProgress !== "function") return;
  var value = Number(percent || 0);
  if (value < 0) value = 0;
  if (value > 100) value = 100;
  onProgress(Math.round(value));
}

function mapMusicDLQuality(qualityCode) {
  switch (String(qualityCode || "").trim()) {
    case "27":
      return "hi-res-max";
    case "7":
      return "hi-res";
    default:
      return "cd";
  }
}

function normalizeQualityCode(quality) {
  switch (String(quality || "").trim().toUpperCase()) {
    case "HI_RES":
      return "7";
    case "HI_RES_LOSSLESS":
    case "DEFAULT":
    case "":
      return "27";
    case "LOSSLESS":
    default:
      return "6";
  }
}

function qualityFallbackChain(quality) {
  var code = normalizeQualityCode(quality);
  if (code === "27") return ["27", "7", "6"];
  if (code === "7") return ["7", "6"];
  return ["6"];
}

function parseDownloadInfo(payload) {
  payload = payload || {};

  if (payload.error && String(payload.error).trim()) {
    throw new Error(String(payload.error).trim());
  }
  if (payload.detail && String(payload.detail).trim()) {
    throw new Error(String(payload.detail).trim());
  }
  if (payload.success === false) {
    throw new Error(String(payload.message || "provider returned success=false"));
  }

  var nested = payload.data || {};
  var url = firstNonEmpty(payload.download_url, payload.url, payload.link, nested.download_url, nested.url, nested.link);
  if (!url) {
    throw new Error("No download URL in provider response");
  }

  var bitDepth = Number(
    payload.bit_depth || nested.bit_depth || 0
  );
  var sampleRate = Number(
    payload.sampling_rate || nested.sampling_rate || 0
  );
  if (sampleRate > 0 && sampleRate < 1000) {
    sampleRate = Math.round(sampleRate * 1000);
  }

  return {
    directURL: String(url).trim(),
    bitDepth: bitDepth,
    sampleRate: sampleRate
  };
}

function providerRequestURL(provider, trackID, qualityCode) {
  return String(provider.url || "");
}

function fetchProviderDownloadInfo(provider, trackID, qualityCode) {
  var attempts = 3;
  var lastError = null;
  for (var attempt = 0; attempt < attempts; attempt++) {
    if (ensureNotCancelled()) {
      throw new Error("download cancelled");
    }

    try {
      var trackURL = CONFIG.openBaseURL + "/track/" + String(trackID || "").trim();
      // The ticket resource_hash must match what the server hashes at consume
      // time. The download body below sends `url`, and the server's /v2/dl/qbz
      // handler derives the hash from `body.url || body.id || body.asin` (so it
      // uses the URL). Minting with the bare trackID produced a different hash
      // and every download failed with "Ticket resource mismatch" (403).
      var ticketID = signedTicket("qbz", "track", trackURL);
      var response = session.signedFetch("POST", providerRequestURL(provider, trackID, qualityCode), {
        quality: mapMusicDLQuality(qualityCode),
        upload_to_r2: false,
        id: String(trackID || "").trim(),
        type: "track",
        url: trackURL
      }, {
        "X-Zarz-Ticket": ticketID
      });

      if (!response || response.error) {
        throw new Error(response && response.error ? response.error : "request failed");
      }

      if (response.statusCode === 429 || response.statusCode >= 500) {
        throw new Error("HTTP " + response.statusCode + summarizeErrorBody(response.body));
      }

      if (response.statusCode !== 200) {
        throw new Error("HTTP " + response.statusCode + summarizeErrorBody(response.body));
      }

      var contentType = getHeaderValue(response.headers, "Content-Type").toLowerCase();
      if (contentType.indexOf("application/json") < 0) {
        throw new Error("Qobuz download API returned non-JSON response");
      }

      if (isCloudflareChallenge(response.body)) {
        throw new Error("Cloudflare challenge");
      }

      var payload = JSON.parse(response.body);
      var info = parseDownloadInfo(payload);
      info.provider = provider.name;
      info.qualityCode = qualityCode;
      info.candidateKey = provider.name + "@" + qualityCode;
      return info;
    } catch (e) {
      lastError = e;
      var message = String(e && e.message ? e.message : e).toLowerCase();
      var retryable =
        message.indexOf("timeout") >= 0 ||
        message.indexOf("http 429") >= 0 ||
        message.indexOf("http 5") >= 0 ||
        message.indexOf("connection") >= 0 ||
        message.indexOf("cloudflare") >= 0;
      if (!retryable || attempt === attempts - 1) {
        break;
      }
    }
  }

  throw lastError || new Error("provider request failed");
}

function resolveDownloadInfo(trackID, requestedQuality, rejectedCandidates) {
  var qualities = qualityFallbackChain(requestedQuality);
  var errors = [];
  rejectedCandidates = rejectedCandidates || {};

  for (var i = 0; i < qualities.length; i++) {
    for (var j = 0; j < CONFIG.downloadProviders.length; j++) {
      var candidateKey = CONFIG.downloadProviders[j].name + "@" + qualities[i];
      if (rejectedCandidates[candidateKey]) {
        errors.push(candidateKey + ": skipped after preview-length download");
        continue;
      }
      try {
        var info = fetchProviderDownloadInfo(CONFIG.downloadProviders[j], trackID, qualities[i]);
        var urlKey = "url:" + String(info.directURL || "").trim();
        if (rejectedCandidates[urlKey]) {
          errors.push(candidateKey + ": skipped duplicate preview URL");
          continue;
        }
        return info;
      } catch (e) {
        var message = e && e.message ? e.message : String(e);
        errors.push(candidateKey + ": " + message);
      }
    }
  }

  throw new Error("All Qobuz download providers failed: " + errors.join("; "));
}

function downloadDirectFile(downloadURL, outputPath, onProgress, progressStart, progressSpan) {
  return file.download(downloadURL, outputPath, {
    headers: {
      "User-Agent": requestUserAgent(downloadURL)
    },
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

function checkAvailability(isrc, trackName, artistName, options) {
  try {
    options = options || {};
    var expectedDurationMs = Number(options.duration_ms || 0);
    var directTrackId = parseTrackID(options.qobuz_id || "");
    if (directTrackId) {
      try {
        var directTrack = fetchTrackRaw(directTrackId);
        if (qobuzTrackMatchesRequest(directTrack, isrc, trackName, artistName, expectedDurationMs)) {
          return {
            available: true,
            track_id: String(directTrack.id || "").trim()
          };
        }
      } catch (directError) {
        log.warn("[QobuzWeb] Direct Qobuz ID verification failed: " + directError.message);
      }
    }

    var query = ((trackName || "") + " " + (artistName || "")).trim();
    if (!query && isrc) {
      query = String(isrc || "").trim();
    }
    if (!query) {
      return {
        available: false,
        reason: "No Qobuz search query available"
      };
    }

    var tracks = searchTracksWithFallback(query, 8);
    var best = selectBestSearchTrack(tracks, isrc, trackName, artistName, expectedDurationMs);
    if (!best || !best.id) {
      return {
        available: false,
        reason: "No verified Qobuz track match found"
      };
    }

    return {
      available: true,
      track_id: String(best.id || "").trim()
    };
  } catch (e) {
    if (isVerificationRequiredError(e)) throw e;
    return {
      available: false,
      reason: e && e.message ? e.message : String(e)
    };
  }
}

function download(trackID, quality, outputPath, onProgress) {
  try {
    var rawTrack = fetchTrackRaw(trackID);
    var formattedTrack = formatTrack(rawTrack);
    if (!formattedTrack) {
      return {
        success: false,
        error_message: "Track metadata was not available from Qobuz",
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
          total_tracks: formattedTrack.total_tracks,
          disc_number: formattedTrack.disc_number,
          total_discs: formattedTrack.total_discs,
          release_date: formattedTrack.release_date,
          cover_url: formattedTrack.cover_url,
          isrc: formattedTrack.isrc,
          label: formattedTrack.label || "",
          genre: formattedTrack.genre || "",
          composer: formattedTrack.composer || "",
          copyright: formattedTrack.copyright || ""
        };
      }
    }

    progressPercent(onProgress, 5);

    var actualOutputPath = ensureOutputExtension(outputPath, ".flac");
    deleteQuietly(actualOutputPath);

    var downloadInfo = null;
    var finalPath = actualOutputPath;
    var qualityInfo = null;
    var validation = { valid: true, preview: false, message: "" };

    var rejectedDownloadCandidates = {};
    var maxDownloadAttempts = qualityFallbackChain(quality).length * Math.max(CONFIG.downloadProviders.length, 1);
    var previewMessages = [];

    for (var attempt = 0; attempt < maxDownloadAttempts; attempt++) {
      try {
        downloadInfo = resolveDownloadInfo(trackID, quality, rejectedDownloadCandidates);
      } catch (resolveError) {
        if (previewMessages.length) {
          return {
            success: false,
            error_message: "All Qobuz candidates returned preview-length audio: " +
              previewMessages.join("; ") + "; " +
              (resolveError && resolveError.message ? resolveError.message : String(resolveError)),
            error_type: "duration_mismatch"
          };
        }
        throw resolveError;
      }
      progressPercent(onProgress, 10);

      var downloadResult = downloadDirectFile(downloadInfo.directURL, actualOutputPath, onProgress, 10, 82);
      if (!downloadResult || !downloadResult.success) {
        deleteQuietly(actualOutputPath);
        return {
          success: false,
          error_message: "Failed to download Qobuz stream: " + (downloadResult && downloadResult.error ? downloadResult.error : "unknown error"),
          error_type: "download_error"
        };
      }

      finalPath = downloadResult.path || actualOutputPath;
      qualityInfo = readDownloadedAudioQuality(finalPath);
      validation = validateDownloadedDuration(
        formattedTrack.duration_ms,
        audioDurationSeconds(qualityInfo)
      );
      if (validation.valid) {
        break;
      }
      deleteQuietly(finalPath);
      if (!validation.preview) {
        return {
          success: false,
          error_message: validation.message,
          error_type: "duration_mismatch"
        };
      }
      previewMessages.push(
        String(downloadInfo.provider || "provider") + "@" +
          String(downloadInfo.qualityCode || "") + ": " + validation.message
      );
      rejectedDownloadCandidates[String(downloadInfo.candidateKey || "")] = true;
      rejectedDownloadCandidates["url:" + String(downloadInfo.directURL || "").trim()] = true;
      log.warn(
        "[QobuzWeb] Preview-length download detected, trying next Qobuz candidate: " +
          validation.message
      );
      validation = {
        valid: false,
        preview: true,
        message: "All Qobuz candidates returned preview-length audio: " + previewMessages.join("; ")
      };
    }

    if (!validation.valid) {
      return {
        success: false,
        error_message: validation.message,
        error_type: "duration_mismatch"
      };
    }

    var bitDepth = Number(downloadInfo.bitDepth || rawTrack.maximum_bit_depth || 0);
    var sampleRate = Number(downloadInfo.sampleRate || 0);
    if (!sampleRate) {
      var rawRate = Number(rawTrack.maximum_sampling_rate || 0);
      if (rawRate > 0) {
        sampleRate = rawRate < 1000 ? Math.round(rawRate * 1000) : Math.round(rawRate);
      }
    }

    if (qualityInfo) {
      if (Number(qualityInfo.bitDepth || 0) > 0) {
        bitDepth = Number(qualityInfo.bitDepth);
      }
      if (Number(qualityInfo.sampleRate || 0) > 0) {
        sampleRate = Number(qualityInfo.sampleRate);
      }
    }

    var lyricsLRC = tryFetchLyricsLRC(formattedTrack);
    progressPercent(onProgress, 100);

    return {
      success: true,
      file_path: finalPath,
      bit_depth: bitDepth,
      sample_rate: sampleRate,
      title: formattedTrack.name,
      artist: formattedTrack.artists,
      album: formattedTrack.album_name,
      album_artist: formattedTrack.album_artist,
      track_number: formattedTrack.track_number,
      total_tracks: formattedTrack.total_tracks,
      disc_number: formattedTrack.disc_number,
      total_discs: formattedTrack.total_discs,
      release_date: formattedTrack.release_date,
      cover_url: formattedTrack.cover_url,
      isrc: formattedTrack.isrc,
      label: formattedTrack.label || "",
      genre: formattedTrack.genre || "",
      composer: formattedTrack.composer || "",
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
        error: "Unsupported Qobuz URL"
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
        playlist: playlist,
        tracks: playlist ? playlist.tracks : []
      };
    }

    return {
      success: false,
      error: "Unsupported Qobuz URL type"
    };
  } catch (e) {
    log.error("[QobuzWeb] handleUrl failed:", e.message);
    return {
      success: false,
      error: e.message || "Failed to fetch Qobuz URL metadata"
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

log.info("[QobuzWeb] Qobuz extension loaded");

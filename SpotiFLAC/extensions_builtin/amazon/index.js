// Amazon Music Metadata & Download Provider for SpotiFLAC
// v2.2.0 - Signed v2 Zarz download API.
// Uses reverse-engineered Amazon Music web API (skill.music.a2z.com).

var CONFIG = {
  maxRetries: 2,
  baseBackoffMs: 500,
  cacheTtlMs: 180000,
  maxResults: 15,
  coverImageSize: 1000,
  songlinkBaseURL: "https://api.song.link/v1-alpha.1/links",
  skillBaseURL: "https://na.mesk.skill.music.a2z.com/api",
  musicBaseURL: "https://music.amazon.com",
  deviceType: "A16ZV8BU3SN1N3",
  appVersion: "1.0.9678.0",
  deviceFamily: "WebPlayer",
  deviceModel: "WEBPLAYER",
  musicTerritory: "US"
};

var USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getAppUserAgent() {
  if (utils && typeof utils.appUserAgent === "function") {
    return String(utils.appUserAgent() || "").trim() || "SpotiFLAC-Mobile";
  }
  return "SpotiFLAC-Mobile";
}

function L(level) {
  try {
    if (typeof log !== "undefined" && typeof log[level] === "function") {
      var args = Array.prototype.slice.call(arguments, 1);
      log[level].apply(log, args);
    }
  } catch (e) {}
}

function sleep(ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) {}
}

// ==================== Cache ====================

var _cache = {};
var _cacheTimes = {};

function cacheGet(k) {
  if (!_cacheTimes[k]) return null;
  if (Date.now() - _cacheTimes[k] > CONFIG.cacheTtlMs) {
    delete _cache[k];
    delete _cacheTimes[k];
    return null;
  }
  return _cache[k];
}

function cacheSet(k, v) {
  _cache[k] = v;
  _cacheTimes[k] = Date.now();
}

// ==================== Retry Helper ====================

function fetchWithRetry(requestFn) {
  var lastErr = null;
  var delay = CONFIG.baseBackoffMs;
  for (var attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      L("info", "[Amazon] Retry " + attempt + "/" + CONFIG.maxRetries + " after " + delay + "ms");
      sleep(delay);
      delay *= 2;
    }
    try {
      var result = requestFn();
      if (result) return result;
      lastErr = "returned null";
    } catch (e) {
      lastErr = String(e);
      var lower = lastErr.toLowerCase();
      var is429 = lower.indexOf("429") >= 0;
      var retryable = lower.indexOf("timeout") >= 0 ||
        lower.indexOf("reset") >= 0 ||
        lower.indexOf("refused") >= 0 ||
        lower.indexOf("eof") >= 0 ||
        lower.indexOf("status 5") >= 0 ||
        is429;
      if (!retryable) {
        L("warn", "[Amazon] Non-retryable error:", lastErr);
        return null;
      }
      if (is429) {
        L("info", "[Amazon] 429 in fetchWithRetry, refreshing session");
        refreshSession();
      }
    }
    L("warn", "[Amazon] Attempt " + (attempt + 1) + " failed:", lastErr);
  }
  L("error", "[Amazon] All attempts failed:", lastErr);
  return null;
}

// ==================== ASIN Extraction ====================

var ASIN_REGEX = /^B[0-9A-Z]{9}$/;
var ASIN_FIND_REGEX = /B[0-9A-Z]{9}/;

function normalizeASIN(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  var s = candidate.trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch (e) {}
  s = s.toUpperCase();
  var cut = s.search(/[?#&\/]/);
  if (cut >= 0) s = s.substring(0, cut);
  if (ASIN_REGEX.test(s)) return s;
  return null;
}

function extractASIN(rawURL) {
  if (!rawURL || typeof rawURL !== "string") return null;
  var url = rawURL.trim();
  if (!url) return null;
  try {
    var parsed = new URL(url);
    var paramKeys = ["trackAsin", "trackasin", "trackASIN", "asin", "ASIN", "i"];
    for (var i = 0; i < paramKeys.length; i++) {
      var val = parsed.searchParams.get(paramKeys[i]);
      if (val) {
        var asin = normalizeASIN(val);
        if (asin) return asin;
      }
    }
    var segments = parsed.pathname.replace(/^\/|\/$/g, "").split("/");
    for (var j = 0; j < segments.length - 1; j++) {
      var seg = segments[j].toLowerCase();
      if (seg === "track" || seg === "tracks") {
        var asin = normalizeASIN(segments[j + 1]);
        if (asin) return asin;
      }
    }
    if (segments.length > 0) {
      var asin = normalizeASIN(segments[segments.length - 1]);
      if (asin) return asin;
    }
  } catch (e) {}
  var m = url.toUpperCase().match(ASIN_FIND_REGEX);
  return m ? m[0] : null;
}

// ==================== URL Parsing ====================

function parseAmazonMusicURL(rawURL) {
  if (!rawURL || typeof rawURL !== "string") return null;
  var url = rawURL.trim();
  try {
    var parsed = new URL(url);
    var host = parsed.hostname.toLowerCase();
    if (host.indexOf("music.amazon") === -1) return null;
    var context = createAmazonContext(url);

    var path = parsed.pathname.replace(/^\/|\/$/g, "");
    var segments = path.split("/");
    if (segments.length < 2) return null;

    var kind = segments[0].toLowerCase();
    var id = segments[1];

    if (kind === "albums") {
      var trackAsin = parsed.searchParams.get("trackAsin") || parsed.searchParams.get("trackasin");
      if (trackAsin) {
        return { type: "track", id: normalizeASIN(trackAsin) || trackAsin, albumId: normalizeASIN(id) || id, context: context };
      }
      return { type: "album", id: normalizeASIN(id) || id, context: context };
    }
    if (kind === "tracks" || kind === "track") {
      return { type: "track", id: normalizeASIN(id) || id, context: context };
    }
    if (kind === "artists" || kind === "artist") {
      var slug = segments.length > 2 ? segments[2] : "";
      return { type: "artist", id: normalizeASIN(id) || id, slug: slug, context: context };
    }
    if (kind === "playlists" || kind === "playlist") {
      return { type: "playlist", id: normalizeASIN(id) || id, context: context };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ==================== Session Management ====================

var _session = {
  deviceId: null,
  sessionId: null,
  csrfToken: null,
  csrfTs: null,
  csrfRnd: null,
  appVersion: null,
  displayLanguage: null,
  musicTerritory: null,
  baseURL: null,
  initialized: false
};

var _currentContext = {
  musicBaseURL: CONFIG.musicBaseURL,
  host: "music.amazon.com",
  timeZone: "UTC"
};

var _resourceContexts = {};
var _resourceHints = {};

function guessTimeZone() {
  try {
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
  } catch (e) {}
  return "UTC";
}

function defaultCurrencyForHost(host) {
  host = String(host || "").toLowerCase();
  if (host.indexOf(".co.jp") >= 0) return "JPY";
  if (host.indexOf(".co.uk") >= 0) return "GBP";
  if (host.indexOf(".de") >= 0 || host.indexOf(".fr") >= 0 || host.indexOf(".it") >= 0 || host.indexOf(".es") >= 0) return "EUR";
  if (host.indexOf(".in") >= 0) return "INR";
  if (host.indexOf(".com.br") >= 0) return "BRL";
  if (host.indexOf(".com.mx") >= 0) return "MXN";
  if (host.indexOf(".com.au") >= 0) return "AUD";
  return "USD";
}

function createAmazonContext(rawURL) {
  var base = CONFIG.musicBaseURL;
  var host = "music.amazon.com";

  if (rawURL) {
    try {
      var parsed = new URL(rawURL);
      host = parsed.hostname.toLowerCase() || host;
      base = parsed.protocol + "//" + host;
    } catch (e) {
      try {
        var parsedBase = new URL(base);
        host = parsedBase.hostname.toLowerCase();
      } catch (e2) {}
    }
  } else {
    try {
      var defaultParsed = new URL(base);
      host = defaultParsed.hostname.toLowerCase();
    } catch (e3) {}
  }

  return {
    musicBaseURL: base,
    host: host,
    timeZone: guessTimeZone(),
    currency: defaultCurrencyForHost(host)
  };
}

function contextKey(type, id) {
  return String(type || "") + ":" + String(id || "");
}

function rememberResourceContext(type, id, context) {
  if (!type || !id || !context) return;
  _resourceContexts[contextKey(type, id)] = {
    musicBaseURL: context.musicBaseURL,
    host: context.host,
    timeZone: context.timeZone,
    currency: context.currency
  };
}

function rememberResourceHint(type, id, hint) {
  if (!type || !id || !hint) return;
  var key = contextKey(type, id);
  if (!_resourceHints[key]) _resourceHints[key] = {};
  var keys = Object.keys(hint);
  for (var i = 0; i < keys.length; i++) {
    if (hint[keys[i]] !== undefined && hint[keys[i]] !== null && hint[keys[i]] !== "") {
      _resourceHints[key][keys[i]] = hint[keys[i]];
    }
  }
}

function getResourceContext(type, id, fallback) {
  var remembered = _resourceContexts[contextKey(type, id)];
  if (remembered) return remembered;
  if (fallback) return fallback;
  return _currentContext || createAmazonContext(CONFIG.musicBaseURL);
}

function getResourceHint(type, id, key) {
  var hint = _resourceHints[contextKey(type, id)];
  return hint ? hint[key] : "";
}

function slugToName(slug) {
  if (!slug) return "";
  var cleaned = String(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.replace(/\b\w/g, function(ch) { return ch.toUpperCase(); });
}

function looksLikeURL(value) {
  if (!value || typeof value !== "string") return false;
  var s = value.trim();
  return /^https?:\/\//i.test(s) || s.indexOf("music.amazon.") >= 0;
}

function sanitizeDisplayText(value) {
  var text = textValue(value);
  if (!text) return "";
  if (looksLikeURL(text)) return "";
  return text.trim();
}

function initSession(context) {
  var ctx = context || _currentContext || createAmazonContext(CONFIG.musicBaseURL);
  if (_session.initialized && _session.baseURL === ctx.musicBaseURL) return;
  _currentContext = ctx;

  // Fetch config.json from Amazon Music to get valid session credentials
  L("info", "[Amazon] Fetching config.json for session...");
  try {
    var configUrl = ctx.musicBaseURL + "/config.json";
    var res = fetch(configUrl, {
      method: "GET",
      headers: {
        "User-Agent": getRandomUA(),
        "Accept": "application/json"
      }
    });
    L("info", "[Amazon] initSession config.json status:", res ? res.status : "null");

    if (res && res.ok) {
      var config = res.json();
      if (config) {
        _session.deviceId = config.deviceId || "";
        _session.sessionId = config.sessionId || "";
        _session.appVersion = config.version || CONFIG.appVersion;
        _session.displayLanguage = config.displayLanguage || "en_US";
        _session.musicTerritory = config.musicTerritory || CONFIG.musicTerritory;
        _session.baseURL = ctx.musicBaseURL;

        if (config.csrf) {
          _session.csrfToken = config.csrf.token || "";
          _session.csrfTs = config.csrf.ts || String(Math.floor(Date.now() / 1000));
          _session.csrfRnd = config.csrf.rnd || String(Math.floor(Math.random() * 2000000000));
        }

        _session.initialized = true;
        L("info", "[Amazon] Session initialized, deviceId:", _session.deviceId);
        return;
      }
    }
  } catch (e) {
    L("warn", "[Amazon] config.json fetch failed:", String(e));
  }

  // Fallback: generate random session (may get 429)
  L("warn", "[Amazon] Using fallback random session");
  _session.deviceId = String(Math.floor(Math.random() * 99999999999999999));
  _session.sessionId = Math.floor(Math.random() * 999) + "-" +
    Math.floor(Math.random() * 9999999) + "-" +
    Math.floor(Math.random() * 9999999);
  _session.csrfToken = "";
  _session.csrfTs = String(Math.floor(Date.now() / 1000));
  _session.csrfRnd = String(Math.floor(Math.random() * 2000000000));
  _session.appVersion = CONFIG.appVersion;
  _session.displayLanguage = "en_US";
  _session.musicTerritory = CONFIG.musicTerritory;
  _session.baseURL = ctx.musicBaseURL;
  _session.initialized = true;
}

function refreshSession() {
  // Force re-fetch config.json if getting 429s
  _session.initialized = false;
  initSession();
}

function buildHeaders(context, pageUrl) {
  var ctx = context || _currentContext || createAmazonContext(pageUrl || CONFIG.musicBaseURL);
  var csrf = JSON.stringify({
    "interface": "CSRFInterface.v1_0.CSRFHeaderElement",
    "token": _session.csrfToken || "",
    "timestamp": _session.csrfTs || String(Math.floor(Date.now() / 1000)),
    "rndNonce": _session.csrfRnd || String(Math.floor(Math.random() * 2000000000))
  });
  var auth = JSON.stringify({
    "interface": "ClientAuthenticationInterface.v1_0.ClientTokenElement",
    "accessToken": ""
  });
  return JSON.stringify({
    "x-amzn-authentication": auth,
    "x-amzn-device-model": CONFIG.deviceModel,
    "x-amzn-device-width": "1920",
    "x-amzn-device-family": CONFIG.deviceFamily,
    "x-amzn-device-id": _session.deviceId,
    "x-amzn-user-agent": getRandomUA(),
    "x-amzn-session-id": _session.sessionId,
    "x-amzn-device-height": "1080",
    "x-amzn-request-id": Math.random().toString(36).substring(2) + "-" + Date.now(),
    "x-amzn-device-language": _session.displayLanguage || "en_US",
    "x-amzn-currency-of-preference": ctx.currency || defaultCurrencyForHost(ctx.host),
    "x-amzn-os-version": "1.0",
    "x-amzn-application-version": _session.appVersion || CONFIG.appVersion,
    "x-amzn-device-time-zone": ctx.timeZone || "UTC",
    "x-amzn-timestamp": String(Date.now()),
    "x-amzn-csrf": csrf,
    "x-amzn-music-domain": ctx.host || "music.amazon.com",
    "x-amzn-referer": "",
    "x-amzn-affiliate-tags": "",
    "x-amzn-ref-marker": "",
    "x-amzn-page-url": pageUrl || ctx.musicBaseURL || CONFIG.musicBaseURL,
    "x-amzn-weblab-id-overrides": "",
    "x-amzn-video-player-token": "",
    "x-amzn-feature-flags": "",
    "x-amzn-has-profile-id": "",
    "x-amzn-age-band": ""
  });
}

// ==================== Amazon Music API Calls ====================

function _doShowHome(apiBaseURL, deeplink, pageUrl, body, context) {
  var ctx = context || _currentContext || createAmazonContext(pageUrl || CONFIG.musicBaseURL);
  var res;
  try {
    L("info", "[Amazon] showHome fetching:", apiBaseURL + "/showHome");
    res = fetch(apiBaseURL + "/showHome", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": getRandomUA(),
        "Origin": ctx.musicBaseURL,
        "Referer": pageUrl
      },
      body: body
    });
  } catch (e) {
    L("error", "[Amazon] showHome fetch exception:", String(e));
    return null;
  }
  L("info", "[Amazon] showHome response:", res ? res.status : "null");
  if (!res || !res.ok) return null;
  try {
    // Get raw text first (free - Go already has it), then parse JSON
    var rawText = res.text();
    var parsed = JSON.parse(rawText);
    L("info", "[Amazon] showHome OK, methods:", parsed && parsed.methods ? parsed.methods.length : 0);
    return { data: parsed, rawText: rawText };
  } catch (e) {
    L("error", "[Amazon] showHome JSON parse failed:", String(e));
    return null;
  }
}

function callShowHome(deeplink, context, _retried) {
  var ctx = context || _currentContext || createAmazonContext(CONFIG.musicBaseURL + deeplink);
  _currentContext = ctx;
  initSession(ctx);
  var pageUrl = ctx.musicBaseURL + deeplink;
  L("info", "[Amazon] callShowHome:", deeplink);

  var body = JSON.stringify({
    deeplink: JSON.stringify({
      "interface": "DeeplinkInterface.v1_0.DeeplinkClientInformation",
      "deeplink": deeplink
    }),
    headers: buildHeaders(ctx, pageUrl)
  });

  var result = _doShowHome(CONFIG.skillBaseURL, deeplink, pageUrl, body, ctx);
  if (result) return result;

  // If failed, refresh session and retry once
  if (!_retried) {
    L("info", "[Amazon] showHome failed, refreshing session and retrying...");
    refreshSession();
    sleep(CONFIG.baseBackoffMs);
    return callShowHome(deeplink, ctx, true);
  }

  L("error", "[Amazon] callShowHome failed for:", deeplink);
  return null;
}

function _doShowHomeBrowse(apiBaseURL, pageUrl, body, context) {
  var ctx = context || _currentContext || createAmazonContext(pageUrl || CONFIG.musicBaseURL);
  var res;
  try {
    L("info", "[Amazon] showHomeBrowse fetching:", apiBaseURL + "/showHomeBrowse");
    res = fetch(apiBaseURL + "/showHomeBrowse", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": getRandomUA(),
        "Origin": ctx.musicBaseURL,
        "Referer": pageUrl
      },
      body: body
    });
  } catch (e) {
    L("error", "[Amazon] showHomeBrowse fetch exception:", String(e));
    return null;
  }
  L("info", "[Amazon] showHomeBrowse response:", res ? res.status : "null");
  if (!res || !res.ok) return null;
  try {
    var rawText = res.text();
    var parsed = JSON.parse(rawText);
    L("info", "[Amazon] showHomeBrowse OK, methods:", parsed && parsed.methods ? parsed.methods.length : 0);
    return { data: parsed, rawText: rawText };
  } catch (e) {
    L("error", "[Amazon] showHomeBrowse JSON parse failed:", String(e));
    return null;
  }
}

function callShowHomeBrowse(context, nextToken, _retried) {
  var ctx = context || _currentContext || createAmazonContext(CONFIG.musicBaseURL);
  _currentContext = ctx;
  initSession(ctx);
  var pageUrl = ctx.musicBaseURL + "/";
  L("info", "[Amazon] callShowHomeBrowse, nextToken:", nextToken ? "yes" : "initial");

  var bodyObj = {
    userHash: JSON.stringify({ level: "LIBRARY_MEMBER" }),
    headers: buildHeaders(ctx, pageUrl)
  };

  if (nextToken) {
    bodyObj.next = JSON.stringify(nextToken);
  }

  var body = JSON.stringify(bodyObj);

  // Try mesk (mobile) endpoint first, then web endpoint
  var result = _doShowHomeBrowse(CONFIG.skillBaseURL, pageUrl, body, ctx);
  if (!result) {
    // Fallback to web endpoint
    var webApiUrl = CONFIG.skillBaseURL.replace("na.mesk.skill", "na.web.skill");
    L("info", "[Amazon] showHomeBrowse: mesk failed, trying web endpoint:", webApiUrl);
    result = _doShowHomeBrowse(webApiUrl, pageUrl, body, ctx);
  }

  if (result) return result;

  // If failed, refresh session and retry once
  if (!_retried) {
    L("info", "[Amazon] showHomeBrowse failed, refreshing session and retrying...");
    refreshSession();
    sleep(CONFIG.baseBackoffMs);
    return callShowHomeBrowse(ctx, nextToken, true);
  }

  L("error", "[Amazon] callShowHomeBrowse failed");
  return null;
}

function callShowCatalogArtist(artistId, slug, context, _retried) {
  var ctx = context || _currentContext || createAmazonContext(CONFIG.musicBaseURL);
  _currentContext = ctx;
  initSession(ctx);
  // pageUrl uses only /artists/{id} (no slug) for showCatalogArtist
  var pageUrl = ctx.musicBaseURL + "/artists/" + artistId;
  L("info", "[Amazon] callShowCatalogArtist:", artistId);

  var body = JSON.stringify({
    id: artistId,
    userHash: JSON.stringify({ "level": "LIBRARY_MEMBER" }),
    headers: buildHeaders(ctx, pageUrl)
  });

  var apiUrl = CONFIG.skillBaseURL.replace(/\/api$/, "") + "/api/explore/v1/showCatalogArtist";
  var res;
  try {
    L("info", "[Amazon] showCatalogArtist fetching:", apiUrl);
    res = fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": getRandomUA(),
        "Origin": ctx.musicBaseURL,
        "Referer": ctx.musicBaseURL + "/"
      },
      body: body
    });
  } catch (e) {
    L("error", "[Amazon] showCatalogArtist fetch exception:", String(e));
    return null;
  }
  L("info", "[Amazon] showCatalogArtist response:", res ? res.status : "null");
  if (!res || !res.ok) {
    if (!_retried) {
      L("info", "[Amazon] showCatalogArtist failed, refreshing session and retrying...");
      refreshSession();
      sleep(CONFIG.baseBackoffMs);
      return callShowCatalogArtist(artistId, slug, ctx, true);
    }
    return null;
  }
  try {
    var rawText = res.text();
    var parsed = JSON.parse(rawText);
    L("info", "[Amazon] showCatalogArtist OK, methods:", parsed && parsed.methods ? parsed.methods.length : 0);
    return { data: parsed, rawText: rawText };
  } catch (e) {
    L("error", "[Amazon] showCatalogArtist JSON parse failed:", String(e));
    return null;
  }
}

function callDisplayCatalogTrack(trackId, context, _retried) {
  var ctx = context || _currentContext || createAmazonContext(CONFIG.musicBaseURL);
  _currentContext = ctx;
  initSession(ctx);
  var pageUrl = ctx.musicBaseURL + "/tracks/" + trackId;
  L("info", "[Amazon] callDisplayCatalogTrack:", trackId);

  var body = JSON.stringify({
    id: trackId,
    userHash: JSON.stringify({ "level": "LIBRARY_MEMBER" }),
    headers: buildHeaders(ctx, pageUrl)
  });

  var apiUrl = CONFIG.skillBaseURL.replace(/\/api$/, "") + "/api/cosmicTrack/displayCatalogTrack";
  var res;
  try {
    res = fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": getRandomUA(),
        "Origin": ctx.musicBaseURL,
        "Referer": ctx.musicBaseURL + "/"
      },
      body: body
    });
  } catch (e) {
    L("error", "[Amazon] displayCatalogTrack fetch exception:", String(e));
    return null;
  }
  L("info", "[Amazon] displayCatalogTrack response:", res ? res.status : "null");
  if (!res || !res.ok) {
    if (!_retried) {
      refreshSession();
      sleep(CONFIG.baseBackoffMs);
      return callDisplayCatalogTrack(trackId, ctx, true);
    }
    return null;
  }
  try {
    var rawText = res.text();
    var parsed = JSON.parse(rawText);
    L("info", "[Amazon] displayCatalogTrack OK, methods:", parsed && parsed.methods ? parsed.methods.length : 0);
    return { data: parsed, rawText: rawText };
  } catch (e) {
    L("error", "[Amazon] displayCatalogTrack JSON parse failed:", String(e));
    return null;
  }
}

function _doShowSearch(apiBaseURL, keyword, pageUrl, body, context) {
  var ctx = context || _currentContext || createAmazonContext(pageUrl || CONFIG.musicBaseURL);
  var res;
  try {
    L("info", "[Amazon] showSearch fetching:", apiBaseURL + "/showSearch");
    res = fetch(apiBaseURL + "/showSearch", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": getRandomUA(),
        "Origin": ctx.musicBaseURL,
        "Referer": pageUrl
      },
      body: body
    });
  } catch (e) {
    L("error", "[Amazon] showSearch fetch exception:", String(e));
    return null;
  }
  L("info", "[Amazon] showSearch response:", res ? res.status : "null");
  if (!res || !res.ok) return null;
  try {
    return res.json();
  } catch (e) {
    L("error", "[Amazon] showSearch JSON parse failed:", String(e));
    return null;
  }
}

function callShowSearch(keyword, context, _retried) {
  var ctx = context || _currentContext || createAmazonContext(CONFIG.musicBaseURL);
  _currentContext = ctx;
  initSession(ctx);
  var pageUrl = ctx.musicBaseURL + "/search/" + encodeURIComponent(keyword);
  L("info", "[Amazon] callShowSearch:", keyword);

  var body = JSON.stringify({
    filter: JSON.stringify({ "IsLibrary": ["false"] }),
    keyword: JSON.stringify({
      "interface": "Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation",
      "keyword": keyword
    }),
    suggestedKeyword: keyword,
    userHash: JSON.stringify({ "level": "LIBRARY_MEMBER" }),
    headers: buildHeaders(ctx, pageUrl)
  });

  var result = _doShowSearch(CONFIG.skillBaseURL, keyword, pageUrl, body, ctx);
  if (result) return result;

  if (!_retried) {
    L("info", "[Amazon] showSearch failed, refreshing session and retrying...");
    refreshSession();
    sleep(CONFIG.baseBackoffMs);
    return callShowSearch(keyword, ctx, true);
  }

  L("error", "[Amazon] callShowSearch failed for:", keyword);
  return null;
}

// ==================== Response Parsing Helpers ====================

function deepStringify(obj) {
  try { return JSON.stringify(obj); } catch (e) { return ""; }
}

function collectInterfaces(obj, results, depth) {
  if (!obj || depth > 15) return results;
  if (!results) results = {};
  if (!depth) depth = 0;
  if (typeof obj !== "object") return results;
  if (obj["interface"] && typeof obj["interface"] === "string") {
    var iface = obj["interface"];
    results[iface] = (results[iface] || 0) + 1;
  }
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    if (typeof val === "object" && val !== null) {
      collectInterfaces(val, results, depth + 1);
    }
  }
  return results;
}

function findAllByInterface(obj, targetInterface, results, depth) {
  if (!obj || depth > 20) return;
  if (!results) results = [];
  if (!depth) depth = 0;

  if (typeof obj !== "object") return results;

  if (obj["interface"] === targetInterface) {
    results.push(obj);
  }

  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    if (typeof val === "object" && val !== null) {
      findAllByInterface(val, targetInterface, results, depth + 1);
    }
  }
  return results;
}

function findWidgetsWithItems(obj, results, depth) {
  if (!obj || depth > 15) return results;
  if (!results) results = [];
  if (!depth) depth = 0;
  if (typeof obj !== "object") return results;

  // Look for objects that have both a "header" (or "headerText") and an "items" array
  if (Array.isArray(obj.items) && obj.items.length > 0) {
    var hasHeader = obj.header || obj.headerText || obj.title || obj.sectionTitle;
    if (hasHeader) {
      results.push(obj);
      return results; // Don't recurse into children of this widget
    }
  }

  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    if (typeof val === "object" && val !== null) {
      findWidgetsWithItems(val, results, depth + 1);
    }
  }
  return results;
}

function findFirst(obj, key, depth) {
  if (!obj || depth > 20) return undefined;
  if (!depth) depth = 0;
  if (typeof obj !== "object") return undefined;

  if (obj[key] !== undefined) return obj[key];

  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    if (typeof val === "object" && val !== null) {
      var found = findFirst(val, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function amazonItemIsExplicit(item) {
  // Amazon marks explicit tracks with a tag array containing "E" and an
  // "explicitAriaLabel" ("Explicit Content") on the row element. Clean tracks
  // carry an empty tags array, so presence of "E"/explicitAriaLabel is reliable.
  if (!item || typeof item !== "object") return false;
  var tags = findFirst(item, "tags", 0);
  if (tags && Object.prototype.toString.call(tags) === "[object Array]") {
    for (var i = 0; i < tags.length; i++) {
      if (String(tags[i]).toUpperCase() === "E") return true;
    }
  }
  var aria = findFirst(item, "explicitAriaLabel", 0);
  if (aria && String(aria).toLowerCase().indexOf("explicit") >= 0) return true;
  return false;
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (typeof value.text === "string" && value.text) return value.text;
    if (value.defaultValue) {
      var nestedDefault = textValue(value.defaultValue);
      if (nestedDefault) return nestedDefault;
    }
    if (value.observer && value.observer.defaultValue) {
      var nestedObserver = textValue(value.observer.defaultValue);
      if (nestedObserver) return nestedObserver;
    }
  }
  return "";
}

function extractAmazonDeeplinkInfo(deeplink) {
  if (!deeplink) return null;
  try {
    var parsed = new URL(deeplink, (_currentContext && _currentContext.musicBaseURL) || CONFIG.musicBaseURL);
    var pathname = parsed.pathname.replace(/^\/|\/$/g, "");
    var segments = pathname ? pathname.split("/") : [];
    if (!segments.length) return null;
    var kind = segments[0].toLowerCase();
    var rawID = segments.length > 1 ? segments[1] : "";
    if (kind === "albums" && parsed.searchParams.get("trackAsin")) {
      return {
        type: "track",
        id: normalizeASIN(parsed.searchParams.get("trackAsin")) || parsed.searchParams.get("trackAsin"),
        albumId: normalizeASIN(rawID) || rawID
      };
    }
    return {
      type: kind,
      id: normalizeASIN(rawID) || rawID
    };
  } catch (e) {
    return null;
  }
}

function extractDeeplinkId(deeplink) {
  var info = extractAmazonDeeplinkInfo(deeplink);
  return info ? info.id : null;
}

function extractDeeplinkType(deeplink) {
  if (!deeplink) return null;
  var parts = deeplink.replace(/^\//, "").split("/");
  return parts[0] || null;
}

function fixImageUrl(url, size) {
  if (!url) return "";
  if (!size) size = CONFIG.coverImageSize;
  // Remove Amazon image sizing params and set to desired size
  var cleaned = url.replace(/\._[^.]+_\./, ".");
  if (cleaned.indexOf("images/I/") >= 0 || cleaned.indexOf("images/S/") >= 0) {
    // Add sizing if not present
    var ext = cleaned.substring(cleaned.lastIndexOf("."));
    var base = cleaned.substring(0, cleaned.lastIndexOf("."));
    return base + "._SL" + size + "_" + ext;
  }
  return cleaned;
}

function ensureHighResCoverUrl(url) {
  return fixImageUrl(url, CONFIG.coverImageSize);
}

function parseDurationISO(iso) {
  // Parse PT3M24S -> seconds
  if (!iso) return 0;
  var match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  var h = parseInt(match[1] || "0", 10);
  var m = parseInt(match[2] || "0", 10);
  var s = parseInt(match[3] || "0", 10);
  return h * 3600 + m * 60 + s;
}

function parseDurationMMSS(mmss) {
  // Parse "03:24" -> 204 seconds
  mmss = textValue(mmss);
  if (!mmss) return 0;
  var parts = mmss.split(":");
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  }
  return 0;
}

// ==================== Schema.org Extractor ====================

function _extractSchemaAtPosition(responseStr, idx) {
  var innerStart = responseStr.lastIndexOf('"innerHTML"', idx);
  if (innerStart === -1) return null;

  var colonIdx = responseStr.indexOf(":", innerStart);
  if (colonIdx === -1) return null;

  var quoteStart = responseStr.indexOf('"', colonIdx + 1);
  if (quoteStart === -1) return null;

  var content = "";
  var pos = quoteStart + 1;
  while (pos < responseStr.length) {
    if (responseStr[pos] === '"' && responseStr[pos - 1] !== '\\') break;
    content += responseStr[pos];
    pos++;
  }

  try {
    content = content.replace(/\\\\/g, "\\");
    content = content.replace(/\\"/g, '"');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function extractSchemaOrg(responseStr, schemaType) {
  var searchStr = '"@type\\":\\"' + schemaType + '\\"';
  var idx = responseStr.indexOf(searchStr);
  if (idx === -1) return null;

  // For MusicAlbum, prefer the album-level schema (has numTracks/track array)
  // over per-track schemas embedded in MusicRecording entries.
  if (schemaType === "MusicAlbum") {
    var firstResult = null;
    var currentIdx = idx;
    while (currentIdx !== -1) {
      var extracted = _extractSchemaAtPosition(responseStr, currentIdx);
      if (extracted) {
        if (extracted.numTracks || extracted.track) {
          return extracted; // Found the album-level schema
        }
        if (!firstResult) firstResult = extracted;
      }
      currentIdx = responseStr.indexOf(searchStr, currentIdx + 1);
    }
    return firstResult; // Fallback to first found
  }

  return _extractSchemaAtPosition(responseStr, idx);
}

// ==================== Track Row Parser ====================

function parseDescriptiveRows(data) {
  var rows = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveRowItemElement", [], 0);
  var tracks = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var name = textValue(row.primaryText);
    var deeplink = "";
    var duration = 0;
    var trackId = "";
    var albumId = "";

    if (row.primaryTextLink && row.primaryTextLink.deeplink) {
      deeplink = row.primaryTextLink.deeplink;
      var deeplinkInfo = extractAmazonDeeplinkInfo(deeplink);
      trackId = deeplinkInfo ? deeplinkInfo.id || "" : "";
      albumId = deeplinkInfo ? deeplinkInfo.albumId || "" : "";
    }

    if (row.secondaryText3) {
      duration = parseDurationMMSS(row.secondaryText3);
    }

    // Artist: secondaryText1 > secondaryText2 (VA albums) > secondaryText
    var artist = "";
    if (row.secondaryText1) {
      artist = textValue(row.secondaryText1);
    }
    if (!artist && row.secondaryText2) {
      artist = textValue(row.secondaryText2);
    }
    if (!artist && row.secondaryText) {
      artist = textValue(row.secondaryText);
    }

    var image = "";
    if (row.image) {
      image = ensureHighResCoverUrl(row.image);
    }

    if (name && trackId) {
      tracks.push({
        id: trackId,
        title: name,
        artist: artist,
        duration: duration,
        duration_ms: duration * 1000,
        cover_art: image,
        deeplink: deeplink,
        track_number: i + 1,
        album_id: albumId,
        explicit: amazonItemIsExplicit(row)
      });
    }
  }
  return tracks;
}

// Parse VisualRowItemElement tracks (used by playlists)
function parseVisualRows(data) {
  var rows = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualRowItemElement", [], 0);
  var tracks = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    var name = textValue(row.primaryText);

    var deeplink = "";
    var trackId = "";
    var albumId = "";

    if (row.primaryLink && row.primaryLink.deeplink) {
      deeplink = row.primaryLink.deeplink;
      var deeplinkInfo = extractAmazonDeeplinkInfo(deeplink);
      trackId = deeplinkInfo ? deeplinkInfo.id || "" : "";
      albumId = deeplinkInfo ? deeplinkInfo.albumId || "" : "";
    }

    var artist = "";
    if (row.secondaryText1) {
      artist = textValue(row.secondaryText1);
    }

    var album = "";
    if (row.secondaryText2) {
      album = textValue(row.secondaryText2);
    }

    var duration = 0;
    if (row.secondaryText3) {
      duration = parseDurationMMSS(textValue(row.secondaryText3));
    }

    var image = "";
    if (row.image) {
      image = ensureHighResCoverUrl(row.image);
    }

    if (name && trackId) {
      tracks.push({
        id: trackId,
        title: name,
        artist: artist,
        album: album,
        duration: duration,
        duration_ms: duration * 1000,
        cover_art: image,
        deeplink: deeplink,
        track_number: i + 1,
        album_id: albumId,
        explicit: amazonItemIsExplicit(row)
      });
    }
  }
  return tracks;
}

// ==================== Album Parser ====================

function parseAlbumFromResponse(data, responseStr, albumId) {
  var result = {
    id: albumId,
    title: "",
    artist: "",
    artist_id: "",
    cover_art: "",
    year: "",
    track_count: 0,
    tracks: [],
    type: "album"
  };

  // Try schema.org first for clean metadata
  if (responseStr) {
    var schema = extractSchemaOrg(responseStr, "MusicAlbum");
    if (schema) {
      result.title = schema.name || "";
      if (schema.byArtist) {
        result.artist = schema.byArtist.name || "";
        if (schema.byArtist["@id"]) {
          var artistUrl = schema.byArtist["@id"];
          var aMatch = artistUrl.match(/\/artists\/([^\/]+)/);
          if (aMatch) result.artist_id = aMatch[1];
        }
      }
    }

    // Extract MusicRecording tracks from schema.org
    var trackSchemaRegex = /"@type\\":\\"MusicRecording\\"/g;
    var trackCount = 0;
    var sIdx = 0;
    while (trackSchemaRegex.exec(responseStr) !== null) trackCount++;
  }

  // Get headerLabel, title from template data
  if (data && data.methods) {
    for (var i = 0; i < data.methods.length; i++) {
      var method = data.methods[i];

      // Check for headerLabel using findFirst
      var headerLabel = findFirst(method, "headerLabel", 0);
      if (headerLabel !== undefined) {
        if (headerLabel === "Album" || headerLabel === "Single" || headerLabel === "EP") {
          result.type = headerLabel.toLowerCase();
        }

        // Try headerText first (direct widget text)
        if (!result.title) {
          var headerText = findFirst(method, "headerText", 0);
          result.title = sanitizeDisplayText(headerText);
        }

        // Try primaryText (common in widgets)
        if (!result.title) {
          var primaryText = findFirst(method, "primaryText", 0);
          result.title = sanitizeDisplayText(primaryText);
        }

        // Try seoHead title (fallback, "Play X by Y on Amazon Music...")
        if (!result.title) {
          var seoTitle = findFirst(method, "title", 0);
          if (seoTitle && typeof seoTitle === "string") {
            var playMatch = seoTitle.match(/^Play\s+(.+?)\s+by\s+(.+?)\s+on\s+/);
            if (playMatch) {
              result.title = playMatch[1];
              if (!result.artist) result.artist = playMatch[2];
            } else {
              // Try other patterns: "Album Name - Artist on Amazon Music"
              var dashMatch = seoTitle.match(/^(.+?)\s*[-–]\s*(.+?)\s+on\s+Amazon/);
              if (dashMatch) {
                result.title = dashMatch[1].trim();
                if (!result.artist) result.artist = dashMatch[2].trim();
              } else if (seoTitle.indexOf("Amazon") === -1) {
                // Use raw title if it doesn't look like a page title
                result.title = seoTitle;
              }
            }
          }
        }

        // headerPrimaryText overrides schema.org for album artist (more reliable).
        var headerPrimaryText = findFirst(method, "headerPrimaryText", 0);
        var hptArtist = sanitizeDisplayText(headerPrimaryText);
        if (hptArtist) {
          result.artist = hptArtist;
        }
        if (!result.artist_id) {
          var headerPrimaryTextLink = findFirst(method, "headerPrimaryTextLink", 0);
          if (headerPrimaryTextLink && headerPrimaryTextLink.deeplink) {
            var artistMatch = headerPrimaryTextLink.deeplink.match(/\/artists\/([^\/]+)/);
            if (artistMatch) result.artist_id = normalizeASIN(artistMatch[1]) || artistMatch[1];
          }
        }
        if (!result.artist) {
          var secondaryText = findFirst(method, "secondaryText", 0);
          result.artist = sanitizeDisplayText(secondaryText);
        }

        var bgImage = findFirst(method, "backgroundImage", 0);
        if (bgImage && typeof bgImage === "string" && bgImage.indexOf("images/I/") >= 0) {
          result.cover_art = ensureHighResCoverUrl(bgImage);
        }
      }

      // Find year from copyright/phonogram text
      var copyrightText = findFirst(method, "copyright", 0);
      if (copyrightText && typeof copyrightText === "string") {
        var yearMatch = copyrightText.match(/(\d{4})/);
        if (yearMatch) result.year = yearMatch[1];
      }
    }
  }

  // Parse track rows
  if (data) {
    result.tracks = parseDescriptiveRows(data);
    result.track_count = result.tracks.length;

    // Set cover art and artist on tracks
    for (var t = 0; t < result.tracks.length; t++) {
      if (!result.tracks[t].cover_art && result.cover_art) {
        result.tracks[t].cover_art = result.cover_art;
      }
      if (!result.tracks[t].artist && result.artist) {
        result.tracks[t].artist = result.artist;
      }
      result.tracks[t].album = result.title;
      result.tracks[t].album_id = albumId;
    }
  }

  return result;
}

// ==================== Track Parser ====================

function parseTrackFromResponse(data, responseStr, trackId) {
  var result = {
    id: trackId,
    title: "",
    artist: "",
    artist_id: "",
    album: "",
    album_id: "",
    cover_art: "",
    duration: 0,
    duration_ms: 0,
    track_number: 0,
    type: "track"
  };

  if (responseStr) {
    var schema = extractSchemaOrg(responseStr, "MusicRecording");
    if (schema) {
      result.title = schema.name || "";
      if (schema.duration) {
        result.duration = parseDurationISO(schema.duration);
        result.duration_ms = result.duration * 1000;
      }
      if (schema.position) result.track_number = schema.position;
      if (schema.byArtist) {
        result.artist = schema.byArtist.name || "";
      }
    }

    var albumSchema = extractSchemaOrg(responseStr, "MusicAlbum");
    if (albumSchema) {
      result.album = albumSchema.name || "";
      if (albumSchema["@id"]) {
        var albumMatch = albumSchema["@id"].match(/\/albums\/([^\/]+)/);
        if (albumMatch) result.album_id = albumMatch[1];
      }
      if (albumSchema.byArtist && albumSchema.byArtist.name) {
        result.artist = albumSchema.byArtist.name;
      }
    }
  }

  // Parse from template data
  if (data && data.methods) {
    for (var i = 0; i < data.methods.length; i++) {
      var method = data.methods[i];

      var headerLabel = findFirst(method, "headerLabel", 0);
      if (headerLabel !== undefined) {
        // Try headerText first
        if (!result.title) {
          var headerText = findFirst(method, "headerText", 0);
          result.title = sanitizeDisplayText(headerText);
        }
        // Try seoTitle
        if (!result.title) {
          var seoTitle = findFirst(method, "title", 0);
          if (seoTitle && typeof seoTitle === "string") {
            var match = seoTitle.match(/^Play\s+(.+?)\s+by\s+(.+?)\s+on\s+/);
            if (match) {
              result.title = match[1];
              if (!result.artist) result.artist = match[2];
            }
          }
        }

        var bgImage = findFirst(method, "backgroundImage", 0);
        if (bgImage && typeof bgImage === "string" && bgImage.indexOf("images/I/") >= 0) {
          result.cover_art = ensureHighResCoverUrl(bgImage);
        }
      }
    }
  }

  // If track page loads as album, find the track in the track list.
  // Track-list data (matched by exact ID) overrides headerText which
  // may contain the album name instead of the track name.
  if (data) {
    var allTracks = parseDescriptiveRows(data);
    var matched = false;
    for (var j = 0; j < allTracks.length; j++) {
      if (allTracks[j].id === trackId) {
        if (allTracks[j].title) result.title = allTracks[j].title;
        if (allTracks[j].artist) result.artist = allTracks[j].artist;
        if (allTracks[j].duration) {
          result.duration = allTracks[j].duration;
          result.duration_ms = allTracks[j].duration_ms;
        }
        result.track_number = allTracks[j].track_number;
        if (!result.album_id && allTracks[j].album_id) result.album_id = allTracks[j].album_id;
        matched = true;
        break;
      }
    }
    // Loose match by title for resolved/foreign ASINs where the ID differs
    if (!matched && result.title && allTracks.length > 0) {
      var titleLower = result.title.toLowerCase();
      for (var k = 0; k < allTracks.length; k++) {
        if (allTracks[k].title && allTracks[k].title.toLowerCase() === titleLower) {
          if (allTracks[k].artist) result.artist = allTracks[k].artist;
          if (!result.duration && allTracks[k].duration) {
            result.duration = allTracks[k].duration;
            result.duration_ms = allTracks[k].duration_ms;
          }
          result.track_number = allTracks[k].track_number;
          if (!result.album_id && allTracks[k].album_id) result.album_id = allTracks[k].album_id;
          break;
        }
      }
    }
  }

  return result;
}

// ==================== Artist Parser ====================

function parseArtistCollectionItem(item, fallbackArtistName) {
  if (!item) return null;

  var deeplink = "";
  if (item.primaryLink && item.primaryLink.deeplink) {
    deeplink = item.primaryLink.deeplink;
  } else if (item.primaryTextLink && item.primaryTextLink.deeplink) {
    deeplink = item.primaryTextLink.deeplink;
  }
  if (!deeplink || deeplink.indexOf("/albums/") < 0) return null;

  var albumInfo = extractAmazonDeeplinkInfo(deeplink);
  if (!albumInfo || albumInfo.type !== "albums" || !albumInfo.id) return null;

  var albumName = textValue(item.primaryText);
  if (!albumName) return null;

  // Strip ranking prefix like "1. " or "12. " from Top Albums names
  albumName = albumName.replace(/^\d+\.\s+/, "");

  // secondaryText is like "Single • 2026" or "Album • 2025"
  var secondary = textValue(item.secondaryText) || "";
  var albumType = "album";
  var releaseDate = "";
  if (secondary) {
    var lower = secondary.toLowerCase();
    if (lower.indexOf("single") >= 0) albumType = "single";
    else if (lower.indexOf("ep") >= 0) albumType = "ep";
    else if (lower.indexOf("compilation") >= 0) albumType = "compilation";
    var yearMatch = secondary.match(/(\d{4})/);
    if (yearMatch) releaseDate = yearMatch[1];
  }

  return {
    id: albumInfo.id,
    name: albumName,
    cover_url: item.image ? ensureHighResCoverUrl(item.image) : "",
    artist: fallbackArtistName || "",
    release_date: releaseDate,
    type: albumType,
    album_type: albumType
  };
}

function pushUniqueArtistCollection(target, item) {
  if (!item || !item.id) return;
  for (var i = 0; i < target.length; i++) {
    if (target[i].id === item.id) return;
  }
  target.push(item);
}

function parseArtistFromResponse(data, responseStr, artistId) {
  var result = {
    id: artistId,
    name: "",
    image: "",
    albums: [],
    releases: [],
    top_tracks: [],
    type: "artist"
  };

  if (responseStr) {
    var schema = extractSchemaOrg(responseStr, "MusicGroup");
    if (schema) {
      result.name = schema.name || "";
      if (schema.image) result.image = ensureHighResCoverUrl(schema.image);
    }
  }

  // Direct extraction from showCatalogArtist DetailTemplate format
  // (template.headerText is the artist name, backgroundImage is the artist image)
  // This is more reliable than schema.org for API responses, so it overrides.
  if (data && data.methods) {
    for (var mi = 0; mi < data.methods.length; mi++) {
      var tmpl = data.methods[mi] && data.methods[mi].template;
      if (tmpl) {
        if (tmpl.headerText) {
          var directName = textValue(tmpl.headerText);
          if (directName) { result.name = directName; break; }
        }
      }
    }
  }
  if (data && data.methods) {
    for (var mi2 = 0; mi2 < data.methods.length; mi2++) {
      var tmpl2 = data.methods[mi2] && data.methods[mi2].template;
      if (tmpl2 && !result.image && tmpl2.backgroundImage && typeof tmpl2.backgroundImage === "string" && tmpl2.backgroundImage.indexOf("images/I/") >= 0) {
        result.image = ensureHighResCoverUrl(tmpl2.backgroundImage);
        break;
      }
    }
  }

  if (data && data.methods) {
    for (var i = 0; i < data.methods.length; i++) {
      var method = data.methods[i];

      // Get artist name from headerText (fallback DFS search)
      var headerLabel = findFirst(method, "headerLabel", 0);
      if (headerLabel !== undefined) {
        // Try headerText
        if (!result.name) {
          var headerText = findFirst(method, "headerText", 0);
          result.name = sanitizeDisplayText(headerText);
        }
        // Try primaryText
        if (!result.name) {
          var primaryText = findFirst(method, "primaryText", 0);
          result.name = sanitizeDisplayText(primaryText);
        }
        // Try seoTitle
        if (!result.name) {
          var seoTitle = findFirst(method, "title", 0);
          if (seoTitle && typeof seoTitle === "string") {
            // "Listen to Artist on Amazon Music"
            var listenMatch = seoTitle.match(/^(?:Listen to|Play)\s+(.+?)\s+on\s+/);
            if (listenMatch) {
              result.name = listenMatch[1];
            } else if (seoTitle.indexOf("Amazon") === -1) {
              result.name = seoTitle;
            }
          }
        }
        var bgImage = findFirst(method, "backgroundImage", 0);
        if (bgImage && typeof bgImage === "string" && bgImage.indexOf("images/I/") >= 0) {
          if (!result.image) result.image = ensureHighResCoverUrl(bgImage);
        }
      }
    }
  }

  if (data) {
    var shovelers = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement", [], 0);
    var featuredShovelers = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.FeaturedShovelerWidgetElement", [], 0);
    var descriptiveShowcases = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShowcaseWidgetElement", [], 0);
    for (var fs = 0; fs < featuredShovelers.length; fs++) shovelers.push(featuredShovelers[fs]);
    for (var ds = 0; ds < descriptiveShowcases.length; ds++) shovelers.push(descriptiveShowcases[ds]);

    for (var s = 0; s < shovelers.length; s++) {
      var shoveler = shovelers[s];
      if (!shoveler.items) continue;
      var headerStr = typeof shoveler.header === "string" ? shoveler.header : "";
      var isReleaseSection = headerStr === "Releases" || headerStr === "Latest Releases";
      var isAlbumSection = headerStr === "Albums" || headerStr === "Top Albums" || headerStr === "Popular Albums";
      if (!isReleaseSection && !isAlbumSection) {
        // Fallback: stringify the whole shoveler to find section identifiers
        var shovelerStr = deepStringify(shoveler);
        isReleaseSection = shovelerStr.indexOf('"Releases"') >= 0 || shovelerStr.indexOf('"Latest Releases"') >= 0;
        isAlbumSection = shovelerStr.indexOf('"Albums"') >= 0 || shovelerStr.indexOf('"Top Albums"') >= 0 || shovelerStr.indexOf('"Popular Albums"') >= 0;
      }
      if (!isReleaseSection && !isAlbumSection) continue;

      for (var i = 0; i < shoveler.items.length; i++) {
        var parsedCollection = parseArtistCollectionItem(shoveler.items[i], result.name);
        if (!parsedCollection) continue;
        if (isReleaseSection) {
          pushUniqueArtistCollection(result.releases, parsedCollection);
        } else {
          pushUniqueArtistCollection(result.albums, parsedCollection);
        }
      }
    }

    if (!result.albums.length) {
      var squares = findAllByInterface(data,
        "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.SquareVerticalItemElement", [], 0);
      for (var k = 0; k < squares.length; k++) {
        var parsedAlbum = parseArtistCollectionItem(squares[k], result.name);
        if (parsedAlbum) {
          pushUniqueArtistCollection(result.albums, parsedAlbum);
        }
      }
    }

    result.top_tracks = parseDescriptiveRows(data);

    // If no tracks from DescriptiveRowItems, try SquareHorizontalItems inside
    // DescriptiveShovelerWidgets (showCatalogArtist uses this for "Top Songs")
    if (!result.top_tracks.length) {
      var descriptiveShovelers = findAllByInterface(data,
        "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShovelerWidgetElement", [], 0);
      for (var dsi = 0; dsi < descriptiveShovelers.length; dsi++) {
        var dWidget = descriptiveShovelers[dsi];
        if (!dWidget.items || !dWidget.header) continue;
        var dHeader = typeof dWidget.header === "string" ? dWidget.header : "";
        if (dHeader !== "Top Songs" && dHeader !== "Songs") continue;
        for (var di = 0; di < dWidget.items.length; di++) {
          var trackItem = dWidget.items[di];
          var trackName = textValue(trackItem.primaryText);
          if (!trackName) continue;
          trackName = trackName.replace(/^\d+\.\s+/, "");
          var trackDeeplink = "";
          if (trackItem.primaryLink && trackItem.primaryLink.deeplink) {
            trackDeeplink = trackItem.primaryLink.deeplink;
          } else if (trackItem.primaryTextLink && trackItem.primaryTextLink.deeplink) {
            trackDeeplink = trackItem.primaryTextLink.deeplink;
          }
          if (!trackDeeplink || trackDeeplink.indexOf("trackAsin") < 0) continue;
          var trackInfo = extractAmazonDeeplinkInfo(trackDeeplink);
          if (!trackInfo || !trackInfo.id) continue;
          var trackArtist = textValue(trackItem.secondaryText) || result.name || "";
          var trackImage = trackItem.image ? ensureHighResCoverUrl(trackItem.image) : "";
          result.top_tracks.push({
            id: trackInfo.id,
            title: trackName,
            artist: trackArtist,
            duration: 0,
            duration_ms: 0,
            cover_art: trackImage,
            deeplink: trackDeeplink,
            track_number: di + 1,
            album_id: trackInfo.albumId || ""
          });
        }
        break;
      }
    }

    for (var t = 0; t < result.top_tracks.length; t++) {
      result.top_tracks[t].artist = result.name;
      result.top_tracks[t].artist_id = artistId;
    }
  }

  return result;
}

// ==================== Playlist Parser ====================

function parsePlaylistFromResponse(data, responseStr, playlistId) {
  var result = {
    id: playlistId,
    title: "",
    description: "",
    cover_art: "",
    owner: "",
    track_count: 0,
    tracks: [],
    type: "playlist"
  };

  if (data && data.methods) {
    for (var i = 0; i < data.methods.length; i++) {
      var method = data.methods[i];

      var headerLabel = findFirst(method, "headerLabel", 0);
      if (headerLabel !== undefined) {
        // Try headerText
        if (!result.title) {
          var headerText = findFirst(method, "headerText", 0);
          result.title = sanitizeDisplayText(headerText);
        }
        // Try primaryText
        if (!result.title) {
          var primaryText = findFirst(method, "primaryText", 0);
          result.title = sanitizeDisplayText(primaryText);
        }
        // Try seoTitle
        if (!result.title) {
          var seoTitle = findFirst(method, "title", 0);
          if (seoTitle && typeof seoTitle === "string") {
            var playMatch = seoTitle.match(/^(?:Play\s+)?(.+?)(?:\s+on\s+Amazon Music)/);
            if (playMatch) {
              result.title = playMatch[1];
            } else if (seoTitle.indexOf("Amazon") === -1) {
              result.title = seoTitle;
            }
          }
        }

        var bgImage = findFirst(method, "backgroundImage", 0);
        if (bgImage && typeof bgImage === "string" && bgImage.indexOf("images/I/") >= 0) {
          result.cover_art = ensureHighResCoverUrl(bgImage);
        }

        var desc = findFirst(method, "description", 0);
        if (desc && typeof desc === "string" && desc.length > 5) {
          result.description = desc;
        }
      }
    }
  }

  if (data) {
    // Debug: log all interfaces present in playlist data
    var ifaces = collectInterfaces(data, {}, 0);
    var ifaceNames = Object.keys(ifaces);
    var ifaceSummary = [];
    for (var k = 0; k < ifaceNames.length; k++) {
      if (ifaceNames[k].indexOf("ItemElement") >= 0 || ifaceNames[k].indexOf("RowItem") >= 0 || ifaceNames[k].indexOf("Widget") >= 0) {
        ifaceSummary.push(ifaceNames[k].replace("Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.", "") + ":" + ifaces[ifaceNames[k]]);
      }
    }
    L("info", "[Amazon] Playlist interfaces: " + ifaceSummary.join(", "));

    result.tracks = parseDescriptiveRows(data);

    // Playlists use VisualRowItemElement instead of DescriptiveRowItemElement
    if (result.tracks.length === 0) {
      result.tracks = parseVisualRows(data);
    }

    result.track_count = result.tracks.length;

    for (var t = 0; t < result.tracks.length; t++) {
      if (!result.tracks[t].cover_art && result.cover_art) {
        result.tracks[t].cover_art = result.cover_art;
      }
    }
  }

  return result;
}

function findTrackSearchFallback(trackId, context) {
  var results = customSearchSync(trackId, { filter: "songs", context: context });
  for (var i = 0; i < results.length; i++) {
    var item = results[i];
    if (item && item.item_type === "track" && item.id === trackId) {
      return item;
    }
  }
  return results.length ? results[0] : null;
}

function buildArtistFromSearch(artistId, query, context) {
  if (!query) return null;
  var results = customSearchSync(query, { context: context });
  if (!results || !results.length) return null;
  var songResults = customSearchSync(query, { filter: "songs", context: context });
  if (!songResults) songResults = [];

  var artistName = "";
  var artistImage = "";
  var albums = [];
  var topTracks = [];

  for (var i = 0; i < results.length; i++) {
    var item = results[i];
    if (!item) continue;
    if (item.item_type === "artist" && (!artistName || item.id === artistId)) {
      artistName = item.name || artistName;
      artistImage = item.cover_url || artistImage;
      if (item.id === artistId) break;
    }
  }

  if (!artistName) artistName = slugToName(query);
  if (!artistName) return null;

  for (var j = 0; j < results.length; j++) {
    var candidate = results[j];
    if (!candidate) continue;
    if (candidate.item_type === "album" && candidate.artists && candidate.artists.toLowerCase() === artistName.toLowerCase()) {
      albums.push({
        id: candidate.id,
        title: candidate.name || "",
        cover_art: candidate.cover_url || "",
        artist: artistName,
        type: "album"
      });
      rememberResourceContext("album", candidate.id, context);
    }
    if (candidate.item_type === "track" && candidate.artists && candidate.artists.toLowerCase().indexOf(artistName.toLowerCase()) >= 0) {
      topTracks.push({
        id: candidate.id,
        title: candidate.name || "",
        artist: artistName,
        artist_id: artistId,
        duration_ms: candidate.duration_ms || 0,
        cover_art: candidate.cover_url || "",
        album_id: candidate.album_id || ""
      });
      rememberResourceContext("track", candidate.id, context);
    }
  }

  for (var s = 0; s < songResults.length; s++) {
    var song = songResults[s];
    if (!song || song.item_type !== "track") continue;
    if (!song.artists || song.artists.toLowerCase().indexOf(artistName.toLowerCase()) < 0) continue;

    var duplicate = false;
    for (var existing = 0; existing < topTracks.length; existing++) {
      if (topTracks[existing].id === song.id) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    topTracks.push({
      id: song.id,
      title: song.name || "",
      artist: artistName,
      artist_id: artistId,
      duration_ms: song.duration_ms || 0,
      cover_art: song.cover_url || "",
      album_id: song.album_id || ""
    });
    rememberResourceContext("track", song.id, context);
  }

  rememberResourceHint("artist", artistId, { name: artistName, image: artistImage });

  return {
    id: artistId,
    name: artistName,
    image: artistImage,
    albums: albums,
    releases: [],
    top_tracks: topTracks,
    type: "artist"
  };
}

function mergeArtistFallbackData(artist, fallbackArtist) {
  if (!fallbackArtist) return artist;
  if (!artist.name && fallbackArtist.name) artist.name = fallbackArtist.name;
  if (!artist.image && fallbackArtist.image) artist.image = fallbackArtist.image;
  if ((!artist.albums || !artist.albums.length) && fallbackArtist.albums && fallbackArtist.albums.length) {
    artist.albums = fallbackArtist.albums;
  }
  if ((!artist.releases || !artist.releases.length) && fallbackArtist.releases && fallbackArtist.releases.length) {
    artist.releases = fallbackArtist.releases;
  }
  if ((!artist.top_tracks || !artist.top_tracks.length) && fallbackArtist.top_tracks && fallbackArtist.top_tracks.length) {
    artist.top_tracks = fallbackArtist.top_tracks;
  }
  return artist;
}

// ==================== handleUrl ====================
// Must return FULL data matching Go's ExtURLHandleResult struct.
// Fields: type, track{}, tracks[], album{}, artist{}, name, cover_url

function handleUrl(url) {
  L("info", "[Amazon] handleUrl:", url);

  var parsed = parseAmazonMusicURL(url);
  if (!parsed) {
    L("warn", "[Amazon] Could not parse URL:", url);
    return null;
  }

  L("info", "[Amazon] Parsed URL type:", parsed.type, "id:", parsed.id);
  if (parsed.context) {
    _currentContext = parsed.context;
    rememberResourceContext(parsed.type, parsed.id, parsed.context);
    if (parsed.albumId) rememberResourceContext("album", parsed.albumId, parsed.context);
    if (parsed.slug) rememberResourceHint("artist", parsed.id, { name: slugToName(parsed.slug) });
  }

  if (parsed.type === "track") {
    return handleTrackUrl(parsed);
  }
  if (parsed.type === "album") {
    return handleAlbumUrl(parsed.id);
  }
  if (parsed.type === "artist") {
    return handleArtistUrl(parsed.id);
  }
  if (parsed.type === "playlist") {
    return handlePlaylistUrl(parsed.id);
  }

  return null;
}

function handleTrackUrl(parsed) {
  var trackId = parsed.id;
  var albumId = parsed.albumId || null;
  var context = parsed.context || getResourceContext("track", trackId, albumId ? getResourceContext("album", albumId, null) : null);

  L("info", "[Amazon] handleTrackUrl:", trackId, "albumId:", albumId);

  // Try showHome first (fast path)
  var deeplink = "/tracks/" + trackId;
  var result = callShowHome(deeplink, context);
  var trackInfo = null;

  if (result) {
    trackInfo = parseTrackFromResponse(result.data, result.rawText, trackId);
  }

  // showHome returns skeletons for track pages — use displayCatalogTrack
  // which also resolves foreign/regional ASINs
  if (!trackInfo || !trackInfo.title || looksLikeURL(trackInfo.title)) {
    var catalogResult = callDisplayCatalogTrack(trackId, context);
    if (catalogResult) {
      result = catalogResult;
      trackInfo = parseTrackFromResponse(result.data, result.rawText, trackId);
      if (looksLikeURL(trackInfo.title)) trackInfo.title = "";
    }
  }

  // Fallback: try album page if we have an albumId
  if ((!trackInfo || !trackInfo.title) && albumId) {
    L("info", "[Amazon] handleTrackUrl trying album:", albumId);
    var albumResult = callShowHome("/albums/" + albumId + "?trackAsin=" + trackId, context);
    if (albumResult) {
      result = albumResult;
      trackInfo = parseTrackFromResponse(result.data, result.rawText, trackId);
      if (looksLikeURL(trackInfo.title)) trackInfo.title = "";
    }
  }

  // Fallback: search for the track, then fetch its album
  var searchFallbackInfo = null;
  if (!trackInfo || !trackInfo.title) {
    searchFallbackInfo = findTrackSearchFallback(trackId, context);
    if (searchFallbackInfo && searchFallbackInfo.album_id && searchFallbackInfo.album_id !== albumId) {
      albumId = searchFallbackInfo.album_id;
      rememberResourceContext("album", albumId, context);
      var albumResult2 = callShowHome("/albums/" + albumId + "?trackAsin=" + trackId, context);
      if (albumResult2) {
        result = albumResult2;
        trackInfo = parseTrackFromResponse(result.data, result.rawText, trackId);
        if (looksLikeURL(trackInfo.title)) trackInfo.title = "";
      }
    }
    if ((!trackInfo || !trackInfo.title) && searchFallbackInfo) {
      if (!trackInfo) trackInfo = { id: trackId, title: "", artist: "", album: "", album_id: "", cover_art: "", duration_ms: 0, track_number: 0 };
      trackInfo.title = searchFallbackInfo.name || "";
      trackInfo.artist = searchFallbackInfo.artists || "";
      trackInfo.album_id = searchFallbackInfo.album_id || trackInfo.album_id;
      trackInfo.duration_ms = searchFallbackInfo.duration_ms || 0;
      trackInfo.cover_art = ensureHighResCoverUrl(searchFallbackInfo.cover_url || "");
    }
  }

  if (!trackInfo) {
    L("warn", "[Amazon] handleTrackUrl no data, returning minimal track:", trackId);
    return {
      type: "track",
      track: {
        id: trackId,
        name: "Amazon Track " + trackId,
        artists: "",
        duration_ms: 0
      }
    };
  }

  if (!trackInfo.title && albumId) {
    trackInfo.album_id = albumId;
  }
  rememberResourceContext("track", trackId, context);
  if (trackInfo.album_id) rememberResourceContext("album", trackInfo.album_id, context);
  L("info", "[Amazon] handleTrackUrl parsed:", trackInfo.title);
  return {
    type: "track",
    track: {
      id: trackId,
      name: trackInfo.title || "Unknown Track",
      artists: trackInfo.artist || "",
      album_name: trackInfo.album || "",
      duration_ms: trackInfo.duration_ms || 0,
      cover_url: ensureHighResCoverUrl(trackInfo.cover_art || ""),
      track_number: trackInfo.track_number || 0,
      isrc: ""
    }
  };
}

function handleAlbumUrl(albumId) {
  var context = getResourceContext("album", albumId, null);
  L("info", "[Amazon] handleAlbumUrl:", albumId);
  var deeplink = "/albums/" + albumId;

  var result = callShowHome(deeplink, context);

  if (!result) {
    L("error", "[Amazon] handleAlbumUrl failed to fetch album:", albumId);
    return null;
  }

  var album = parseAlbumFromResponse(result.data, result.rawText, albumId);
  rememberResourceContext("album", albumId, context);
  if (album.artist_id) rememberResourceContext("artist", album.artist_id, context);
  if (album.artist) rememberResourceHint("artist", album.artist_id || album.artist, { name: album.artist });
  L("info", "[Amazon] handleAlbumUrl parsed:", album.title, "tracks:", album.tracks.length);

  var tracks = [];
  for (var i = 0; i < album.tracks.length; i++) {
    var t = album.tracks[i];
    tracks.push({
      id: t.id,
      name: t.title || "",
      artists: t.artist || album.artist || "",
      album_name: album.title || "",
      album_artist: album.artist || "",
      duration_ms: t.duration_ms || 0,
      cover_url: ensureHighResCoverUrl(t.cover_art || album.cover_art || ""),
      track_number: t.track_number || (i + 1),
      disc_number: 1,
      isrc: "",
      explicit: !!t.explicit
    });
  }

  return {
    type: "album",
    album: {
      id: albumId,
      name: album.title || "",
      artists: album.artist || "",
      artist_id: album.artist_id || "",
      cover_url: ensureHighResCoverUrl(album.cover_art || ""),
      release_date: album.year || "",
      total_tracks: tracks.length,
      album_type: album.type || "album",
      tracks: tracks
    },
    tracks: tracks,
    name: album.title || "",
    cover_url: ensureHighResCoverUrl(album.cover_art || "")
  };
}

function handleArtistUrl(artistId) {
  var hintedName = getResourceHint("artist", artistId, "name");
  var context = getResourceContext("artist", artistId, null);
  L("info", "[Amazon] handleArtistUrl:", artistId);
  var deeplink = "/artists/" + artistId;
  var slug = hintedName ? hintedName.toLowerCase().replace(/\s+/g, "-") : "";
  if (slug) deeplink += "/" + slug;

  // Try showCatalogArtist first (returns separate Releases + Top Albums sections)
  var result = callShowCatalogArtist(artistId, slug, context);
  if (!result) {
    L("info", "[Amazon] handleArtistUrl showCatalogArtist failed, falling back to showHome");
    result = callShowHome(deeplink, context);
  }

  if (!result) {
    var fallbackArtist = buildArtistFromSearch(artistId, hintedName, context);
    if (fallbackArtist) {
      L("info", "[Amazon] handleArtistUrl search fallback parsed:", fallbackArtist.name);
      return {
        type: "artist",
        artist: {
          id: artistId,
          name: fallbackArtist.name || hintedName || "",
          image_url: fallbackArtist.image || "",
          header_image: fallbackArtist.image || "",
          albums: fallbackArtist.albums || [],
          releases: fallbackArtist.releases || [],
          top_tracks: fallbackArtist.top_tracks || []
        }
      };
    }
    L("error", "[Amazon] handleArtistUrl failed to fetch artist:", artistId);
    return {
      type: "artist",
      artist: {
        id: artistId,
        name: hintedName || "",
        image_url: "",
        header_image: "",
        albums: [],
        releases: [],
        top_tracks: []
      }
    };
  }

  var artist = parseArtistFromResponse(result.data, result.rawText, artistId);
  if (!artist.name && hintedName) artist.name = hintedName;
  if (hintedName && (!artist.name || !artist.albums.length || !artist.top_tracks.length)) {
    var parsedFallbackArtist = buildArtistFromSearch(artistId, hintedName, context);
    artist = mergeArtistFallbackData(artist, parsedFallbackArtist);
  }
  rememberResourceContext("artist", artistId, context);
  rememberResourceHint("artist", artistId, { name: artist.name, image: artist.image });
  L("info", "[Amazon] handleArtistUrl parsed:", artist.name, "albums:", artist.albums.length, "tracks:", artist.top_tracks.length);

  var albums = [];
  for (var i = 0; i < artist.albums.length; i++) {
      var a = artist.albums[i];
      albums.push({
        id: a.id,
        name: a.name || a.title || "",
        artists: a.artists || a.artist || artist.name || "",
        cover_url: a.cover_url || a.cover_art || "",
        album_type: a.album_type || a.type || "album",
        total_tracks: a.total_tracks || 0,
        release_date: a.release_date || "",
        provider_id: "amazon"
      });
    }

  var releases = [];
  for (var r = 0; r < artist.releases.length; r++) {
      var rel = artist.releases[r];
      releases.push({
        id: rel.id,
        name: rel.name || rel.title || "",
        artists: rel.artists || rel.artist || artist.name || "",
        cover_url: rel.cover_url || rel.cover_art || "",
        album_type: rel.album_type || rel.type || "album",
        total_tracks: rel.total_tracks || 0,
        release_date: rel.release_date || "",
        provider_id: "amazon"
      });
    }

  var topTracks = [];
  for (var j = 0; j < artist.top_tracks.length; j++) {
      var t = artist.top_tracks[j];
      topTracks.push({
        id: t.id,
        name: t.name || t.title || "",
        artists: t.artists || t.artist || artist.name || "",
        album_name: t.album_name || "",
        album_id: t.album_id || "",
        duration_ms: t.duration_ms || 0,
        cover_url: t.cover_url || t.cover_art || "",
        track_number: 0,
        isrc: "",
        artist_id: t.artist_id || artist.id || artistId,
        provider_id: "amazon"
      });
    }

  return {
    type: "artist",
    artist: {
      id: artistId,
      name: artist.name || "",
      image_url: artist.image || "",
      header_image: artist.image || "",
      albums: albums,
      releases: releases,
      top_tracks: topTracks
    }
  };
}

function handlePlaylistUrl(playlistId) {
  var context = getResourceContext("playlist", playlistId, null);
  L("info", "[Amazon] handlePlaylistUrl:", playlistId);
  var deeplink = "/playlists/" + playlistId;

  var result = callShowHome(deeplink, context);

  if (!result) {
    L("error", "[Amazon] handlePlaylistUrl failed to fetch playlist:", playlistId);
    return null;
  }

  var playlist = parsePlaylistFromResponse(result.data, result.rawText, playlistId);
  if (!playlist.title) playlist.title = getResourceHint("playlist", playlistId, "name");
  if (!playlist.cover_art) playlist.cover_art = getResourceHint("playlist", playlistId, "cover_art");
  rememberResourceContext("playlist", playlistId, context);
  rememberResourceHint("playlist", playlistId, { name: playlist.title, cover_art: playlist.cover_art });
  L("info", "[Amazon] handlePlaylistUrl parsed:", playlist.title, "tracks:", playlist.tracks.length);

  var tracks = [];
  for (var i = 0; i < playlist.tracks.length; i++) {
    var t = playlist.tracks[i];
    tracks.push({
      id: t.id,
      name: t.title || "",
      artists: t.artist || "",
      album_name: t.album || "",
      duration_ms: t.duration_ms || 0,
      cover_url: t.cover_art || playlist.cover_art || "",
      track_number: i + 1,
      isrc: "",
      explicit: !!t.explicit
    });
  }

  return {
    type: "playlist",
    tracks: tracks,
    name: playlist.title || "",
    cover_url: playlist.cover_art || ""
  };
}

// ==================== getAlbum ====================

function getAlbum(albumId) {
  L("info", "[Amazon] getAlbum:", albumId);

  var cacheKey = "album_" + albumId;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var context = getResourceContext("album", albumId, null);
  var deeplink = "/albums/" + albumId;
  var result = fetchWithRetry(function() {
    return callShowHome(deeplink, context);
  });

  if (!result) {
    L("error", "[Amazon] Failed to fetch album:", albumId);
    return null;
  }

  var album = parseAlbumFromResponse(result.data, result.rawText, albumId);
  rememberResourceContext("album", albumId, context);

  var tracks = [];
  for (var i = 0; i < album.tracks.length; i++) {
    var t = album.tracks[i];
    tracks.push({
      id: t.id,
      name: t.title || "",
      artists: t.artist || album.artist || "",
      album_name: album.title || "",
      album_artist: album.artist || "",
      duration_ms: t.duration_ms || 0,
      cover_url: t.cover_art || album.cover_art || "",
      track_number: t.track_number || (i + 1),
      disc_number: 1,
      isrc: "",
      explicit: !!t.explicit
    });
  }

  var result = {
    success: true,
    id: album.id,
    name: album.title || "",
    artists: album.artist || "",
    artist_id: album.artist_id || "",
    cover_url: album.cover_art || "",
    release_date: album.year || "",
    total_tracks: tracks.length,
    album_type: album.type || "album",
    tracks: tracks
  };

  L("info", "[Amazon] Album parsed:", result.name, "tracks:", result.total_tracks);
  cacheSet(cacheKey, result);
  return result;
}

// ==================== getArtist ====================

function getArtist(artistId) {
  L("info", "[Amazon] getArtist:", artistId);

  var cacheKey = "artist_" + artistId;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var context = getResourceContext("artist", artistId, null);
  var hintedName = getResourceHint("artist", artistId, "name");
  var deeplink = "/artists/" + artistId;
  var slug = hintedName ? hintedName.toLowerCase().replace(/\s+/g, "-") : "";
  if (slug) deeplink += "/" + slug;

  // Try showCatalogArtist first (returns separate Releases + Top Albums sections)
  var result = fetchWithRetry(function() {
    return callShowCatalogArtist(artistId, slug, context);
  });
  if (!result) {
    L("info", "[Amazon] getArtist showCatalogArtist failed, falling back to showHome");
    result = fetchWithRetry(function() {
      return callShowHome(deeplink, context);
    });
  }

  if (!result) {
    var fallbackArtist = buildArtistFromSearch(artistId, hintedName, context);
    if (!fallbackArtist) {
      L("error", "[Amazon] Failed to fetch artist:", artistId);
      return null;
    }
    var fallbackResult = {
      success: true,
      id: artistId,
      name: fallbackArtist.name || hintedName || "",
      image_url: fallbackArtist.image || "",
      header_image: fallbackArtist.image || "",
      albums: fallbackArtist.albums || [],
      releases: fallbackArtist.releases || [],
      top_tracks: fallbackArtist.top_tracks || []
    };
    cacheSet(cacheKey, fallbackResult);
    return fallbackResult;
  }

  var artist = parseArtistFromResponse(result.data, result.rawText, artistId);
  if (!artist.name && hintedName) artist.name = hintedName;
  if (hintedName && (!artist.name || !artist.albums.length || !artist.top_tracks.length)) {
    var parsedFallbackArtist = buildArtistFromSearch(artistId, hintedName, context);
    artist = mergeArtistFallbackData(artist, parsedFallbackArtist);
  }
  rememberResourceContext("artist", artistId, context);
  rememberResourceHint("artist", artistId, { name: artist.name, image: artist.image });

  var albums = [];
  for (var i = 0; i < artist.albums.length; i++) {
      var a = artist.albums[i];
      albums.push({
        id: a.id,
        name: a.name || a.title || "",
        artists: a.artists || a.artist || artist.name || "",
        cover_url: a.cover_url || a.cover_art || "",
        album_type: a.album_type || a.type || "album",
        total_tracks: a.total_tracks || 0,
        release_date: a.release_date || "",
        provider_id: "amazon"
      });
    }

  var releases = [];
  for (var r = 0; r < artist.releases.length; r++) {
      var rel = artist.releases[r];
      releases.push({
        id: rel.id,
        name: rel.name || rel.title || "",
        artists: rel.artists || rel.artist || artist.name || "",
        cover_url: rel.cover_url || rel.cover_art || "",
        album_type: rel.album_type || rel.type || "album",
        total_tracks: rel.total_tracks || 0,
        release_date: rel.release_date || "",
        provider_id: "amazon"
      });
    }

  var topTracks = [];
  for (var j = 0; j < artist.top_tracks.length; j++) {
      var t = artist.top_tracks[j];
      topTracks.push({
        id: t.id,
        name: t.name || t.title || "",
        artists: t.artists || t.artist || artist.name || "",
        album_name: t.album_name || "",
        album_id: t.album_id || "",
        duration_ms: t.duration_ms || 0,
        cover_url: t.cover_url || t.cover_art || "",
        track_number: 0,
        isrc: "",
        artist_id: t.artist_id || artist.id || artistId,
        provider_id: "amazon"
      });
    }

  var result = {
    success: true,
    id: artist.id,
    name: artist.name || "",
    image_url: artist.image || "",
    header_image: artist.image || "",
    albums: albums,
    releases: releases,
    top_tracks: topTracks
  };

  L("info", "[Amazon] Artist parsed:", result.name, "albums:", result.albums.length, "tracks:", result.top_tracks.length);
  cacheSet(cacheKey, result);
  return result;
}

// ==================== getPlaylist ====================

function getPlaylist(playlistId) {
  L("info", "[Amazon] getPlaylist:", playlistId);

  var cacheKey = "playlist_" + playlistId;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var context = getResourceContext("playlist", playlistId, null);
  var deeplink = "/playlists/" + playlistId;
  var result = fetchWithRetry(function() {
    return callShowHome(deeplink, context);
  });

  if (!result) {
    L("error", "[Amazon] Failed to fetch playlist:", playlistId);
    return null;
  }

  var playlist = parsePlaylistFromResponse(result.data, result.rawText, playlistId);
  if (!playlist.title) playlist.title = getResourceHint("playlist", playlistId, "name");
  if (!playlist.cover_art) playlist.cover_art = getResourceHint("playlist", playlistId, "cover_art");
  rememberResourceContext("playlist", playlistId, context);
  rememberResourceHint("playlist", playlistId, { name: playlist.title, cover_art: playlist.cover_art });

  var tracks = [];
  for (var i = 0; i < playlist.tracks.length; i++) {
    var t = playlist.tracks[i];
    tracks.push({
      id: t.id,
      name: t.title || "",
      artists: t.artist || "",
      album_name: t.album || "",
      duration_ms: t.duration_ms || 0,
      cover_url: t.cover_art || playlist.cover_art || "",
      track_number: i + 1,
      isrc: "",
      explicit: !!t.explicit
    });
  }

  var result = {
    success: true,
    id: playlist.id,
    name: playlist.title || "",
    description: playlist.description || "",
    cover_url: playlist.cover_art || "",
    owner: playlist.owner || "",
    total_tracks: tracks.length,
    tracks: tracks
  };

  L("info", "[Amazon] Playlist parsed:", result.name, "tracks:", result.total_tracks);
  cacheSet(cacheKey, result);
  return result;
}

// ==================== Search ====================

function parseSearchResults(data, filter) {
  var results = [];
  if (!data || !data.methods) return results;

  // Determine which widget types to look for based on filter
  var wantTracks = !filter || filter === "songs";
  var wantAlbums = !filter || filter === "albums";
  var wantArtists = !filter || filter === "artists";
  var wantPlaylists = !filter || filter === "playlists";

  // Find all VisualShovelerWidgetElement - they contain categorized results
  var shovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement", [], 0);
  var featuredShovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.FeaturedShovelerWidgetElement", [], 0);
  var descriptiveShowcases = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShowcaseWidgetElement", [], 0);
  for (var fs = 0; fs < featuredShovelers.length; fs++) shovelers.push(featuredShovelers[fs]);
  for (var ds = 0; ds < descriptiveShowcases.length; ds++) shovelers.push(descriptiveShowcases[ds]);

  for (var s = 0; s < shovelers.length; s++) {
    var shoveler = shovelers[s];
    if (!shoveler.items) continue;

    // Check header to determine category
    var shovelerStr = deepStringify(shoveler);
    var isTrackSection = shovelerStr.indexOf('"Songs"') >= 0 || shovelerStr.indexOf('"Top Result"') >= 0;
    var isAlbumSection = shovelerStr.indexOf('"Albums"') >= 0;
    var isArtistSection = shovelerStr.indexOf('"Artists"') >= 0;
    var isPlaylistSection = shovelerStr.indexOf('"Playlists"') >= 0;

    for (var i = 0; i < shoveler.items.length && results.length < CONFIG.maxResults; i++) {
      var item = shoveler.items[i];
      var iface = item["interface"] || "";

      // Track items inside shoveler
      if (wantTracks && (iface.indexOf("DescriptiveRowItemElement") >= 0 || iface.indexOf("SquareHorizontalItemElement") >= 0)) {
        var trackName = textValue(item.primaryText);
        var trackDeeplink = "";
        var trackDuration = 0;
        var trackArtist = "";
        var trackImage = "";
        var trackAlbumId = "";

        if (item.primaryTextLink && item.primaryTextLink.deeplink) {
          trackDeeplink = item.primaryTextLink.deeplink;
        }
        if (!trackDeeplink && item.primaryLink && item.primaryLink.deeplink) {
          trackDeeplink = item.primaryLink.deeplink;
        }
        if (item.secondaryText3) {
          trackDuration = parseDurationMMSS(item.secondaryText3);
        }
        if (!trackDuration && item.duration) {
          trackDuration = parseDurationMMSS(item.duration);
        }
        if (item.secondaryText1) {
          trackArtist = textValue(item.secondaryText1);
        }
        if (!trackArtist) {
          trackArtist = textValue(item.secondaryText);
        }
        if (item.image) trackImage = ensureHighResCoverUrl(item.image);

        var trackInfo = extractAmazonDeeplinkInfo(trackDeeplink);
        var tId = trackInfo ? trackInfo.id : null;
        if (trackInfo) trackAlbumId = trackInfo.albumId || "";
        if (trackName && tId && trackInfo && trackInfo.type === "track") {
          results.push({
            item_type: "track",
            id: tId,
            name: trackName,
            artists: trackArtist,
            duration_ms: trackDuration * 1000,
            cover_url: trackImage,
            album_id: trackAlbumId,
            explicit: amazonItemIsExplicit(item)
          });
          rememberResourceContext("track", tId, _currentContext);
          if (trackAlbumId) rememberResourceContext("album", trackAlbumId, _currentContext);
        }
      }

      // Album items with /albums/ deeplink and no trackAsin
      if (wantAlbums && (iface.indexOf("SquareVerticalItemElement") >= 0 || iface.indexOf("SquareHorizontalItemElement") >= 0)) {
        var albumDeeplink = "";
        if (item.primaryLink && item.primaryLink.deeplink) {
          albumDeeplink = item.primaryLink.deeplink;
        }

        var albumInfo = extractAmazonDeeplinkInfo(albumDeeplink);
        if (albumInfo && albumInfo.type === "albums") {
          var aId = albumInfo.id;
          var albumTitle = textValue(item.primaryText);
          var albumArtist = textValue(item.secondaryText);
          var albumImage = item.image ? ensureHighResCoverUrl(item.image) : "";

          if (albumTitle && aId) {
            results.push({
              item_type: "album",
              id: aId,
              name: albumTitle,
              artists: albumArtist,
              cover_url: albumImage
            });
            rememberResourceContext("album", aId, _currentContext);
          }
        }
      }

      // Artist items (CircleVerticalItemElement or SquareVerticalItemElement with /artists/)
      if (wantArtists && (iface.indexOf("CircleVerticalItemElement") >= 0 || iface.indexOf("SquareVerticalItemElement") >= 0)) {
        var artistDeeplink = "";
        if (item.primaryLink && item.primaryLink.deeplink) {
          artistDeeplink = item.primaryLink.deeplink;
        }

        if (artistDeeplink.indexOf("/artists/") >= 0) {
          var arId = extractDeeplinkId(artistDeeplink);
          var artistName = textValue(item.primaryText);
          var artistImage = item.image ? ensureHighResCoverUrl(item.image) : "";

          if (artistName && arId) {
            results.push({
              item_type: "artist",
              id: arId,
              name: artistName,
              artists: artistName,
              cover_url: artistImage
            });
            rememberResourceContext("artist", arId, _currentContext);
            rememberResourceHint("artist", arId, { name: artistName, image: artistImage });
          }
        }
      }

      // Playlist items (SquareVerticalItemElement with /playlists/)
      if (wantPlaylists && iface.indexOf("SquareVerticalItemElement") >= 0) {
        var plDeeplink = "";
        if (item.primaryLink && item.primaryLink.deeplink) {
          plDeeplink = item.primaryLink.deeplink;
        }

        if (plDeeplink.indexOf("/playlists/") >= 0) {
          var plId = extractDeeplinkId(plDeeplink);
          var plTitle = textValue(item.primaryText);
          var plImage = item.image ? ensureHighResCoverUrl(item.image) : "";

          if (plTitle && plId) {
            results.push({
              item_type: "playlist",
              id: plId,
              name: plTitle,
              cover_url: plImage
            });
            rememberResourceContext("playlist", plId, _currentContext);
            rememberResourceHint("playlist", plId, { name: plTitle, cover_art: plImage });
          }
        }
      }
    }
  }

  // Also check DescriptiveTableWidgetElement for track results not in shovelers
  if (wantTracks && results.length < CONFIG.maxResults) {
    var tables = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveTableWidgetElement", [], 0);
    for (var tb = 0; tb < tables.length; tb++) {
      if (!tables[tb].items) continue;
      for (var ti = 0; ti < tables[tb].items.length && results.length < CONFIG.maxResults; ti++) {
        var tItem = tables[tb].items[ti];
        if (!tItem.primaryText) continue;
        var tName = textValue(tItem.primaryText);
        var tDl = (tItem.primaryTextLink && tItem.primaryTextLink.deeplink) ? tItem.primaryTextLink.deeplink : "";
        var tDur = tItem.secondaryText3 ? parseDurationMMSS(tItem.secondaryText3) : 0;
        var tArt = "";
        if (tItem.secondaryText1) {
          tArt = textValue(tItem.secondaryText1);
        }
        var tImg = tItem.image ? ensureHighResCoverUrl(tItem.image) : "";
        var tInfo = extractAmazonDeeplinkInfo(tDl);
        var tTrackId = tInfo ? tInfo.id : null;

        if (tName && tTrackId) {
          // Check for duplicates
          var dup = false;
          for (var d = 0; d < results.length; d++) {
            if (results[d].id === tTrackId) { dup = true; break; }
          }
          if (!dup) {
            results.push({
              item_type: "track",
              id: tTrackId,
              name: tName,
              artists: tArt,
              duration_ms: tDur * 1000,
              cover_url: tImg,
              album_id: tInfo ? tInfo.albumId || "" : "",
              explicit: amazonItemIsExplicit(tItem)
            });
            rememberResourceContext("track", tTrackId, _currentContext);
          }
        }
      }
    }
  }

  return results;
}

function customSearchSync(query, options) {
  L("info", "[Amazon] customSearch:", query);

  var filter = null;
  var context = _currentContext;
  if (options && options.filter) filter = options.filter;
  if (options && options.context) context = options.context;

  var cacheKey = "search_" + query + "_" + (filter || "all");
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var data = fetchWithRetry(function() {
    return callShowSearch(query, context);
  });

  if (!data) {
    L("error", "[Amazon] Search failed for:", query);
    return [];
  }

  var results = parseSearchResults(data, filter);
  L("info", "[Amazon] Search returned", results.length, "results");

  cacheSet(cacheKey, results);
  return results;
}

// ==================== enrichTrack ====================

function enrichTrack(trackInfo) {
  L("info", "[Amazon] enrichTrack:", trackInfo ? (trackInfo.name || trackInfo.title || trackInfo.id) : "null");

  if (!trackInfo || !trackInfo.id) return trackInfo;

  var trackId = trackInfo.id;
  var cacheKey = "enrich_" + trackId;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Prefer Go JSON tag names (name, artists, album_name, cover_url) first,
  // then fall back to internal parser names (title, artist, album, cover_art)
  var enriched = {
    id: trackInfo.id,
    name: trackInfo.name || trackInfo.title || "",
    artists: trackInfo.artists || trackInfo.artist || "",
    album_name: trackInfo.album_name || trackInfo.album || "",
    duration_ms: trackInfo.duration_ms || 0,
    track_number: trackInfo.track_number || 0,
    cover_url: ensureHighResCoverUrl(trackInfo.cover_url || trackInfo.cover_art || ""),
    isrc: trackInfo.isrc || "",
    spotify_id: trackInfo.spotify_id || "",
    deezer_id: trackInfo.deezer_id || ""
  };

  // SongLink lookup is optional best-effort for ISRC/cross-platform IDs
  // It does NOT block downloading - ASIN is enough for AfkarXYZ
  try {
    var amazonUrl = CONFIG.musicBaseURL + "/tracks/" + trackId;
    var songLinkData = callSongLink(CONFIG.songlinkBaseURL + "?url=" + encodeURIComponent(amazonUrl) + "&userCountry=US");

    if (songLinkData) {
      // Extract ISRC
      if (songLinkData.entitiesByUniqueId) {
        var entities = songLinkData.entitiesByUniqueId;
        var entityKeys = Object.keys(entities);
        for (var i = 0; i < entityKeys.length; i++) {
          var entity = entities[entityKeys[i]];
          if (entity && entity.isrc && !enriched.isrc) {
            enriched.isrc = entity.isrc;
          }
        }
      }

      // Extract cross-platform IDs for metadata tagging
      if (songLinkData.linksByPlatform) {
        if (!enriched.spotify_id && songLinkData.linksByPlatform.spotify) {
          var spotUrl = songLinkData.linksByPlatform.spotify.url;
          if (spotUrl) {
            var spotMatch = spotUrl.match(/track\/([a-zA-Z0-9]+)/);
            if (spotMatch) enriched.spotify_id = spotMatch[1];
          }
        }
        if (!enriched.deezer_id && songLinkData.linksByPlatform.deezer) {
          var dzUrl = songLinkData.linksByPlatform.deezer.url;
          if (dzUrl) {
            var dzMatch = dzUrl.match(/track\/(\d+)/);
            if (dzMatch) enriched.deezer_id = dzMatch[1];
          }
        }
      }
    }
  } catch (e) {
    // SongLink failure is not fatal - we still have ASIN for download
    L("warn", "[Amazon] SongLink enrichment failed (non-fatal):", String(e));
  }

  L("info", "[Amazon] Enriched track ISRC:", enriched.isrc, "spotify:", enriched.spotify_id);
  cacheSet(cacheKey, enriched);
  return enriched;
}

// ==================== Zarz Moe Resolve ====================

function callZarzMoeResolve(spotifyID) {
  var data;
  try {
    data = signedJSON("POST", "/resolve", { url: "https://open.spotify.com/track/" + spotifyID });
  } catch (e) {
    L("warn", "[Amazon] zarz.moe resolve failed:", String(e && e.message ? e.message : e));
    return null;
  }

  if (!data || !data.success || !data.songUrls) {
    L("warn", "[Amazon] zarz.moe resolve returned success=false or no songUrls");
    return null;
  }
  var amazonURL = null;
  if (data.songUrls.AmazonMusic) {
    var rawValue = data.songUrls.AmazonMusic;
    if (typeof rawValue === "string" && rawValue) {
      amazonURL = rawValue;
    } else if (Array.isArray(rawValue) && rawValue.length > 0) {
      amazonURL = rawValue[0];
    }
  }
  if (!amazonURL) {
    L("info", "[Amazon] zarz.moe resolve: no AmazonMusic link for Spotify ID:", spotifyID);
    return null;
  }
  L("info", "[Amazon] zarz.moe resolve: found Amazon URL:", amazonURL);
  return amazonURL;
}

// ==================== SongLink Resolution ====================

function callSongLink(lookupURL) {
  var res;
  try {
    res = fetch(lookupURL, {
      method: "GET",
      headers: { "User-Agent": getRandomUA(), "Accept": "application/json" }
    });
  } catch (e) {
    L("error", "[Amazon] SongLink fetch failed:", String(e));
    return null;
  }
  if (!res || !res.ok) {
    L("warn", "[Amazon] SongLink returned status:", res ? res.status : "no response");
    return null;
  }
  try { return res.json(); } catch (e) {
    L("error", "[Amazon] SongLink JSON parse failed:", String(e));
    return null;
  }
}

function callSongLinkPage(spotifyID) {
  var pageURL = "https://song.link/s/" + encodeURIComponent(spotifyID);
  var res;
  try {
    res = fetch(pageURL, {
      method: "GET",
      headers: {
        "User-Agent": getRandomUA(),
        "Accept": "text/html,application/xhtml+xml"
      }
    });
  } catch (e) {
    L("error", "[Amazon] SongLink page fetch failed:", String(e));
    return null;
  }
  if (!res || !res.ok) {
    L("warn", "[Amazon] SongLink page returned status:", res ? res.status : "no response");
    return null;
  }
  try {
    return res.text();
  } catch (e) {
    L("error", "[Amazon] SongLink page text read failed:", String(e));
    return null;
  }
}

function extractSongLinkNextDataJSON(html) {
  if (!html || typeof html !== "string") return null;
  var startMarker = '<script id="__NEXT_DATA__" type="application/json">';
  var endMarker = "</script>";
  var start = html.indexOf(startMarker);
  if (start < 0) return null;
  start += startMarker.length;
  var end = html.indexOf(endMarker, start);
  if (end < 0) return null;
  return html.substring(start, end);
}

function extractSongLinkPageLinks(html) {
  var nextDataJSON = extractSongLinkNextDataJSON(html);
  if (!nextDataJSON) return null;
  try {
    var pageData = JSON.parse(nextDataJSON);
    var sections = (((pageData || {}).props || {}).pageProps || {}).pageData;
    sections = sections && sections.sections ? sections.sections : [];
    var linksByPlatform = {};
    for (var i = 0; i < sections.length; i++) {
      var links = sections[i] && sections[i].links ? sections[i].links : [];
      for (var j = 0; j < links.length; j++) {
        var link = links[j] || {};
        if (!link.show || !link.url || !link.platform) continue;
        linksByPlatform[link.platform] = { url: link.url };
      }
    }
    return linksByPlatform;
  } catch (e) {
    L("error", "[Amazon] SongLink page parse failed:", String(e));
    return null;
  }
}

function resolveAmazonURLFromSpotifyPage(spotifyID) {
  var html = callSongLinkPage(spotifyID);
  if (!html) return null;
  var linksByPlatform = extractSongLinkPageLinks(html);
  if (!linksByPlatform || !linksByPlatform.amazonMusic || !linksByPlatform.amazonMusic.url) {
    L("warn", "[Amazon] SongLink page had no Amazon link for Spotify ID:", spotifyID);
    return null;
  }
  L("info", "[Amazon] Found Amazon URL via SongLink page:", linksByPlatform.amazonMusic.url);
  return linksByPlatform.amazonMusic.url;
}

function extractAmazonURLFromSongLink(data) {
  if (data && data.linksByPlatform && data.linksByPlatform.amazonMusic) {
    var u = data.linksByPlatform.amazonMusic.url;
    if (u) return u;
  }
  return null;
}

function callSongstatsForAmazon(isrc) {
  var url = "https://songstats.com/" + encodeURIComponent(isrc.toUpperCase().trim()) + "?ref=ISRCFinder";
  var res;
  try {
    res = fetch(url, {
      method: "GET",
      headers: { "User-Agent": getRandomUA(), "Accept": "text/html" }
    });
  } catch (e) {
    L("warn", "[Amazon] Songstats fetch failed:", String(e));
    return null;
  }
  if (!res || !res.ok) {
    L("warn", "[Amazon] Songstats returned status:", res ? res.status : "no response");
    return null;
  }
  var html;
  try { html = res.text(); } catch (e) {
    L("error", "[Amazon] Songstats text read failed:", String(e));
    return null;
  }
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var match;
  while ((match = re.exec(html)) !== null) {
    var jsonStr = match[1];
    var parsed;
    try { parsed = JSON.parse(jsonStr); } catch (e) { continue; }
    var amazonURL = extractAmazonFromJsonLD(parsed);
    if (amazonURL) {
      L("info", "[Amazon] Found Amazon URL via Songstats:", amazonURL);
      return amazonURL;
    }
  }
  L("info", "[Amazon] Songstats had no Amazon link for ISRC:", isrc);
  return null;
}

function extractAmazonFromJsonLD(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      var r = extractAmazonFromJsonLD(obj[i]);
      if (r) return r;
    }
    return null;
  }
  if (obj.sameAs && Array.isArray(obj.sameAs)) {
    for (var j = 0; j < obj.sameAs.length; j++) {
      var link = obj.sameAs[j];
      if (typeof link === "string" && link.indexOf("music.amazon.") !== -1) {
        return link;
      }
    }
  }
  var keys = Object.keys(obj);
  for (var k = 0; k < keys.length; k++) {
    var val = obj[keys[k]];
    if (val && typeof val === "object") {
      var r = extractAmazonFromJsonLD(val);
      if (r) return r;
    }
  }
  return null;
}

function isLikelySpotifyId(id) {
  return typeof id === "string" && /^[A-Za-z0-9]{22}$/.test(id.trim());
}

function resolveAmazonURL(isrc, spotifyID, deezerID) {
  // Deezer first: the app resolves a Deezer ID from the ISRC reliably and
  // SongLink maps it to Amazon without depending on the zarz.moe resolve
  // endpoint, which can be slow or down and otherwise burns the whole timeout.
  if (deezerID) {
    L("info", "[Amazon] Resolving via Deezer ID:", deezerID);
    var deezerURL = "https://www.deezer.com/track/" + deezerID;
    var data = callSongLink(CONFIG.songlinkBaseURL + "?url=" + encodeURIComponent(deezerURL) + "&userCountry=US");
    var url = extractAmazonURLFromSongLink(data);
    if (url) {
      L("info", "[Amazon] Found Amazon URL via Deezer:", url);
      return url;
    }
  }
  // Spotify next, but only for genuine Spotify IDs. Metadata sourced from Apple
  // Music and others can place a numeric foreign ID in this field, which
  // produces an invalid Spotify URL and poisons every Spotify-based lookup.
  if (isLikelySpotifyId(spotifyID)) {
    L("info", "[Amazon] Resolving via Spotify ID:", spotifyID);
    var url = callZarzMoeResolve(spotifyID);
    if (url) return url;
    L("info", "[Amazon] zarz.moe failed for Spotify ID, falling back to SongLink page");
    url = resolveAmazonURLFromSpotifyPage(spotifyID);
    if (url) {
      return url;
    }
    var spotifyURL = "https://open.spotify.com/track/" + spotifyID;
    var data = callSongLink(CONFIG.songlinkBaseURL + "?url=" + encodeURIComponent(spotifyURL) + "&userCountry=US");
    url = extractAmazonURLFromSongLink(data);
    if (url) {
      L("info", "[Amazon] Found Amazon URL via Spotify:", url);
      return url;
    }
  } else if (spotifyID) {
    L("info", "[Amazon] Ignoring non-Spotify ID in spotify field:", spotifyID);
  }
  if (isrc) {
    L("info", "[Amazon] Resolving via ISRC:", isrc);
    var data = callSongLink(CONFIG.songlinkBaseURL + "?isrc=" + encodeURIComponent(isrc) + "&userCountry=US");
    var url = extractAmazonURLFromSongLink(data);
    if (url) {
      L("info", "[Amazon] Found Amazon URL via ISRC:", url);
      return url;
    }
    L("info", "[Amazon] SongLink ISRC failed, trying Songstats for ISRC:", isrc);
    url = callSongstatsForAmazon(isrc);
    if (url) return url;
  }
  L("info", "[Amazon] No Amazon URL found");
  return null;
}

// ==================== Zarz.moe Download API ====================

function qualityToCodec(quality) {
  if (!quality) return "flac";
  var q = String(quality).toLowerCase().trim();
  if (q === "opus") return "opus";
  if (q === "eac3") return "eac3";
  if (q === "ac4") return "ac4";
  // "best" and any other value defaults to flac
  return "flac";
}

function normalizeAudioCodec(codec) {
  var c = String(codec || "").toLowerCase().trim();
  if (c.indexOf(".") >= 0) c = c.split(".")[0];
  if (c === "ec-3") return "eac3";
  if (c === "ac-4") return "ac4";
  return c || "flac";
}

// ==================== v2 Signed Session Helpers ====================

// Performs an HMAC-signed request via the host runtime. The session secret
// lives in Go and is scoped by namespace, base URL, app version, and platform,
// so each provider must complete its own verification challenge.
function signedJSON(method, path, body, headers) {
  if (typeof session === "undefined" || !session || typeof session.signedFetch !== "function") {
    throw new Error("signed session runtime is not available");
  }
  var response = session.signedFetch(method, path, body || null, headers || {});
  if (response && response.needsVerification) {
    var verr = new Error("VERIFY_REQUIRED");
    verr.needsVerification = true;
    verr.authUrl = response.auth_url || response.open_auth_url || "";
    throw verr;
  }
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "signed request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + path);
  }
  return JSON.parse(response.body || "null");
}

// Mints a one-use download ticket. resource_hash must match what the server
// hashes at consume time: the /v2/dl/amazeamazeamaze handler derives it from
// body.asin, so we hash the alias + asin here.
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

function callZarzMedia(asin, codec) {
  if (!codec) codec = "flac";
  L("info", "[Amazon] Calling v2 signed download API for ASIN:", asin, "codec:", codec);

  var data;
  try {
    var ticketID = signedTicket("amazeamazeamaze", "track", asin);
    data = signedJSON("POST", "/dl/amazeamazeamaze", { asin: asin, codec: codec }, {
      "X-Zarz-Ticket": ticketID
    });
  } catch (e) {
    if (e && e.needsVerification) {
      // Surface verification upward so download() can tag the result and the
      // app shows the in-app verification sheet.
      return { needsVerification: true, authUrl: e.authUrl || "" };
    }
    // Other failures (5xx/429/transient) -> null lets fetchWithRetry retry.
    L("warn", "[Amazon] v2 download API failed:", String(e && e.message ? e.message : e));
    return null;
  }

  // Response is an array, take first element
  if (Array.isArray(data)) {
    if (data.length === 0) {
      L("warn", "[Amazon] v2 download API returned empty array");
      return null;
    }
    data = data[0];
  }
  if (!data || !data.audio || !data.audio.url) {
    L("warn", "[Amazon] v2 download API returned no audio URL");
    return null;
  }
  // Build cover URL from template (when present)
  var coverUrl = "";
  if (data.cover) {
    coverUrl = data.cover.replace("{size}", "1200").replace("{jpegQuality}", "94").replace("{format}", "jpg");
  }
  return {
    streamUrl: data.audio.url,
    decryptionKey: (data.audio.key || "").trim(),
    codec: data.audio.codec || codec,
    sampleRate: data.audio.sampleRate || 0,
    meta: data.meta || null,
    coverUrl: coverUrl
  };
}

// ==================== Home Feed ====================

function extractNextPageToken(data) {
  // The pagination token is embedded in onEndOfWidgetsReached of the first GalleryTemplate.
  // It contains an InvokeHttpSkillMethod with a URL like:
  //   .../showHomeBrowse?next={"offset":4,"uri":"home","nextToken":"<uuid>","count":4}&userHash=...
  // We extract the "next" query parameter JSON from that URL.
  var galleries = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.GalleryTemplateInterface.GalleryTemplate", [], 0);
  for (var g = 0; g < galleries.length; g++) {
    var reached = galleries[g].onEndOfWidgetsReached;
    if (!reached || !Array.isArray(reached) || reached.length === 0) continue;
    for (var r = 0; r < reached.length; r++) {
      var url = reached[r].url;
      if (!url || url.indexOf("showHomeBrowse") < 0) continue;
      try {
        var qIdx = url.indexOf("?");
        if (qIdx < 0) continue;
        var qs = url.substring(qIdx + 1);
        var parts = qs.split("&");
        for (var p = 0; p < parts.length; p++) {
          if (parts[p].indexOf("next=") === 0) {
            var nextVal = decodeURIComponent(parts[p].substring(5));
            var parsed = JSON.parse(nextVal);
            L("info", "[Amazon] Extracted next page token: offset=" + parsed.offset + ", nextToken=" + (parsed.nextToken || "none"));
            return parsed;
          }
        }
      } catch (e) {
        L("error", "[Amazon] Failed to parse next page token:", String(e));
      }
    }
  }
  return null;
}

function fetchHomeFeed() {
  L("info", "[Amazon] Fetching home feed...");
  initSession();

  // Use showHomeBrowse which returns the actual section data (shovelers with items).
  // showHome only returns template/chrome data without content on the web API.
  var result = callShowHomeBrowse();
  if (result && result.data) {
    var feedData = formatHomeFeedData(result.data);
    if (feedData.sections.length > 0) {
      // Extract pagination token and fetch next page
      var nextPage = extractNextPageToken(result.data);
      if (nextPage) {
        L("info", "[Amazon] Fetching page 2 with offset " + nextPage.offset + "...");
        var result2 = callShowHomeBrowse(null, nextPage);
        if (result2 && result2.data) {
          var feedData2 = formatHomeFeedData(result2.data);
          for (var s2 = 0; s2 < feedData2.sections.length; s2++) {
            feedData.sections.push(feedData2.sections[s2]);
          }
          L("info", "[Amazon] Home feed total: " + feedData.sections.length + " sections (page1 + page2)");
        }
      }
      return feedData;
    }
  }

  // Fallback: try original showHome approach (may work on mesk/mobile API)
  L("info", "[Amazon] showHomeBrowse returned 0 sections, falling back to showHome...");
  var fallbackResult = callShowHome("/");
  if (!fallbackResult || !fallbackResult.data) {
    L("error", "[Amazon] Home feed: both showHomeBrowse and showHome failed");
    return { success: false, error: "Failed to fetch Amazon Music home page", sections: [] };
  }

  return formatHomeFeedData(fallbackResult.data);
}

function formatHomeFeedData(data) {
  var sections = [];
  if (!data || !data.methods) {
    return { success: true, greeting: "", sections: sections };
  }

  // Debug: log all interfaces present in home feed data
  var ifaces = collectInterfaces(data, {}, 0);
  var ifaceNames = Object.keys(ifaces);
  var ifaceSummary = [];
  for (var k = 0; k < ifaceNames.length; k++) {
    var shortName = ifaceNames[k].replace("Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.", "").replace("Web.TemplatesInterface.v1_0.Touch.", "");
    if (ifaceNames[k].indexOf("Widget") >= 0 || ifaceNames[k].indexOf("Shoveler") >= 0 ||
        ifaceNames[k].indexOf("Item") >= 0 || ifaceNames[k].indexOf("Section") >= 0 ||
        ifaceNames[k].indexOf("Showcase") >= 0 || ifaceNames[k].indexOf("Carousel") >= 0 ||
        ifaceNames[k].indexOf("Grid") >= 0 || ifaceNames[k].indexOf("Container") >= 0) {
      ifaceSummary.push(shortName + ":" + ifaces[ifaceNames[k]]);
    }
  }
  L("info", "[Amazon] Home feed ALL interfaces (" + ifaceNames.length + " total): " + ifaceNames.join(", "));
  L("info", "[Amazon] Home feed widget/item interfaces: " + ifaceSummary.join(", "));

  // Collect all shoveler-type widgets (these are the horizontal sections on the home page)
  // Also dynamically find any interface containing "Shoveler" or "Showcase" as fallback
  var shovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement", [], 0);
  var featuredShovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.FeaturedShovelerWidgetElement", [], 0);
  var descriptiveShowcases = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShowcaseWidgetElement", [], 0);
  var descriptiveShovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShovelerWidgetElement", [], 0);
  for (var fs = 0; fs < featuredShovelers.length; fs++) shovelers.push(featuredShovelers[fs]);
  for (var ds = 0; ds < descriptiveShowcases.length; ds++) shovelers.push(descriptiveShowcases[ds]);
  for (var dsi = 0; dsi < descriptiveShovelers.length; dsi++) shovelers.push(descriptiveShovelers[dsi]);

  // Fallback: if no known shoveler interfaces found, dynamically discover any widget with "items" array
  if (shovelers.length === 0) {
    L("info", "[Amazon] No known shoveler interfaces found, trying dynamic discovery...");
    for (var di = 0; di < ifaceNames.length; di++) {
      var ifName = ifaceNames[di];
      // Look for anything that might be a section/shoveler/carousel widget
      if (ifName.indexOf("Shoveler") >= 0 || ifName.indexOf("Showcase") >= 0 ||
          ifName.indexOf("Carousel") >= 0 || ifName.indexOf("Grid") >= 0) {
        var dynamicWidgets = findAllByInterface(data, ifName, [], 0);
        for (var dw = 0; dw < dynamicWidgets.length; dw++) {
          if (dynamicWidgets[dw].items && dynamicWidgets[dw].items.length > 0) {
            shovelers.push(dynamicWidgets[dw]);
          }
        }
        if (dynamicWidgets.length > 0) {
          L("info", "[Amazon] Dynamic discovery found " + dynamicWidgets.length + " widgets for: " + ifName);
        }
      }
    }
  }

  // Second fallback: find ANY object with a "header" and "items" array
  if (shovelers.length === 0) {
    L("info", "[Amazon] Dynamic discovery found nothing, trying deep scan for objects with header+items...");
    var candidates = findWidgetsWithItems(data, [], 0);
    for (var ci = 0; ci < candidates.length; ci++) {
      shovelers.push(candidates[ci]);
    }
    L("info", "[Amazon] Deep scan found " + shovelers.length + " candidate widgets");
  }

  for (var s = 0; s < shovelers.length; s++) {
    var shoveler = shovelers[s];
    if (!shoveler.items || shoveler.items.length === 0) continue;

    // Extract section title from header
    var sectionTitle = "";
    if (typeof shoveler.header === "string") {
      sectionTitle = shoveler.header;
    } else if (shoveler.header && typeof shoveler.header === "object") {
      sectionTitle = textValue(shoveler.header);
    }
    if (!sectionTitle) {
      // Try headerText or title in the shoveler
      var ht = findFirst(shoveler, "headerText", 0);
      if (ht) sectionTitle = textValue(ht);
    }
    if (!sectionTitle) continue;

    var items = [];

    for (var i = 0; i < shoveler.items.length; i++) {
      var item = shoveler.items[i];
      var iface = item["interface"] || "";
      var deeplink = "";
      var itemId = "";
      var itemType = "";
      var itemName = textValue(item.primaryText);
      var artistStr = "";
      var coverUrl = "";
      var durationMs = 0;
      var albumId = "";
      var albumName = "";
      var description = "";

      // Extract deeplink
      if (item.primaryLink && item.primaryLink.deeplink) {
        deeplink = item.primaryLink.deeplink;
      } else if (item.primaryTextLink && item.primaryTextLink.deeplink) {
        deeplink = item.primaryTextLink.deeplink;
      }

      if (!deeplink) continue;

      var deeplinkInfo = extractAmazonDeeplinkInfo(deeplink);
      if (!deeplinkInfo || !deeplinkInfo.id) continue;

      itemId = deeplinkInfo.id;

      // Determine type from deeplink path
      var dlType = deeplinkInfo.type;
      if (dlType === "podcasts" || dlType === "podcast") {
        continue; // Skip podcasts - not downloadable music
      }
      if (dlType === "albums" && !deeplinkInfo.albumId) {
        itemType = "album";
      } else if (dlType === "track" || (dlType === "albums" && deeplinkInfo.albumId)) {
        itemType = "track";
        albumId = deeplinkInfo.albumId || "";
      } else if (dlType === "artists") {
        itemType = "artist";
      } else if (dlType === "playlists") {
        itemType = "playlist";
      } else {
        // Fallback: infer from interface name
        if (iface.indexOf("CircleVerticalItemElement") >= 0) {
          itemType = "artist";
        } else if (iface.indexOf("DescriptiveRowItemElement") >= 0) {
          itemType = "track";
        } else {
          itemType = "album"; // default
        }
      }

      // Artist
      if (item.secondaryText1) artistStr = textValue(item.secondaryText1);
      if (!artistStr && item.secondaryText) artistStr = textValue(item.secondaryText);

      // Cover image
      if (item.image) coverUrl = ensureHighResCoverUrl(item.image);

      // Duration (for tracks)
      if (itemType === "track") {
        if (item.secondaryText3) durationMs = parseDurationMMSS(item.secondaryText3) * 1000;
      }

      // Description (for playlists)
      if (itemType === "playlist" && item.secondaryText) {
        description = textValue(item.secondaryText);
      }

      // Fallback: use imageAltText if primaryText was empty (common in showHomeBrowse items)
      if (!itemName && item.imageAltText) itemName = String(item.imageAltText);
      if (!itemName) continue;

      items.push({
        id: itemId,
        uri: deeplink,
        type: itemType,
        name: itemName,
        artists: artistStr,
        description: description,
        cover_url: coverUrl,
        album_id: albumId,
        album_name: albumName,
        duration_ms: durationMs,
        provider_id: "amazon"
      });

      // Remember context for later resource fetching
      if (itemType === "track" || itemType === "album") {
        rememberResourceContext(itemType === "track" ? "track" : "album", itemId, _currentContext);
      }
    }

    if (items.length > 0) {
      sections.push({
        uri: "",
        title: sectionTitle,
        items: items
      });
    }
  }

  L("info", "[Amazon] Home feed: " + sections.length + " sections");
  return {
    success: true,
    greeting: "",
    sections: sections
  };
}

function getHomeFeed() {
  try {
    return fetchHomeFeed();
  } catch (e) {
    L("error", "[Amazon] getHomeFeed failed: " + String(e));
    return { success: false, error: String(e), sections: [] };
  }
}

// ==================== Extension Registration ====================

function completeGrant() {
  if (typeof session === "undefined" || !session || typeof session.completeGrant !== "function") {
    return { success: false, error: "signed session runtime is not available" };
  }
  return session.completeGrant();
}

registerExtension({
  initialize: function() {
    L("info", "[Amazon] Extension v2.2.0 init");
    initSession();
    return true;
  },

  // Exchanges the verification grant for a signed session. The host app calls
  // this action after the user completes the Turnstile challenge; without it
  // the grant is never exchanged and downloads loop on "Verification required".
  completeGrant: completeGrant,

  // ---- Metadata Provider Functions ----

  handleUrl: handleUrl,

  getAlbum: getAlbum,

  getPlaylist: getPlaylist,

  getArtist: getArtist,

  enrichTrack: enrichTrack,

  getHomeFeed: getHomeFeed,

  customSearch: function(query, options) {
    L("info", "[Amazon] customSearch:", query, "options:", JSON.stringify(options || {}));
    try {
      return customSearchSync(query, options);
    } catch (e) {
      L("error", "[Amazon] customSearch fatal:", String(e));
      return [];
    }
  },

  // ---- Download Provider Functions ----
  //
  // Flow A (URL langsung): handleUrl -> getAlbum -> track.id = ASIN
  //   Go memanggil download(ASIN) langsung TANPA checkAvailability.
  //   Jadi ASIN sudah diketahui, langsung hit AfkarXYZ.
  //
  // Flow B (fallback, track dari Spotify/lainnya):
  //   Go memanggil checkAvailability(isrc, trackName, artistName, {spotify_id, deezer_id})
  //   checkAvailability resolve ASIN via SongLink, lalu return {track_id: ASIN}
  //   Go kemudian memanggil download(ASIN).

  checkAvailability: function(isrc, trackName, artistName, options) {
    L("info", "[Amazon] checkAvailability:", isrc, trackName, artistName);
    var spotifyID = (options && options.spotify_id) ? options.spotify_id : null;
    var deezerID = (options && options.deezer_id) ? options.deezer_id : null;

    // Cek apakah spotifyID sebenarnya sudah ASIN (dari handleUrl/getAlbum)
    if (spotifyID && ASIN_REGEX.test(spotifyID)) {
      L("info", "[Amazon] spotifyID is already an ASIN:", spotifyID);
      return { available: true, track_id: spotifyID };
    }

    // Fallback: resolve ASIN via SongLink (untuk track dari sumber lain)
    var amazonURL = resolveAmazonURL(isrc, spotifyID, deezerID);
    if (!amazonURL) {
      return { available: false, reason: "not_found_on_amazon" };
    }
    var asin = extractASIN(amazonURL);
    if (!asin) {
      return { available: false, reason: "could_not_extract_asin" };
    }
    L("info", "[Amazon] Track available, ASIN:", asin);
    return { available: true, track_id: asin };
  },

  download: function(trackID, quality, outputPath, onProgress) {
    L("info", "[Amazon] download called:", trackID, quality);

    // trackID bisa berupa:
    // - ASIN langsung (dari handleUrl/getAlbum flow, atau checkAvailability)
    // - "ASIN|amazonURL" (legacy compat)
    var asin = String(trackID).trim();

    if (asin.indexOf("|") >= 0) {
      var parts = asin.split("|");
      asin = parts[0];
    }

    if (!asin || !ASIN_REGEX.test(asin)) {
      return { success: false, error_message: "Invalid track ID / ASIN: " + trackID, error_type: "invalid_input" };
    }

    var codec = qualityToCodec(quality);
    L("info", "[Amazon] Downloading ASIN:", asin, "codec:", codec);

    // Call Zarz.moe media API — with fallback to FLAC if requested codec unavailable
    var apiResult = fetchWithRetry(function() {
      return callZarzMedia(asin, codec);
    });

    // If non-FLAC codec failed, fallback to FLAC
    if (!apiResult && codec !== "flac") {
      L("info", "[Amazon] Codec", codec, "unavailable for ASIN:", asin, "— falling back to FLAC");
      codec = "flac";
      apiResult = fetchWithRetry(function() {
        return callZarzMedia(asin, "flac");
      });
    }

    if (apiResult && apiResult.needsVerification) {
      return {
        success: false,
        error_message: "Verification required",
        error_type: "verification_required",
        auth_url: apiResult.authUrl || ""
      };
    }

    if (!apiResult) {
      return { success: false, error_message: "Download API failed for ASIN: " + asin, error_type: "api_error" };
    }

    var outputExt = "";
    if (codec === "eac3" || codec === "ac4" || codec === "opus") {
      outputExt = ".mp4";
    }

    L("info", "[Amazon] Got stream URL, downloading to:", outputPath);
    var actualOutputPath = outputPath;
    if (apiResult.decryptionKey) {
      actualOutputPath = outputPath.replace(/\.[^.]+$/, outputExt || ".m4a");
      L("info", "[Amazon] Encrypted stream, saving as:", actualOutputPath);
    }

    if (onProgress) {
      try { onProgress(5); } catch (e) {}
    }

    var downloadResult = file.download(apiResult.streamUrl, actualOutputPath, {
      headers: { "User-Agent": getRandomUA() },
      onProgress: function(written, total) {
        if (onProgress && total > 0) {
          var percent = Math.min(95, Math.floor((written / total) * 95) + 5);
          try { onProgress(percent); } catch (e) {}
        }
      }
    });

    if (!downloadResult || !downloadResult.success) {
      var errMsg = downloadResult ? downloadResult.error : "file.download returned null";
      return { success: false, error_message: "Failed to download file: " + errMsg, error_type: "download_error" };
    }

    if (onProgress) {
      try { onProgress(100); } catch (e) {}
    }

    L("info", "[Amazon] Download complete for ASIN:", asin);
    var decryption = null;
    if (apiResult.decryptionKey) {
      // Determine output extension based on codec:
      // - flac: decrypt to .flac (Dart default)
      // - eac3/ac4: must use .mp4 (mp4/ipod muxer container constraints)
      // - opus: must use .mp4 (opus in encrypted MP4 can't go into .flac)
      decryption = {
        strategy: "ffmpeg.mov_key",
        key: apiResult.decryptionKey,
        input_format: "mov",
        output_extension: outputExt
      };
    }

    // Build result with rich metadata from Zarz.moe /media response
    var result = {
      success: true,
      file_path: downloadResult.path || actualOutputPath,
      decryption: decryption,
      decryption_key: apiResult.decryptionKey || "",
      output_extension: outputExt,
      audio_codec: normalizeAudioCodec(apiResult.codec || codec),
      bit_depth: 0,
      sample_rate: apiResult.sampleRate || 0
    };

    // Overlay metadata from /media API for Go backend enrichment
    if (apiResult.meta) {
      var m = apiResult.meta;
      if (m.title) result.title = m.title;
      if (m.artist) result.artist = m.artist;
      if (m.album) result.album = m.album;
      if (m.albumArtist) result.album_artist = m.albumArtist;
      if (m.track) result.track_number = m.track;
      if (m.trackTotal) result.total_tracks = m.trackTotal;
      if (m.disc) result.disc_number = m.disc;
      if (m.discTotal) result.total_discs = m.discTotal;
      if (m.isrc) result.isrc = m.isrc;
      if (m.genre) result.genre = m.genre;
      if (m.label) result.label = m.label;
      if (m.copyright) result.copyright = m.copyright;
      if (m.date) result.release_date = m.date;
    }
    if (apiResult.coverUrl) {
      result.cover_url = apiResult.coverUrl;
    }

    return result;
  },

  getDownloadUrl: function() { return null; },

  matchTrack: function() { return null; },

  validateTrackForDownload: function() { return true; },

  cleanup: function() {
    L("info", "[Amazon] Extension cleanup");
    _cache = {};
    _cacheTimes = {};
    _resourceContexts = {};
    _resourceHints = {};
    _currentContext = createAmazonContext(CONFIG.musicBaseURL);
    _session.initialized = false;
    return true;
  }
});

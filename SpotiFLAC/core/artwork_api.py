"""SpotiFLAC/core/artwork_api.py — Apple Music Animated Covers & 3000x iTunes Artwork Extractor."""

from __future__ import annotations

import asyncio
import logging
import re
import urllib.parse
from typing import Any, Dict, Optional, Tuple

import httpx

logger = logging.getLogger("SpotiFLAC.artwork_api")

ANIMATED_ARTWORK_BASE_URL = "https://artwork.m8tec.top"
ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
UA_SAFARI = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)


async def _scrape_apple_m3u8(apple_url: str) -> Optional[str]:
    """Scrapes Apple Music web page to extract animated .m3u8 video URL."""
    if not apple_url or not apple_url.startswith("http"):
        return None
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(apple_url, headers={"User-Agent": UA_SAFARI})
            if resp.status_code == 200:
                m3u8_links = set(re.findall(r'https?://[^\s"\'><]+?\.m3u8', resp.text))
                for link in m3u8_links:
                    if "mvod.itunes.apple.com" in link or "apple.com" in link:
                        return link
                if m3u8_links:
                    return list(m3u8_links)[0]
    except Exception as exc:
        logger.debug("Apple Music HLS scrape failed for %s: %s", apple_url, exc)
    return None


async def fetch_animated_artwork(
    artist: str = "", album: str = "", title: str = "", apple_url: str = ""
) -> Optional[Dict[str, Any]]:
    """Fetch animated artwork (.m3u8) by direct Apple Music URL or by searching artist/title."""
    # 1. Direct Apple Music URL scrape
    if apple_url:
        m3u8_url = await _scrape_apple_m3u8(apple_url)
        if m3u8_url:
            return {"animated_url": m3u8_url, "url": m3u8_url, "has_animated": True}

    # 2. Search iTunes to get Apple Music trackViewUrl / collectionViewUrl
    target_apple_url = None
    search_queries = [
        f"{artist} {title}".strip(),
        f"{title} {artist}".strip(),
        f"{artist} {album}".strip() if album else "",
    ]

    async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
        for q in search_queries:
            if not q:
                continue
            try:
                resp = await client.get(
                    ITUNES_SEARCH_URL,
                    params={"term": q, "entity": "song", "limit": 5, "country": "US"},
                )
                if resp.status_code == 200:
                    results = resp.json().get("results", [])
                    if results:
                        item = results[0]
                        target_apple_url = item.get("trackViewUrl") or item.get("collectionViewUrl")
                        if target_apple_url:
                            break
            except Exception:
                pass

    if target_apple_url:
        m3u8_url = await _scrape_apple_m3u8(target_apple_url)
        if m3u8_url:
            return {"animated_url": m3u8_url, "url": m3u8_url, "has_animated": True}

    # 3. Fallback to artwork.m8tec.top
    if artist or title:
        params = {"artist": artist, "album": album, "title": title}
        url = f"{ANIMATED_ARTWORK_BASE_URL}/api/v1/artwork/search?{urllib.parse.urlencode(params)}"
        try:
            async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    if data and isinstance(data, dict):
                        return data
        except Exception:
            pass

    return None


async def fetch_itunes_3000x_cover_url(artist: str, title: str, album: str = "") -> Optional[str]:
    """Search iTunes for track/album and return a high-resolution 3000x3000px cover URL."""
    search_terms = [
        f"{artist} {title}".strip(),
        f"{title} {artist}".strip(),
        f"{artist} {album}".strip() if album else "",
    ]
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            for term in search_terms:
                if not term:
                    continue
                resp = await client.get(
                    ITUNES_SEARCH_URL,
                    params={"term": term, "entity": "song", "limit": 5, "country": "US"},
                )
                if resp.status_code == 200:
                    results = resp.json().get("results", [])
                    for item in results:
                        cover_raw = item.get("artworkUrl100") or item.get("artworkUrl60")
                        if cover_raw:
                            high_res_url = re.sub(
                                r"/\d+x\d+bb\.([a-z]+)$",
                                r"/3000x3000bb.\1",
                                cover_raw,
                                flags=re.IGNORECASE,
                            )
                            return high_res_url
    except Exception as exc:
        logger.warning("iTunes 3000x cover search failed: %s", exc)
    return None


async def fetch_cover_bytes_3000x(
    artist: str, title: str, album: str = "", fallback_url: str = ""
) -> Tuple[Optional[bytes], str]:
    """Fetch cover image bytes (trying iTunes 3000x first, then fallback_url)."""
    itunes_url = await fetch_itunes_3000x_cover_url(artist, title, album)
    target_url = itunes_url or fallback_url

    if not target_url:
        return None, ""

    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            resp = await client.get(target_url)
            if resp.status_code == 200 and len(resp.content) > 1000:
                return resp.content, target_url
    except Exception as exc:
        logger.warning("Failed to download cover bytes from %s: %s", target_url, exc)

    if fallback_url and fallback_url != target_url:
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                resp = await client.get(fallback_url)
                if resp.status_code == 200 and len(resp.content) > 1000:
                    return resp.content, fallback_url
        except Exception:
            pass

    return None, target_url

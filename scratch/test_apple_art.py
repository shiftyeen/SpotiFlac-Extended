import httpx
import re

async def test_scrape(apple_url: str):
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    }
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        r = await client.get(apple_url, headers=headers)
        if r.status_code == 200:
            m3u8s = set(re.findall(r'https?://[^\s"\'><]+?\.m3u8', r.text))
            print("Extracted m3u8 URLs:", m3u8s)
            return list(m3u8s)
    return []

import asyncio
asyncio.run(test_scrape("https://music.apple.com/us/album/need-to-know/1573475827?i=1573475837"))

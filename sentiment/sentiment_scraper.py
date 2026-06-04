import os
import re
import time
import random
import logging
import cloudscraper
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# URLs
# ---------------------------------------------------------------
MENTFX_HOME = "https://mentfx.com/"
MENTFX_URL  = "https://mentfx.com/sentiment-viewer/index.php"

# ---------------------------------------------------------------
# Rotating User-Agents (latest Chrome/Firefox — 2024)
# ---------------------------------------------------------------
USER_AGENTS = [
    # Chrome Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # Chrome macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # Chrome Linux
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # Firefox Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    # Firefox macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
]

# ---------------------------------------------------------------
# Browser configs — cloudscraper ke liye rotation
# ---------------------------------------------------------------
BROWSER_CONFIGS = [
    {'browser': 'chrome',  'platform': 'windows', 'mobile': False},
    {'browser': 'chrome',  'platform': 'darwin',  'mobile': False},
    {'browser': 'chrome',  'platform': 'linux',   'mobile': False},
    {'browser': 'firefox', 'platform': 'windows', 'mobile': False},
    {'browser': 'firefox', 'platform': 'darwin',  'mobile': False},
]

# ---------------------------------------------------------------
# MENTFX_TO_APP Dictionary
# ---------------------------------------------------------------
MENTFX_TO_APP = {
    # Commodities & Oil
    'USOIL': 'USOIL', 'WTI': 'USOIL', 'CRUDEOIL': 'USOIL',
    'XAGUSD': 'XAGUSD', 'SILVER': 'XAGUSD', 'XAG': 'XAGUSD',

    # Indices
    'US500': 'US500', 'SPX500': 'US500', 'SPX': 'US500', 'S&P500': 'US500',
    'US100': 'US100', 'NAS100': 'US100', 'NASDAQ': 'US100', 'NASDAQ100': 'US100',
    'US30': 'US30', 'DOW': 'US30', 'DOW30': 'US30', 'DJ30': 'US30',
    'GER40': 'GER40', 'DAX': 'GER40', 'DAX40': 'GER40', 'GER30': 'GER40',
    'UK100': 'UK100', 'FTSE': 'UK100', 'FTSE100': 'UK100',
    'JPN225': 'JPN225', 'NIKKEI': 'JPN225', 'NIKKEI225': 'JPN225',

    # Major Forex
    'EURUSD': 'EURUSD', 'EUR/USD': 'EURUSD',
    'GBPUSD': 'GBPUSD', 'GBP/USD': 'GBPUSD',
    'USDJPY': 'USDJPY', 'USD/JPY': 'USDJPY',
    'USDCHF': 'USDCHF', 'USD/CHF': 'USDCHF',
    'USDCAD': 'USDCAD', 'USD/CAD': 'USDCAD',
    'AUDUSD': 'AUDUSD', 'AUD/USD': 'AUDUSD',
    'NZDUSD': 'NZDUSD', 'NZD/USD': 'NZDUSD',

    # Cross Forex
    'EURJPY': 'EURJPY', 'EUR/JPY': 'EURJPY',
    'GBPJPY': 'GBPJPY', 'GBP/JPY': 'GBPJPY',
    'AUDJPY': 'AUDJPY', 'AUD/JPY': 'AUDJPY',
}


# ---------------------------------------------------------------
# Helper: Ek fully realistic scraper session banao
# ---------------------------------------------------------------
def _make_scraper(ua: str, browser_cfg: dict) -> cloudscraper.CloudScraper:
    scraper = cloudscraper.create_scraper(
        browser=browser_cfg,
        delay=random.uniform(3, 7),        # challenge solve karne se pehle wait
    )
    # Cloudflare jo modern browser headers expect karta hai
    scraper.headers.update({
        'User-Agent':      ua,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control':   'max-age=0',
        # Sec-Fetch headers — modern Cloudflare inmein check karta hai
        'Sec-Fetch-Dest':  'document',
        'Sec-Fetch-Mode':  'navigate',
        'Sec-Fetch-Site':  'none',
        'Sec-Fetch-User':  '?1',
        # Client Hints
        'Sec-CH-UA':          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-CH-UA-Mobile':   '?0',
        'Sec-CH-UA-Platform': '"Windows"',
        'DNT': '1',
    })
    return scraper


# ---------------------------------------------------------------
# Helper: Homepage "warmup" — real browser ki tarah pehle homepage visit
# ---------------------------------------------------------------
def _warmup(scraper: cloudscraper.CloudScraper) -> bool:
    try:
        r = scraper.get(MENTFX_HOME, timeout=20)
        logger.debug(f"Warmup status: {r.status_code}")
        time.sleep(random.uniform(2, 4))   # human-like pause
        return r.status_code < 400
    except Exception as e:
        logger.warning(f"Warmup request failed: {e}")
        return False


# ---------------------------------------------------------------
# Main fetch — 3 retries, har baar nayi UA + browser config
# ---------------------------------------------------------------
def _fetch_html(max_retries: int = 3) -> str | None:
    configs = random.sample(BROWSER_CONFIGS, min(max_retries, len(BROWSER_CONFIGS)))

    for attempt in range(max_retries):
        ua  = random.choice(USER_AGENTS)
        cfg = configs[attempt % len(configs)]

        logger.info(f"[Attempt {attempt + 1}/{max_retries}] UA: {ua[:60]}... | Browser: {cfg}")

        scraper = _make_scraper(ua, cfg)

        # Step 1: Warmup — homepage pehle visit karo
        _warmup(scraper)

        # Step 2: Asli page request — homepage ko referrer set karo
        scraper.headers.update({
            'Referer':        MENTFX_HOME,
            'Sec-Fetch-Site': 'same-origin',   # ab same site se navigate kar rahe hain
        })

        try:
            resp = scraper.get(MENTFX_URL, timeout=30)
            logger.info(f"Response status: {resp.status_code}")

            if resp.status_code == 200:
                return resp.text

            logger.warning(f"Attempt {attempt + 1} failed: HTTP {resp.status_code}")

        except Exception as e:
            logger.warning(f"Attempt {attempt + 1} exception: {e}")

        # Retry se pehle wait karo — exponential backoff
        wait = (attempt + 1) * random.uniform(4, 8)
        logger.info(f"Retry wait: {wait:.1f}s ...")
        time.sleep(wait)

    logger.error(f"Saare {max_retries} attempts fail ho gaye.")
    return None


# ---------------------------------------------------------------
# Pair mapping
# ---------------------------------------------------------------
def _map_pair(raw: str):
    key = raw.strip().upper().replace(' ', '').replace('/', '')
    for mk, av in MENTFX_TO_APP.items():
        if mk.replace(' ', '').replace('/', '').upper() == key:
            return av
    for mk, av in MENTFX_TO_APP.items():
        ck = mk.replace(' ', '').replace('/', '').upper()
        if ck in key or key in ck:
            return av
    return None


def _normalize(a: float, b: float):
    total = a + b
    if total == 0:
        return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)


# ---------------------------------------------------------------
# HTML Parser
# ---------------------------------------------------------------
def _parse(soup: BeautifulSoup) -> dict:
    results = {}

    # Strategy 1: <table>
    for table in soup.find_all('table'):
        for row in table.find_all('tr'):
            cells = row.find_all(['td', 'th'])
            if len(cells) < 2:
                continue
            app_pair = _map_pair(cells[0].get_text(strip=True))
            if not app_pair:
                continue
            nums = []
            for cell in cells[1:]:
                for m in re.findall(r'(\d+(?:\.\d+)?)\s*%?', cell.get_text()):
                    v = float(m)
                    if 0 < v <= 100:
                        nums.append(v)
            if len(nums) >= 2:
                bear, bull = _normalize(nums[0], nums[1])
                results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}

    # Strategy 2: div/flex layout
    if not results:
        for tag in soup.find_all(['div', 'li', 'article']):
            text = tag.get_text(separator=' ', strip=True)
            app_pair = None
            for mk, av in MENTFX_TO_APP.items():
                if mk.lower() in text.lower():
                    app_pair = av
                    break
            if not app_pair or app_pair in results:
                continue
            nums = [float(m) for m in re.findall(r'(\d+(?:\.\d+)?)\s*%', text)
                    if 0 < float(m) <= 100]
            if len(nums) >= 2:
                bear, bull = _normalize(nums[0], nums[1])
                results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}

    return results


# ---------------------------------------------------------------
# Public API
# ---------------------------------------------------------------
def fetch_sentiment_data() -> dict:
    """
    Returns:
    { 'US500': {'bearish_pct': 33.0, 'bullish_pct': 67.0}, ... }
    """
    debug = os.environ.get('MENTFX_DEBUG', 'false').lower() == 'true'

    html = _fetch_html(max_retries=3)
    if not html:
        return {}

    if debug:
        logger.debug("=== RAW HTML (first 4000 chars) ===\n" + html[:4000])

    soup    = BeautifulSoup(html, 'html.parser')
    results = _parse(soup)

    if not results:
        logger.warning(
            "Parser ne koi data nahi nikala. "
            "MENTFX_DEBUG=true set kar ke HTML dekho aur "
            "MENTFX_TO_APP / _parse() adjust karo."
        )
    else:
        logger.info(f"Scraped {len(results)} pairs: {list(results.keys())}")

    return results

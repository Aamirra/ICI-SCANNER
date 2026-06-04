import os
import re
import json
import time
import random
import logging
import cloudscraper
from bs4 import BeautifulSoup
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# URLs
# ---------------------------------------------------------------
MENTFX_HOME = "https://mentfx.com/"
MENTFX_URL  = "https://mentfx.com/sentiment-viewer/index.php"
MENTFX_BASE = "https://mentfx.com/sentiment-viewer/"

# ---------------------------------------------------------------
# JS-rendered pages ke liye — common PHP API endpoints
# ---------------------------------------------------------------
COMMON_API_PATHS = [
    "data.php", "api.php", "get_data.php", "sentiment.php",
    "get_sentiment.php", "fetch_data.php", "ajax.php", "json.php",
    "sentiments.php", "get.php", "load.php", "fetch.php",
    "sentiment_data.php", "market_data.php", "positions.php",
]

# ---------------------------------------------------------------
# Rotating User-Agents
# ---------------------------------------------------------------
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
]

# ---------------------------------------------------------------
# Browser configs
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
    'USOIL': 'USOIL', 'WTI': 'USOIL', 'CRUDEOIL': 'USOIL',
    'XAGUSD': 'XAGUSD', 'SILVER': 'XAGUSD', 'XAG': 'XAGUSD',
    'US500': 'US500', 'SPX500': 'US500', 'SPX': 'US500', 'S&P500': 'US500',
    'US100': 'US100', 'NAS100': 'US100', 'NASDAQ': 'US100', 'NASDAQ100': 'US100',
    'US30': 'US30', 'DOW': 'US30', 'DOW30': 'US30', 'DJ30': 'US30',
    'GER40': 'GER40', 'DAX': 'GER40', 'DAX40': 'GER40', 'GER30': 'GER40',
    'UK100': 'UK100', 'FTSE': 'UK100', 'FTSE100': 'UK100',
    'JPN225': 'JPN225', 'NIKKEI': 'JPN225', 'NIKKEI225': 'JPN225',
    'EURUSD': 'EURUSD', 'EUR/USD': 'EURUSD',
    'GBPUSD': 'GBPUSD', 'GBP/USD': 'GBPUSD',
    'USDJPY': 'USDJPY', 'USD/JPY': 'USDJPY',
    'USDCHF': 'USDCHF', 'USD/CHF': 'USDCHF',
    'USDCAD': 'USDCAD', 'USD/CAD': 'USDCAD',
    'AUDUSD': 'AUDUSD', 'AUD/USD': 'AUDUSD',
    'NZDUSD': 'NZDUSD', 'NZD/USD': 'NZDUSD',
    'EURJPY': 'EURJPY', 'EUR/JPY': 'EURJPY',
    'GBPJPY': 'GBPJPY', 'GBP/JPY': 'GBPJPY',
    'AUDJPY': 'AUDJPY', 'AUD/JPY': 'AUDJPY',
}


# ---------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------
def _map_pair(raw: str) -> Optional[str]:
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


def _valid_nums(text: str):
    return [float(m) for m in re.findall(r'(\d+(?:\.\d+)?)\s*%?', text)
            if 0 < float(m) <= 100]


# ---------------------------------------------------------------
# Debug — seedha Render logs mein HTML chunks print karta hai
# ---------------------------------------------------------------
def _dump_debug(html_raw: str, soup: BeautifulSoup):
    logger.info("╔══════════ DEBUG: RAW HTML DUMP START ══════════╗")
    chunk_size = 1000
    raw_slice = html_raw[:8000]
    for i in range(0, len(raw_slice), chunk_size):
        logger.info(f"[HTML {i}–{i + chunk_size}]\n{raw_slice[i:i + chunk_size]}")
    logger.info("╚══════════ DEBUG: RAW HTML DUMP END ══════════╝")

    pct_tags = [t for t in soup.find_all(True) if '%' in t.get_text()]
    logger.info(f"Tags with '%': {len(pct_tags)}")
    for tag in pct_tags[:15]:
        classes = ' '.join(tag.get('class', []))
        logger.info(f"  <{tag.name} class='{classes}'> {tag.get_text(strip=True)[:120]}")

    scripts = soup.find_all('script')
    logger.info(f"Script tags total: {len(scripts)}")
    for i, s in enumerate(scripts):
        src = s.get('src', '')
        content = (s.string or '').strip()
        if src:
            logger.info(f"  Script[{i}] src: {src}")
        if content:
            logger.info(f"  Script[{i}] inline (first 400):\n{content[:400]}")

    tables = soup.find_all('table')
    logger.info(f"Tables: {len(tables)}")
    for i, t in enumerate(tables[:2]):
        logger.info(f"  Table[{i}]: {str(t)[:300]}")


# ---------------------------------------------------------------
# NEW: JS code mein embedded API URLs dhundo
# ---------------------------------------------------------------
def _find_api_urls_in_js(html_raw: str) -> set:
    """
    HTML/JS mein fetch(), $.get(), $.ajax(), XMLHttpRequest patterns dhundo.
    Yeh woh actual data URLs hain jo browser JS se call karta hai.
    """
    found = set()
    patterns = [
        r"fetch\s*\(\s*['\"]([^'\"]+)['\"]",
        r"\.get\s*\(\s*['\"]([^'\"]+)['\"]",
        r"\.post\s*\(\s*['\"]([^'\"]+)['\"]",
        r"url\s*:\s*['\"]([^'\"]+)['\"]",
        r"\.load\s*\(\s*['\"]([^'\"]+)['\"]",
        r"\.ajax\s*\(\s*['\"]([^'\"]+)['\"]",
        r"open\s*\(\s*['\"](?:GET|POST)['\"],\s*['\"]([^'\"]+)['\"]",
        r"axios\s*\.\s*(?:get|post)\s*\(\s*['\"]([^'\"]+)['\"]",
        r"src\s*=\s*['\"]([^'\"]+\.php[^'\"]*)['\"]",
    ]
    for pattern in patterns:
        for match in re.findall(pattern, html_raw, re.IGNORECASE):
            m = match.strip()
            if not m or len(m) > 200:
                continue
            if m.startswith('http'):
                found.add(m)
            elif m.startswith('/'):
                found.add(f"https://mentfx.com{m}")
            elif m.endswith('.php') or '.php?' in m:
                found.add(f"{MENTFX_BASE}{m}")
    return found


# ---------------------------------------------------------------
# NEW: API response parse karo — JSON ya HTML dono handle karta hai
# ---------------------------------------------------------------
def _parse_api_response(text: str) -> dict:
    results = {}
    text = text.strip()

    # JSON array try karo
    try:
        data = json.loads(text)
        items = data if isinstance(data, list) else (
            list(data.values()) if isinstance(data, dict) else []
        )
        for item in items:
            if not isinstance(item, dict):
                # dict nahi — seedha pair:value format check karo
                continue
            pair_val = None
            for k in ('pair', 'symbol', 'name', 'instrument', 'asset', 'currency'):
                if k in item:
                    pair_val = _map_pair(str(item[k]))
                    break
            if not pair_val:
                continue
            bear = bull = None
            for bk in ('bear', 'bearish', 'short', 'sell', 'bearish_pct', 'negative'):
                if bk in item:
                    try:
                        bear = float(item[bk])
                        break
                    except (ValueError, TypeError):
                        pass
            for blk in ('bull', 'bullish', 'long', 'buy', 'bullish_pct', 'positive'):
                if blk in item:
                    try:
                        bull = float(item[blk])
                        break
                    except (ValueError, TypeError):
                        pass
            if bear is not None and bull is not None:
                b, bl = _normalize(bear, bull)
                results[pair_val] = {'bearish_pct': b, 'bullish_pct': bl}

        # dict{pair: {bear, bull}} format
        if not results and isinstance(data, dict):
            for key, val in data.items():
                pair_val = _map_pair(str(key))
                if not pair_val or not isinstance(val, dict):
                    continue
                bear = bull = None
                for bk in ('bear', 'bearish', 'short'):
                    if bk in val:
                        bear = float(val[bk])
                        break
                for blk in ('bull', 'bullish', 'long'):
                    if blk in val:
                        bull = float(val[blk])
                        break
                if bear is not None and bull is not None:
                    b, bl = _normalize(bear, bull)
                    results[pair_val] = {'bearish_pct': b, 'bullish_pct': bl}

    except (json.JSONDecodeError, ValueError, TypeError):
        # JSON nahi — HTML try karo
        if text.startswith('<'):
            soup = BeautifulSoup(text, 'html.parser')
            results = _strategy_table(soup)
            if not results:
                results = _strategy_text_scan(soup)

    return results


# ---------------------------------------------------------------
# NEW: Direct API calls — JS-rendered pages ke liye main approach
# ---------------------------------------------------------------
def _try_direct_api_calls(scraper: cloudscraper.CloudScraper, html_raw: str) -> dict:
    """
    2-step approach:
    1. HTML/JS mein embedded API URLs dhundo aur try karo
    2. Common PHP endpoint names try karo
    """
    ajax_headers = {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json, text/javascript, */*; q=0.01',
        'Referer':          MENTFX_URL,
        'Sec-Fetch-Mode':   'cors',
        'Sec-Fetch-Site':   'same-origin',
        'Sec-Fetch-Dest':   'empty',
    }

    # Step 1: JS se dhunde hue URLs
    js_urls = _find_api_urls_in_js(html_raw)
    logger.info(f"JS mein {len(js_urls)} API URLs mile: {js_urls}")

    # Step 2: Common paths
    common_urls = {f"{MENTFX_BASE}{p}" for p in COMMON_API_PATHS}

    all_urls = list(js_urls) + [u for u in common_urls if u not in js_urls]

    for url in all_urls[:20]:
        try:
            resp = scraper.get(
                url, timeout=12,
                headers={**scraper.headers, **ajax_headers}
            )
            size = len(resp.text.strip())
            logger.debug(f"  [{resp.status_code}] {url} (size={size})")

            if resp.status_code != 200 or size < 10:
                continue

            preview = resp.text.strip()[:150].replace('\n', ' ')
            logger.info(f"Non-empty response from {url}: {preview}")

            data = _parse_api_response(resp.text)
            if data:
                logger.info(f"✓ API endpoint kaam kiya: {url} — {len(data)} pairs")
                return data

        except Exception as e:
            logger.debug(f"  API {url} error: {e}")

    return {}


# ================================================================
# HTML PARSING STRATEGIES (JS-rendered nahi hone ki surat mein)
# ================================================================

def _strategy_script_json(soup: BeautifulSoup) -> dict:
    results = {}
    for script in soup.find_all('script'):
        raw = script.string or ''
        if not raw.strip():
            continue
        for json_chunk in re.findall(r'[\[{][^<]{20,}?[}\]]', raw, re.DOTALL):
            try:
                data = json.loads(json_chunk)
                items = data if isinstance(data, list) else [data]
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    pair_val = None
                    for k in ('pair', 'symbol', 'name', 'instrument', 'asset'):
                        if k in item:
                            pair_val = _map_pair(str(item[k]))
                            break
                    if not pair_val:
                        continue
                    bear = bull = None
                    for bk in ('bear', 'bearish', 'short', 'sell'):
                        if bk in item:
                            bear = float(item[bk])
                            break
                    for blk in ('bull', 'bullish', 'long', 'buy'):
                        if blk in item:
                            bull = float(item[blk])
                            break
                    if bear is not None and bull is not None:
                        b, bl = _normalize(bear, bull)
                        results[pair_val] = {'bearish_pct': b, 'bullish_pct': bl}
            except (json.JSONDecodeError, ValueError, TypeError):
                pass
        for mk, av in MENTFX_TO_APP.items():
            if mk.lower() not in raw.lower():
                continue
            idx = raw.lower().find(mk.lower())
            chunk = raw[max(0, idx - 20): idx + 150]
            nums = _valid_nums(chunk)
            if len(nums) >= 2 and av not in results:
                b, bl = _normalize(nums[0], nums[1])
                results[av] = {'bearish_pct': b, 'bullish_pct': bl}
    return results


def _strategy_table(soup: BeautifulSoup) -> dict:
    results = {}
    for table in soup.find_all('table'):
        for row in table.find_all('tr'):
            cells = row.find_all(['td', 'th'])
            if len(cells) < 2:
                continue
            app_pair = None
            pair_cell_idx = -1
            for i, cell in enumerate(cells):
                app_pair = _map_pair(cell.get_text(strip=True))
                if app_pair:
                    pair_cell_idx = i
                    break
            if not app_pair:
                continue
            nums = []
            for i, cell in enumerate(cells):
                if i == pair_cell_idx:
                    continue
                style = cell.get('style', '')
                wm = re.search(r'width\s*:\s*(\d+(?:\.\d+)?)\s*%', style)
                if wm:
                    v = float(wm.group(1))
                    if 0 < v <= 100:
                        nums.append(v)
                for m in re.findall(r'(\d+(?:\.\d+)?)\s*%?', cell.get_text()):
                    v = float(m)
                    if 0 < v <= 100:
                        nums.append(v)
            if len(nums) >= 2 and app_pair not in results:
                bear, bull = _normalize(nums[0], nums[1])
                results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
    return results


def _strategy_progress_bars(soup: BeautifulSoup) -> dict:
    results = {}
    width_tags = []
    for tag in soup.find_all(True):
        style = tag.get('style', '')
        m = re.search(r'width\s*:\s*(\d+(?:\.\d+)?)\s*%', style)
        if m:
            v = float(m.group(1))
            if 0 < v <= 100:
                width_tags.append((tag, v))
    for tag, _ in width_tags:
        for ancestor in [tag] + list(tag.parents)[:5]:
            text = ancestor.get_text(separator=' ', strip=True)
            app_pair = None
            for mk in MENTFX_TO_APP:
                if mk.lower() in text.lower():
                    app_pair = _map_pair(mk)
                    break
            if not app_pair or app_pair in results:
                continue
            all_widths = []
            for child in ancestor.find_all(True):
                cs = child.get('style', '')
                wm = re.search(r'width\s*:\s*(\d+(?:\.\d+)?)\s*%', cs)
                if wm:
                    v = float(wm.group(1))
                    if 0 < v <= 100:
                        all_widths.append(v)
            if len(all_widths) >= 2:
                bear, bull = _normalize(all_widths[0], all_widths[1])
                results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
            break
    return results


def _strategy_css_classes(soup: BeautifulSoup) -> dict:
    results = {}
    bear_keywords = {'bear', 'bearish', 'short', 'sell', 'negative', 'red'}
    bull_keywords = {'bull', 'bullish', 'long',  'buy',  'positive',  'green'}
    pair_data = {}
    for tag in soup.find_all(True):
        classes = set(' '.join(tag.get('class', [])).lower().split())
        is_bear = bool(classes & bear_keywords)
        is_bull = bool(classes & bull_keywords)
        if not (is_bear or is_bull):
            continue
        val = None
        sm = re.search(r'width\s*:\s*(\d+(?:\.\d+)?)\s*%', tag.get('style', ''))
        if sm:
            val = float(sm.group(1))
        else:
            tm = re.search(r'(\d+(?:\.\d+)?)\s*%', tag.get_text())
            if tm:
                val = float(tm.group(1))
        if not val or not (0 < val <= 100):
            continue
        for ancestor in list(tag.parents)[:6]:
            ancestor_text = ancestor.get_text(separator=' ', strip=True)
            for mk in MENTFX_TO_APP:
                if mk.lower() in ancestor_text.lower():
                    ap = _map_pair(mk)
                    if ap:
                        if ap not in pair_data:
                            pair_data[ap] = {'bear': None, 'bull': None}
                        if is_bear and pair_data[ap]['bear'] is None:
                            pair_data[ap]['bear'] = val
                        if is_bull and pair_data[ap]['bull'] is None:
                            pair_data[ap]['bull'] = val
                    break
            break
    for ap, vals in pair_data.items():
        if vals['bear'] is not None and vals['bull'] is not None:
            bear, bull = _normalize(vals['bear'], vals['bull'])
            results[ap] = {'bearish_pct': bear, 'bullish_pct': bull}
    return results


def _strategy_text_scan(soup: BeautifulSoup) -> dict:
    results = {}
    for tag in soup.find_all(['div', 'li', 'article', 'section', 'span', 'p', 'tr']):
        text = tag.get_text(separator=' ', strip=True)
        if len(text) > 500:
            continue
        app_pair = None
        for mk in MENTFX_TO_APP:
            if mk.lower() in text.lower():
                app_pair = _map_pair(mk)
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
# Master parse
# ---------------------------------------------------------------
def _parse(soup: BeautifulSoup, debug: bool = False,
           html_raw: str = '', scraper=None) -> dict:

    if debug:
        _dump_debug(html_raw, soup)

    # STEP 1: JS-rendered page — seedha API try karo (SABSE PEHLE)
    if scraper and html_raw:
        logger.info("Step 1: Direct API endpoints try kar rahe hain...")
        api_results = _try_direct_api_calls(scraper, html_raw)
        if api_results:
            return api_results
        logger.info("Direct API calls se data nahi mila — HTML parse try karte hain...")

    # STEP 2: HTML parsing strategies (fallback)
    strategies = [
        ("Script/JSON",   _strategy_script_json),
        ("Table",         _strategy_table),
        ("Progress bars", _strategy_progress_bars),
        ("CSS classes",   _strategy_css_classes),
        ("Text scan",     _strategy_text_scan),
    ]
    for name, fn in strategies:
        try:
            results = fn(soup)
            if results:
                logger.info(f"✓ Strategy '{name}' ne {len(results)} pairs nikale: {list(results.keys())}")
                return results
            logger.debug(f"✗ Strategy '{name}': koi data nahi mila")
        except Exception as e:
            logger.warning(f"Strategy '{name}' crash: {e}")

    return {}


# ---------------------------------------------------------------
# Scraper helpers
# ---------------------------------------------------------------
def _make_scraper(ua: str, browser_cfg: dict) -> cloudscraper.CloudScraper:
    scraper = cloudscraper.create_scraper(
        browser=browser_cfg,
        delay=random.uniform(3, 7),
    )
    scraper.headers.update({
        'User-Agent':                ua,
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language':           'en-US,en;q=0.9',
        'Accept-Encoding':           'gzip, deflate, br',
        'Connection':                'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control':             'max-age=0',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            'none',
        'Sec-Fetch-User':            '?1',
        'Sec-CH-UA':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-CH-UA-Mobile':          '?0',
        'Sec-CH-UA-Platform':        '"Windows"',
        'DNT':                       '1',
    })
    return scraper


def _warmup(scraper: cloudscraper.CloudScraper) -> bool:
    try:
        r = scraper.get(MENTFX_HOME, timeout=20)
        logger.debug(f"Warmup status: {r.status_code}")
        time.sleep(random.uniform(2, 4))
        return r.status_code < 400
    except Exception as e:
        logger.warning(f"Warmup failed: {e}")
        return False


def _fetch_html(max_retries: int = 3):
    """HTML + active scraper instance dono return karta hai"""
    configs = random.sample(BROWSER_CONFIGS, min(max_retries, len(BROWSER_CONFIGS)))
    for attempt in range(max_retries):
        ua  = random.choice(USER_AGENTS)
        cfg = configs[attempt % len(configs)]
        logger.info(f"[Attempt {attempt + 1}/{max_retries}] Browser: {cfg['browser']}/{cfg['platform']}")
        scraper = _make_scraper(ua, cfg)
        _warmup(scraper)
        scraper.headers.update({
            'Referer':        MENTFX_HOME,
            'Sec-Fetch-Site': 'same-origin',
        })
        try:
            resp = scraper.get(MENTFX_URL, timeout=30)
            logger.info(f"Response status: {resp.status_code} | Size: {len(resp.text)} chars")
            if resp.status_code == 200:
                return resp.text, scraper   # dono return karo
            logger.warning(f"Attempt {attempt + 1}: HTTP {resp.status_code}")
        except Exception as e:
            logger.warning(f"Attempt {attempt + 1} exception: {e}")
        wait = (attempt + 1) * random.uniform(4, 8)
        logger.info(f"Retry wait: {wait:.1f}s ...")
        time.sleep(wait)
    logger.error(f"Saare {max_retries} attempts fail ho gaye.")
    return None, None


# ---------------------------------------------------------------
# Public API
# ---------------------------------------------------------------
def fetch_sentiment_data() -> dict:
    """
    Returns:
    { 'US500': {'bearish_pct': 33.0, 'bullish_pct': 67.0}, ... }
    """
    debug = os.environ.get('MENTFX_DEBUG', 'false').lower() == 'true'

    html, scraper = _fetch_html(max_retries=3)
    if not html:
        return {}

    soup    = BeautifulSoup(html, 'html.parser')
    results = _parse(soup, debug=debug, html_raw=html, scraper=scraper)

    if not results:
        logger.error(
            "Direct API + saari 5 HTML strategies fail ho gayin. "
            "Logs mein 'Non-empty response from' lines dekho — "
            "woh paste karo taake next fix ho sake."
        )
    else:
        logger.info(f"Final: {len(results)} pairs scraped: {list(results.keys())}")

    return results

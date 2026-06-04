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
    'XAUUSD': 'XAUUSD', 'GOLD': 'XAUUSD', 'XAU': 'XAUUSD',
    'BTCUSD': 'BTCUSD', 'BITCOIN': 'BTCUSD', 'BTC': 'BTCUSD',
    'ETHUSD': 'ETHUSD', 'ETHEREUM': 'ETHUSD', 'ETH': 'ETHUSD'
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

# ---------------------------------------------------------------
# Debug HTML Dumper
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

# ================================================================
# HTML PARSING STRATEGIES (STRICTLY DAILY ONLY)
# ================================================================

def _strategy_table(soup: BeautifulSoup) -> dict:
    """Table rows se strictly DAILY columns (aakhri 2 percentages) nikalta hai."""
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
                
                text_matches = re.findall(r'(\d+(?:\.\d+)?)\s*%?', cell.get_text())
                if text_matches:
                    for m in text_matches:
                        v = float(m)
                        if 0 < v <= 100:
                            nums.append(v)
                else:
                    style = cell.get('style', '')
                    wm = re.search(r'width\s*:\s*(\d+(?:\.\d+)?)\s*%', style)
                    if wm:
                        v = float(wm.group(1))
                        if 0 < v <= 100:
                            nums.append(v)

            # Agar 4 numbers hain: [Intraday Bear, Intraday Bull, DAILY BEAR, DAILY BULL]
            if len(nums) == 4:
                bear, bull = _normalize(nums[2], nums[3])
                results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
            # Agar sirf 2 numbers hain, toh confirm karo ke context mein 'daily' ho
            elif len(nums) == 2:
                context = (row.get_text() + " " + table.get_text()).lower()
                if 'daily' in context and 'intraday' not in row.get_text().lower():
                    bear, bull = _normalize(nums[0], nums[1])
                    results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
    return results

def _strategy_progress_bars(soup: BeautifulSoup) -> dict:
    """Progress bars ka data nikal kar strictly DAILY bars target karta hai."""
    results = {}
    for row in soup.find_all(['tr', 'div', 'li']):
        text = row.get_text(separator=' ', strip=True)
        app_pair = None
        for mk in MENTFX_TO_APP:
            if mk.lower() in text.lower():
                app_pair = _map_pair(mk)
                break
        if not app_pair or app_pair in results:
            continue

        all_widths = []
        for child in row.find_all(True):
            cs = child.get('style', '')
            wm = re.search(r'width\s*:\s*(\d+(?:\.\d+)?)\s*%', cs)
            if wm:
                v = float(wm.group(1))
                if 0 < v <= 100 and v not in all_widths:
                    all_widths.append(v)
            
            tm = re.findall(r'(\d+(?:\.\d+)?)\s*%', child.get_text())
            for m in tm:
                v = float(m)
                if 0 < v <= 100 and v not in all_widths:
                    all_widths.append(v)

        if len(all_widths) == 4:
            bear, bull = _normalize(all_widths[2], all_widths[3])
            results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
        elif len(all_widths) == 2 and 'daily' in text.lower():
            bear, bull = _normalize(all_widths[0], all_widths[1])
            results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
    return results

def _strategy_text_scan(soup: BeautifulSoup) -> dict:
    """Raw text sections scan karke target DAILY rows filter karta hai."""
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

        nums = [float(m) for m in re.findall(r'(\d+(?:\.\d+)?)\s*%', text) if 0 < float(m) <= 100]
        
        if len(nums) == 4:
            bear, bull = _normalize(nums[2], nums[3])
            results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
        elif len(nums) == 2 and 'daily' in text.lower() and 'intraday' not in text.lower():
            bear, bull = _normalize(nums[0], nums[1])
            results[app_pair] = {'bearish_pct': bear, 'bullish_pct': bull}
    return results

def _strategy_script_json(soup: BeautifulSoup) -> dict:
    """JSON script blocks se strictly DAILY sentiment key match karta hai."""
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
                    
                    # Ensure it is a daily metric if structural keys exist
                    if 'type' in item and str(item['type']).lower() == 'intraday':
                        continue
                    
                    pair_val = None
                    for k in ('pair', 'symbol', 'name', 'instrument', 'asset'):
                        if k in item:
                            pair_val = _map_pair(str(item[k]))
                            break
                    if not pair_val:
                        continue
                        
                    bear = bull = None
                    # Target explicit daily fields if they exist, else fallback
                    for bk in ('daily_bear', 'bear_daily', 'bear', 'bearish'):
                        if bk in item:
                            bear = float(item[bk])
                            break
                    for blk in ('daily_bull', 'bull_daily', 'bull', 'bullish'):
                        if blk in item:
                            bull = float(item[blk])
                            break
                            
                    if bear is not None and bull is not None:
                        b, bl = _normalize(bear, bull)
                        results[pair_val] = {'bearish_pct': b, 'bullish_pct': bl}
            except:
                pass
    return results

# ---------------------------------------------------------------
# Master parse
# ---------------------------------------------------------------
def _parse(soup: BeautifulSoup, debug: bool = False, html_raw: str = '') -> dict:
    if debug:
        _dump_debug(html_raw, soup)

    strategies = [
        ("Table (Daily Mode)",         _strategy_table),
        ("Progress bars (Daily Mode)", _strategy_progress_bars),
        ("Text scan (Daily Mode)",     _strategy_text_scan),
        ("Script/JSON (Daily Mode)",   _strategy_script_json),
    ]
    for name, fn in strategies:
        try:
            results = fn(soup)
            if results:
                logger.info(f"✓ Strategy '{name}' ne {len(results)} DAILY pairs nikale.")
                return results
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
        time.sleep(random.uniform(2, 4))
        return r.status_code < 400
    except Exception as e:
        logger.warning(f"Warmup failed: {e}")
        return False

def _fetch_html(max_retries: int = 3):
    configs = random.sample(BROWSER_CONFIGS, min(max_retries, len(BROWSER_CONFIGS)))
    for attempt in range(max_retries):
        ua  = random.choice(USER_AGENTS)
        cfg = configs[attempt % len(configs)]
        logger.info(f"[Attempt {attempt + 1}/{max_retries}] Scraping Mentfx Sentiment Viewer...")
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
                return resp.text
        except Exception as e:
            logger.warning(f"Attempt {attempt + 1} exception: {e}")
        wait = (attempt + 1) * random.uniform(4, 8)
        time.sleep(wait)
    return None

# ---------------------------------------------------------------
# Public API
# ---------------------------------------------------------------
def fetch_sentiment_data() -> dict:
    debug = os.environ.get('MENTFX_DEBUG', 'false').lower() == 'true'
    html = _fetch_html(max_retries=3)
    if not html:
        return {}

    soup    = BeautifulSoup(html, 'html.parser')
    results = _parse(soup, debug=debug, html_raw=html)

    if not results:
        logger.error("HTML parse fail ho gaya. Koi DAILY data nahi mila.")
    else:
        logger.info(f"Final: {len(results)} DAILY pairs successfully scraped!")
    return results

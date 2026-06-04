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
# URLs - Direct JSON Data Endpoints Target Kiye Hain
# ---------------------------------------------------------------
MENTFX_HOME      = "https://mentfx.com/"
MENTFX_DATA_URL  = "https://mentfx.com/sentiment-viewer/sentiment_data.php"
MENTFX_DATA_ALT  = "https://mentfx.com/sentiment-viewer/get_data.php"

# ---------------------------------------------------------------
# Rotating User-Agents
# ---------------------------------------------------------------
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
]

BROWSER_CONFIGS = [
    {'browser': 'chrome',  'platform': 'windows', 'mobile': False},
    {'browser': 'firefox', 'platform': 'windows', 'mobile': False},
]

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
    'BTCUSD': 'BTCUSD', 'BITCOIN': 'BTCUSD', 'BTC': 'BTCUSD'
}

def _map_pair(raw: str) -> Optional[str]:
    key = raw.strip().upper().replace(' ', '').replace('/', '')
    for mk, av in MENTFX_TO_APP.items():
        if mk.replace(' ', '').replace('/', '').upper() == key:
            return av
    return None

def _normalize(a: float, b: float):
    total = a + b
    if total == 0:
        return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)

# ---------------------------------------------------------------
# Pure JSON Parser (Bypasses HTML Completely)
# ---------------------------------------------------------------
def _parse_json_data(raw_text: str) -> dict:
    results = {}
    try:
        # Garbled text/compression check aur json loaded safely
        data = json.loads(raw_text)
        items = data if isinstance(data, list) else [data]
        
        for item in items:
            if not isinstance(item, dict):
                continue
                
            # Intraday object ko ignore marna hai
            if str(item.get('type', '')).lower() == 'intraday':
                continue
                
            pair_raw = item.get('pair') or item.get('symbol') or item.get('asset')
            if not pair_raw:
                continue
                
            app_pair = _map_pair(str(pair_raw))
            if not app_pair:
                continue
                
            # Strictly Target DAILY keys from JSON structure
            bear = item.get('daily_bear') or item.get('bear_daily') or item.get('bear')
            bull = item.get('daily_bull') or item.get('bull_daily') or item.get('bull')
            
            if bear is not None and bull is not None:
                b, bl = _normalize(float(bear), float(bull))
                results[app_pair] = {'bearish_pct': b, 'bullish_pct': bl}
                
    except Exception as e:
        logger.warning(f"JSON parsing direct optimization skipped/failed: {e}")
    return results

def _make_scraper(ua: str, browser_cfg: dict) -> cloudscraper.CloudScraper:
    scraper = cloudscraper.create_scraper(browser=browser_cfg, delay=random.uniform(2, 5))
    scraper.headers.update({
        'User-Agent': ua,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        # Brotli ('br') ko hata diya taake logs mein kachra text/garbage na aaye
        'Accept-Encoding': 'gzip, deflate',
        'X-Requested-With': 'XMLHttpRequest',
        'Connection': 'keep-alive'
    })
    return scraper

def _fetch_raw(url: str, max_retries: int = 2) -> Optional[str]:
    for attempt in range(max_retries):
        ua = random.choice(USER_AGENTS)
        cfg = random.choice(BROWSER_CONFIGS)
        scraper = _make_scraper(ua, cfg)
        try:
            scraper.get(MENTFX_HOME, timeout=15) # Warmup
            resp = scraper.get(url, timeout=20)
            if resp.status_code == 200 and resp.text.strip():
                return resp.text
        except Exception as e:
            logger.warning(f"Endpoint {url} attempt {attempt+1} failed: {e}")
        time.sleep(2)
    return None

# ---------------------------------------------------------------
# Public API
# ---------------------------------------------------------------
def fetch_sentiment_data() -> dict:
    logger.info("Direct JSON endpoint check starting...")
    
    # Pehle main data endpoint try karein
    raw_data = _fetch_raw(MENTFX_DATA_URL)
    if not raw_data:
        # Fallback to alternate data endpoint
        raw_data = _fetch_raw(MENTFX_DATA_ALT)
        
    if not raw_data:
        logger.error("Dono endpoints se raw data fetch nahi ho saka.")
        return {}
        
    results = _parse_json_data(raw_data)
    
    if not results:
        logger.error("JSON decode ho gaya par koi valid DAILY metrics nahi mili.")
    else:
        logger.info(f"Success! {len(results)} DAILY pairs processed directly via JSON.")
        
    return results

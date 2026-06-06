"""
sentiment_scraper.py  —  ICI-SCANNER (Render Env Version)
============================================================
Cloudflare ko bypass karne ke liye ScrapingAnt API aur Render Env variables ka use.
"""

import os
import json
import re
import logging
import urllib.parse
import tls_client
from bs4 import BeautifulSoup
from typing import Dict, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# CONFIGURATION (Render ki settings se key auto-load hogi)
# ─────────────────────────────────────────────
ANT_API_KEY = os.environ.get("SCRAPINGANT_API_KEY", "")

MENTFX_VIEWER = "https://mentfx.com/sentiment-viewer/"
MENTFX_JSON_1 = "https://mentfx.com/sentiment-viewer/sentiment_data.php"
MENTFX_JSON_2 = "https://mentfx.com/sentiment-viewer/get_data.php"

MENTFX_TO_APP: Dict[str, str] = {
    "USOIL": "USOIL",   "WTI": "USOIL",
    "XAGUSD": "XAGUSD", "SILVER": "XAGUSD",
    "US500": "US500",   "SPX500": "US500",   "SPX": "US500",
    "US100": "US100",   "NAS100": "US100",   "NASDAQ": "US100",
    "US30": "US30",     "DOW": "US30",       "DOW30": "US30",
    "GER40": "GER40",   "DAX": "GER40",      "DAX40": "GER40",
    "UK100": "UK100",   "FTSE": "UK100",     "FTSE100": "UK100",
    "JPN225": "JPN225", "NIKKEI": "JPN225",
    "EURUSD": "EURUSD", "EUR/USD": "EURUSD",
    "GBPUSD": "GBPUSD", "GBP/USD": "GBPUSD",
    "USDJPY": "USDJPY", "USD/JPY": "USDJPY",
    "USDCHF": "USDCHF", "USD/CHF": "USDCHF",
    "USDCAD": "USDCAD", "USD/CAD": "USDCAD",
    "AUDUSD": "AUDUSD", "AUD/USD": "AUDUSD",
    "NZDUSD": "NZDUSD", "NZD/USD": "NZDUSD",
    "EURJPY": "EURJPY", "EUR/JPY": "EURJPY",
    "GBPJPY": "GBPJPY", "GBP/JPY": "GBPJPY",
    "AUDJPY": "AUDJPY", "AUD/JPY": "AUDJPY",
    "XAUUSD": "XAUUSD", "GOLD": "XAUUSD",
    "BTCUSD": "BTCUSD", "BITCOIN": "BTCUSD",
    "NZDCAD": "NZDCAD", "NZDCHF": "NZDCHF",
    "NZDJPY": "NZDJPY", "CADCHF": "CADCHF",
    "CADJPY": "CADJPY", "CHFJPY": "CHFJPY",
    "AUDCAD": "AUDCAD", "AUDCHF": "AUDCHF",
    "AUDNZD": "AUDNZD", "EURGBP": "EURGBP",
    "EURAUD": "EURAUD", "EURNZD": "EURNZD",
    "EURCAD": "EURCAD", "EURCHF": "EURCHF",
    "GBPAUD": "GBPAUD", "GBPCAD": "GBPCAD",
    "GBPNZD": "GBPNZD", "GBPCHF": "GBPCHF",
}

def _map_pair(raw: str) -> Optional[str]:
    key = raw.strip().upper().replace(" ", "").replace("/", "")
    for mk, av in MENTFX_TO_APP.items():
        if mk.replace(" ", "").replace("/", "").upper() == key:
            return av
    return None

def _normalize(a: float, b: float) -> Tuple[float, float]:
    total = a + b
    if total == 0:
        return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)

def _parse_json_response(data) -> Dict:
    results = {}
    items = data if isinstance(data, list) else [data]
    for item in items:
        if not isinstance(item, dict) or str(item.get("type", "")).lower() == "intraday":
            continue
        pair_raw = item.get("pair") or item.get("symbol") or item.get("asset") or ""
        app_pair = _map_pair(str(pair_raw))
        if not app_pair:
            continue
        bear = item.get("daily_bear") or item.get("bear_daily") or item.get("bear") or item.get("short")
        bull = item.get("daily_bull") or item.get("bull_daily") or item.get("bull") or item.get("long")
        if bear is not None and bull is not None:
            try:
                b_pct, bl_pct = _normalize(float(bear), float(bull))
                results[app_pair] = {"bearish_pct": b_pct, "bullish_pct": bl_pct}
            except (ValueError, TypeError):
                continue
    return results

def _call_ant_api(target_url: str) -> Optional[str]:
    """ScrapingAnt ke zariye request bhejta hai jo Cloudflare bypass kar deta hai."""
    try:
        encoded_url = urllib.parse.quote_plus(target_url)
        ant_url = f"https://api.scrapingant.com/v2/general?url={encoded_url}&x-api-key={ANT_API_KEY}&browser=false"
        
        session = tls_client.Session(client_identifier="chrome_120")
        resp = session.get(ant_url, timeout_seconds=30)
        
        if resp.status_code == 200:
            return resp.text
        else:
            logger.warning(f"[Ant-API] Failed with status code: {resp.status_code}")
            return None
    except Exception as e:
        logger.error(f"[Ant-API] Error: {e}")
        return None

# ─────────────────────────────────────────────
# MAIN PUBLIC FUNCTION
# ─────────────────────────────────────────────
def fetch_sentiment_data() -> Dict:
    logger.info("━━━ Fetching Data via ScrapingAnt Free API ━━━")
    
    if not ANT_API_KEY:
        logger.error("Render ki settings mein SCRAPINGANT_API_KEY nahi mili!")
        return {}

    # Layer 1: Try endpoint 1
    raw_json1 = _call_ant_api(MENTFX_JSON_1)
    if raw_json1:
        try:
            res = _parse_json_response(json.loads(raw_json1))
            if res:
                logger.info(f"✅ Success! Found {len(res)} pairs from Endpoint 1.")
                return res
        except Exception:
            pass

    # Layer 2: Try endpoint 2
    raw_json2 = _call_ant_api(MENTFX_JSON_2)
    if raw_json2:
        try:
            res = _parse_json_response(json.loads(raw_json2))
            if res:
                logger.info(f"✅ Success! Found {len(res)} pairs from Endpoint 2.")
                return res
        except Exception:
            pass

    logger.error("❌ ScrapingAnt se data fetch/parse nahi ho saka.")
    return {}

if __name__ == "__main__":
    print(fetch_sentiment_data())

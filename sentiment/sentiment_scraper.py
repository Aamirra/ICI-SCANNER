"""
sentiment_scraper.py  —  ICI-SCANNER (ScrapingAnt JS-Render Version)
==================================================================
MentFX Cloudflare bypass karne ke liye JavaScript execution forced.
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
# CONFIGURATION
# ─────────────────────────────────────────────
# Render settings se key uthayega
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

def _parse_html_fallback(html_text: str) -> Dict:
    """Agar direct JSON na mile, to rendered HTML se table parse karne ka mechanism."""
    results = {}
    try:
        soup = BeautifulSoup(html_text, "html.parser")
        pct_re = re.compile(r"^(\d{1,3}(?:\.\d+)?)%?$")
        for table in soup.find_all("table"):
            for row in table.find_all("tr"):
                cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
                pair = next((_map_pair(c) for c in cells if _map_pair(c)), None)
                if not pair: continue
                nums = [float(pct_re.match(c.strip().rstrip("%")).group(1)) for c in cells if pct_re.match(c.strip().rstrip("%"))]
                if len(nums) >= 2:
                    b, bl = _normalize(nums[0], nums[1])
                    results[pair] = {"bearish_pct": b, "bullish_pct": bl}
    except Exception:
        pass
    return results

def _call_ant_api(target_url: str, use_browser: bool = True) -> Optional[str]:
    """ScrapingAnt API supporting JS Browser Rendering."""
    try:
        encoded_url = urllib.parse.quote_plus(target_url)
        # browser=true lagane se cloudflare her soorat bypass hoga
        browser_str = "true" if use_browser else "false"
        ant_url = f"https://api.scrapingant.com/v2/general?url={encoded_url}&x-api-key={ANT_API_KEY}&browser={browser_str}"
        
        session = tls_client.Session(client_identifier="chrome_120")
        resp = session.get(ant_url, timeout_seconds=45)
        
        if resp.status_code == 200:
            return resp.text
        else:
            logger.warning(f"[Ant-API] Failed status: {resp.status_code} on browser={browser_str}")
            return None
    except Exception as e:
        logger.error(f"[Ant-API] Error: {e}")
        return None

# ─────────────────────────────────────────────
# MAIN PUBLIC FUNCTION
# ─────────────────────────────────────────────
def fetch_sentiment_data() -> Dict:
    logger.info("━━━ Fetching Data via ScrapingAnt (JS Render Mode) ━━━")
    
    if not ANT_API_KEY:
        logger.error("Render ki settings mein SCRAPINGANT_API_KEY nahi mili!")
        return {}

    # Approach 1: Try fetching the full rendered HTML page directly
    # Jab browser=true chalega, to MentFX poori tarah open ho kar saamne aayegi
    raw_html = _call_ant_api(MENTFX_VIEWER, use_browser=True)
    if raw_html:
        res_html = _parse_html_fallback(raw_html)
        if res_html:
            logger.info(f"✅ Success! Found {len(res_html)} pairs via Rendered HTML Table.")
            return res_html

    # Approach 2: Fallback to endpoints if HTML fails
    for endpoint in [MENTFX_JSON_1, MENTFX_JSON_2]:
        raw_json = _call_ant_api(endpoint, use_browser=False)
        if raw_json:
            try:
                res = _parse_json_response(json.loads(raw_json))
                if res:
                    logger.info(f"✅ Success! Found {len(res)} pairs from fallback JSON.")
                    return res
            except Exception:
                pass

    logger.error("❌ ScrapingAnt (JS Mode) se bhi data fetch nahi ho saka.")
    return {}

if __name__ == "__main__":
    print(fetch_sentiment_data())

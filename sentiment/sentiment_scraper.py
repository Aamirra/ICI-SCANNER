"""
sentiment_scraper.py  —  ICI-SCANNER (GitLab Runner Version)
============================================================
Bina kisi proxy ke direct clean request jo GitLab server se chalegi.
"""

import os
import json
import re
import logging
import tls_client
from bs4 import BeautifulSoup
from typing import Dict, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

MENTFX_JSON_1 = "https://mentfx.com/sentiment-viewer/sentiment_data.php"
MENTFX_JSON_2 = "https://mentfx.com/sentiment-viewer/get_data.php"

MENTFX_TO_APP: Dict[str, str] = {
    "USOIL": "USOIL", "WTI": "USOIL", "XAGUSD": "XAGUSD", "SILVER": "XAGUSD",
    "US500": "US500", "SPX500": "US500", "SPX": "US500", "US100": "US100",
    "NAS100": "US100", "NASDAQ": "US100", "US30": "US30", "DOW": "US30",
    "GER40": "GER40", "DAX": "GER40", "UK100": "UK100", "XAUUSD": "XAUUSD",
    "GOLD": "XAUUSD", "BTCUSD": "BTCUSD", "EURUSD": "EURUSD", "GBPUSD": "GBPUSD"
}

def _map_pair(raw: str) -> Optional[str]:
    key = raw.strip().upper().replace(" ", "").replace("/", "")
    for mk, av in MENTFX_TO_APP.items():
        if mk.replace(" ", "").replace("/", "").upper() == key: return av
    return None

def _normalize(a: float, b: float) -> Tuple[float, float]:
    total = a + b
    if total == 0: return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)

def _parse_json_response(data) -> Dict:
    results = {}
    items = data if isinstance(data, list) else [data]
    for item in items:
        if not isinstance(item, dict) or str(item.get("type", "")).lower() == "intraday": continue
        pair_raw = item.get("pair") or item.get("symbol") or item.get("asset") or ""
        app_pair = _map_pair(str(pair_raw))
        if not app_pair: continue
        bear = item.get("daily_bear") or item.get("bear") or item.get("short")
        bull = item.get("daily_bull") or item.get("bull") or item.get("long")
        if bear is not None and bull is not None:
            b_pct, bl_pct = _normalize(float(bear), float(bull))
            results[app_pair] = {"bearish_pct": b_pct, "bullish_pct": bl_pct}
    return results

def fetch_sentiment_data() -> Dict:
    logger.info("━━━ Fetching MentFX Data via GitLab Runner (Direct) ━━━")
    session = tls_client.Session(client_identifier="chrome_120")
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://mentfx.com/sentiment-viewer/"
    })
    
    for url in [MENTFX_JSON_1, MENTFX_JSON_2]:
        try:
            resp = session.get(url, timeout_seconds=15)
            if resp.status_code == 200 and resp.text.strip().startswith(('[', '{')):
                res = _parse_json_response(json.loads(resp.text))
                if res:
                    logger.info(f"✅ Success! Found {len(res)} pairs.")
                    return res
        except Exception as e:
            logger.error(f"Endpoint error: {e}")
    return {}

if __name__ == "__main__":
    # Isko test karne ke liye jab script direct chale
    data = fetch_sentiment_data()
    print(json.dumps(data, indent=2))

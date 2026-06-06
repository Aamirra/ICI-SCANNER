"""
sentiment_scraper.py  —  ICI-SCANNER (Proxy Version)
===================================================
Render Datacenter IPs ko bypass karne ke liye free proxy rotator integrated hai.
"""

import os
import json
import re
import time
import random
import logging
import tls_client
from bs4 import BeautifulSoup
from typing import Dict, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# URLS & CONFIG
# ─────────────────────────────────────────────
MENTFX_HOME   = "https://mentfx.com/"
MENTFX_VIEWER = "https://mentfx.com/sentiment-viewer/"
MENTFX_JSON_1 = "https://mentfx.com/sentiment-viewer/sentiment_data.php"
MENTFX_JSON_2 = "https://mentfx.com/sentiment-viewer/get_data.php"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

# Public free proxy list websites jo use ki ja sakti hain fallback ke liye
FREE_PROXY_SOURCES = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
    "https://www.proxy-list.download/api/v1/get?type=https"
]

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

def _is_cf_challenge(text: str) -> bool:
    lower = (text or "").lower()
    signals = ["just a moment", "checking your browser", "cloudflare",
               "challenge-platform", "turnstile", "enable javascript"]
    return any(s in lower for s in signals)

def _get_free_proxies() -> list:
    """Internet se automatically working free proxies uthata hai Render IP ko bypass karne ke liye."""
    proxies = []
    try:
        temp_session = tls_client.Session(client_identifier="chrome_120")
        for url in FREE_PROXY_SOURCES:
            res = temp_session.get(url, timeout_seconds=10)
            if res.status_code == 200 and res.text:
                found = re.findall(r'\d+\.\d+\.\d+\.\d+:\d+', res.text)
                proxies.extend(found)
        logger.info(f"[Proxy Rotator] Loaded {len(proxies)} fresh public proxies.")
    except Exception as e:
        logger.warning(f"Could not load free proxies: {e}")
    return proxies

def _make_session(ua: str, proxy: Optional[str] = None) -> tls_client.Session:
    session = tls_client.Session(
        client_identifier="chrome_120",
        random_tls_extension_order=True
    )
    session.headers.update({
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    if proxy:
        session.proxies = {
            "http": f"http://{proxy}",
            "https": f"http://{proxy}"
        }
        logger.info(f"[Session] Using Proxy: {proxy}")
    return session

def _warmup_session(session: tls_client.Session) -> bool:
    try:
        resp = session.get(MENTFX_HOME, timeout_seconds=15)
        if _is_cf_challenge(resp.text):
            logger.warning("[warmup] CF challenge detected.")
            return False
        time.sleep(random.uniform(1.0, 2.0))

        resp2 = session.get(MENTFX_VIEWER, timeout_seconds=15)
        if _is_cf_challenge(resp2.text):
            logger.warning("[warmup] CF challenge on viewer page.")
            return False

        return True
    except Exception as e:
        logger.warning(f"[warmup] Failed connection: {e}")
        return False

def _fetch_json(session: tls_client.Session, url: str) -> Optional[Dict]:
    try:
        current_headers = dict(session.headers)
        current_headers.update({
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": MENTFX_VIEWER,
            "Origin": "https://mentfx.com",
        })
        resp = session.get(url, headers=current_headers, timeout_seconds=15)
        if resp.status_code != 200:
            return None
        raw = resp.text.strip()
        if not raw or _is_cf_challenge(raw) or raw[0] not in ('{', '['):
            return None
        return _parse_json_response(json.loads(raw))
    except Exception:
        return None

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

def _fetch_html(session: tls_client.Session) -> Optional[Dict]:
    try:
        current_headers = dict(session.headers)
        current_headers.update({
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Referer": MENTFX_HOME,
        })
        resp = session.get(MENTFX_VIEWER, headers=current_headers, timeout_seconds=20)
        if resp.status_code != 200 or _is_cf_challenge(resp.text):
            return None
        soup = BeautifulSoup(resp.text, "html.parser")
        
        for parser in [_parse_scripts, _parse_tables]:
            res = parser(soup)
            if res: return res
        return None
    except Exception:
        return None

def _parse_scripts(soup: BeautifulSoup) -> Dict:
    results = {}
    pattern = re.compile(r"(?:var\s+\w+|window\.\w+|\w+)\s*=\s*(\[[\s\S]*?\]|\{[\s\S]*?\})\s*;", re.IGNORECASE)
    for script in soup.find_all("script"):
        text = script.string or ""
        if not text or sum(1 for k in ["pair", "bear", "bull"] if k in text.lower()) < 2:
            continue
        for match in pattern.finditer(text):
            try:
                extracted = _parse_json_response(json.loads(match.group(1).strip()))
                if extracted: results.update(extracted)
            except Exception: continue
    return results

def _parse_tables(soup: BeautifulSoup) -> Dict:
    results = {}
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
    return results

# ─────────────────────────────────────────────
# MAIN PUBLIC FUNCTION
# ─────────────────────────────────────────────
def fetch_sentiment_data() -> Dict:
    # 1. Pehle direct try karo bina proxy ke (Kya pta luck acha ho)
    ua = random.choice(USER_AGENTS)
    logger.info("━━━ Attempting Direct Connection (No Proxy) ━━━")
    session = _make_session(ua)
    if _warmup_session(session):
        for url in [MENTFX_JSON_1, MENTFX_JSON_2]:
            res = _fetch_json(session, url)
            if res: return res
        res_html = _fetch_html(session)
        if res_html: return res_html

    # 2. Agar direct block ho jaye, to automatically public proxies load karo
    logger.warning("Direct connection blocked by Cloudflare. Activating Proxy Rotator...")
    proxies = _get_free_proxies()
    
    # Sirf top 10 positions try karenge random filter ke sath taake script latkay nahi
    sampled_proxies = random.sample(proxies, min(len(proxies), 12))
    
    for idx, proxy in enumerate(sampled_proxies):
        logger.info(f"━━━ Proxy Session {idx+1}/{len(sampled_proxies)} ━━━")
        try:
            session = _make_session(ua, proxy=proxy)
            if not _warmup_session(session):
                continue
                
            # Layer 1 & 2
            for url in [MENTFX_JSON_1, MENTFX_JSON_2]:
                result = _fetch_json(session, url)
                if result:
                    logger.info(f"✅ Success via Proxy {proxy}: {len(result)} pairs found!")
                    return result
            
            # Layer 3 fallback
            result = _fetch_html(session)
            if result:
                logger.info(f"✅ Success via Proxy HTML {proxy}!")
                return result
        except Exception as e:
            logger.debug(f"Proxy {proxy} failed error: {e}")
            continue
            
    logger.error("❌ All proxy layers and sessions exhausted.")
    return {}

if __name__ == "__main__":
    print(fetch_sentiment_data())

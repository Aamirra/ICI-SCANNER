"""
sentiment_scraper.py  —  ICI-SCANNER
=====================================
GitHub Actions pe chalega — Cloudflare bypass guaranteed
Cloudflare GitHub ke IPs ko block nahi karta.

Strategy:
  Layer 1 → sentiment_data.php  (direct JSON)
  Layer 2 → get_data.php        (alternate JSON)
  Layer 3 → HTML scraping       (BeautifulSoup)
"""

import os
import json
import re
import time
import random
import logging
import requests
from bs4 import BeautifulSoup
from typing import Dict, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# URLS
# ─────────────────────────────────────────────
MENTFX_HOME   = "https://mentfx.com/"
MENTFX_VIEWER = "https://mentfx.com/sentiment-viewer/"
MENTFX_JSON_1 = "https://mentfx.com/sentiment-viewer/sentiment_data.php"
MENTFX_JSON_2 = "https://mentfx.com/sentiment-viewer/get_data.php"

# ─────────────────────────────────────────────
# USER AGENTS
# ─────────────────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) "
    "Gecko/20100101 Firefox/125.0",
]

# ─────────────────────────────────────────────
# PAIR MAPPING
# ─────────────────────────────────────────────
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


def _make_session(ua: str) -> requests.Session:
    """
    Simple requests session — GitHub Actions IPs Cloudflare bypass karti hain
    isliye heavy cloudscraper ki zaroorat nahi.
    """
    session = requests.Session()
    session.headers.update({
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    return session


def _warmup_session(session: requests.Session) -> bool:
    """Homepage visit karo cookie collect karne ke liye."""
    try:
        resp = session.get(MENTFX_HOME, timeout=20)
        if _is_cf_challenge(resp.text):
            logger.warning("[warmup] CF challenge on homepage")
            return False
        time.sleep(random.uniform(1.5, 3.0))

        resp2 = session.get(MENTFX_VIEWER, timeout=20)
        if _is_cf_challenge(resp2.text):
            logger.warning("[warmup] CF challenge on viewer page")
            return False

        logger.info(f"[warmup] OK — cookies: {list(session.cookies.keys())}")
        return True
    except Exception as e:
        logger.warning(f"[warmup] Failed: {e}")
        return False


def _fetch_json(session: requests.Session, url: str) -> Optional[Dict]:
    """JSON endpoint fetch karo aur parse karo."""
    try:
        session.headers.update({
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": MENTFX_VIEWER,
            "Origin": "https://mentfx.com",
        })
        resp = session.get(url, timeout=20)

        if resp.status_code != 200:
            logger.warning(f"[json] HTTP {resp.status_code} from {url}")
            return None

        raw = resp.text.strip()
        if not raw or _is_cf_challenge(raw):
            return None

        if raw[0] not in ('{', '['):
            logger.warning(f"[json] Not JSON from {url}: {raw[:80]!r}")
            return None

        data = json.loads(raw)
        return _parse_json_response(data)

    except Exception as e:
        logger.warning(f"[json] Exception for {url}: {e}")
        return None


def _parse_json_response(data) -> Dict:
    """JSON response ko parse karo — daily data nikalo."""
    results = {}
    items = data if isinstance(data, list) else [data]

    for item in items:
        if not isinstance(item, dict):
            continue

        # Sirf DAILY data chahiye
        if str(item.get("type", "")).lower() == "intraday":
            continue

        pair_raw = (item.get("pair") or item.get("symbol")
                    or item.get("asset") or "")
        app_pair = _map_pair(str(pair_raw))
        if not app_pair:
            continue

        # Multiple key names try karo
        bear = (item.get("daily_bear") or item.get("bear_daily")
                or item.get("bear") or item.get("short"))
        bull = (item.get("daily_bull") or item.get("bull_daily")
                or item.get("bull") or item.get("long"))

        if bear is not None and bull is not None:
            try:
                b_pct, bl_pct = _normalize(float(bear), float(bull))
                results[app_pair] = {
                    "bearish_pct": b_pct,
                    "bullish_pct": bl_pct
                }
            except (ValueError, TypeError):
                continue

    return results


def _fetch_html(session: requests.Session) -> Optional[Dict]:
    """HTML scraping fallback — BeautifulSoup se data nikalo."""
    try:
        session.headers.update({
            "Accept": ("text/html,application/xhtml+xml,"
                       "application/xml;q=0.9,*/*;q=0.8"),
            "Referer": MENTFX_HOME,
        })
        resp = session.get(MENTFX_VIEWER, timeout=25)

        if resp.status_code != 200 or _is_cf_challenge(resp.text):
            return None

        soup = BeautifulSoup(resp.text, "html.parser")
        results = {}

        # Strategy A: Script tags mein JSON dhundo
        results = _parse_scripts(soup)
        if results:
            logger.info(f"[html] Script JSON: {len(results)} pairs")
            return results

        # Strategy B: Table rows parse karo
        results = _parse_tables(soup)
        if results:
            logger.info(f"[html] Table data: {len(results)} pairs")
            return results

        # Strategy C: Div/span elements scan karo
        results = _parse_elements(soup)
        if results:
            logger.info(f"[html] Element scan: {len(results)} pairs")
            return results

        logger.warning("[html] Koi data nahi mila")
        return None

    except Exception as e:
        logger.warning(f"[html] Exception: {e}")
        return None


def _parse_scripts(soup: BeautifulSoup) -> Dict:
    results = {}
    pattern = re.compile(
        r"(?:var\s+\w+|window\.\w+|\w+)\s*=\s*"
        r"(\[[\s\S]*?\]|\{[\s\S]*?\})\s*;",
        re.IGNORECASE
    )
    for script in soup.find_all("script"):
        text = script.string or ""
        if not text:
            continue
        lower = text.lower()
        if sum(1 for k in ["pair", "bear", "bull", "sentiment"] if k in lower) < 2:
            continue
        for match in pattern.finditer(text):
            candidate = match.group(1).strip()
            if len(candidate) < 20:
                continue
            try:
                parsed = json.loads(candidate)
                extracted = _parse_json_response(parsed)
                if extracted:
                    results.update(extracted)
            except (json.JSONDecodeError, ValueError):
                continue
    return results


def _parse_tables(soup: BeautifulSoup) -> Dict:
    results = {}
    pct_re = re.compile(r"^(\d{1,3}(?:\.\d+)?)%?$")
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
            pair = None
            for cell in cells:
                pair = _map_pair(cell)
                if pair:
                    break
            if not pair:
                continue
            nums = []
            for cell in cells:
                m = pct_re.match(cell.strip().rstrip("%"))
                if m:
                    nums.append(float(m.group(1)))
            if len(nums) >= 2:
                b, bl = _normalize(nums[0], nums[1])
                results[pair] = {"bearish_pct": b, "bullish_pct": bl}
    return results


def _parse_elements(soup: BeautifulSoup) -> Dict:
    results = {}
    pct_re = re.compile(r"^(\d{1,3}(?:\.\d+)?)%?$")
    for container in soup.find_all(["div", "li", "article"], limit=600):
        if len(container.find_all(True)) > 30:
            continue
        texts = [t.strip() for t in container.stripped_strings if t.strip()]
        if len(texts) < 3:
            continue
        found_pair = None
        for t in texts:
            mapped = _map_pair(t)
            if mapped:
                found_pair = mapped
                break
        if not found_pair or found_pair in results:
            continue
        pct_vals = []
        for t in texts:
            m = pct_re.match(t.rstrip("%").strip())
            if m:
                pct_vals.append(float(m.group(1)))
        if len(pct_vals) >= 2:
            b, bl = _normalize(pct_vals[0], pct_vals[1])
            results[found_pair] = {"bearish_pct": b, "bullish_pct": bl}
    return results


# ─────────────────────────────────────────────
# MAIN PUBLIC FUNCTION
# ─────────────────────────────────────────────
def fetch_sentiment_data() -> Dict:
    """
    Main function — 3 sessions try karega.
    Har session mein 3 layers:
      1. sentiment_data.php (JSON)
      2. get_data.php (JSON)
      3. HTML scraping
    """
    MAX_SESSIONS = 3

    for attempt in range(1, MAX_SESSIONS + 1):
        ua = random.choice(USER_AGENTS)
        logger.info(f"━━━ Session {attempt}/{MAX_SESSIONS} ━━━")

        session = _make_session(ua)

        # Warmup
        if not _warmup_session(session):
            logger.warning(f"Session {attempt} warmup failed")
            time.sleep(attempt * 10)
            continue

        time.sleep(random.uniform(1.0, 2.0))

        # Layer 1
        logger.info("[Layer 1] sentiment_data.php ...")
        result = _fetch_json(session, MENTFX_JSON_1)
        if result:
            logger.info(f"✅ Layer 1 SUCCESS: {len(result)} pairs")
            return result

        time.sleep(random.uniform(1.0, 2.0))

        # Layer 2
        logger.info("[Layer 2] get_data.php ...")
        result = _fetch_json(session, MENTFX_JSON_2)
        if result:
            logger.info(f"✅ Layer 2 SUCCESS: {len(result)} pairs")
            return result

        time.sleep(random.uniform(1.5, 2.5))

        # Layer 3
        logger.info("[Layer 3] HTML scraping ...")
        result = _fetch_html(session)
        if result:
            logger.info(f"✅ Layer 3 SUCCESS: {len(result)} pairs")
            return result

        logger.warning(f"Session {attempt} — sab layers fail. Retry...")
        time.sleep(attempt * 15)

    logger.error("❌ Sab sessions fail — koi data nahi mila")
    return {}


if __name__ == "__main__":
    data = fetch_sentiment_data()
    print(json.dumps(data, indent=2))

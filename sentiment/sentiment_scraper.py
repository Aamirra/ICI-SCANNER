"""
sentiment_scraper.py  —  ICI-SCANNER  (complete rewrite)
=========================================================
3-Layer anti-block strategy
  Layer 1  →  sentiment_data.php   (JSON, primary)
  Layer 2  →  get_data.php         (JSON, alternate)
  Layer 3  →  /sentiment-viewer/   (HTML → BeautifulSoup, last resort)

Key fixes vs. old version
  • Response validated BEFORE json.loads() — no more blind JSONDecodeError
  • CF-challenge/HTML-error pages detected and routed to HTML fallback
  • Session is warmed-up through BOTH homepage AND viewer page to collect
    all CF clearance cookies before hitting API endpoints
  • AJAX headers include proper Referer/Origin so server sees a legit XHR
  • Accept-Encoding has NO 'br' (Brotli) — avoids garbled binary output
  • Exponential back-off between full session re-tries
  • BeautifulSoup fallback has 3 sub-strategies:
      (a) JSON objects embedded inside <script> tags
      (b) <table> rows with pair + percentage cells
      (c) Generic div/span grid elements
"""

import json
import re
import time
import random
import logging
import cloudscraper
from bs4 import BeautifulSoup
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────
# TARGET URLs
# ──────────────────────────────────────────────────────────────────
MENTFX_HOME   = "https://mentfx.com/"
MENTFX_VIEWER = "https://mentfx.com/sentiment-viewer/"          # warmup + HTML fallback
MENTFX_JSON_1 = "https://mentfx.com/sentiment-viewer/sentiment_data.php"
MENTFX_JSON_2 = "https://mentfx.com/sentiment-viewer/get_data.php"

# ──────────────────────────────────────────────────────────────────
# ROTATING USER-AGENTS  (Chrome > Firefox for CF compatibility)
# ──────────────────────────────────────────────────────────────────
USER_AGENTS = [
    # Chrome 124 Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # Chrome 124 macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # Chrome 123 Linux
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # Firefox 125 Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) "
    "Gecko/20100101 Firefox/125.0",
]

BROWSER_CONFIGS = [
    {"browser": "chrome",  "platform": "windows", "mobile": False},
    {"browser": "chrome",  "platform": "linux",   "mobile": False},
    {"browser": "firefox", "platform": "windows", "mobile": False},
]

# ──────────────────────────────────────────────────────────────────
# PAIR MAPPING  (site label → app canonical name)
# ──────────────────────────────────────────────────────────────────
MENTFX_TO_APP: Dict[str, str] = {
    "USOIL": "USOIL",   "WTI": "USOIL",       "CRUDEOIL": "USOIL",
    "XAGUSD": "XAGUSD", "SILVER": "XAGUSD",   "XAG": "XAGUSD",
    "US500": "US500",   "SPX500": "US500",     "SPX": "US500",    "S&P500": "US500",
    "US100": "US100",   "NAS100": "US100",     "NASDAQ": "US100", "NASDAQ100": "US100",
    "US30": "US30",     "DOW": "US30",         "DOW30": "US30",   "DJ30": "US30",
    "GER40": "GER40",   "DAX": "GER40",        "DAX40": "GER40",  "GER30": "GER40",
    "UK100": "UK100",   "FTSE": "UK100",       "FTSE100": "UK100",
    "JPN225": "JPN225", "NIKKEI": "JPN225",    "NIKKEI225": "JPN225",
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
    "XAUUSD": "XAUUSD", "GOLD": "XAUUSD",     "XAU": "XAUUSD",
    "BTCUSD": "BTCUSD", "BITCOIN": "BTCUSD",  "BTC": "BTCUSD",
}


# ══════════════════════════════════════════════════════════════════
#  SECTION 1 – SMALL UTILITY HELPERS
# ══════════════════════════════════════════════════════════════════

def _map_pair(raw: str) -> Optional[str]:
    """Normalize a raw pair string to its app-canonical name, or None."""
    key = raw.strip().upper().replace(" ", "").replace("/", "")
    for mk, av in MENTFX_TO_APP.items():
        if mk.replace(" ", "").replace("/", "").upper() == key:
            return av
    return None


def _normalize(a: float, b: float) -> Tuple[float, float]:
    """Convert raw bear/bull numbers into two percentages that sum to 100."""
    total = a + b
    if total == 0:
        return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)


# ══════════════════════════════════════════════════════════════════
#  SECTION 2 – RESPONSE VALIDATORS
#  These run BEFORE json.loads() to avoid blind JSONDecodeError.
# ══════════════════════════════════════════════════════════════════

def _looks_like_json(text: str) -> bool:
    """True only when the trimmed response starts with '{' or '['."""
    s = (text or "").strip()
    return bool(s) and s[0] in ("{", "[")


def _looks_like_html(text: str) -> bool:
    """True when the response is clearly an HTML page."""
    s = (text or "").strip().lower()
    return s.startswith("<!doctype") or s.startswith("<html")


def _is_cf_challenge(text: str) -> bool:
    """
    True when Cloudflare has returned a browser-challenge / CAPTCHA page
    instead of real data.  Render IPs are frequently targeted by this.
    """
    lower = (text or "").lower()
    CF_SIGNALS = [
        "just a moment",        # CF interstitial title
        "checking your browser",
        "cf-ray",               # CF debug header echoed in page
        "challenge-platform",
        "turnstile",            # CF Turnstile widget
        "cloudflare",
        "enable javascript",
        "ddos-guard",           # alternative WAF sometimes on same infra
    ]
    return any(sig in lower for sig in CF_SIGNALS)


# ══════════════════════════════════════════════════════════════════
#  SECTION 3 – SCRAPER FACTORY & SESSION BUILDER
# ══════════════════════════════════════════════════════════════════

def _make_browser_headers(ua: str) -> dict:
    """
    Full browser-navigation headers.
    Used for warmup requests and the HTML-page fallback fetch.
    NOTE: 'br' (Brotli) intentionally omitted from Accept-Encoding.
          Brotli-encoded responses from CF on Render often produce
          garbled binary text that breaks all string operations.
    """
    return {
        "User-Agent":                ua,
        "Accept":                    (
            "text/html,application/xhtml+xml,"
            "application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        ),
        "Accept-Language":           "en-US,en;q=0.9",
        "Accept-Encoding":           "gzip, deflate",   # NO 'br'
        "Connection":                "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest":            "document",
        "Sec-Fetch-Mode":            "navigate",
        "Sec-Fetch-Site":            "none",
        "Cache-Control":             "max-age=0",
    }


def _make_ajax_headers(ua: str) -> dict:
    """
    XHR/AJAX headers for JSON endpoint calls.
    Referer and Origin are critical — servers use them to verify the
    request originated from within the site (same as a real browser XHR).
    """
    return {
        "User-Agent":        ua,
        "Accept":            "application/json, text/javascript, */*; q=0.01",
        "Accept-Language":   "en-US,en;q=0.9",
        "Accept-Encoding":   "gzip, deflate",   # NO 'br'
        "X-Requested-With":  "XMLHttpRequest",
        "Referer":           MENTFX_VIEWER,      # must look like XHR from viewer page
        "Origin":            "https://mentfx.com",
        "Connection":        "keep-alive",
    }


def _build_warmed_session(ua: str, cfg: dict) -> Optional[cloudscraper.CloudScraper]:
    """
    Build a scraper with a real CF-clearance cookie by simulating a human
    browser navigating:  homepage  →  sentiment-viewer page.

    Returns the live scraper (with cookies) ready for API calls, or None if
    Cloudflare blocked us at any warmup step.
    """
    scraper = cloudscraper.create_scraper(
        browser=cfg,
        delay=random.uniform(3, 6),   # mimic human page-load time
    )
    scraper.headers.update(_make_browser_headers(ua))

    # Two-step warmup to collect homepage + viewer-page cookies
    warmup_steps = [
        (MENTFX_HOME,   "Homepage warmup"),
        (MENTFX_VIEWER, "Viewer-page warmup"),
    ]

    for url, label in warmup_steps:
        try:
            resp = scraper.get(url, timeout=20)
            logger.debug(
                f"[session] {label}: HTTP {resp.status_code}, "
                f"{len(resp.text)} chars, "
                f"cookies={list(scraper.cookies.keys())}"
            )

            if _is_cf_challenge(resp.text):
                logger.warning(
                    f"[session] CF challenge hit on '{label}' — "
                    "this Render IP may be blocked. Abandoning session."
                )
                return None

            # Pause between steps — looks more human
            time.sleep(random.uniform(1.5, 3.5))

        except Exception as exc:
            logger.warning(f"[session] {label} failed: {exc}")
            return None

    logger.debug(f"[session] Warmed-up OK. Cookies: {list(scraper.cookies.keys())}")
    return scraper


# ══════════════════════════════════════════════════════════════════
#  SECTION 4 – JSON PARSER
# ══════════════════════════════════════════════════════════════════

def _parse_json_data(raw_text: str) -> Dict:
    """
    Parse raw JSON text from the API endpoints.
    All exceptions are caught here — this function never raises.
    """
    results: Dict = {}
    try:
        data = json.loads(raw_text)
        items = data if isinstance(data, list) else [data]

        for item in items:
            if not isinstance(item, dict):
                continue

            # Skip intraday entries — we only want DAILY
            if str(item.get("type", "")).lower() == "intraday":
                continue

            pair_raw = item.get("pair") or item.get("symbol") or item.get("asset")
            if not pair_raw:
                continue

            app_pair = _map_pair(str(pair_raw))
            if not app_pair:
                continue

            # Accept multiple key naming conventions from the API
            bear = (
                item.get("daily_bear") or item.get("bear_daily") or item.get("bear")
            )
            bull = (
                item.get("daily_bull") or item.get("bull_daily") or item.get("bull")
            )

            if bear is not None and bull is not None:
                b_pct, bl_pct = _normalize(float(bear), float(bull))
                results[app_pair] = {"bearish_pct": b_pct, "bullish_pct": bl_pct}

    except json.JSONDecodeError as exc:
        # This is the exact error from your logs — now safely caught & reported
        logger.warning(f"[json_parser] JSONDecodeError: {exc}")
    except (TypeError, ValueError) as exc:
        logger.warning(f"[json_parser] Data conversion error: {exc}")
    except Exception as exc:
        logger.warning(f"[json_parser] Unexpected error: {exc}")

    return results


# ══════════════════════════════════════════════════════════════════
#  SECTION 5 – HTML FALLBACK PARSERS  (BeautifulSoup, 3 sub-strategies)
# ══════════════════════════════════════════════════════════════════

# Regex: matches a standalone number like "42", "42.5", "42.50", with
# optional trailing "%" — used in cell / text parsing.
_PCT_RE = re.compile(r"^(\d{1,3}(?:\.\d+)?)%?$")


def _parse_html_fallback(html: str) -> Dict:
    """
    Entry-point for the HTML fallback path.  Tries three strategies in order,
    returning as soon as one yields usable data.
    """
    soup = BeautifulSoup(html, "html.parser")

    # ── Sub-strategy A: JSON objects embedded inside <script> blocks ──────
    logger.debug("[html] Trying sub-strategy A: script-tag JSON extraction")
    data = _extract_from_scripts(soup)
    if data:
        logger.info(f"[html] Sub-strategy A hit: {len(data)} pairs from scripts.")
        return data

    # ── Sub-strategy B: <table> rows with pair + bear/bull cells ──────────
    logger.debug("[html] Trying sub-strategy B: HTML table parsing")
    data = _extract_from_tables(soup)
    if data:
        logger.info(f"[html] Sub-strategy B hit: {len(data)} pairs from tables.")
        return data

    # ── Sub-strategy C: div/span grid / card layout ───────────────────────
    logger.debug("[html] Trying sub-strategy C: generic element scan")
    data = _extract_from_elements(soup)
    if data:
        logger.info(f"[html] Sub-strategy C hit: {len(data)} pairs from elements.")
        return data

    logger.warning("[html] All sub-strategies exhausted — no pairs found.")
    return {}


# ── Sub-strategy A ────────────────────────────────────────────────────────

def _extract_from_scripts(soup: BeautifulSoup) -> Dict:
    """
    Find JSON arrays/objects assigned to JavaScript variables inside
    <script> tags, then run them through the normal JSON parser.

    Patterns targeted (any of):
        var sentimentData = [...];
        window.tableData  = [...];
        sentimentData     = {...};
    """
    results: Dict = {}

    # Keywords that suggest a script block contains sentiment data
    RELEVANT_KEYS = ["pair", "bear", "bull", "sentiment", "daily"]

    # JS variable assignment followed by a JSON literal
    ASSIGN_PATTERN = re.compile(
        r"(?:var\s+\w+|window\.\w+|\w+)\s*=\s*"   # variable name
        r"(\[[\s\S]*?\]|\{[\s\S]*?\})\s*;",         # JSON array or object
        re.IGNORECASE,
    )

    for script in soup.find_all("script"):
        text = script.string or ""
        if not text:
            continue

        # Only process scripts that mention at least two relevant keys
        lower_text = text.lower()
        if sum(1 for k in RELEVANT_KEYS if k in lower_text) < 2:
            continue

        for match in ASSIGN_PATTERN.finditer(text):
            candidate = match.group(1).strip()
            # Skip tiny snippets and huge blobs (> 100 KB)
            if len(candidate) < 20 or len(candidate) > 102_400:
                continue
            try:
                parsed = json.loads(candidate)
                extracted = _parse_json_data(json.dumps(parsed))
                if extracted:
                    results.update(extracted)
            except (json.JSONDecodeError, ValueError):
                continue

    return results


# ── Sub-strategy B ────────────────────────────────────────────────────────

def _extract_from_tables(soup: BeautifulSoup) -> Dict:
    """
    Scan all <table> elements.  When a row has a cell whose text maps to a
    known pair AND at least two numeric/percentage cells, record the entry.

    Prefers tables that live inside a 'daily' section/tab, but falls back to
    scanning all tables on the page.
    """
    results: Dict = {}

    # Try to narrow scope to a "daily" section first
    daily_container = (
        soup.find(id=re.compile(r"daily", re.I))
        or soup.find(class_=re.compile(r"daily", re.I))
    )
    root = daily_container or soup

    tables = root.find_all("table") or soup.find_all("table")
    if not tables:
        return results

    for table in tables:
        for row in table.find_all("tr"):
            cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
            row_result = _row_cells_to_pair(cells)
            if row_result:
                results.update(row_result)

    return results


def _row_cells_to_pair(cells: list) -> Dict:
    """
    Given a list of cell texts from one table row, return a single-entry dict
    {app_pair: {bearish_pct, bullish_pct}} if the row is parseable, else {}.
    """
    # Find the first cell that maps to a known pair
    pair = None
    for cell in cells:
        pair = _map_pair(cell)
        if pair:
            break
    if not pair:
        return {}

    # Collect all numeric/percentage values in the same row
    nums = []
    for cell in cells:
        m = _PCT_RE.match(cell.strip().rstrip("%"))
        if m:
            nums.append(float(m.group(1)))

    if len(nums) >= 2:
        b_pct, bl_pct = _normalize(nums[0], nums[1])
        return {pair: {"bearish_pct": b_pct, "bullish_pct": bl_pct}}

    return {}


# ── Sub-strategy C ────────────────────────────────────────────────────────

def _extract_from_elements(soup: BeautifulSoup) -> Dict:
    """
    Last-resort scan for sites using a card / grid layout (div or li blocks)
    rather than tables.  Looks for any container whose text includes a known
    pair name AND at least two percentage-like values near it.
    """
    results: Dict = {}

    # Walk likely container elements (limit to keep it fast)
    containers = soup.find_all(
        ["div", "li", "article", "section", "span"],
        limit=600,
    )

    for container in containers:
        # Only examine leaf-ish nodes (not the entire page body)
        if len(container.find_all(True)) > 30:
            continue

        texts = [t.strip() for t in container.stripped_strings if t.strip()]
        if len(texts) < 3:
            continue

        # Attempt to find a pair name in the container's text
        found_pair: Optional[str] = None
        for t in texts:
            mapped = _map_pair(t)
            if mapped:
                found_pair = mapped
                break

        if not found_pair:
            continue

        # Collect numeric values that look like percentages
        pct_values = []
        for t in texts:
            clean = t.rstrip("%").strip()
            m = _PCT_RE.match(clean)
            if m:
                pct_values.append(float(m.group(1)))

        if len(pct_values) >= 2 and found_pair not in results:
            b_pct, bl_pct = _normalize(pct_values[0], pct_values[1])
            results[found_pair] = {"bearish_pct": b_pct, "bullish_pct": bl_pct}

    return results


# ══════════════════════════════════════════════════════════════════
#  SECTION 6 – PER-LAYER FETCH HELPERS
# ══════════════════════════════════════════════════════════════════

def _fetch_json_endpoint(
    scraper: cloudscraper.CloudScraper,
    url: str,
    ua: str,
) -> Optional[str]:
    """
    Fetch a JSON endpoint using an already-warmed scraper session.
    Returns the raw text only if it genuinely looks like JSON.
    Returns None for:  HTTP errors  |  CF challenge  |  HTML page  |  empty.
    """
    try:
        # Switch to AJAX headers for the actual data request
        scraper.headers.update(_make_ajax_headers(ua))
        resp = scraper.get(url, timeout=20)

        ct = resp.headers.get("Content-Type", "?")
        logger.debug(
            f"[json_fetch] {url} → HTTP {resp.status_code}, "
            f"Content-Type={ct}, size={len(resp.text)}"
        )

        if resp.status_code != 200:
            logger.warning(f"[json_fetch] Non-200 ({resp.status_code}) from {url}")
            return None

        raw = resp.text.strip()

        if not raw:
            logger.warning(f"[json_fetch] Empty body from {url}")
            return None

        if _is_cf_challenge(raw):
            logger.warning(f"[json_fetch] CF challenge returned from {url}")
            return None

        if _looks_like_html(raw):
            logger.warning(
                f"[json_fetch] Got HTML instead of JSON from {url} "
                f"(starts: {raw[:80]!r})"
            )
            return None

        # ── THE KEY GUARD ──────────────────────────────────────────
        # This is the exact guard that was missing before.
        # json.loads() is now NEVER called unless this passes.
        if not _looks_like_json(raw):
            logger.warning(
                f"[json_fetch] Non-JSON response from {url} "
                f"(starts: {raw[:80]!r})"
            )
            return None
        # ──────────────────────────────────────────────────────────

        return raw

    except Exception as exc:
        logger.warning(f"[json_fetch] Exception for {url}: {exc}")
        return None


def _fetch_html_page(
    scraper: cloudscraper.CloudScraper,
    ua: str,
) -> Optional[str]:
    """
    Fetch the sentiment viewer HTML page using the warmed session.
    Returns full HTML string, or None on failure.
    """
    try:
        # Revert to full browser-navigation headers for the page load
        scraper.headers.update(_make_browser_headers(ua))
        scraper.headers.update({"Referer": MENTFX_HOME})

        resp = scraper.get(MENTFX_VIEWER, timeout=25)

        logger.debug(
            f"[html_fetch] {MENTFX_VIEWER} → HTTP {resp.status_code}, "
            f"size={len(resp.text)}"
        )

        if resp.status_code != 200:
            logger.warning(f"[html_fetch] Non-200 ({resp.status_code})")
            return None

        raw = resp.text.strip()

        if not raw:
            logger.warning("[html_fetch] Empty body")
            return None

        if _is_cf_challenge(raw):
            logger.warning("[html_fetch] CF challenge on viewer page")
            return None

        return raw

    except Exception as exc:
        logger.warning(f"[html_fetch] Exception: {exc}")
        return None


# ══════════════════════════════════════════════════════════════════
#  SECTION 7 – PUBLIC API
# ══════════════════════════════════════════════════════════════════

def fetch_sentiment_data() -> Dict:
    """
    Main entry-point for ICI-SCANNER.

    Tries up to MAX_ATTEMPTS full scraper sessions.  Within each session,
    three layers are attempted in order:
        Layer 1  →  sentiment_data.php  (JSON)
        Layer 2  →  get_data.php        (JSON fallback)
        Layer 3  →  /sentiment-viewer/  (HTML + BeautifulSoup)

    Returns a dict of  {pair_name: {bearish_pct, bullish_pct}}
    or an empty dict if all attempts fail.
    """
    MAX_ATTEMPTS = 3
    t_start = time.time()

    for attempt in range(1, MAX_ATTEMPTS + 1):
        ua  = random.choice(USER_AGENTS)
        cfg = random.choice(BROWSER_CONFIGS)

        logger.info(
            f"━━━ Session {attempt}/{MAX_ATTEMPTS} "
            f"[{cfg['browser']} / {cfg['platform']}] ━━━"
        )

        # ── Build warmed session ───────────────────────────────────
        scraper = _build_warmed_session(ua, cfg)
        if scraper is None:
            backoff = attempt * random.uniform(6, 12)
            logger.warning(
                f"Session {attempt} warmup failed. "
                f"Backing off {backoff:.1f}s before retry…"
            )
            time.sleep(backoff)
            continue

        # ── Layer 1: Primary JSON endpoint ────────────────────────
        logger.info("[Layer 1] sentiment_data.php …")
        raw = _fetch_json_endpoint(scraper, MENTFX_JSON_1, ua)
        if raw:
            results = _parse_json_data(raw)
            if results:
                _log_success("Layer 1", len(results), t_start)
                return results
            logger.warning(
                "[Layer 1] JSON decoded successfully but no valid "
                "DAILY metrics found (check key names in response)."
            )

        # Small pause between same-session requests
        time.sleep(random.uniform(1.0, 2.5))

        # ── Layer 2: Alternate JSON endpoint ──────────────────────
        logger.info("[Layer 2] get_data.php …")
        raw = _fetch_json_endpoint(scraper, MENTFX_JSON_2, ua)
        if raw:
            results = _parse_json_data(raw)
            if results:
                _log_success("Layer 2", len(results), t_start)
                return results
            logger.warning(
                "[Layer 2] JSON decoded successfully but no valid "
                "DAILY metrics found."
            )

        time.sleep(random.uniform(1.5, 3.0))

        # ── Layer 3: HTML page + BeautifulSoup ────────────────────
        logger.info("[Layer 3] Falling back to HTML scraping …")
        html = _fetch_html_page(scraper, ua)
        if html:
            results = _parse_html_fallback(html)
            if results:
                _log_success("Layer 3 (HTML)", len(results), t_start)
                return results
            logger.warning(
                "[Layer 3] HTML page fetched but no sentiment pairs "
                "could be parsed — page structure may have changed."
            )
        else:
            logger.warning("[Layer 3] HTML page fetch itself failed.")

        # ── All three layers failed — back off before next session ─
        backoff = attempt * random.uniform(8, 15)
        logger.warning(
            f"All layers failed on session {attempt}. "
            f"Sleeping {backoff:.1f}s before next attempt…"
        )
        time.sleep(backoff)

    # ── Exhausted all attempts ─────────────────────────────────────
    elapsed = time.time() - t_start
    logger.error(
        f"Scraper se koi data nahi aaya. "
        f"All {MAX_ATTEMPTS} session attempts exhausted "
        f"({elapsed:.1f}s total). Job abort."
    )
    return {}


def _log_success(layer: str, count: int, t_start: float) -> None:
    elapsed = time.time() - t_start
    logger.info(
        f"[SUCCESS] {layer}: {count} DAILY pairs fetched in {elapsed:.1f}s."
    )

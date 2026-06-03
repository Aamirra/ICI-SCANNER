import os
import re
import logging
import cloudscraper
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# Mentfx sentiment page ka URL.
# Deploy se pehle browser mein khol kar confirm kar lo.
# ---------------------------------------------------------------
MENTFX_URL = "https://www.mentfx.com/sentiment/"

# ---------------------------------------------------------------
# Mentfx par jo bhi naam use ho sakta hai → App ka naam
# Agar scrape ke baad koi pair match nahi karta, toh
# MENTFX_DEBUG=true set karo aur is dictionary mein
# Mentfx wala actual naam add karo.
# ---------------------------------------------------------------
MENTFX_TO_APP = {
    # Direct matches
    'US500': 'US500', 'US100': 'US100', 'US30': 'US30',
    'GER40': 'GER40', 'UK100': 'UK100', 'JPN225': 'JPN225',
    'XAGUSD': 'XAGUSD',
    # S&P 500 variants
    'SPX500': 'US500', 'SPX': 'US500', 'S&P500': 'US500', 'S&P 500': 'US500',
    # NASDAQ variants
    'NAS100': 'US100', 'NASDAQ': 'US100', 'NASDAQ100': 'US100',
    # Dow variants
    'DOW': 'US30', 'DOW30': 'US30', 'DJ30': 'US30', 'DOWJONES': 'US30',
    # DAX variants
    'DAX': 'GER40', 'DAX40': 'GER40', 'GER30': 'GER40',
    # FTSE variants
    'FTSE': 'UK100', 'FTSE100': 'UK100',
    # Nikkei variants
    'NIKKEI': 'JPN225', 'NIKKEI225': 'JPN225',
    # Silver variants
    'SILVER': 'XAGUSD', 'XAG/USD': 'XAGUSD', 'XAG': 'XAGUSD',
}


def _map_pair(raw: str):
    """
    Mentfx name → App name.
    Pehle exact match karta hai, phir partial fallback.
    """
    key = raw.strip().upper().replace(' ', '').replace('/', '').replace('&', '&')
    for mk, av in MENTFX_TO_APP.items():
        if mk.replace(' ', '').replace('/', '').upper() == key:
            return av
    # Partial fallback
    for mk, av in MENTFX_TO_APP.items():
        ck = mk.replace(' ', '').replace('/', '').upper()
        if ck in key or key in ck:
            return av
    return None


def _normalize(a: float, b: float):
    """bearish + bullish = exactly 100."""
    total = a + b
    if total == 0:
        return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)


def _parse(soup: BeautifulSoup) -> dict:
    results = {}

    # --- Strategy 1: HTML <table> ---
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

    # --- Strategy 2: Div/flex layout ---
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


def fetch_sentiment_data() -> dict:
    """
    Main function. Returns:
    { 'US500': {'bearish_pct': 33.0, 'bullish_pct': 67.0}, ... }
    """
    debug = os.environ.get('MENTFX_DEBUG', 'false').lower() == 'true'

    scraper = cloudscraper.create_scraper(
        browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
    )

    try:
        resp = scraper.get(MENTFX_URL, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        logger.error(f"Mentfx fetch failed: {e}")
        return {}

    if debug:
        logger.debug("=== RAW HTML (first 4000 chars) ===\n" + resp.text[:4000])

    soup = BeautifulSoup(resp.text, 'lxml')
    results = _parse(soup)

    if not results:
        logger.warning(
            "Parser ne koi data nahi nikala. "
            "MENTFX_DEBUG=true set kar ke HTML dekho aur "
            "MENTFX_TO_APP dictionary ya _parse() function adjust karo."
        )
    else:
        logger.info(f"Scraped {len(results)} pairs: {list(results.keys())}")

    return results

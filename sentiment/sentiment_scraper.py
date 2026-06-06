"""
sentiment_scraper.py  —  ICI-SCANNER (GitHub Actions HTML Live Parser + Firebase Fix)
====================================================================
Bina kisi proxy ke direct main page ka table parse karke Firebase ke 'sentiment' node mein save karne wala system.
"""

import os
import json
import re
import logging
import tls_client
import firebase_admin
from firebase_admin import credentials, db
from bs4 import BeautifulSoup
from typing import Dict, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ✅ URL updated to main sentiment page
MENTFX_VIEWER = "https://mentfx.com/sentiment/"

# ✅ Full pair mapping added
MENTFX_TO_APP: Dict[str, str] = {
    # --- Commodities & Crypto ---
    "USOIL": "USOIL",
    "XAGUSD": "XAGUSD", "SILVER": "XAGUSD",
    "XAUUSD": "XAUUSD", "GOLD": "XAUUSD",
    "BTCUSD": "BTCUSD",
    "ETHUSD": "ETHUSD",

    # --- Indices ---
    "US500": "US500", "SPX500": "US500", "SPX": "US500",
    "US100": "US100", "NAS100": "US100", "NASDAQ": "US100",
    "US30": "US30", "DOW": "US30",
    "GER40": "GER40", "DAX": "GER40",
    "UK100": "UK100",

    # --- Major USD Pairs ---
    "EURUSD": "EURUSD",
    "GBPUSD": "GBPUSD",
    "AUDUSD": "AUDUSD",
    "NZDUSD": "NZDUSD",
    "USDJPY": "USDJPY",
    "USDCHF": "USDCHF",
    "USDCAD": "USDCAD",

    # --- JPY Cross Pairs ---
    "EURJPY": "EURJPY",
    "GBPJPY": "GBPJPY",
    "AUDJPY": "AUDJPY",
    "NZDJPY": "NZDJPY",
    "CADJPY": "CADJPY",
    "CHFJPY": "CHFJPY",

    # --- EUR Cross Pairs ---
    "EURGBP": "EURGBP",
    "EURAUD": "EURAUD",
    "EURCAD": "EURCAD",
    "EURCHF": "EURCHF",

    # --- GBP Cross Pairs ---
    "GBPAUD": "GBPAUD",
    "GBPCAD": "GBPCAD",
    "GBPCHF": "GBPCHF",

    # --- AUD Cross Pairs ---
    "AUDCAD": "AUDCAD",
    "AUDCHF": "AUDCHF",
    "AUDNZD": "AUDNZD",

    # --- NZD Cross Pairs ---
    "NZDCAD": "NZDCAD",
    "NZDCHF": "NZDCHF",

    # --- CAD Cross Pairs ---
    "CADCHF": "CADCHF",
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

def save_to_firebase(data: Dict):
    """Data ko Firebase Realtime Database ke direct 'sentiment' node mein save karne ka function."""
    if not data:
        logger.warning("Firebase mein save karne ke liye koi data nahi mila.")
        return

    cred_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not cred_json:
        logger.error("FIREBASE_SERVICE_ACCOUNT variable GitHub secrets mein nahi mila!")
        return

    try:
        cred_dict = json.loads(cred_json)
        
        if not firebase_admin._apps:
            db_url = f"https://{cred_dict['project_id']}-default-rtdb.firebaseio.com/"
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred, {'databaseURL': db_url})
        
        # FIX: Purane node path par data overwrite karenge taake App foran pakad le
        ref = db.reference("sentiment")
        ref.set(data)
        logger.info("🔥 Data successfully saved to Firebase 'sentiment' Node!")
    except Exception as e:
        logger.error(f"Firebase mein save karte waqt error aaya: {e}")

def fetch_sentiment_data() -> Dict:
    logger.info("━━━ Fetching MentFX Daily Sentiment via GitHub Actions ━━━")
    session = tls_client.Session(client_identifier="chrome_120")
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive"
    })
    
    results = {}
    try:
        resp = session.get(MENTFX_VIEWER, timeout_seconds=20)
        logger.info(f"Page Response Status: {resp.status_code}")
        
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
            tables = soup.find_all("table")
            pct_re = re.compile(r"(\d+(?:\.\d+)?)")
            
            for table in tables:
                rows = table.find_all("tr")
                for row in rows:
                    cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
                    if not cells: continue
                    
                    # Pair dhundo
                    pair = None
                    pair_index = -1
                    for idx, cell in enumerate(cells):
                        mapped = _map_pair(cell)
                        if mapped:
                            pair = mapped
                            pair_index = idx
                            break
                    
                    if not pair: continue
                    
                    # ✅ DAILY column logic:
                    # Website mein structure: [SYMBOL] [INTRADAY_bear%] [INTRADAY_bull%] [DAILY_bear%] [DAILY_bull%]
                    # Hum sirf DAILY chahiye — isliye pair ke baad se saare numbers nikalo
                    # aur last 2 numbers lo (jo DAILY column ke hain)
                    numbers = []
                    for cell in cells[pair_index + 1:]:
                        match = pct_re.search(cell)
                        if match:
                            numbers.append(float(match.group(1)))
                    
                    # DAILY = last 2 numbers (INTRADAY = first 2, DAILY = last 2)
                    if len(numbers) >= 4:
                        daily_bear = numbers[2]
                        daily_bull = numbers[3]
                    elif len(numbers) == 2:
                        # Agar sirf 2 numbers hain to wahi le lo
                        daily_bear = numbers[0]
                        daily_bull = numbers[1]
                    else:
                        continue
                    
                    b_pct, bl_pct = _normalize(daily_bear, daily_bull)
                    results[pair] = {"bearish_pct": b_pct, "bullish_pct": bl_pct}
                    logger.info(f"✅ {pair} → Bear: {b_pct}% | Bull: {bl_pct}% (DAILY)")
                        
    except Exception as e:
        logger.error(f"HTML Parsing main error aaya: {e}")
        
    return results

if __name__ == "__main__":
    data = fetch_sentiment_data()
    print("\n📊 --- FINAL PARSED DATA (DAILY SENTIMENT) ---")
    print(json.dumps(data, indent=2))
    
    save_to_firebase(data)

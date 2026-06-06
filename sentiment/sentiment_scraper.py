"""
sentiment_scraper.py  —  ICI-SCANNER (Full Pairs Matrix + Column 2 DAILY Fix)
====================================================================
MentFX ke main table se INTRADAY skip karke exact DAILY column ka data
saare cross aur main pairs ke liye utha kar Firebase 'sentiment' node mein dalne wala script.
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

MENTFX_VIEWER = "https://mentfx.com/sentiment/"

# 📊 COMPLETE PAIRS MAPPING (Aapki App Ke Saare Pairs)
MENTFX_TO_APP: Dict[str, str] = {
    # Main Indices & Commodities
    "USOIL": "USOIL", "WTI": "USOIL", "XAGUSD": "XAGUSD", "SILVER": "XAGUSD",
    "XAUUSD": "XAUUSD", "GOLD": "XAUUSD", "BTCUSD": "BTCUSD", "ETHUSD": "ETHUSD",
    "US500": "US500", "SPX500": "US500", "SPX": "US500", "ES1!": "US500",
    "US100": "US100", "NAS100": "US100", "NASDAQ": "US100", "NQ1!": "US100", "QQQ": "US100",
    "US30": "US30", "DOW": "US30", "YM1!": "US30",
    "GER40": "GER40", "DAX": "GER40", "UK100": "UK100", "JPN225": "JPN225",
    
    # Forex Majors
    "EURUSD": "EURUSD", "GBPUSD": "GBPUSD", "USDJPY": "USDJPY", 
    "USDCHF": "USDCHF", "USDCAD": "USDCAD", "AUDUSD": "AUDUSD", "NZDUSD": "NZDUSD",
    
    # JPY Crosses
    "EURJPY": "EURJPY", "GBPJPY": "GBPJPY", "AUDJPY": "AUDJPY", 
    "NZDJPY": "NZDJPY", "CADJPY": "CADJPY", "CHFJPY": "CHFJPY",
    
    # GBP & EUR Crosses
    "EURGBP": "EURGBP", "EURAUD": "EURAUD", "EURCAD": "EURCAD", "EURCHF": "EURCHF",
    "GBPAUD": "GBPAUD", "GBPCAD": "GBPCAD", "GBPCHF": "GBPCHF",
    
    # Other Minors
    "AUDCAD": "AUDCAD", "AUDCHF": "AUDCHF", "AUDNZD": "AUDNZD",
    "NZDCAD": "NZDCAD", "NZDCHF": "NZDCHF", "CADCHF": "CADCHF"
}

def _map_pair(raw: str) -> Optional[str]:
    key = raw.strip().upper().replace(" ", "").replace("/", "")
    return MMENTFX_TO_APP.get(key, None)

def _normalize(a: float, b: float) -> Tuple[float, float]:
    total = a + b
    if total == 0: return 50.0, 50.0
    return round(a / total * 100, 2), round(b / total * 100, 2)

def save_to_firebase(data: Dict):
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
        
        ref = db.reference("sentiment")
        ref.set(data)
        logger.info("🔥 Live Matrix successfully saved to Firebase 'sentiment' Node!")
    except Exception as e:
        logger.error(f"Firebase mein save karte waqt error aaya: {e}")

def fetch_sentiment_data() -> Dict:
    logger.info("━━━ Fetching MentFX Full Table via GitHub Actions ━━━")
    session = tls_client.Session(client_identifier="chrome_120")
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
    })
    
    results = {}
    try:
        resp = session.get(MENTFX_VIEWER, timeout_seconds=20)
        if resp.status_code != 200:
            logger.error(f"Page Load Error: {resp.status_code}")
            return results
            
        soup = BeautifulSoup(resp.text, "html.parser")
        tables = soup.find_all("table")
        pct_re = re.compile(r"(\d+)")
        
        for table in tables:
            rows = table.find_all("tr")
            for row in rows:
                cells = row.find_all(["td", "th"])
                if len(cells) < 3: continue
                
                raw_pair = cells[0].get_text(strip=True)
                pair = _map_pair(raw_pair)
                if not pair: continue
                
                # Column 1 = Intraday, Column 2 = Daily (Humen Daily uthana hai)
                daily_cell = cells[2].get_text(strip=True)
                numbers = pct_re.findall(daily_cell)
                
                if len(numbers) >= 2:
                    bear_val = float(numbers[0])
                    bull_val = float(numbers[1])
                    b_pct, bl_pct = _normalize(bear_val, bull_val)
                    results[pair] = {"bearish_pct": b_pct, "bullish_pct": bl_pct}
                    
    except Exception as e:
        logger.error(f"HTML Parsing main error aaya: {e}")
        
    return results

if __name__ == "__main__":
    data = fetch_sentiment_data()
    print("\n📊 --- FULL MATRIX DAILY PARSED DATA ---")
    print(json.dumps(data, indent=2))
    save_to_firebase(data)

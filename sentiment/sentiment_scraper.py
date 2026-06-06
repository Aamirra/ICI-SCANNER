import os
import json
import re
import logging
import tls_client
import firebase_admin
from firebase_admin import credentials, db
from bs4 import BeautifulSoup
from typing import Dict, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

MENTFX_VIEWER = "https://mentfx.com/sentiment/"

# Mapping wahi hai, bas headers update kar diye hain
MENTFX_TO_APP = {
    "USOIL": "USOIL", "WTI": "USOIL", "XAGUSD": "XAGUSD", "SILVER": "XAGUSD",
    "XAUUSD": "XAUUSD", "GOLD": "XAUUSD", "BTCUSD": "BTCUSD", "ETHUSD": "ETHUSD",
    "US500": "US500", "SPX500": "US500", "SPX": "US500", "ES1!": "US500",
    "US100": "US100", "NAS100": "US100", "NASDAQ": "US100", "NQ1!": "US100", "QQQ": "US100",
    "US30": "US30", "DOW": "US30", "YM1!": "US30", "GER40": "GER40", "DAX": "GER40",
    "UK100": "UK100", "JPN225": "JPN225", "EURUSD": "EURUSD", "GBPUSD": "GBPUSD",
    "USDJPY": "USDJPY", "USDCHF": "USDCHF", "USDCAD": "USDCAD", "AUDUSD": "AUDUSD",
    "NZDUSD": "NZDUSD", "EURJPY": "EURJPY", "GBPJPY": "GBPJPY", "AUDJPY": "AUDJPY",
    "NZDJPY": "NZDJPY", "CADJPY": "CADJPY", "CHFJPY": "CHFJPY", "EURGBP": "EURGBP",
    "EURAUD": "EURAUD", "EURCAD": "EURCAD", "EURCHF": "EURCHF", "GBPAUD": "GBPAUD",
    "GBPCAD": "GBPCAD", "GBPCHF": "GBPCHF", "AUDCAD": "AUDCAD", "AUDCHF": "AUDCHF",
    "AUDNZD": "AUDNZD", "NZDCAD": "NZDCAD", "NZDCHF": "NZDCHF", "CADCHF": "CADCHF"
}

def fetch_sentiment_data() -> Dict:
    # 🕵️ Stealth Mode Headers
    session = tls_client.Session(client_identifier="chrome_120")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://mentfx.com/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1"
    }
    
    try:
        resp = session.get(MENTFX_VIEWER, headers=headers, timeout_seconds=30)
        logger.info(f"Status Code: {resp.status_code}")
        
        if resp.status_code != 200: return {}

        soup = BeautifulSoup(resp.text, "html.parser")
        # Logic yahan same hai, bas 403 bypass ho gaya
        results = {}
        for row in soup.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 3: continue
            pair_raw = cells[0].get_text(strip=True).upper().replace("/", "").replace(" ", "")
            mapped = MENTFX_TO_APP.get(pair_raw)
            if mapped:
                nums = re.findall(r"(\d+)", cells[2].get_text())
                if len(nums) >= 2:
                    t = float(nums[0]) + float(nums[1])
                    results[mapped] = {"bearish_pct": round(float(nums[0])/t*100, 2), "bullish_pct": round(float(nums[1])/t*100, 2)}
        return results
    except Exception as e:
        logger.error(f"Error: {e}")
        return {}

def save_to_firebase(data):
    # Firebase logic wahi purani hai, check kar lein FIREBASE_SERVICE_ACCOUNT sahi hai
    cred_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not cred_json: return
    cred_dict = json.loads(cred_json)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(cred_dict), {'databaseURL': f"https://{cred_dict['project_id']}-default-rtdb.firebaseio.com/"})
    db.reference("sentiment").set(data)
    logger.info("🔥 Data saved!")

if __name__ == "__main__":
    data = fetch_sentiment_data()
    if data: save_to_firebase(data)

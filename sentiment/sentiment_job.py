import os
import sys

# ============================================================
# STEP 1: Local packages folder ko sys.path mein SABSE PEHLE add karo
# ============================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_PACKAGES_DIR = os.path.join(SCRIPT_DIR, "packages")

if not os.path.exists(LOCAL_PACKAGES_DIR):
    print(f"[WARNING] Local packages directory nahi mili: {LOCAL_PACKAGES_DIR}")
else:
    print(f"[INFO] Local packages directory mili: {LOCAL_PACKAGES_DIR}")

if LOCAL_PACKAGES_DIR not in sys.path:
    sys.path.insert(0, LOCAL_PACKAGES_DIR)
    print(f"[INFO] sys.path mein add kiya: {LOCAL_PACKAGES_DIR}")

# ============================================================
# STEP 2: Third-party packages import karo
# ============================================================
try:
    import schedule
    print("[OK] schedule imported successfully")
except ImportError as e:
    print(f"[ERROR] schedule import failed: {e}")
    sys.exit(1)

try:
    import tls_client
    print("[OK] tls-client imported successfully")
except ImportError as e:
    print(f"[ERROR] tls-client import failed: {e}")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
    print("[OK] BeautifulSoup imported successfully")
except ImportError as e:
    print(f"[ERROR] beautifulsoup4 import failed: {e}")
    sys.exit(1)

try:
    import pandas as pd
    import yfinance as yf
    print("[OK] pandas & yfinance imported successfully for custom fallback")
except ImportError as e:
    print(f"[ERROR] pandas/yfinance import failed: {e}")
    sys.exit(1)

HAS_DOTENV = False
try:
    from dotenv import load_dotenv
    HAS_DOTENV = True
    print("[OK] dotenv imported successfully")
except ImportError as e:
    print("[INFO] dotenv library nahi mili. Render Environment variables use hongi.")

# ============================================================
# STEP 3: Standard Library Imports
# ============================================================
import time
import json
import logging

# ============================================================
# STEP 4: Project ke Custom Modules Import karo
# ============================================================
try:
    from sentiment_db import upsert_sentiment
    print("[OK] sentiment_db (Firebase bridge) imported successfully")
except ImportError as e:
    print(f"[ERROR] sentiment_db import failed: {e}")
    sys.exit(1)

try:
    from sentiment_scraper import fetch_sentiment_data
    print("[OK] sentiment_scraper imported successfully")
except ImportError as e:
    print(f"[ERROR] sentiment_scraper import failed: {e}")
    sys.exit(1)

# ============================================================
# STEP 5: Environment Variables Load karo
# ============================================================
if HAS_DOTENV:
    load_dotenv()
    print("[OK] Environment variables load ho gayi (.env file se)")
else:
    print("[OK] Native Render Environment variables active hain")

# ============================================================
# STEP 6: Logging Setup
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger('sentiment_job')

# ============================================================
# FIXED WHITELIST & CUSTOM FALLBACK MAP (Crypto & Extra Assets)
# ============================================================
WHITELIST_PAIRS = [
    'AUDCAD', 'AUDCHF', 'AUDJPY', 'AUDNZD', 'AUDUSD', 'BTCUSD',
    'CADCHF', 'CADJPY', 'CHFJPY', 'ETHUSD', 'EURAUD', 'CAD',
    'EURCHF', 'EURGBP', 'EURJPY', 'EURUSD', 'GBPAUD', 'GBPCAD',
    'GBPCHF', 'GBPJPY', 'GBPUSD', 'GER40', 'JPN225', 'NZDCAD',
    'NZDCHF', 'NZDJPY', 'NZDUSD', 'UK100', 'US100', 'US300',
    'US500', 'USDCAD', 'USDCHF', 'USDJPY', 'USOIL', 'XAUUSD'
]

# Jo symbols web scraper se nahi aate, unke liye custom yfinance tickers
CUSTOM_FALLBACK_ASSETS = {
    "BTC": "BTC-USD",
    "ETH": "ETH-USD",
    "SOL": "SOL-USD",
    "BNB": "BNB-USD",
    "TSLA": "TSLA",
    "AAPL": "AAPL"
}

# ============================================================
# STEP 7: Custom MTF EMA Calculation Logic (Fallback Engine)
# ============================================================
def calc_window_score(df, lookback_bars):
    df["EMA10"] = df["Close"].ewm(span=10, adjust=False).mean()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["SMA50"] = df["Close"].rolling(window=50).mean()
    df = df.dropna()

    if len(df) < lookback_bars: 
        return 0.5
    
    window = df.tail(lookback_bars)
    total_points = len(window) * 3
    earned_points = 0

    for _, row in window.iterrows():
        if row["Close"] > row["EMA10"]: earned_points += 1
        if row["EMA10"] > row["EMA20"]: earned_points += 1
        if row["EMA20"] > row["SMA50"]: earned_points += 1

    return earned_points / total_points

def get_custom_sentiment(ticker_symbol):
    try:
        ticker = yf.Ticker(ticker_symbol)
        df_15m = ticker.history(period="5d", interval="15m")
        df_1h  = ticker.history(period="1mo", interval="1h")
        df_1d  = ticker.history(period="1y", interval="1d")

        if df_15m.empty or df_1h.empty or df_1d.empty: 
            return None

        score_15m = calc_window_score(df_15m, 32)
        score_1h  = calc_window_score(df_1h, 24)
        score_1d  = calc_window_score(df_1d, 14)

        intra_green = round(((score_15m * 0.4) + (score_1h * 0.6)) * 100)
        
        return {
            "bearish_pct": 100 - intra_green,
            "bullish_pct": intra_green
        }
    except Exception:
        return None

# ============================================================
# STEP 8: Main Sentiment Job Logic (With Safe Merge)
# ============================================================
def run_job():
    logger.info("══════════ Sentiment Job START ══════════")
    try:
        logger.info(f"Whitelist [{len(WHITELIST_PAIRS)}]: {sorted(WHITELIST_PAIRS)}")

        # 1. Live market data scrape karo (tls-client ke zariye)
        scraped = fetch_sentiment_data()
        if not scraped:
            logger.warning("Scraper se direct data nahi mila. Fallback mode par chal rahe hain.")
            scraped = {}

        saved = 0
        skipped = 0
        processed_pairs = set()

        # 2. Whitelisted Scraped Data ko Process karo
        for pair, data in scraped.items():
            if pair in WHITELIST_PAIRS:
                upsert_sentiment(
                    pair, data['bearish_pct'], data['bullish_pct']
                )
                logger.info(
                    f"  ✓ [Web] {pair:<10} | "
                    f"Bear: {data['bearish_pct']}% "
                    f"Bull: {data['bullish_pct']}%"
                )
                saved += 1
                processed_pairs.add(pair)
            else:
                skipped += 1

        # 3. Custom Fallback Assets (Crypto/Stocks) ko Process karo (Jo web pe nahi thay)
        logger.info("--- Processing Custom Fallback Assets (Crypto/Stocks) ---")
        for pair, ticker in CUSTOM_FALLBACK_ASSETS.items():
            if pair not in scraped and pair not in processed_pairs:
                custom_data = get_custom_sentiment(ticker)
                if custom_data:
                    upsert_sentiment(
                        pair, custom_data['bearish_pct'], custom_data['bullish_pct']
                    )
                    logger.info(
                        f"  ⚙ [Custom] {pair:<10} | "
                        f"Bear: {custom_data['bearish_pct']}% "
                        f"Bull: {custom_data['bullish_pct']}%"
                    )
                    saved += 1
                else:
                    logger.error(f"  ❌ Custom data fetch failed for {pair}")

        logger.info(
            f"══════════ Done — "
            f"Saved: {saved} | "
            f"Skipped: {skipped} ══════════"
        )
    except Exception as e:
        logger.error(f"Error aaya job run mein: {e}", exc_info=True)

# ============================================================
# STEP 9: Entry Point
# ============================================================
if __name__ == "__main__":
    logger.info("------------------------------------------")
    logger.info("  Python Sentiment Job Script Start Hua   ")
    logger.info("------------------------------------------")
    logger.info(f"Python Version : {sys.version}")
    logger.info(f"Script Dir     : {SCRIPT_DIR}")
    logger.info(f"Packages Dir   : {LOCAL_PACKAGES_DIR}")

    logger.info("[OK] SQL Database check bypassed successfully.")

    # Pehli baar turant run karo
    logger.info("Pehla run abhi kar rahe hain...")
    run_job()

    # Scheduled: Har 2.5 ghante baad automatic chalega (150 minutes)
    schedule.every(150).minutes.do(run_job)
    logger.info("Scheduled: Har 2.5 ghante baad automatic chalega")

    # Infinite loop - scheduler active rakhne ke liye
    while True:
        schedule.run_pending()
        time.sleep(1)

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
    import cloudscraper
    print("[OK] cloudscraper imported successfully")
except ImportError as e:
    print(f"[ERROR] cloudscraper import failed: {e}")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
    print("[OK] BeautifulSoup imported successfully")
except ImportError as e:
    print(f"[ERROR] beautifulsoup4 import failed: {e}")
    sys.exit(1)

HAS_DOTENV = False
try:
    from dotenv import load_dotenv
    HAS_DOTENV = True
    print("[OK] dotenv imported successfully")
except ImportError as e:
    print("[INFO] dotenv library nahi mili. Render Environment variables use hongi. No problem!")

# ============================================================
# STEP 3: Standard Library Imports
# ============================================================
import time
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
# FIXED WHITELIST (Database dependency hamesha ke liye khatam)
# ============================================================
WHITELIST_PAIRS = [
    'AUDCAD', 'AUDCHF', 'AUDJPY', 'AUDNZD', 'AUDUSD', 'BTCUSD',
    'CADCHF', 'CADJPY', 'CHFJPY', 'ETHUSD', 'EURAUD', 'EURCAD',
    'EURCHF', 'EURGBP', 'EURJPY', 'EURUSD', 'GBPAUD', 'GBPCAD',
    'GBPCHF', 'GBPJPY', 'GBPUSD', 'GER40', 'JPN225', 'NZDCAD',
    'NZDCHF', 'NZDJPY', 'NZDUSD', 'UK100', 'US100', 'US300',
    'US500', 'USDCAD', 'USDCHF', 'USDJPY', 'USOIL', 'XAUUSD'
]

# ============================================================
# STEP 7: Main Sentiment Job Logic
# ============================================================
def run_job():
    logger.info("══════════ Sentiment Job START ══════════")
    try:
        logger.info(f"Whitelist [{len(WHITELIST_PAIRS)}]: {sorted(WHITELIST_PAIRS)}")

        # Live market data scrape karo
        scraped = fetch_sentiment_data()
        if not scraped:
            logger.error("Scraper se koi data nahi aaya. Job abort.")
            return

        # Sirf whitelisted pairs ko process karo
        saved = 0
        skipped = 0
        for pair, data in scraped.items():
            if pair in WHITELIST_PAIRS:
                upsert_sentiment(
                    pair, data['bearish_pct'], data['bullish_pct']
                )
                logger.info(
                    f"  ✓ {pair:<10} | "
                    f"Bear: {data['bearish_pct']}% "
                    f"Bull: {data['bullish_pct']}%"
                )
                saved += 1
            else:
                skipped += 1

        logger.info(
            f"══════════ Done — "
            f"Saved: {saved} | "
            f"Skipped: {skipped} ══════════"
        )
    except Exception as e:
        logger.error(f"Error aaya job run mein: {e}", exc_info=True)

# ============================================================
# STEP 8: Entry Point
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

    # ✅ CHANGED: 5 minutes → 1 hour
    schedule.every(1).hours.do(run_job)
    logger.info("Scheduled: Har 1 ghante baad automatic chalega")

    # Infinite loop - scheduler active rakhne ke liye
    while True:
        schedule.run_pending()
        time.sleep(1)

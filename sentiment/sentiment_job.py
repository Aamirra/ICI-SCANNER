import os
import sys

# ============================================================
# STEP 1: Local packages folder ko sys.path mein add karo
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
# STEP 2: Packages import karo (FIXED - No crash)
# ============================================================
try:
    import schedule
    print(f"[OK] schedule imported successfully")
except ImportError as e:
    print(f"[ERROR] schedule import failed: {e}")
    sys.exit(1)

try:
    import cloudscraper
    print(f"[OK] cloudscraper imported successfully")
except ImportError as e:
    print(f"[ERROR] cloudscraper import failed: {e}")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
    print(f"[OK] BeautifulSoup imported successfully")
except ImportError as e:
    print(f"[ERROR] beautifulsoup4 import failed: {e}")
    sys.exit(1)

# ============================================================
# STEP 3: Standard & Custom Project Imports (ICI SCANNER)
# ============================================================
import time
import logging
from dotenv import load_dotenv

# Aapke original database aur scraper modules
from sentiment_db import create_sentiment_table, get_existing_pairs, upsert_sentiment
from sentiment_scraper import fetch_sentiment_data

load_dotenv()

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger('sentiment_job')

# ============================================================
# STEP 4: Asli Sentiment Job Logic
# ============================================================
def run_job():
    logger.info("══════════ Sentiment Job START ══════════")
    try:
        # Step 1: Database se allowed pairs uthao
        existing_pairs = get_existing_pairs()
        if not existing_pairs:
            logger.warning("Database mein koi pairs nahi mili. Job abort.")
            return
        logger.info(f"Whitelist [{len(existing_pairs)}]: {sorted(existing_pairs)}")

        # Step 2: Live market data scrape karo
        scraped = fetch_sentiment_data()
        if not scraped:
            logger.error("Scraper se koi data nahi aaya. Job abort.")
            return

        # Step 3: Sirf whitelisted pairs ko database mein save karo
        saved = skipped = 0
        for pair, data in scraped.items():
            if pair in existing_pairs:
                upsert_sentiment(pair, data['bearish_pct'], data['bullish_pct'])
                logger.info(f"  ✓ {pair:<10} | Bear: {data['bearish_pct']}%  Bull: {data['bullish_pct']}%")
                saved += 1
            else:
                skipped += 1
                
        logger.info(f"══════════ Done — Saved: {saved} | Skipped: {skipped} ══════════")
    except Exception as e:
        logger.error(f"Error aaya job run mein: {e}", exc_info=True)

# ============================================================
# STEP 5: Automation Script Entry Point
# ============================================================
if __name__ == "__main__":
    logger.info("------------------------------------------")
    logger.info(" Python Sentiment Job Script Start Hua ")
    logger.info("------------------------------------------")
    
    # DB Table structure automatic check/create karo
    create_sentiment_table()
    
    # Pehli baar script chalte hi turant live data fetch karo
    run_job()

    # Har 5 minute baad background mein automatic chalao
    schedule.every(5).minutes.do(run_job)
    logger.info("Scheduled: har 5 minute baad automatic chalega.")

    # Infinite loop scheduler ko active rakhne ke liye
    while True:
        schedule.run_pending()
        time.sleep(1)

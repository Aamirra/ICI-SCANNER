import sys
import os

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
# STEP 2: Packages import karo (FIXED - no __version__ for schedule)
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
# STEP 3: Standard library imports
# ============================================================

import time
import json
import logging
import threading
from datetime import datetime

# ============================================================
# STEP 4: Logging setup
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

# ============================================================
# STEP 5: Apna actual sentiment job logic
# ============================================================

def scrape_and_analyze():
    """
    Main scraping aur sentiment analysis function
    """
    logger.info("=" * 50)
    logger.info("Sentiment Job Start Hua")
    logger.info("=" * 50)

    try:
        # CloudScraper instance banao
        scraper = cloudscraper.create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'mobile': False
            }
        )

        # Apni target URL yahan daalo
        TARGET_URL = os.getenv("SCRAPE_URL", "https://example.com")

        logger.info(f"Scraping URL: {TARGET_URL}")

        response = scraper.get(TARGET_URL, timeout=30)

        if response.status_code == 200:
            logger.info(f"Response mila - Status: {response.status_code}")

            # BeautifulSoup se HTML parse karo
            soup = BeautifulSoup(response.text, "html.parser")

            # Page title nikalo
            title = soup.find("title")
            if title:
                logger.info(f"Page Title: {title.get_text()}")

            # ------------------------------------------------
            # TODO: Apna sentiment logic yahan add karo
            # Example:
            # articles = soup.find_all("article")
            # for article in articles:
            #     text = article.get_text()
            #     sentiment_score = analyze_sentiment(text)
            #     save_to_db(sentiment_score)
            # ------------------------------------------------

            logger.info("Scraping successfully complete hua!")
            return True

        else:
            logger.error(f"Scraping failed - Status Code: {response.status_code}")
            return False

    except Exception as e:
        logger.error(f"Error aaya: {e}", exc_info=True)
        return False


# ============================================================
# STEP 6: Scheduler setup
# ============================================================

def run_scheduler():
    """
    Schedule setup aur infinite loop
    """
    logger.info("Scheduler initialize ho raha hai...")

    # Har 30 minute mein run karo
    schedule.every(30).minutes.do(scrape_and_analyze)

    # Agar specific time chahiye toh yeh use karo:
    # schedule.every().day.at("09:00").do(scrape_and_analyze)
    # schedule.every().hour.do(scrape_and_analyze)

    logger.info("Schedule set - Har 30 minute mein chalega")

    # Pehli baar abhi turant run karo
    logger.info("Pehla run abhi kar rahe hain...")
    scrape_and_analyze()

    # Infinite loop
    while True:
        schedule.run_pending()
        time.sleep(60)


# ============================================================
# STEP 7: Entry point
# ============================================================

if __name__ == "__main__":
    logger.info("------------------------------------------")
    logger.info("  Python Sentiment Job Script Start Hua   ")
    logger.info("------------------------------------------")
    logger.info(f"Python Version : {sys.version}")
    logger.info(f"Script Location: {SCRIPT_DIR}")
    logger.info(f"Packages Path  : {LOCAL_PACKAGES_DIR}")

    try:
        run_scheduler()
    except KeyboardInterrupt:
        logger.info("Script manually stop kiya (Ctrl+C)")
    except Exception as e:
        logger.critical(f"Script crash: {e}", exc_info=True)
        sys.exit(1)

import sys
import os

# ============================================================
# STEP 1: Local packages folder ko sys.path mein add karo
# Yeh SABSE PEHLE hona chahiye, kisi bhi import se pehle
# ============================================================

# Current script ki directory nikalo
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Local packages folder ka full path banao
# sentiment/sentiment_job.py -> sentiment/packages/
LOCAL_PACKAGES_DIR = os.path.join(SCRIPT_DIR, "packages")

# Path exist karta hai ya nahi check karo
if not os.path.exists(LOCAL_PACKAGES_DIR):
    print(f"[WARNING] Local packages directory nahi mili: {LOCAL_PACKAGES_DIR}")
    print(f"[WARNING] Build command run karo: pip install schedule cloudscraper beautifulsoup4 --target=./sentiment/packages")
else:
    print(f"[INFO] Local packages directory mili: {LOCAL_PACKAGES_DIR}")

# sys.path mein SABSE PEHLE insert karo (index 0)
# index 0 pe isliye taake system packages se pehle yahan check ho
if LOCAL_PACKAGES_DIR not in sys.path:
    sys.path.insert(0, LOCAL_PACKAGES_DIR)
    print(f"[INFO] sys.path mein add kiya: {LOCAL_PACKAGES_DIR}")

# ============================================================
# STEP 2: Ab safely import karo
# ============================================================

try:
    import schedule
    print(f"[OK] schedule imported - version: {schedule.__version__}")
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
    print(f"[OK] BeautifulSoup (bs4) imported successfully")
except ImportError as e:
    print(f"[ERROR] beautifulsoup4 (bs4) import failed: {e}")
    sys.exit(1)

# Standard library imports (yeh hamesha available hote hain)
import time
import json
import logging
from datetime import datetime

# ============================================================
# STEP 3: Logging setup karo
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

# ============================================================
# STEP 4: Apna actual sentiment job logic likho
# ============================================================

def scrape_and_analyze():
    """
    Main function jo scraping aur sentiment analysis karti hai
    """
    logger.info("=" * 50)
    logger.info("Sentiment Job Start Hua")
    logger.info("=" * 50)
    
    try:
        # CloudScraper use karo (Cloudflare bypass ke liye)
        scraper = cloudscraper.create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'mobile': False
            }
        )
        
        # Example: Koi bhi news/sentiment site scrape karo
        # Apni actual URL yahan daalo
        TARGET_URL = os.getenv("SCRAPE_URL", "https://example.com")
        
        logger.info(f"Scraping URL: {TARGET_URL}")
        
        response = scraper.get(TARGET_URL, timeout=30)
        
        if response.status_code == 200:
            logger.info(f"Response mila - Status: {response.status_code}")
            
            # BeautifulSoup se HTML parse karo
            soup = BeautifulSoup(response.text, "html.parser")
            
            # Example: Page title nikalo
            title = soup.find("title")
            if title:
                logger.info(f"Page Title: {title.get_text()}")
            
            # TODO: Apna actual sentiment logic yahan add karo
            # Example:
            # articles = soup.find_all("article")
            # for article in articles:
            #     text = article.get_text()
            #     sentiment_score = analyze_sentiment(text)
            #     save_to_db(sentiment_score)
            
            logger.info("Scraping successful!")
            return True
            
        else:
            logger.error(f"Scraping failed - Status Code: {response.status_code}")
            return False
            
    except cloudscraper.exceptions.CloudflareException as e:
        logger.error(f"Cloudflare block hua: {e}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return False


def run_scheduler():
    """
    Schedule setup aur infinite loop
    """
    logger.info("Scheduler initialize ho raha hai...")
    
    # Har 30 minute mein run karo
    schedule.every(30).minutes.do(scrape_and_analyze)
    
    # Ya specific time pe:
    # schedule.every().day.at("09:00").do(scrape_and_analyze)
    # schedule.every().hour.do(scrape_and_analyze)
    
    logger.info("Schedule set ho gaya - Har 30 minute mein chalega")
    
    # Pehli baar turant run karo (wait mat karo)
    logger.info("Pehla run abhi kar rahe hain...")
    scrape_and_analyze()
    
    # Infinite loop - scheduled jobs ke liye
    while True:
        schedule.run_pending()
        time.sleep(60)  # Har 60 second mein check karo


# ============================================================
# STEP 5: Entry point
# ============================================================

if __name__ == "__main__":
    logger.info("Python Sentiment Job Script Start")
    logger.info(f"Python Version: {sys.version}")
    logger.info(f"Script Location: {SCRIPT_DIR}")
    logger.info(f"Packages Location: {LOCAL_PACKAGES_DIR}")
    logger.info(f"sys.path: {sys.path[:3]}...")  # Pehle 3 paths dikhao
    
    try:
        run_scheduler()
    except KeyboardInterrupt:
        logger.info("Script manually stop kiya gaya (Ctrl+C)")
    except Exception as e:
        logger.critical(f"Script crash ho gaya: {e}", exc_info=True)
        sys.exit(1)

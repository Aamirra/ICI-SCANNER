import logging
import schedule
import time
from dotenv import load_dotenv

from sentiment_db import create_sentiment_table, get_existing_pairs, upsert_sentiment
from sentiment_scraper import fetch_sentiment_data

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger('sentiment_job')


def run_job():
    logger.info("══════════ Sentiment Job START ══════════")

    # Step 1: Whitelist — sirf yeh pairs save honge
    existing_pairs = get_existing_pairs()
    if not existing_pairs:
        logger.warning("Database mein koi pairs nahi mili. Job abort.")
        return
    logger.info(f"Whitelist [{len(existing_pairs)}]: {sorted(existing_pairs)}")

    # Step 2: Mentfx scrape
    scraped = fetch_sentiment_data()
    if not scraped:
        logger.error("Scraper se koi data nahi aaya. Job abort.")
        return

    # Step 3: Sirf whitelisted pairs save karo, baaki skip
    saved = skipped = 0
    for pair, data in scraped.items():
        if pair in existing_pairs:
            upsert_sentiment(pair, data['bearish_pct'], data['bullish_pct'])
            logger.info(
                f"  ✓ {pair:<10} | Bear: {data['bearish_pct']}%"
                f"  Bull: {data['bullish_pct']}%"
            )
            saved += 1
        else:
            logger.debug(f"  ✗ Skipped (not in app): {pair}")
            skipped += 1

    logger.info(f"══════════ Done — Saved: {saved} | Skipped: {skipped} ══════════")


if __name__ == '__main__':
    logger.info("Sentiment Worker booting...")

    # Startup par table banao (agar pehle se nahi hai)
    create_sentiment_table()

    # Pehli baar turant chalao
    run_job()

    # Timing 1 hour se badal kar 5 minutes kar di hai
    schedule.every(5).minutes.do(run_job)
    logger.info("Scheduled: every 5 minutes.")

    while True:
        schedule.run_pending()
        time.sleep(1) # 1 second sleep taake schedule missing na ho

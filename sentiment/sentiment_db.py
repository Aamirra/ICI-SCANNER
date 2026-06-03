import os
import logging
import psycopg2
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# Agar aapke 'pairs' table mein pair column ka naam 'pair' nahi
# balke 'symbol' ya kuch aur hai, toh yahan change karo.
# ---------------------------------------------------------------
PAIRS_SYMBOL_COLUMN = 'pair'


def _get_conn():
    """Returns a new PostgreSQL connection."""
    url = os.environ.get('DATABASE_URL', '')
    # Render ke URLs kabhi kabhi 'postgres://' se shuru hote hain;
    # psycopg2 ko 'postgresql://' chahiye.
    if url.startswith('postgres://'):
        url = url.replace('postgres://', 'postgresql://', 1)
    return psycopg2.connect(url)


def create_sentiment_table():
    """
    Ek baar chalta hai startup par.
    'sentiment' table nahi hai toh banata hai.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS sentiment (
                    pair         VARCHAR(20)  PRIMARY KEY,
                    bearish_pct  NUMERIC(5,2) NOT NULL,
                    bullish_pct  NUMERIC(5,2) NOT NULL,
                    updated_at   TIMESTAMPTZ  DEFAULT NOW()
                );
            """)
            conn.commit()
            logger.info("sentiment table is ready.")
    except Exception as e:
        logger.error(f"create_sentiment_table error: {e}")
        conn.rollback()
    finally:
        conn.close()


def get_existing_pairs() -> set:
    """
    'pairs' table se sare pair names fetch karta hai.
    Yeh whitelist hai — scraper sirf inhi ko save karega.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f'SELECT DISTINCT "{PAIRS_SYMBOL_COLUMN}" FROM pairs')
            rows = cur.fetchall()
            return {row[0].strip().upper() for row in rows if row[0]}
    except Exception as e:
        logger.error(f"get_existing_pairs error: {e}")
        return set()
    finally:
        conn.close()


def upsert_sentiment(pair: str, bearish_pct: float, bullish_pct: float):
    """
    Pair exist kare toh UPDATE, nahi kare toh INSERT.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO sentiment (pair, bearish_pct, bullish_pct, updated_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT (pair) DO UPDATE SET
                    bearish_pct = EXCLUDED.bearish_pct,
                    bullish_pct = EXCLUDED.bullish_pct,
                    updated_at  = EXCLUDED.updated_at;
            """, (pair, round(bearish_pct, 2), round(bullish_pct, 2)))
            conn.commit()
    except Exception as e:
        logger.error(f"upsert_sentiment failed for {pair}: {e}")
        conn.rollback()
    finally:
        conn.close()

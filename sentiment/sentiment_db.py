# sentiment_db.py

import os
import logging
import psycopg2
import json
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# Firebase Initialization
# ---------------------------------------------------------------
if not firebase_admin._apps:
    try:
        cred_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
        if cred_json:
            cred_dict = json.loads(cred_json)
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred, {
                'databaseURL': 'https://fatima-16b38-default-rtdb.firebaseio.com'
            })
            logger.info("Firebase initialized successfully.")
    except Exception as e:
        logger.error(f"Firebase init error: {e}")

# ---------------------------------------------------------------
PAIRS_SYMBOL_COLUMN = 'pair'

DEFAULT_PAIRS = [
    'USOIL',
    'US500', 'US100', 'US30',
    'GER40', 'UK100', 'JPN225',
    'EURUSD', 'GBPUSD', 'USDJPY',
    'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
    'EURJPY', 'GBPJPY', 'AUDJPY',
    'NZDJPY', 'CADJPY', 'CHFJPY',
    'EURGBP', 'EURAUD', 'EURCAD', 'EURCHF',
    'GBPAUD', 'GBPCAD', 'GBPCHF',
    'AUDCAD', 'AUDCHF', 'AUDNZD',
    'NZDCAD', 'NZDCHF', 'CADCHF',
    'XAUUSD', 'BTCUSD', 'ETHUSD'
]

# ---------------------------------------------------------------

def _get_conn():
    """Database connection banata hai."""
    url = os.environ.get('DATABASE_URL', '')
    if url.startswith('postgres://'):
        url = url.replace('postgres://', 'postgresql://', 1)
    return psycopg2.connect(url)


def initialize_database():
    """
    Scanner start hotay hi SABSE PEHLE yeh call karo.
    Ek hi connection mein:
      1. pairs table create karta hai
      2. Default pairs insert karta hai (agar table khali ho)
      3. sentiment table create karta hai
    Sab kuch ek commit mein — koi table miss nahi hogi.
    """
    logger.info("═══ Database initialization shuru ═══")
    conn = _get_conn()
    try:
        with conn.cursor() as cur:

            # --- Step 1: pairs table ---
            cur.execute("""
                CREATE TABLE IF NOT EXISTS pairs (
                    id   SERIAL      PRIMARY KEY,
                    pair VARCHAR(20) UNIQUE NOT NULL
                );
            """)
            logger.info("pairs table: check/create done.")

            # --- Step 2: Default pairs insert (agar table khali ho) ---
            cur.execute("SELECT COUNT(*) FROM pairs;")
            count = cur.fetchone()[0]

            if count == 0:
                logger.info("pairs table khali hai — default pairs insert ho rahe hain...")
                for pair in DEFAULT_PAIRS:
                    cur.execute(
                        """
                        INSERT INTO pairs (pair)
                        VALUES (%s)
                        ON CONFLICT (pair) DO NOTHING;
                        """,
                        (pair,)
                    )
                logger.info(f"{len(DEFAULT_PAIRS)} pairs successfully insert ho gaye.")
            else:
                logger.info(f"pairs table mein pehle se {count} records hain.")

            # --- Step 3: sentiment table ---
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sentiment (
                    pair        VARCHAR(20)  PRIMARY KEY,
                    bearish_pct NUMERIC(5,2) NOT NULL,
                    bullish_pct NUMERIC(5,2) NOT NULL,
                    updated_at  TIMESTAMPTZ  DEFAULT NOW()
                );
            """)
            logger.info("sentiment table: check/create done.")

            # --- Single commit — dono tables guaranteed ---
            conn.commit()
            logger.info("═══ Database initialization complete ═══")

    except Exception as e:
        logger.error(f"initialize_database FAILED: {e}")
        conn.rollback()
        raise  # Upar propagate karo taake app crash kare, silently aage na jaye
    finally:
        conn.close()


def get_existing_pairs() -> set:
    """
    pairs table se saare valid pairs fetch karta hai.
    initialize_database() ke BAAD hi call karo.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f'SELECT DISTINCT "{PAIRS_SYMBOL_COLUMN}" FROM pairs;')
            rows = cur.fetchall()
            pairs = {row[0].strip().upper() for row in rows if row[0]}
            logger.debug(f"get_existing_pairs: {len(pairs)} pairs mili hain.")
            return pairs
    except Exception as e:
        logger.error(f"get_existing_pairs error: {e}")
        return set()
    finally:
        conn.close()


def upsert_sentiment(pair: str, bearish_pct: float, bullish_pct: float):
    """
    Sentiment data save karta hai:
    - PostgreSQL mein upsert
    - Firebase mein set
    """
    # 1. PostgreSQL
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
            logger.debug(f"PostgreSQL updated: {pair} → bear={bearish_pct} bull={bullish_pct}")
    except Exception as e:
        logger.error(f"upsert_sentiment PostgreSQL failed [{pair}]: {e}")
        conn.rollback()
    finally:
        conn.close()

    # 2. Firebase
    try:
        if firebase_admin._apps:
            ref = db.reference(f'sentiment/{pair}')
            ref.set({
                'bearish_pct': round(bearish_pct, 2),
                'bullish_pct': round(bullish_pct, 2)
            })
            logger.debug(f"Firebase updated: {pair}")
    except Exception as e:
        logger.error(f"Firebase update failed [{pair}]: {e}")

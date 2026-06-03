import os
import logging
import psycopg2
import json
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# --- Firebase Initialization ---
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

def _get_conn():
    url = os.environ.get('DATABASE_URL', '')
    if url.startswith('postgres://'):
        url = url.replace('postgres://', 'postgresql://', 1)
    return psycopg2.connect(url)

def create_sentiment_table():
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
    # 1. PostgreSQL Update
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

    # 2. Firebase Update
    try:
        if firebase_admin._apps:
            ref = db.reference(f'sentiment/{pair}')
            ref.set({
                'bearish_pct': round(bearish_pct, 2),
                'bullish_pct': round(bullish_pct, 2)
            })
    except Exception as e:
        logger.error(f"Firebase update failed for {pair}: {e}")

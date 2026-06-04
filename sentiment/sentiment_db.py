import os
import logging
import json
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# ===============================================================
# Firebase Initialization (Lifetime Free Cloud Storage)
# ===============================================================
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
        else:
            logger.warning("[WARNING] FIREBASE_SERVICE_ACCOUNT variable nahi mila.")
    except Exception as e:
        logger.error(f"Firebase init error: {e}")

# ===============================================================
# Main Execution Function (Only Firebase)
# ===============================================================
def upsert_sentiment(pair: str, bearish_pct: float, bullish_pct: float):
    """
    Sentiment data save karta hai.
    [POSTGRESQL COMPLETELY REMOVED] - Ab data sirf Firebase mein jayega.
    """
    try:
        if firebase_admin._apps:
            ref = db.reference(f'sentiment/{pair}')
            ref.set({
                'bearish_pct': round(bearish_pct, 2),
                'bullish_pct': round(bullish_pct, 2)
            })
            logger.debug(f"Firebase updated successfully: {pair}")
        else:
            logger.error(f"Firebase initialization miss hai. Data NOT saved for {pair}")
    except Exception as e:
        logger.error(f"Firebase update failed [{pair}]: {e}")

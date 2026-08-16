import time
import requests
import yfinance as yf
import pandas as pd

CRYPTO_SYMBOLS = [
    "BTCUSD", "ETHUSD", "LTCUSD", "BCHUSD", "XRPUSD", "ADAUSD",
    "DOTUSD", "LINKUSD", "UNIUSD", "SOLUSD", "MATICUSD", "AVAXUSD",
    "ATOMUSD", "FILUSD", "VETUSD", "ETCUSD", "TRXUSD", "XLMUSD",
    "ICPUSD", "THETAUSD", "XTZUSD", "EOSUSD", "SANDUSD", "MANAUSD",
    "DOGEUSD", "SHIBUSD", "PEPEUSD", "BONKUSD", "FLOKIUSD", "WIFUSD",
    "GRTUSD", "ENJUSD", "CHZUSD", "BATUSD", "ZRXUSD", "OMGUSD",
    "DASHUSD", "ZECUSD", "BTGUSD", "DCRUSD", "XVGUSD", "SCUSD",
    "SNXUSD", "COMPUSD", "MKRUSD", "AAVEUSD", "YFIUSD", "SUSHIUSD",
    "CRVUSD", "RENUSD", "KNCUSD", "BANDUSD", "NMRUSD", "OCEANUSD",
    "FETUSD", "AGIXUSD", "BNBUSD", "CAKEUSD", "RUNEUSD", "ALGOUSD",
    "NEARUSD", "FLOWUSD", "APTUSD", "OPUSD", "ARBUSD", "SUIUSD",
    "INJUSD", "TIAUSD", "SEIUSD", "BLURUSD", "PYTHUSD", "JTOUSD",
    "ORDIUSD", "1000SATSUSD", "BEAMUSD", "RNDRUSD", "IMXUSD", "MINAUSD",
    "GALAUSD", "AXSUSD", "APEUSD", "ENSUSD", "LDOUSD", "STXUSD",
    "CFXUSD", "KLAYUSD", "FTMUSD", "HBARUSD", "EGLDUSD", "QNTUSD",
    "ARUSD", "ZILUSD", "KSMUSD", "ANTUSD", "IOTXUSD", "CELOUSD",
    "ANKRUSD", "SKLUSD", "SPELLUSD", "JOEUSD", "GMXUSD", "PENDLEUSD",
    "SSVUSD", "FXSUSD", "LQTYUSD", "MASKUSD"
]

def get_yf_ticker(symbol):
    if symbol == "1000SATSUSD":
        return "1000SATS-USD"
    return symbol.replace("USD", "-USD")

def calc_window_score(df, lookback_bars):
    df = df.copy()
    df["EMA10"] = df["Close"].ewm(span=10, adjust=False).mean()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["SMA50"] = df["Close"].rolling(window=50).mean()
    df = df.dropna()
    if len(df) < lookback_bars:
        return None
    window = df.tail(lookback_bars)
    total_points = len(window) * 3
    earned_points = 0
    for _, row in window.iterrows():
        if row["Close"] > row["EMA10"]:
            earned_points += 1
        if row["EMA10"] > row["EMA20"]:
            earned_points += 1
        if row["EMA20"] > row["SMA50"]:
            earned_points += 1
    return earned_points / total_points

def get_custom_sentiment(symbol):
    ticker = get_yf_ticker(symbol)
    try:
        t = yf.Ticker(ticker)
        df_15m = t.history(period="5d", interval="15m")
        df_1h = t.history(period="1mo", interval="1h")
        df_1d = t.history(period="1y", interval="1d")
        if df_15m.empty or df_1h.empty or df_1d.empty:
            return None
        score_15m = calc_window_score(df_15m, 32)
        score_1h = calc_window_score(df_1h, 24)
        score_1d = calc_window_score(df_1d, 14)
        if score_15m is None or score_1h is None or score_1d is None:
            return None
        intra_green = round(((score_15m * 0.4) + (score_1h * 0.6)) * 100)
        return {
            "bullish_pct": intra_green,
            "bearish_pct": 100 - intra_green,
            "source": "Custom MTF Engine"
        }
    except Exception as e:
        print(f"Error {symbol}: {e}")
        return None

def update_crypto_sentiment():
    firebase_url = "https://fatima-16b38-default-rtdb.firebaseio.com/sentiment.json"
    try:
        existing = requests.get(firebase_url).json()
        if existing is None:
            existing = {}
    except:
        existing = {}
    for sym in CRYPTO_SYMBOLS:
        print(f"Processing {sym}...")
        result = get_custom_sentiment(sym)
        if result:
            existing[sym] = result
            print(f"  -> Bullish: {result['bullish_pct']}%, Bearish: {result['bearish_pct']}%")
        else:
            print(f"  -> Skipped {sym}")
        time.sleep(1)
    response = requests.put(firebase_url, json=existing)
    print(f"Firebase update status: {response.status_code}")

if __name__ == "__main__":
    update_crypto_sentiment()

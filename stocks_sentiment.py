import time
import requests
import yfinance as yf
import pandas as pd

# US Stock Symbols
US_STOCKS = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "NFLX",
    "AVGO", "AMD", "INTC", "QCOM", "CSCO", "ORCL", "IBM", "CRM",
    "ADBE", "TSM", "JPM", "BAC", "WFC", "C", "GS", "MS",
    "V", "MA", "PYPL", "AXP", "WMT", "HD", "COST", "TGT",
    "NKE", "SBUX", "MCD", "KO", "PEP", "PG", "BABA", "JD",
    "PDD", "DIS", "CMCSA", "T", "VZ", "TMUS", "SONY", "F",
    "GM", "CAT", "GE", "BA", "MMM", "LMT", "JNJ", "PFE",
    "MRK", "LLY", "UNH", "BMY", "GILD", "XOM", "CVX", "UBER",
    "BIDU", "NIO", "LI", "XPEV", "FUTU", "HPQ", "MU", "TXN"
]

# PSX Stock Symbols
PSX_STOCKS = [
    "SYS", "TRG", "AIRLINK", "WTL", "MEBL", "UBL", "MCB", "HBL",
    "NBP", "OGDC", "PPL", "MARI", "PSO", "FFC", "EFERT", "ENGRO",
    "HUBC", "LUCK", "DGKC", "MLCF", "FCCL", "CHCC", "PIOC", "PAEL",
    "MTL", "INDU", "PSMC", "PRL", "CYAN", "EPCL", "LOTCHEM", "COLG",
    "SEARL", "FEROZ", "INIL", "ISL", "ASTL", "MUGHAL", "KOSM", "KEL",
    "NPL", "NCPL", "NML", "ANL", "GATM", "NESTLE", "FFL", "UNITY",
    "TREET", "SNGP", "SSGC"
]

def get_yf_ticker(symbol):
    return symbol

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

def get_us_stock_sentiment(symbol):
    try:
        t = yf.Ticker(symbol)
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

def get_psx_sentiment_from_firebase(symbol, psx_data):
    """Compute sentiment from PSX market data signals."""
    if symbol not in psx_data:
        return None
    data = psx_data[symbol]
    # Extract signals (keys like signal1h, signal4h, etc.)
    signals = []
    for key, val in data.items():
        if 'signal' in key.lower() and isinstance(val, str):
            signals.append(val.lower())
        elif key in ['1h', '4h', '1d', '1w'] and isinstance(val, str):
            signals.append(val.lower())
    # Also check for direction fields
    if 'direction' in data:
        dir_val = str(data['direction']).lower()
        if dir_val in ['bull', 'bear']:
            signals.append(dir_val)
    if not signals:
        # Try any field that is 'bull' or 'bear'
        for key, val in data.items():
            if isinstance(val, str) and val.lower() in ['bull', 'bear']:
                signals.append(val.lower())
    if not signals:
        return None
    bull_count = signals.count('bull') + signals.count('long') + signals.count('buy')
    bear_count = signals.count('bear') + signals.count('short') + signals.count('sell')
    total = bull_count + bear_count
    if total == 0:
        return None
    bull_pct = round((bull_count / total) * 100)
    bear_pct = 100 - bull_pct
    return {
        "bullish_pct": bull_pct,
        "bearish_pct": bear_pct,
        "source": "PSX Firebase Signals"
    }

def update_stocks_sentiment():
    firebase_url = "https://fatima-16b38-default-rtdb.firebaseio.com"
    sentiment_url = firebase_url + "/sentiment.json"
    psx_data_url = firebase_url + "/psxStockMarketData.json"

    # Load existing sentiment data (to preserve US, crypto, etc.)
    try:
        existing = requests.get(sentiment_url).json()
        if existing is None:
            existing = {}
    except:
        existing = {}

    # Fetch PSX market data from Firebase
    try:
        psx_market_data = requests.get(psx_data_url).json()
        if psx_market_data is None:
            psx_market_data = {}
    except:
        psx_market_data = {}

    # US Stocks
    print("=== US STOCKS ===")
    for sym in US_STOCKS:
        print(f"Processing {sym}...")
        result = get_us_stock_sentiment(sym)
        if result:
            existing[sym] = result
            print(f"  -> Bullish: {result['bullish_pct']}%, Bearish: {result['bearish_pct']}%")
        else:
            print(f"  -> Skipped {sym}")
        time.sleep(1)

    # PSX Stocks (from Firebase signals)
    print("\n=== PSX STOCKS ===")
    for sym in PSX_STOCKS:
        print(f"Processing {sym}...")
        result = get_psx_sentiment_from_firebase(sym, psx_market_data)
        if result:
            existing[sym] = result
            print(f"  -> Bullish: {result['bullish_pct']}%, Bearish: {result['bearish_pct']}%")
        else:
            print(f"  -> Skipped {sym} (no signals found)")
        time.sleep(0.2)

    # Push updated sentiment to Firebase
    response = requests.put(sentiment_url, json=existing)
    print(f"\nFirebase update status: {response.status_code}")

if __name__ == "__main__":
    update_stocks_sentiment()

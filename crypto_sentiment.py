import time
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta

# Crypto symbols (frontend list)
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

def get_binance_symbol(symbol):
    return symbol.replace("USD", "USDT")

def calc_window_score(df, lookback_bars):
    df = df.copy()
    if len(df) < lookback_bars:
        return None
    df["EMA10"] = df["close"].ewm(span=10, adjust=False).mean()
    df["EMA20"] = df["close"].ewm(span=20, adjust=False).mean()
    df["SMA50"] = df["close"].rolling(window=50).mean()
    df = df.dropna()
    if len(df) < lookback_bars:
        return None
    window = df.tail(lookback_bars)
    total_points = len(window) * 3
    earned_points = 0
    for _, row in window.iterrows():
        if row["close"] > row["EMA10"]:
            earned_points += 1
        if row["EMA10"] > row["EMA20"]:
            earned_points += 1
        if row["EMA20"] > row["SMA50"]:
            earned_points += 1
    return earned_points / total_points

def fetch_binance_klines(symbol, interval, limit=500):
    base_url = "https://api.binance.com/api/v3/klines"
    params = {
        "symbol": symbol,
        "interval": interval,
        "limit": limit
    }
    try:
        resp = requests.get(base_url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return None
        df = pd.DataFrame(data, columns=[
            "open_time", "open", "high", "low", "close", "volume",
            "close_time", "quote_asset_volume", "number_of_trades",
            "taker_buy_base_asset_volume", "taker_buy_quote_asset_volume", "ignore"
        ])
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
        df["close"] = df["close"].astype(float)
        return df[["open_time", "close"]]
    except Exception as e:
        print(f"    Binance error for {symbol} {interval}: {e}")
        return None

def get_custom_sentiment_binance(symbol):
    bin_symbol = get_binance_symbol(symbol)
    df_15m = fetch_binance_klines(bin_symbol, "15m", limit=200)
    df_1h = fetch_binance_klines(bin_symbol, "1h", limit=200)
    df_1d = fetch_binance_klines(bin_symbol, "1d", limit=200)

    if df_15m is None or df_1h is None or df_1d is None:
        return None

    score_15m = calc_window_score(df_15m, 32)
    score_1h = calc_window_score(df_1h, 24)
    score_1d = calc_window_score(df_1d, 14)

    if score_15m is None or score_1h is None or score_1d is None:
        return None

    intra_green = round(((score_15m * 0.4) + (score_1h * 0.6)) * 100)
    daily_green = round(((score_1h * 0.3) + (score_1d * 0.7)) * 100)

    return {
        "bullish_pct": intra_green,
        "bearish_pct": 100 - intra_green,
        "daily_bullish_pct": daily_green,
        "daily_bearish_pct": 100 - daily_green,
        "source": "Binance API"
    }

def get_custom_sentiment_yahoo(symbol):
    ticker = get_yf_ticker(symbol)
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        df_15m = t.history(period="5d", interval="15m")
        df_1h = t.history(period="1mo", interval="1h")
        df_1d = t.history(period="1y", interval="1d")

        if df_15m.empty or df_1h.empty or df_1d.empty:
            return None

        df_15m = df_15m.reset_index()[['Datetime', 'Close']].rename(columns={'Datetime':'open_time', 'Close':'close'})
        df_1h = df_1h.reset_index()[['Datetime', 'Close']].rename(columns={'Datetime':'open_time', 'Close':'close'})
        df_1d = df_1d.reset_index()[['Date', 'Close']].rename(columns={'Date':'open_time', 'Close':'close'})

        score_15m = calc_window_score(df_15m, 32)
        score_1h = calc_window_score(df_1h, 24)
        score_1d = calc_window_score(df_1d, 14)

        if score_15m is None or score_1h is None or score_1d is None:
            return None

        intra_green = round(((score_15m * 0.4) + (score_1h * 0.6)) * 100)
        daily_green = round(((score_1h * 0.3) + (score_1d * 0.7)) * 100)

        return {
            "bullish_pct": intra_green,
            "bearish_pct": 100 - intra_green,
            "daily_bullish_pct": daily_green,
            "daily_bearish_pct": 100 - daily_green,
            "source": "Yahoo Finance"
        }
    except Exception as e:
        print(f"  Yahoo error for {symbol}: {e}")
        return None

def get_sentiment_for_symbol(symbol):
    print(f"  Trying Binance for {symbol}...")
    result = get_custom_sentiment_binance(symbol)
    if result:
        return result
    print(f"  Binance failed, trying Yahoo for {symbol}...")
    result = get_custom_sentiment_yahoo(symbol)
    if result:
        return result
    print(f"  Both failed for {symbol}, skipping.")
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
        result = get_sentiment_for_symbol(sym)
        if result:
            existing[sym] = result
            print(f"  -> Intraday Bullish: {result['bullish_pct']}%, Daily Bullish: {result['daily_bullish_pct']}%")
        else:
            print(f"  -> No data for {sym}")
        time.sleep(0.5)

    response = requests.put(firebase_url, json=existing)
    print(f"\nFirebase update status: {response.status_code}")

if __name__ == "__main__":
    update_crypto_sentiment()

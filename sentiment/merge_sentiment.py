!pip install -q yfinance pandas

import yfinance as yf
import pandas as pd
import json
import os

# ---------------------------------------------------------
# 1. FALLBACK WATCHLIST (Crypto & Stocks jo MentFX pe nahi hain)
# ---------------------------------------------------------
FALLBACK_WATCHLIST = {
    # Cryptos
    "BTC": "BTC-USD",
    "ETH": "ETH-USD",
    "SOL": "SOL-USD",
    "BNB": "BNB-USD",
    
    # Extra Stocks / Indices (Agar scraped data mein na hon)
    "AAPL": "AAPL",
    "TSLA": "TSLA",
    "MSFT": "MSFT"
}

# File path jahan aapka web scraped data save hota hai
SCRAPED_JSON_FILE = "scraped_data.json"

# ---------------------------------------------------------
# 2. CALCULATION ENGINE (Sirf missing symbols ke liye)
# ---------------------------------------------------------
def calc_window_score(df, lookback_bars):
    df["EMA10"] = df["Close"].ewm(span=10, adjust=False).mean()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["SMA50"] = df["Close"].rolling(window=50).mean()
    df = df.dropna()

    if len(df) < lookback_bars: return 0.5
    
    window = df.tail(lookback_bars)
    total_points = len(window) * 3
    earned_points = 0

    for _, row in window.iterrows():
        if row["Close"] > row["EMA10"]: earned_points += 1
        if row["EMA10"] > row["EMA20"]: earned_points += 1
        if row["EMA20"] > row["SMA50"]: earned_points += 1

    return earned_points / total_points

def get_custom_sentiment(ticker_symbol):
    try:
        ticker = yf.Ticker(ticker_symbol)
        df_15m = ticker.history(period="5d", interval="15m")
        df_1h  = ticker.history(period="1mo", interval="1h")
        df_1d  = ticker.history(period="1y", interval="1d")

        if df_15m.empty or df_1h.empty or df_1d.empty: return None

        score_15m = calc_window_score(df_15m, 32)
        score_1h  = calc_window_score(df_1h, 24)
        score_1d  = calc_window_score(df_1d, 14)

        intra_green = round(((score_15m * 0.4) + (score_1h * 0.6)) * 100)
        daily_green = round(((score_1h * 0.3) + (score_1d * 0.7)) * 100)

        return {
            "intra_red": 100 - intra_green,
            "intra_green": intra_green,
            "daily_red": 100 - daily_green,
            "daily_green": daily_green,
            "source": "Custom MTF Engine" # Taake app me pata chal sake data kahan se aya
        }
    except Exception:
        return None

# ---------------------------------------------------------
# 3. MERGE LOGIC (Scraped Data ko bachana hai)
# ---------------------------------------------------------
def process_and_merge_data():
    master_data = {}
    
    # A. Scraped Data Load Karein (Agar file majood hai)
    if os.path.exists(SCRAPED_JSON_FILE):
        with open(SCRAPED_JSON_FILE, "r") as f:
            try:
                master_data = json.load(f)
                print(f"✅ Loaded {len(master_data)} symbols from Web Scraped Data.")
            except json.JSONDecodeError:
                print("⚠️ Scraped JSON file khali ya kharab hai. Naya data ban raha hai.")

    print("\n🔍 Checking missing Crypto & Stocks...\n")

    # B. Sirf unko calculate karein jo Scraped Data mein NAHI hain
    added_count = 0
    for symbol, ticker in FALLBACK_WATCHLIST.items():
        if symbol in master_data:
            print(f"⏭️  SKIPPED: {symbol} (Pehle se Web Scraped Data mein majood hai)")
        else:
            print(f"⚙️  CALCULATING: {symbol} (Web pe nahi mila, custom engine chal raha hai...)")
            result = get_custom_sentiment(ticker)
            if result:
                master_data[symbol] = result
                added_count += 1
                print(f"   └─ Done! Intraday: {result['intra_green']}% Green | Daily: {result['daily_green']}% Green")
            else:
                print(f"   └─ ❌ Error fetching data for {symbol}")

    # C. Final Merged Data Save Karein
    with open("final_merged_sentiment.json", "w") as f:
        json.dump(master_data, f, indent=4)
        
    print(f"\n🚀 SUCCESS: Final data saved to 'final_merged_sentiment.json'")
    print(f"📊 Total Symbols in App: {len(master_data)} ({added_count} newly calculated)")

# Run the process
process_and_merge_data()

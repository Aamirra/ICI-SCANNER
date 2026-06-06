def fetch_sentiment_data() -> Dict:
    logger.info("Starting stealth scrape session...")
    session = tls_client.Session(client_identifier="chrome_120")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Referer": "https://mentfx.com/sentiment/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    }
    
    try:
        resp = session.get(MENTFX_VIEWER, headers=headers, timeout_seconds=30)
        if resp.status_code != 200: return {}

        soup = BeautifulSoup(resp.text, "html.parser")
        results = {}
        
        # Har row ko check karein
        for row in soup.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 3: continue
            
            # Pair name aur Daily Sentiment extraction
            pair_raw = cells[0].get_text(strip=True).upper().replace("/", "").replace(" ", "")
            daily_data = cells[2].get_text(strip=True)
            
            mapped = MENTFX_TO_APP.get(pair_raw)
            if mapped:
                nums = re.findall(r"(\d+)%", daily_data)
                if len(nums) >= 2:
                    bear_val, bull_val = float(nums[0]), float(nums[1])
                    total = bear_val + bull_val
                    results[mapped] = {
                        "bearish_pct": round(bear_val, 2), 
                        "bullish_pct": round(bull_val, 2)
                    }
        
        logger.info(f"Successfully parsed {len(results)} pairs.")
        return results

    except Exception as e:
        logger.error(f"Error during parsing: {e}")
        return {}

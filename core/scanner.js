// --- Ye function scanner.js mein kahin bhi (e.g., masterScan se pehle) daal dein ---
async function updateSentiment(pairName, data) {
    const timeframes = ['1h', '4h', '1day', '1week'];
    let bullCount = 0;
    let bearCount = 0;

    timeframes.forEach(tf => {
        if (data[tf] === 'bull') bullCount++;
        else if (data[tf] === 'bear') bearCount++;
    });

    const total = bullCount + bearCount;
    if (total > 0) {
        const bullish_pct = (bullCount / total) * 100;
        const bearish_pct = (bearCount / total) * 100;

        // Firebase par data bhej rahe hain
        await firebasePut(`sentiment/${pairName}`, {
            bearish_pct: parseFloat(bearish_pct.toFixed(2)),
            bullish_pct: parseFloat(bullish_pct.toFixed(2))
        });
    }
}

// --- Ab masterScan ke andar jahan loop hai (Line 285 ke paas), wahan ye update karein ---
        // Pehli batch ke baad jin pairs ka data aa gaya unhe save + rules
        for (const p of config.PAIRS) {
            if (DATA_STORE[p.n]) {
                await firebasePut(`marketData/${p.n}`, DATA_STORE[p.n]);
                
                // --- Yahan naya sentiment update call ho raha hai ---
                await updateSentiment(p.n, DATA_STORE[p.n]);
                
                pullbackEngine.checkRules(p, DATA_STORE[p.n], RAW_1H[p.n], sendTG, firebasePut);
            }
        }

const https = require('https');

// Jo pairs fail ho rahe hain unke Stooq symbols
const TEST_PAIRS = [
    { name: 'US500',  stooq: '^spx' },
    { name: 'US100',  stooq: '^ndq' },
    { name: 'US30',   stooq: '^dji' },
    { name: 'GER40',  stooq: '^dax' },
    { name: 'UK100',  stooq: '^ukx' },
    { name: 'JPN225', stooq: '^nkx' },
    { name: 'USOIL',  stooq: 'cl.f' },
    { name: 'UKOIL',  stooq: 'lco.f' },
    { name: 'XAGUSD', stooq: 'xagusd' },
    { name: 'NATGAS', stooq: 'ng.f' },
];

// Interval mapping
// Stooq mein: h=hourly, d=daily, w=weekly
const INTERVALS = [
    { label: '1h',    stooq: 'h' },
    { label: '1day',  stooq: 'd' },
    { label: '1week', stooq: 'w' },
];

function fetchStooq(symbol, interval) {
    const url = `https://stooq.com/q/d/l/?s=${symbol}&i=${interval}`;
    
    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const lines = data.trim().split('\n');
                // Pehli line header hoti hai: Date,Open,High,Low,Close,Volume
                if (lines.length < 3) {
                    resolve({ ok: false, rows: 0, sample: data.substring(0, 100) });
                    return;
                }
                resolve({ ok: true, rows: lines.length - 1, sample: lines[1] });
            });
        }).on('error', (err) => {
            resolve({ ok: false, rows: 0, sample: err.message });
        });
    });
}

async function runTest() {
    console.log('=== STOOQ TEST START ===\n');
    
    for (const pair of TEST_PAIRS) {
        console.log(`--- ${pair.name} (${pair.stooq}) ---`);
        
        for (const tf of INTERVALS) {
            await new Promise(r => setTimeout(r, 500)); // rate limit se bachao
            const result = await fetchStooq(pair.stooq, tf.stooq);
            
            if (result.ok) {
                console.log(`  ✅ ${tf.label}: ${result.rows} rows | Sample: ${result.sample}`);
            } else {
                console.log(`  ❌ ${tf.label}: FAILED | ${result.sample}`);
            }
        }
        console.log('');
    }
    
    console.log('=== TEST COMPLETE ===');
}

runTest();

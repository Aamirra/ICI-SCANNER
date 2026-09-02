const fs = require('fs');
const filePath = 'ici-server.js';

let content = fs.readFileSync(filePath, 'utf8');

// Line dhundo jahan newsRes await fetch hai
const newsMarker = "const newsRes = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');";
const newsIdx = content.indexOf(newsMarker);
if (newsIdx === -1) {
    console.error('❌ News fetch line nahi mili.');
    process.exit(1);
}

// Is line se pehle wala `if` block ka start dhundo (nearest line with lower indentation)
// Hum search karenge backwards for a line that starts with `if (req.method === 'GET' && safePath ===`
// ya phir hum line number ke hisaab se block start guess karenge.
// Better: hum simply us line ke aas paas ke 200 characters dekhenge.
const before = content.slice(0, newsIdx);
const lines = before.split('\n');
let startLineIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().startsWith("if (req.method === 'GET' && safePath ===")) {
        startLineIdx = i;
        break;
    }
}
if (startLineIdx === -1) {
    console.error('❌ Enclosing if block nahi mila. Manual check karo.');
    process.exit(1);
}

// Block ka start index (line start)
const startIdx = before.lastIndexOf('\n', before.lastIndexOf(lines[startLineIdx])) + 1;

// Ab block ka end dhundo (matching closing brace)
let openBraces = 0;
let endIdx = -1;
let inBlock = false;
for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') {
        openBraces++;
        if (!inBlock) inBlock = true;
    } else if (content[i] === '}') {
        openBraces--;
        if (inBlock && openBraces === 0) {
            endIdx = i;
            break;
        }
    }
}
if (endIdx === -1) {
    console.error('❌ Closing brace nahi mila.');
    process.exit(1);
}

// Block content nikal kar async IIFE mein wrap karo
const blockContent = content.slice(startIdx, endIdx + 1);
// Opening brace ke baad `(async () => {` insert karo
const firstBraceIdx = blockContent.indexOf('{');
if (firstBraceIdx === -1) {
    console.error('❌ Opening brace nahi mila block mein.');
    process.exit(1);
}
const wrappedBlock = blockContent.slice(0, firstBraceIdx + 1) + 
                    '\n(async () => {' + 
                    blockContent.slice(firstBraceIdx + 1, -1) + 
                    '})();' + 
                    blockContent.slice(-1); // closing brace

content = content.slice(0, startIdx) + wrappedBlock + content.slice(endIdx + 1);

fs.writeFileSync(filePath, content);
console.log('✅ News fetch block wrapped in async IIFE successfully.');

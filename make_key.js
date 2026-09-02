const fs = require('fs');
const raw = fs.readFileSync('/home/ubuntu/ICI-SCANNER/.env', 'utf8');

const match = raw.match(/FIREBASE_SERVICE_ACCOUNT='([\s\S]+?)'\s*(\n|$)/);
if (!match) {
  console.error('FIREBASE_SERVICE_ACCOUNT not found in .env');
  process.exit(1);
}

let jsonStr = match[1];

try {
  JSON.parse(jsonStr);
} catch (e1) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  jsonStr = out;

  try {
    JSON.parse(jsonStr);
  } catch (e2) {
    console.error('JSON parse error (after sanitize):', e2.message);
    process.exit(1);
  }
}

fs.writeFileSync('/home/ubuntu/ICI-SCANNER/firebase_key.json', jsonStr);
console.log('firebase_key.json created successfully!');

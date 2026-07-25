const http = require('http');
const { exec } = require('child_process');

const PORT = 8080; // Webhook listener port

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      console.log('🚀 GitHub Push Event Received! Pulling changes...');

      // Automatic git pull & pm2 restart
      exec('git pull origin main && pm2 restart ici-server', (err, stdout, stderr) => {
        if (err) {
          console.error(`❌ Deployment Error: ${err}`);
          res.writeHead(500);
          return res.end('Deployment failed');
        }
        console.log(`✅ Deployment Output:\n${stdout}`);
        res.writeHead(200);
        res.end('Updated successfully!');
      });
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}).listen(PORT, () => {
  console.log(`Webhook listener running on port ${PORT}`);
});

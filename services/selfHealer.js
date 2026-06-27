const https = require('https');
const admin = require('firebase-admin');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const AI_MODEL = 'deepseek/deepseek-v4-flash:free';

if (!GITHUB_TOKEN || !OPENROUTER_API_KEY) {
    console.error('[SelfHealer] Missing tokens – self‑repair disabled.');
    module.exports = { start: () => {} };
    return;
}

async function checkForRequests() {
    const db = admin.database();
    const snap = await db.ref('codeChangeRequests').orderByChild('status').equalTo('approved').once('value');
    const requests = snap.val();
    if (!requests) return;

    for (const [id, req] of Object.entries(requests)) {
        if (req.status !== 'approved') continue;
        console.log(`[SelfHealer] Processing request ${id}: ${req.instruction}`);
        try {
            await db.ref(`codeChangeRequests/${id}/status`).set('processing');

            const filePaths = ['services/technicalMetrics.js', 'core/scanner.js', 'services/liveTicks.js'];
            const fileContents = {};
            for (const path of filePaths) {
                const content = await fetchGitHubFile(path);
                if (content) fileContents[path] = content;
            }

            const systemPrompt = `You are an expert coding assistant. Modify the provided files according to the user's instruction.
Return a JSON object with keys as file paths and values as the complete new file content. Only modify files that are necessary.
User instruction: "${req.instruction}"
Current files: ${JSON.stringify(fileContents, null, 2)}`;

            const aiResponse = await callAI(systemPrompt);
            let changes;
            try { changes = JSON.parse(aiResponse); } catch(e) {
                await db.ref(`codeChangeRequests/${id}`).update({ status: 'failed', error: 'AI response parsing failed' });
                continue;
            }

            const branchName = `ai-fix-${id}`;
            await createBranch(branchName);
            for (const [path, newContent] of Object.entries(changes)) {
                if (typeof newContent !== 'string') continue;
                await updateFileInBranch(branchName, path, newContent, `AI: ${req.instruction}`);
            }

            const pr = await createPullRequest(branchName, `AI Suggested: ${req.instruction}`, req.instruction);
            let merged = false;
            try {
                await githubRequest('PUT', `/repos/${REPO}/pulls/${pr.number}/merge`, { commit_title: pr.title });
                merged = true;
                console.log(`[SelfHealer] PR #${pr.number} merged successfully.`);
            } catch(e) { console.warn(`[SelfHealer] Auto‑merge failed: ${e.message}`); }

            await db.ref(`codeChangeRequests/${id}`).update({
                status: 'completed',
                prUrl: pr.html_url,
                merged,
                message: merged ? 'Merged & deployed.' : 'PR created, manual merge required.',
                updatedAt: Date.now()
            });
        } catch (err) {
            console.error(`[SelfHealer] Error processing ${id}:`, err.message);
            await db.ref(`codeChangeRequests/${id}`).update({ status: 'failed', error: err.message });
        }
    }
}

// GitHub helpers (same as earlier)
function githubRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'ICI-Scanner-Bot',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': body ? 'application/json' : undefined
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                    else reject(new Error(`GitHub API ${res.statusCode}: ${json.message}`));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function fetchGitHubFile(path) {
    try {
        const data = await githubRequest('GET', `/repos/${REPO}/contents/${path}?ref=main`);
        return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (e) { return null; }
}

async function getMainCommitSHA() {
    const refData = await githubRequest('GET', `/repos/${REPO}/git/ref/heads/main`);
    return refData.object.sha;
}

async function createBranch(branchName) {
    const sha = await getMainCommitSHA();
    try {
        await githubRequest('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branchName}`, sha });
    } catch (e) { if (!e.message.includes('Reference already exists')) throw e; }
}

async function updateFileInBranch(branch, path, content, commitMessage) {
    let fileSha = null;
    try {
        const fileData = await githubRequest('GET', `/repos/${REPO}/contents/${path}?ref=${branch}`);
        fileSha = fileData.sha;
    } catch (e) {}
    const body = { message: commitMessage, content: Buffer.from(content).toString('base64'), branch };
    if (fileSha) body.sha = fileSha;
    await githubRequest('PUT', `/repos/${REPO}/contents/${path}`, body);
}

async function createPullRequest(head, title, body) {
    return githubRequest('POST', `/repos/${REPO}/pulls`, { title, head, base: 'main', body });
}

async function callAI(systemPrompt) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: systemPrompt }], temperature: 0.2, max_tokens: 8000 });
        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://ici-scanner.onrender.com',
                'X-Title': 'ICI Scanner SelfHealer'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { const json = JSON.parse(data); resolve(json.choices?.[0]?.message?.content || ''); } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function start() {
    console.log('[SelfHealer] Started – monitoring codeChangeRequests');
    setInterval(checkForRequests, 30 * 1000);
}

module.exports = { start };

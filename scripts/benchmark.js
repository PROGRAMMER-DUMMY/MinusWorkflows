const { randomUUID } = require('crypto');

const API_BASE = 'http://localhost:3000';

async function post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return res.json();
}

async function runBenchmark() {
    console.log('[INIT] Starting OCR-Memory Benchmark Harness...');

    const projectId = randomUUID();
    const teamId    = randomUUID();
    const userId    = randomUUID();
    const episodeId = randomUUID();

    const needle = "The secret invoice number for the project is INV-9988-X.";
    const haystack = [
        "User logged into the system.",
        "Agent queried the CRM database.",
        needle,
        "Agent updated the project status to 'In Progress'.",
        "User asked about the billing details.",
    ];

    console.log('\n--- Test 1: Store & Verbatim Recall ---');
    try {
        await fetch(`${API_BASE}/memory/store`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ episode_id: episodeId, project_id: projectId, team_id: teamId, user_id: userId, events: haystack }),
        }).then(r => { if (!r.ok) throw new Error(`Store failed: ${r.status}`); });
        console.log('[OK] Store: 200');

        const results = await post('/memory/retrieve', {
            query: 'What is the secret invoice number?',
            project_id: projectId,
            scope: 'project',
        });

        const found = results.some(log => log.includes('INV-9988-X'));
        console.log(found ? '[OK] Recall: needle found' : '[FAIL] Recall: needle not found');
    } catch (err) {
        console.error('[FAIL] Test 1:', err.message);
    }

    console.log('\n--- Test 2: Multi-Tenant Isolation ---');
    try {
        const otherProjectId = randomUUID();
        const results = await post('/memory/retrieve', {
            query: 'What is the secret invoice number?',
            project_id: otherProjectId,
            scope: 'project',
        });
        console.log(results.length === 0
            ? '[OK] Isolation: no data leaked'
            : '[FAIL] Isolation: data leaked across projects');
    } catch (err) {
        console.error('[FAIL] Test 2:', err.message);
    }

    console.log('\n--- Test 3: Health Check ---');
    try {
        const res = await fetch(`${API_BASE}/health`);
        const body = await res.json();
        console.log(`[${res.ok ? 'OK' : 'FAIL'}] Health: ${JSON.stringify(body)}`);
    } catch (err) {
        console.error('[FAIL] Test 3:', err.message);
    }

    console.log('\n--- Benchmark Complete ---');
}

runBenchmark();

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const API_BASE = 'http://localhost:3000';

/**
 * Benchmark Harness for OCR-Memory
 * 
 * Tests:
 * 1. Store Recall (Verbatim)
 * 2. Multi-Tenant Isolation
 * 3. Adaptive Switching Latency
 */

async function runBenchmark() {
    console.log('[INIT] Starting OCR-Memory Benchmark Harness...');

    const projectId = uuidv4();
    const teamId = uuidv4();
    const userId = uuidv4();
    const episodeId = uuidv4();

    // 1. Setup 'Needle' in the Haystack
    const needle = "The secret invoice number for the project is INV-9988-X.";
    const haystack = [
        "User logged into the system.",
        "Agent queried the CRM database.",
        needle,
        "Agent updated the project status to 'In Progress'.",
        "User asked about the billing details."
    ];

    console.log('\n--- Test 1: Store & Verbatim Recall ---');
    try {
        const storeResp = await axios.post(`${API_BASE}/memory/store`, {
            episode_id: episodeId,
            project_id: projectId,
            team_id: teamId,
            user_id: userId,
            events: haystack
        });
        console.log('[OK] Store Status:', storeResp.status);

        const retrieveResp = await axios.post(`${API_BASE}/memory/retrieve`, {
            query: "What is the secret invoice number?",
            project_id: projectId,
            scope: "project"
        });

        const found = retrieveResp.data.some(log => log.includes("INV-9988-X"));
        if (found) {
            console.log('[OK] Recall Success: Needle found in haystack!');
        } else {
            console.log('[FAIL] Recall Failure: Needle not found.');
        }
    } catch (err) {
        console.error('[FAIL] Test 1 Failed:', err.message);
    }

    console.log('\n--- Test 2: Multi-Tenant Isolation ---');
    try {
        const otherProjectId = uuidv4();
        const retrieveResp = await axios.post(`${API_BASE}/memory/retrieve`, {
            query: "What is the secret invoice number?",
            project_id: otherProjectId,
            scope: "project"
        });

        if (retrieveResp.data.length === 0) {
            console.log('[OK] Isolation Success: No data leaked to other project.');
        } else {
            console.log('[FAIL] Isolation Failure: Data leaked across projects!');
        }
    } catch (err) {
        console.error('[FAIL] Test 2 Failed:', err.message);
    }

    console.log('\n--- Benchmark Complete ---');
}

runBenchmark();

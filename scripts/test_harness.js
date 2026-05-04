'use strict';
/**
 * MinusWorkflows Enterprise Test Harness
 * Run:  node scripts/test_harness.js
 *       npm run harness
 *       minus benchmark
 *
 * Reads: OCR_MEMORY_URL, API_KEY, ADMIN_KEY from env / .env
 * Writes: docs/HARNESS_REPORT_<timestamp>.md
 */

const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Env ───────────────────────────────────────────────────────────────────────
function loadEnv() {
    const p = path.join(ROOT, '.env');
    if (!fs.existsSync(p)) return {};
    const out = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (v) out[k] = v;
    }
    return out;
}

const env      = { ...loadEnv(), ...process.env };
const BASE_URL = env.OCR_MEMORY_URL || 'http://localhost:3000';
const API_KEY  = env.API_KEY  || '';
const ADMIN_KEY = env.ADMIN_KEY || '';

// ── Colors ────────────────────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// ── HTTP ──────────────────────────────────────────────────────────────────────
async function req(method, endpoint, body, headers = {}) {
    const res = await fetch(BASE_URL + endpoint, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
}

function apiHeaders(key)  { return { 'X-Api-Key':   key || API_KEY }; }
function adminHeaders()   { return { 'X-Admin-Key': ADMIN_KEY }; }

// ── Test runner ───────────────────────────────────────────────────────────────
const results   = [];
const skipped   = [];
let currentSuite = '';

async function test(name, fn) {
    const start = Date.now();
    try {
        await fn();
        const ms = Date.now() - start;
        results.push({ suite: currentSuite, name, ok: true, ms });
        process.stdout.write(`    ${G}[PASS]${X} ${name.padEnd(52)} ${D}${ms}ms${X}\n`);
    } catch (err) {
        const ms = Date.now() - start;
        results.push({ suite: currentSuite, name, ok: false, ms, error: err.message });
        process.stdout.write(`    ${R}[FAIL]${X} ${name.padEnd(52)} ${err.message}\n`);
    }
}

function skip(name, reason) {
    skipped.push({ suite: currentSuite, name, reason });
    process.stdout.write(`    ${Y}[SKIP]${X} ${name.padEnd(52)} ${D}${reason}${X}\n`);
}

function suite(name) {
    currentSuite = name;
    console.log(`\n${B}${name}${X}`);
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

// ── Helper: create a scoped key ───────────────────────────────────────────────
async function createKey(label, projectId, expiresInDays) {
    if (!ADMIN_KEY) throw new Error('ADMIN_KEY not set');
    const body = { label, project_id: projectId || null, expires_in_days: expiresInDays || null };
    const r = await req('POST', '/keys', body, adminHeaders());
    assert(r.status === 201, `key creation failed: ${r.status} ${r.text}`);
    return r.json;
}

async function revokeKey(id) {
    await req('DELETE', `/keys/${id}`, null, adminHeaders());
}

// ── Helper: store episode ────────────────────────────────────────────────────
async function storeEpisode(projectId, events, apiKey) {
    const r = await req('POST', '/memory/store', {
        episode_id: randomUUID(),
        project_id: projectId,
        team_id:    randomUUID(),
        user_id:    randomUUID(),
        events,
    }, apiHeaders(apiKey));
    return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Authentication
// ─────────────────────────────────────────────────────────────────────────────
async function suiteAuth() {
    suite('Suite 1 — Authentication');

    const pid = randomUUID();

    await test('no key → 401', async () => {
        const r = await req('POST', '/memory/store', { episode_id: randomUUID(), project_id: pid, team_id: randomUUID(), user_id: randomUUID(), events: ['x'] }, {});
        assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('invalid key → 401', async () => {
        const r = await req('POST', '/memory/store', { episode_id: randomUUID(), project_id: pid, team_id: randomUUID(), user_id: randomUUID(), events: ['x'] }, apiHeaders('invalid-key-xyz'));
        assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    if (!API_KEY) {
        skip('valid global key → 200', 'API_KEY not set');
    } else {
        await test('valid global key → 200', async () => {
            const r = await storeEpisode(pid, ['auth test event'], API_KEY);
            assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`);
        });
    }

    if (!ADMIN_KEY) {
        skip('project-scoped key + matching project → 200', 'ADMIN_KEY not set');
        skip('project-scoped key + wrong project → 403',    'ADMIN_KEY not set');
    } else {
        const scopedPid = randomUUID();
        let scopedKey = null;

        await test('project-scoped key + matching project → 200', async () => {
            const k = await createKey('harness-scoped', scopedPid);
            scopedKey = k;
            const r = await storeEpisode(scopedPid, ['scoped test'], k.raw_key);
            await revokeKey(k.id);
            assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`);
        });

        await test('project-scoped key + wrong project → 403', async () => {
            const k = await createKey('harness-wrong-scope', scopedPid);
            const r = await storeEpisode(randomUUID(), ['wrong project'], k.raw_key);
            await revokeKey(k.id);
            assert(r.status === 403, `expected 403, got ${r.status}`);
        });

        await test('/keys without admin key → 401 or 503', async () => {
            const r = await req('GET', '/keys', null, {});
            assert(r.status === 401 || r.status === 503, `expected 401 or 503, got ${r.status}`);
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Store / Retrieve round-trip
// ─────────────────────────────────────────────────────────────────────────────
async function suiteRoundTrip() {
    suite('Suite 2 — Store → Retrieve round-trip');

    if (!API_KEY) {
        skip('store + retrieve exact match',     'API_KEY not set');
        skip('store 500 events (max) → 200',     'API_KEY not set');
        skip('store 501 events → 400',           'API_KEY not set');
        skip('store empty events → 400',         'API_KEY not set');
        skip('store event > 10 000 chars → 400', 'API_KEY not set');
        return;
    }

    const pid     = randomUUID();
    const needle  = `harness-needle-${randomUUID()}`;

    await test('store + retrieve exact match', async () => {
        const storeRes = await storeEpisode(pid, [needle, 'unrelated event', 'another unrelated'], API_KEY);
        assert(storeRes.status === 200, `store failed: ${storeRes.status}`);

        // Allow indexing time for text search
        await new Promise(r => setTimeout(r, 500));

        const retRes = await req('POST', '/memory/retrieve',
            { project_id: pid, query: needle },
            apiHeaders(API_KEY)
        );
        assert(retRes.status === 200, `retrieve failed: ${retRes.status}`);
        const results = retRes.json || [];
        assert(results.some(e => e.includes(needle)), `needle not found in results: ${JSON.stringify(results)}`);
    });

    await test('store 500 events (max) → 200', async () => {
        const events = Array.from({ length: 500 }, (_, i) => `event-${i}`);
        const r = await storeEpisode(pid, events, API_KEY);
        assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`);
    });

    await test('store 501 events → 400', async () => {
        const events = Array.from({ length: 501 }, (_, i) => `event-${i}`);
        const r = await storeEpisode(pid, events, API_KEY);
        assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('store empty events → 400', async () => {
        const r = await storeEpisode(pid, [], API_KEY);
        assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('store event > 10 000 chars → 400', async () => {
        const r = await storeEpisode(pid, ['a'.repeat(10_001)], API_KEY);
        assert(r.status === 400, `expected 400, got ${r.status}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Multi-tenant isolation
// ─────────────────────────────────────────────────────────────────────────────
async function suiteIsolation() {
    suite('Suite 3 — Multi-tenant isolation');

    if (!API_KEY) {
        skip('project A data not visible from project B', 'API_KEY not set');
        skip('project-scoped key blocked from other project', 'ADMIN_KEY not set');
        return;
    }

    const pidA   = randomUUID();
    const pidB   = randomUUID();
    const marker = `isolation-marker-${randomUUID()}`;

    await test('project A data not visible from project B', async () => {
        const s = await storeEpisode(pidA, [marker], API_KEY);
        assert(s.status === 200, `store failed: ${s.status}`);
        await new Promise(r => setTimeout(r, 500));

        const r = await req('POST', '/memory/retrieve',
            { project_id: pidB, query: marker },
            apiHeaders(API_KEY)
        );
        assert(r.status === 200, `retrieve failed: ${r.status}`);
        const results = r.json || [];
        assert(!results.some(e => e.includes(marker)), `isolation breach: marker found in project B: ${JSON.stringify(results)}`);
    });

    if (!ADMIN_KEY) {
        skip('project-scoped key blocked from other project', 'ADMIN_KEY not set');
        return;
    }

    await test('project-scoped key blocked from other project', async () => {
        const k = await createKey('harness-isolation', pidA);
        const r = await storeEpisode(pidB, ['should be blocked'], k.raw_key);
        await revokeKey(k.id);
        assert(r.status === 403, `expected 403, got ${r.status}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Retention
// ─────────────────────────────────────────────────────────────────────────────
async function suiteRetention() {
    suite('Suite 4 — Retention policy');

    if (!ADMIN_KEY) {
        skip('retention endpoint responds correctly', 'ADMIN_KEY not set');
        skip('retention response has correct shape',  'ADMIN_KEY not set');
        return;
    }

    await test('retention endpoint responds → 200', async () => {
        const r = await req('POST', '/admin/retention/run', null, adminHeaders());
        assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`);
    });

    await test('retention response has correct shape', async () => {
        const r = await req('POST', '/admin/retention/run', null, adminHeaders());
        assert(r.status === 200, `expected 200, got ${r.status}`);
        const j = r.json || {};
        assert('deleted_episodes' in j, `missing deleted_episodes: ${r.text}`);
        assert('freed_bytes'      in j, `missing freed_bytes: ${r.text}`);
        assert('archived_pngs'   in j, `missing archived_pngs: ${r.text}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: Performance
// ─────────────────────────────────────────────────────────────────────────────
async function suitePerformance() {
    suite('Suite 5 — Performance');

    if (!API_KEY) {
        skip('50 sequential store requests', 'API_KEY not set');
        skip('50 sequential retrieve requests', 'API_KEY not set');
        skip('10 concurrent store requests', 'API_KEY not set');
        return;
    }

    const pid = randomUUID();

    await test('50 sequential store requests — p50/p95/p99', async () => {
        const latencies = [];
        for (let i = 0; i < 50; i++) {
            const t = Date.now();
            const r = await storeEpisode(pid, [`perf-event-${i}`], API_KEY);
            latencies.push(Date.now() - t);
            assert(r.status === 200, `store ${i} failed: ${r.status}`);
        }
        const p50 = percentile(latencies, 50);
        const p95 = percentile(latencies, 95);
        const p99 = percentile(latencies, 99);
        console.log(`         ${D}store  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms${X}`);
    });

    await test('50 sequential retrieve requests — p50/p95/p99', async () => {
        const latencies = [];
        for (let i = 0; i < 50; i++) {
            const t = Date.now();
            const r = await req('POST', '/memory/retrieve',
                { project_id: pid, query: `perf-event-${i}` },
                apiHeaders(API_KEY)
            );
            latencies.push(Date.now() - t);
            assert(r.status === 200, `retrieve ${i} failed: ${r.status}`);
        }
        const p50 = percentile(latencies, 50);
        const p95 = percentile(latencies, 95);
        const p99 = percentile(latencies, 99);
        console.log(`         ${D}retrieve p50=${p50}ms  p95=${p95}ms  p99=${p99}ms${X}`);
    });

    await test('10 concurrent store requests — all 200', async () => {
        const reqs = Array.from({ length: 10 }, (_, i) =>
            storeEpisode(pid, [`concurrent-${i}`], API_KEY)
        );
        const all = await Promise.all(reqs);
        const fails = all.filter(r => r.status !== 200);
        assert(fails.length === 0, `${fails.length}/10 requests failed`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6: Health + Metrics
// ─────────────────────────────────────────────────────────────────────────────
async function suiteObservability() {
    suite('Suite 6 — Health + Metrics');

    await test('/health → 200 with all fields', async () => {
        const r = await req('GET', '/health');
        assert(r.status === 200, `expected 200, got ${r.status}`);
        const j = r.json || {};
        assert('status' in j, 'missing status');
        assert('db'     in j, 'missing db');
        assert('cache'  in j, 'missing cache');
        assert('mode'   in j, 'missing mode');
    });

    await test('/metrics → 200 Prometheus format', async () => {
        const r = await req('GET', '/metrics');
        assert(r.status === 200, `expected 200, got ${r.status}`);
        assert(r.text.includes('ocr_memory_store_requests_total'),    'missing store counter');
        assert(r.text.includes('ocr_memory_retrieve_requests_total'), 'missing retrieve counter');
    });

    await test('X-Request-Id echoed in response headers', async () => {
        const reqId = `harness-${randomUUID()}`;
        const res = await fetch(BASE_URL + '/health', { headers: { 'X-Request-Id': reqId } });
        const echoed = res.headers.get('x-request-id');
        assert(echoed === reqId, `expected echo of ${reqId}, got ${echoed}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Report generation
// ─────────────────────────────────────────────────────────────────────────────
function writeReport(totalMs) {
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const reportPath = path.join(ROOT, 'docs', `HARNESS_REPORT_${ts}.md`);

    const lines = [
        `# Harness Report — ${new Date().toISOString()}`,
        '',
        `**Result:** ${passed}/${results.length} tests passed  |  ${skipped.length} skipped  |  ${totalMs}ms total`,
        `**Target:** ${BASE_URL}`,
        '',
        '## Results',
        '',
        '| Suite | Test | Status | Time |',
        '|---|---|---|---|',
    ];

    for (const r of results) {
        lines.push(`| ${r.suite} | ${r.name} | ${r.ok ? 'PASS' : `FAIL: ${r.error}`} | ${r.ms}ms |`);
    }
    for (const s of skipped) {
        lines.push(`| ${s.suite} | ${s.name} | SKIP: ${s.reason} | — |`);
    }

    if (failed > 0) {
        lines.push('', '## Failures', '');
        for (const r of results.filter(r => !r.ok)) {
            lines.push(`- **${r.suite} / ${r.name}**: ${r.error}`);
        }
    }

    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(reportPath, lines.join('\n'));
    return reportPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`\n${B}MinusWorkflows Test Harness${X}`);
    console.log(`Target: ${BASE_URL}`);
    console.log(`API_KEY:   ${API_KEY   ? `${API_KEY.slice(0, 8)}...` : `${Y}(not set — auth tests skipped)${X}`}`);
    console.log(`ADMIN_KEY: ${ADMIN_KEY ? `${ADMIN_KEY.slice(0, 8)}...` : `${Y}(not set — admin tests skipped)${X}`}`);

    const globalStart = Date.now();

    try {
        await suiteAuth();
        await suiteRoundTrip();
        await suiteIsolation();
        await suiteRetention();
        await suitePerformance();
        await suiteObservability();
    } catch (err) {
        console.error(`\nHarness crashed: ${err.message}`);
        process.exitCode = 1;
    }

    const totalMs = Date.now() - globalStart;
    const passed  = results.filter(r => r.ok).length;
    const failed  = results.filter(r => !r.ok).length;

    console.log(`\n${'─'.repeat(72)}`);
    if (failed === 0) {
        console.log(`${G}${B}ALL PASSED${X}  ${passed}/${results.length} tests  |  ${skipped.length} skipped  |  ${totalMs}ms`);
    } else {
        console.log(`${R}${B}${failed} FAILED${X}  ${passed}/${results.length} passed  |  ${skipped.length} skipped  |  ${totalMs}ms`);
    }

    const reportPath = writeReport(totalMs);
    console.log(`Report → ${reportPath}\n`);

    if (failed > 0) process.exitCode = 1;
})();

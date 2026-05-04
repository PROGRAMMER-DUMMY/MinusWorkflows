'use strict';
/**
 * Pipeline unit tests — tests pure functions and isolated utilities.
 * Run: node scripts/test_pipeline.js
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];

async function it(label, fn) {
    try {
        await fn();
        results.push({ label, ok: true });
        passed++;
    } catch (err) {
        results.push({ label, ok: false, error: err.message });
        failed++;
    }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'minus-test-')); }

// ── Lock helpers (mirrors pipeline_executor.js logic) ────────────────────────

function acquireLock(sessionDir) {
    const lockPath = path.join(sessionDir, '.lock');
    try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        fs.closeSync(fd);
        return lockPath;
    } catch {
        try {
            const content = fs.readFileSync(lockPath, 'utf8');
            const ts = parseInt((content.split(' ')[1] || '0'), 10);
            if (Date.now() - ts > 600_000) { fs.unlinkSync(lockPath); return acquireLock(sessionDir); }
        } catch {}
        throw new Error(`Session is locked (${lockPath})`);
    }
}

function releaseLock(lockPath) { try { fs.unlinkSync(lockPath); } catch {} }

// ── Token estimation (mirrors pipeline_executor.js divisor logic) ─────────────

function estimateTokens(str) {
    if (!str) return 0;
    const len = str.length;
    const jsonDensity  = (str.match(/[{}\[\],:"]/g) || []).length / len;
    const codeDensity  = (str.match(/[()=>;{}\/\\<>]/g) || []).length / len;
    const newlineDensity = (str.match(/\n/g) || []).length / len;
    let divisor;
    if (jsonDensity > 0.08)         divisor = 3.8;
    else if (codeDensity > 0.06)    divisor = 3.5;
    else if (newlineDensity > 0.04) divisor = 4.2;
    else                            divisor = 4.0;
    return Math.ceil(len / divisor);
}

// ── Main (async IIFE so we can use await in CommonJS) ─────────────────────────

(async () => {
    const { classifyFailure, FAILURE_CODES } =
        require(path.resolve(__dirname, '..', 'utils', 'failure_taxonomy'));

    // ── Suite 1: Failure Taxonomy ─────────────────────────────────────────────

    await it('FAILURE_CODES exports 9 known codes', () => {
        const expected = ['F-LOC','F-CTX','F-PAT','F-REG','F-DEC','F-HND','F-SYN','F-TKN','F-ENV'];
        for (const code of expected) assert.ok(FAILURE_CODES[code], `missing ${code}`);
        assert.strictEqual(Object.keys(FAILURE_CODES).length, 9);
    });

    await it('classifyFailure → F-PAT for git apply failure', () => {
        assert.strictEqual(classifyFailure('git apply failed — hunk mismatch', '', {}), 'F-PAT');
        assert.strictEqual(classifyFailure('patch does not apply to repo', '', {}), 'F-PAT');
    });

    await it('classifyFailure → F-TKN for token/context-window messages', () => {
        assert.strictEqual(classifyFailure('Error: context window exceeded', '', {}), 'F-TKN');
        assert.strictEqual(classifyFailure('Stopped: max_tokens reached', '', {}), 'F-TKN');
        assert.strictEqual(classifyFailure('context length exceeded by 500 tokens', '', {}), 'F-TKN');
    });

    await it('classifyFailure → F-ENV for Cannot find module', () => {
        assert.strictEqual(classifyFailure("Error: Cannot find module './missing'", '', {}), 'F-ENV');
        assert.strictEqual(classifyFailure('npm err! missing peer dep', '', {}), 'F-ENV');
    });

    await it('classifyFailure → F-LOC for ENOENT on source files', () => {
        const code = classifyFailure('ENOENT: no such file or directory, open src/foo.js', '', {});
        assert.strictEqual(code, 'F-LOC');
    });

    await it('classifyFailure → F-REG from testResults regression_count', () => {
        assert.strictEqual(classifyFailure('', '', { passed: 5, regression_count: 2 }), 'F-REG');
    });

    await it('classifyFailure → F-REG from assertion failure text', () => {
        const log = 'AssertionError: expected 404 received 200\n  at expect(response.status).toBe(404)';
        assert.strictEqual(classifyFailure(log, '', {}), 'F-REG');
    });

    await it('classifyFailure → F-LOC for TypeError / ReferenceError', () => {
        assert.strictEqual(classifyFailure('TypeError: Cannot read properties of undefined', '', {}), 'F-LOC');
        assert.strictEqual(classifyFailure('ReferenceError: myFn is not defined', '', {}), 'F-LOC');
    });

    await it('classifyFailure → F-SYN for long output without JSON receipt', () => {
        const longOutput = 'Here is my detailed analysis: ' + 'words '.repeat(600);
        assert.ok(longOutput.length > 3000, 'precondition: output is long');
        assert.ok(!/```json|"phase"\s*:/i.test(longOutput), 'precondition: no receipt block');
        assert.strictEqual(classifyFailure(longOutput, '', {}), 'F-SYN');
    });

    await it('classifyFailure → NOT F-SYN when receipt JSON present in long output', () => {
        const output = 'analysis...\n'.repeat(300) +
            '\n```json\n{"phase":"builder","status":"ok","summary":"done"}\n```';
        const code = classifyFailure(output, '', {});
        assert.notStrictEqual(code, 'F-SYN', `long output with receipt should not be F-SYN, got ${code}`);
    });

    await it('classifyFailure → F-HND for missing context patterns', () => {
        assert.strictEqual(
            classifyFailure('Error: prior phase context missing — upstream not found', '', {}),
            'F-HND'
        );
    });

    // ── Suite 2: Token Estimation ─────────────────────────────────────────────

    await it('JSON content uses smaller divisor than prose (more tokens per char)', () => {
        const json  = JSON.stringify({ phase: 'builder', status: 'ok', output_files: ['a', 'b', 'c'] });
        const prose = 'This is a sentence that contains common English words and phrases.';
        const jsonTokens  = estimateTokens(json);
        const proseTokens = estimateTokens(prose);
        const jsonRatio  = json.length / jsonTokens;
        const proseRatio = prose.length / proseTokens;
        assert.ok(jsonRatio <= proseRatio,
            `JSON ratio (${jsonRatio.toFixed(2)}) should be ≤ prose (${proseRatio.toFixed(2)})`);
    });

    await it('estimateTokens returns 0 for empty / null input', () => {
        assert.strictEqual(estimateTokens(''), 0);
        assert.strictEqual(estimateTokens(null), 0);
        assert.strictEqual(estimateTokens(undefined), 0);
    });

    await it('estimateTokens is in ballpark: 1000-char prose ≈ 200–300 tokens', () => {
        const prose = 'word '.repeat(200); // 1000 chars
        const tokens = estimateTokens(prose);
        assert.ok(tokens >= 200 && tokens <= 350, `expected 200–350, got ${tokens}`);
    });

    // ── Suite 3: Session Lock ─────────────────────────────────────────────────

    await it('acquireLock creates lock file and releaseLock removes it', () => {
        const dir = tmpDir();
        const lockPath = acquireLock(dir);
        assert.ok(fs.existsSync(lockPath), 'lock file should exist');
        releaseLock(lockPath);
        assert.ok(!fs.existsSync(lockPath), 'lock file should be deleted after release');
    });

    await it('acquireLock throws when fresh lock is held', () => {
        const dir = tmpDir();
        const lockPath = path.join(dir, '.lock');
        fs.writeFileSync(lockPath, `99999 ${Date.now()}`);
        assert.throws(() => acquireLock(dir), /locked/i);
    });

    await it('acquireLock auto-clears stale lock (> 10 min old)', () => {
        const dir = tmpDir();
        const lockPath = path.join(dir, '.lock');
        fs.writeFileSync(lockPath, `99999 ${Date.now() - 700_000}`); // 11+ min ago
        const newLock = acquireLock(dir);
        assert.ok(fs.existsSync(newLock), 'should acquire after clearing stale lock');
        releaseLock(newLock);
    });

    // ── Suite 4: Phase Receipt Validation ────────────────────────────────────

    let schemaModule = null;
    try { schemaModule = require(path.resolve(__dirname, '..', 'utils', 'pipeline_schemas')); } catch {}

    if (schemaModule && typeof schemaModule.validate === 'function') {
        await it('pipeline_schemas.validate rejects receipt missing status field', () => {
            const result = schemaModule.validate('builder', { phase: 'builder', summary: 'ok' });
            assert.ok(!result.ok, 'should reject receipt missing status');
            assert.ok(result.missing.some(f => f.includes('status')),
                `missing should include status, got ${JSON.stringify(result.missing)}`);
        });

        await it('pipeline_schemas.validate accepts complete builder receipt', () => {
            const result = schemaModule.validate('builder', {
                phase: 'builder', status: 'ok', summary: 'built it',
                files_changed: ['src/foo.js'], tests_passed: 5,
            });
            assert.ok(result.ok, `valid receipt should pass: ${JSON.stringify(result.missing)}`);
        });
    }

    // ── Report ────────────────────────────────────────────────────────────────

    console.log('\nPipeline Unit Tests\n' + '─'.repeat(60));
    for (const r of results) {
        const mark = r.ok ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
        console.log(`${mark} ${r.label}`);
        if (!r.ok) console.log(`       ${r.error}`);
    }
    console.log('─'.repeat(60));
    console.log(`SUMMARY  ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
})();

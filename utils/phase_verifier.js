'use strict';
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PHASES_REQUIRING_VERIFICATION = new Set(['builder', 'auditor']);

function detectTestCommand(cwd) {
    if (fs.existsSync(path.join(cwd, 'package.json'))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
            const t = pkg.scripts?.test || '';
            if (t && !t.includes('no test specified')) return 'npm test';
        } catch {}
    }
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
    // pytest: use --junit-xml for accurate structured counts regardless of stdout truncation/color
    if (fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
        fs.existsSync(path.join(cwd, 'setup.py')) ||
        fs.existsSync(path.join(cwd, 'pytest.ini'))) {
        return 'pytest --junit-xml=.test-results.xml -q';
    }
    return null;
}

function parseTestCounts(stdout, exitCode) {
    const passed = stdout.match(/(\d+)\s+passed/i);
    const failed = stdout.match(/(\d+)\s+failed/i);
    if (passed) {
        const p = parseInt(passed[1], 10);
        const f = failed ? parseInt(failed[1], 10) : 0;
        return { total: p + f, passed: p, failed: f };
    }
    const cargo = stdout.match(/(\d+)\s+passed;\s*(\d+)\s+failed/);
    if (cargo) {
        return { total: parseInt(cargo[1]) + parseInt(cargo[2]), passed: parseInt(cargo[1]), failed: parseInt(cargo[2]) };
    }
    return { total: 1, passed: exitCode === 0 ? 1 : 0, failed: exitCode !== 0 ? 1 : 0 };
}

/**
 * Async non-blocking verifier — runs real test suite, returns Promise.
 * Replaces prior spawnSync which blocked the orchestrator thread.
 */
function runVerifier(cwd, timeoutMs = 120_000) {
    return new Promise(resolve => {
        const command = process.env.PHASE_VERIFY_CMD || detectTestCommand(cwd);
        if (!command) {
            resolve({ ok: true, skipped: true, command: null, total: 0, passed: 0, failed: 0, duration_ms: 0, stdout: '' });
            return;
        }

        const startMs = Date.now();
        let stdout    = '';
        let timedOut  = false;
        const child   = spawn(command, { shell: true, cwd });

        child.stdout.on('data', c => { stdout += c.toString(); });
        child.stderr.on('data', c => { stdout += c.toString(); });

        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);

        child.on('close', async code => {
            clearTimeout(timer);
            const duration_ms = Date.now() - startMs;
            stdout = stdout.slice(0, 4_000);

            // Prefer JUnit XML parse for pytest (accurate counts even with colorized/truncated stdout)
            const xmlPath = path.join(cwd, '.test-results.xml');
            if (!timedOut && fs.existsSync(xmlPath)) {
                try {
                    const { parsePytestResults } = require('./pytest_parser');
                    const parsed = await parsePytestResults(xmlPath);
                    try { fs.unlinkSync(xmlPath); } catch {}
                    return resolve({
                        ok: code === 0 && parsed.failed === 0,
                        skipped: false, command, duration_ms, stdout,
                        total: parsed.total_tests, passed: parsed.passed, failed: parsed.failed,
                    });
                } catch { /* fall through to stdout regex */ }
            }

            const counts = parseTestCounts(stdout, timedOut ? 1 : (code ?? 1));
            resolve({ ok: !timedOut && code === 0, skipped: false, command, duration_ms, stdout, ...counts });
        });
    });
}

module.exports = { runVerifier, detectTestCommand, PHASES_REQUIRING_VERIFICATION };

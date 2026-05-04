'use strict';
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { invokeAgentWithReceipt } = require('./agent_runner');
const { validate } = require('./pipeline_schemas');
const { openSpan, closeSpan, emitEvent } = require('./tracer');
const { runVerifier, PHASES_REQUIRING_VERIFICATION } = require('./phase_verifier');
const { classifyFailure, FAILURE_CODES } = require('./failure_taxonomy');

const SESSIONS_DIR   = path.join(process.cwd(), '.memory', 'sessions');
const RETRY_LIMIT    = parseInt(process.env.PIPELINE_RETRY_LIMIT || '3', 10);
const CONTEXT_BUDGET = parseInt(process.env.CONTEXT_BUDGET_TOKENS || '60000', 10);
const ora            = (() => { try { return require('ora'); } catch { return null; } })();

// ── Public API ────────────────────────────────────────────────────────────────

async function run(goal, phases, opts = {}) {
    const sessionId  = opts.sessionId || randomUUID();
    const sessionDir = ensureSessionDir(sessionId);
    const traceFile  = path.join(sessionDir, 'trace.jsonl');
    const lockPath   = acquireLock(sessionDir);

    try {
        const state = loadOrCreateState(sessionDir, sessionId, goal, phases);
        const pipelineSpan = openSpan(traceFile, 'pipeline', null, {
            goal: goal.slice(0, 80),
            phases,
            session_id: sessionId,
        });
        console.log(`[pipeline] session=${sessionId} phases=[${phases.join(',')}]`);

        const completedReceiptData = loadCompletedReceiptData(state.phases_completed, sessionDir);

        for (const phase of phases) {
            if (state.phases_completed.includes(phase)) {
                console.log(`[pipeline] ${phase} already complete — skipping`);
                continue;
            }

            state.current_phase = phase;
            saveState(sessionDir, state);

            // Build tiered prompt and capture context stats for trace
            const { prompt, stats } = buildPhasePrompt(goal, phase, completedReceiptData, sessionDir, state);

            const phaseSpan = openSpan(traceFile, phase, pipelineSpan, {
                receipts_injected: stats.receipts_injected,
                tokens_estimate:   stats.tokens_estimate,
            });
            emitEvent(traceFile, 'context.built', {
                parent_span:        phaseSpan,
                tokens_estimate:    stats.tokens_estimate,
                receipts_injected:  stats.receipts_injected,
                tier:               stats.tier,
            });

            const before = [...state.phases_completed];
            const result = await runPhaseWithRetry(phase, prompt, sessionDir, state, opts, {
                traceFile,
                parentSpanId: phaseSpan,
                completedReceiptData,
            });

            if (!result.ok) {
                closeSpan(traceFile, phaseSpan, { error: result.history.at(-1)?.error || 'exhausted retries' });
                closeSpan(traceFile, pipelineSpan, { error: `halted at ${phase}` });
                writeDiagnostic(sessionDir, phase, state, result.history);
                state.halted = true;
                saveState(sessionDir, state);
                console.error(`[pipeline] HALTED at phase=${phase}`);
                return { sessionId, completed: state.phases_completed, halted: true, diagnosticPath: path.join(sessionDir, 'DIAGNOSTIC.md') };
            }

            // Collect saved receipt for next phase's context
            const savedReceipt = readReceipt(sessionDir, phase);
            if (savedReceipt) {
                completedReceiptData.push({ name: phase, receipt: savedReceipt });
                emitEvent(traceFile, 'receipt.saved', {
                    parent_span:  phaseSpan,
                    phase,
                    summary:      savedReceipt.summary || null,
                    prd_path:     savedReceipt.prd_path || null,
                    tasks_count:  savedReceipt.tasks_count || null,
                    tasks_path:   savedReceipt.tasks_path || null,
                });
            }

            state.phases_completed.push(phase);
            emitEvent(traceFile, 'state.change', {
                parent_span: phaseSpan,
                key:  'phases_completed',
                from: before,
                to:   [...state.phases_completed],
            });

            closeSpan(traceFile, phaseSpan, { status: 'complete' });
            state.current_phase = null;
            saveState(sessionDir, state);
        }

        closeSpan(traceFile, pipelineSpan, { status: 'complete', phases_total: phases.length });
        state.completed_at = new Date().toISOString();
        saveState(sessionDir, state);
        console.log(`[pipeline] ALL PHASES COMPLETE session=${sessionId}`);
        return { sessionId, completed: state.phases_completed, halted: false };

    } finally {
        releaseLock(lockPath);
    }
}

async function resume(sessionId, humanHint = '', opts = {}) {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) throw new Error(`Session ${sessionId} not found`);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    if (!state.halted) throw new Error(`Session ${sessionId} is not halted`);

    state.halted = false;
    if (humanHint) { state.human_hint = humanHint; }
    saveState(sessionDir, state);

    const remaining = (state.phases || []).filter(p => !state.phases_completed.includes(p));
    return run(state.goal, remaining, { ...opts, sessionId });
}

// ── Phase execution with retry ────────────────────────────────────────────────

async function runPhaseWithRetry(phase, basePrompt, sessionDir, state, opts, traceOpts = {}) {
    const { traceFile = null, parentSpanId = null } = traceOpts;
    const history     = [];
    let verifierResult = null;

    if (!state.retry_counts) state.retry_counts = {};
    state.retry_counts[phase] = state.retry_counts[phase] || 0;

    // WAL checkpoint directory — one file per attempt, deleted on clean success
    const checkpointDir = path.join(sessionDir, 'checkpoints');
    fs.mkdirSync(checkpointDir, { recursive: true });

    const shortGoal = (state.goal || phase).slice(0, 45);

    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        state.retry_counts[phase] = attempt - 1;
        saveState(sessionDir, state);

        // WAL path for this attempt's stdout stream
        const checkpointPath = path.join(checkpointDir, `${phase}.attempt_${attempt}.out`);

        // Recover partial output from a crashed prior attempt
        let crashContext = '';
        const prevCrashFile = path.join(checkpointDir, `${phase}.attempt_${attempt - 1}.out`);
        if (attempt > 1 && fs.existsSync(prevCrashFile)) {
            try {
                crashContext = '\n\nPrevious partial output (from interrupted attempt):\n' +
                    fs.readFileSync(prevCrashFile, 'utf8').slice(0, 3000);
                fs.unlinkSync(prevCrashFile); // consume
            } catch {}
        }

        let prompt = basePrompt;
        if (attempt > 1) {
            const prevRecord = history[history.length - 1];
            const failCode   = classifyFailure(
                prevRecord?.output || prevRecord?.error || '',
                '',
                verifierResult ? { passed: verifierResult.passed, regression_count: verifierResult.failed } : {}
            );
            emitEvent(traceFile, 'retry.classified', {
                parent_span: parentSpanId,
                fail_code:   failCode,
                action:      FAILURE_CODES[failCode]?.description || 'generic retry',
            });
            prompt = buildRetryPrompt(phase, attempt, RETRY_LIMIT, prevRecord?.receipt, failCode, sessionDir, verifierResult);

            // F-TKN: downgrade model
            if (failCode === 'F-TKN' && process.env.AGENT_FAST_MODEL) {
                opts = { ...opts, model: process.env.AGENT_FAST_MODEL };
            }
        }

        // Append crash recovery context (empty string on first attempt or no crash)
        if (crashContext) prompt += crashContext;

        // Ora spinner — shows elapsed time and phase info during agent execution
        const attemptStart = Date.now();
        let spinner = null, tick = null;
        if (ora) {
            spinner = ora({ text: ` ${phase}  attempt ${attempt}/${RETRY_LIMIT}  •  0s  — ${shortGoal}`, color: 'cyan' }).start();
            tick = setInterval(() => {
                const s = Math.round((Date.now() - attemptStart) / 1000);
                spinner.text = ` ${phase}  attempt ${attempt}/${RETRY_LIMIT}  •  ${s}s  — ${shortGoal}`;
            }, 1000);
        }

        const attemptSpan = openSpan(traceFile, `attempt.${attempt}`, parentSpanId, { phase, attempt });

        const { ok, output, receipt, error } = await invokeAgentWithReceipt(
            phase, prompt,
            { model: opts.model, sessionId: opts.sessionId || state.session_id,
              traceFile, parentSpanId: attemptSpan, checkpointPath, attempt }
        );

        const validation = receipt ? validate(phase, receipt) : { ok: false, missing: ['no receipt'] };
        const phaseOk    = ok && validation.ok && receipt?.status === 'ok';

        // Run real tests after builder / auditor (async — non-blocking)
        verifierResult = null;
        if (phaseOk && PHASES_REQUIRING_VERIFICATION.has(phase)) {
            const verSpan = openSpan(traceFile, 'verifier.run', attemptSpan);
            verifierResult = await runVerifier(process.cwd());
            closeSpan(traceFile, verSpan, {
                tests:       verifierResult.total,
                passed:      verifierResult.passed,
                failed:      verifierResult.failed,
                duration_ms: verifierResult.duration_ms,
                command:     verifierResult.command || undefined,
            });
        }

        const verifierOk = !verifierResult || verifierResult.ok || verifierResult.skipped;
        const attemptOk  = phaseOk && verifierOk;

        const attemptError = attemptOk ? null
            : !ok           ? error
            : !validation.ok ? `missing fields: ${validation.missing.join(', ')}`
            : verifierResult && !verifierResult.ok
                ? `Verifier: ${verifierResult.failed}/${verifierResult.total} tests failed`
            : 'phase failed';

        history.push({ attempt, ok: attemptOk, output: output || '', receipt, error: attemptError });

        // Stop spinner — succeed or fail
        if (tick) clearInterval(tick);
        const finalElapsed = Math.round((Date.now() - attemptStart) / 1000);
        if (spinner) {
            if (attemptOk) {
                const verMsg = verifierResult && !verifierResult.skipped
                    ? `${verifierResult.passed}/${verifierResult.total} tests passed`
                    : 'done';
                spinner.succeed(` ${phase}  attempt ${attempt}/${RETRY_LIMIT}  •  ${finalElapsed}s  — ${verMsg}`);
            } else {
                spinner.fail(` ${phase}  attempt ${attempt}/${RETRY_LIMIT}  •  ${finalElapsed}s  — ${(attemptError || 'failed').slice(0, 60)}`);
            }
        }

        // Emit retry_count state change
        if (!attemptOk) {
            emitEvent(traceFile, 'state.change', {
                parent_span: attemptSpan,
                key:  `retry_counts.${phase}`,
                from: attempt - 1,
                to:   attempt,
            });
        }

        closeSpan(traceFile, attemptSpan, {
            ok:       attemptOk,
            error:    attemptError || undefined,
            verified: verifierResult && !verifierResult.skipped
                ? `${verifierResult.passed}/${verifierResult.total}`
                : undefined,
        });

        if (attemptOk) {
            const receiptDir = path.join(sessionDir, 'receipts');
            fs.mkdirSync(receiptDir, { recursive: true });
            fs.writeFileSync(path.join(receiptDir, `${phase}.json`), JSON.stringify({
                ...receipt,
                _validated_at: new Date().toISOString(),
                ...(verifierResult && !verifierResult.skipped ? { _verified: {
                    command: verifierResult.command,
                    total: verifierResult.total, passed: verifierResult.passed,
                    failed: verifierResult.failed, duration_ms: verifierResult.duration_ms,
                }} : {}),
            }, null, 2));
            return { ok: true, history };
        }
    }

    return { ok: false, history };
}

// ── Tiered context injection ──────────────────────────────────────────────────

// Lazy-loaded cl100k_base tokenizer — same BPE family as Claude/GPT-4.
// Falls back to weighted heuristic if gpt-tokenizer isn't installed.
let _encode = null;
function estimateTokens(str) {
    if (!str) return 0;
    try {
        if (!_encode) _encode = require('gpt-tokenizer').encode;
        return _encode(str).length;
    } catch {
        const len = str.length;
        const j = (str.match(/[{}\[\],:"]/g) || []).length / len;
        const c = (str.match(/[()=>;\/\\<>]/g) || []).length / len;
        const n = (str.match(/\n/g) || []).length / len;
        return Math.ceil(len / (j > 0.08 ? 3.8 : c > 0.06 ? 3.5 : n > 0.04 ? 4.2 : 4.0));
    }
}

function loadArtifacts(receipt, sessionDir) {
    const filePaths = [
        receipt.prd_path,
        receipt.tasks_path,
        ...(Array.isArray(receipt.output_files) ? receipt.output_files : []),
    ].filter(Boolean);

    return filePaths.map(p => {
        try {
            const abs = path.isAbsolute(p) ? p : path.resolve(sessionDir, p);
            if (!fs.existsSync(abs)) return '';
            return `### ${p}\n${fs.readFileSync(abs, 'utf8').slice(0, 8_000)}`;
        } catch { return ''; }
    }).filter(Boolean).join('\n\n');
}

/**
 * Build phase prompt with tiered context injection.
 * Returns { prompt, stats: { tokens_estimate, receipts_injected, tier } }
 */
function buildPhasePrompt(goal, phase, completedReceiptData, sessionDir, state) {
    let tokens = estimateTokens(goal) + 500;
    const sections = [];
    let tiers = [];

    for (let i = completedReceiptData.length - 1; i >= 0; i--) {
        const { name, receipt } = completedReceiptData[i];
        const artifacts = loadArtifacts(receipt, sessionDir);
        const full    = JSON.stringify(receipt, null, 2) + (artifacts ? '\n\n' + artifacts : '');
        const slim    = JSON.stringify(receipt);
        const summary = receipt.summary || receipt.status || `phase ${name} completed`;

        let chosen, tier;
        if (estimateTokens(full) + tokens <= CONTEXT_BUDGET) {
            chosen = full; tier = 'full';
        } else if (estimateTokens(slim) + tokens <= CONTEXT_BUDGET) {
            chosen = slim; tier = 'slim';
        } else {
            chosen = summary; tier = 'summary';
        }
        tokens += estimateTokens(chosen);
        tiers.push(tier);
        sections.unshift(`## Prior phase: ${name} [context_tier=${tier}]\n${chosen}`);
    }

    const hint = state?.human_hint ? `Human guidance: ${state.human_hint}\n\n` : '';
    const prompt = [
        hint + `# Goal\n${goal}`,
        ...sections,
        receiptInstructions(phase),
    ].join('\n\n---\n\n');

    const dominantTier = tiers.length === 0 ? 'none'
        : tiers.every(t => t === 'full') ? 'full'
        : tiers.every(t => t === 'summary') ? 'summary'
        : 'mixed';

    return {
        prompt,
        stats: {
            tokens_estimate:  tokens,
            receipts_injected: completedReceiptData.length,
            tier: dominantTier,
        },
    };
}

function buildRetryPrompt(phase, attempt, maxAttempts, prevReceipt, failCode, sessionDir, verifierResult) {
    const codeDesc = FAILURE_CODES[failCode]?.description || 'unknown failure';
    const lines = [
        `RETRY ${attempt}/${maxAttempts} for phase: ${phase}`,
        `Failure code: ${failCode} — ${codeDesc}`,
    ];

    if (failCode === 'F-REG' && verifierResult?.stdout) {
        lines.push(`\nTest output:\n${verifierResult.stdout.slice(0, 2_000)}`);
    } else if (failCode === 'F-CTX') {
        try { lines.push(`\nFile tree:\n${buildDirectoryTree(process.cwd(), 3)}`); } catch {}
    } else if (failCode === 'F-ENV') {
        lines.push(`\nNode: ${process.version}  CWD: ${process.cwd()}  Platform: ${process.platform}`);
    }

    if (prevReceipt) lines.push(`\nPrevious receipt:\n${JSON.stringify(prevReceipt).slice(0, 500)}`);
    lines.push('\nPlease fix the issue and emit a valid PhaseReceipt.');
    lines.push(receiptInstructions(phase));
    return lines.join('\n');
}

function buildDirectoryTree(dir, depth, prefix = '') {
    if (depth === 0) return '';
    const IGNORE = new Set(['node_modules', '.git', 'target', 'dist', '.memory']);
    let out = '';
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.filter(e => !IGNORE.has(e.name)).forEach((e, i, arr) => {
            const isLast = i === arr.length - 1;
            out += `${prefix}${isLast ? '└── ' : '├── '}${e.name}\n`;
            if (e.isDirectory()) {
                out += buildDirectoryTree(path.join(dir, e.name), depth - 1, prefix + (isLast ? '    ' : '│   '));
            }
        });
    } catch {}
    return out;
}

// ── Session lock ──────────────────────────────────────────────────────────────

function acquireLock(sessionDir) {
    const lockPath = path.join(sessionDir, '.lock');
    try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        fs.closeSync(fd);
        return lockPath;
    } catch {
        // Stale lock? (> 10 min)
        try {
            const content = fs.readFileSync(lockPath, 'utf8');
            const ts = parseInt((content.split(' ')[1] || '0'), 10);
            if (Date.now() - ts > 600_000) {
                fs.unlinkSync(lockPath);
                return acquireLock(sessionDir);
            }
        } catch {}
        throw new Error(
            `Session is locked by another process (${lockPath}). ` +
            `If no process is running, delete the lock file and retry.`
        );
    }
}

function releaseLock(lockPath) {
    try { fs.unlinkSync(lockPath); } catch {}
}

// ── State machine helpers ─────────────────────────────────────────────────────

function loadOrCreateState(sessionDir, sessionId, goal, phases) {
    const statePath = path.join(sessionDir, 'state.json');
    if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
    const state = {
        session_id: sessionId, goal, phases,
        phases_completed: [], current_phase: null,
        retry_counts: {}, halted: false, human_hint: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    saveState(sessionDir, state);
    return state;
}

function saveState(sessionDir, state) {
    state.updated_at = new Date().toISOString();
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

function ensureSessionDir(sessionId) {
    const dir = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
    return dir;
}

function readReceipt(sessionDir, phase) {
    const p = path.join(sessionDir, 'receipts', `${phase}.json`);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadCompletedReceiptData(completedPhases, sessionDir) {
    return completedPhases.map(name => {
        const receipt = readReceipt(sessionDir, name);
        return receipt ? { name, receipt } : null;
    }).filter(Boolean);
}

// ── Diagnostic ────────────────────────────────────────────────────────────────

function writeDiagnostic(sessionDir, phase, state, history) {
    const lines = [
        `# Pipeline Diagnostic — session ${state.session_id}`,
        `Phase: **${phase}**  |  Attempts: **${history.length}/${RETRY_LIMIT}**`,
        '', '## Failure History', '',
    ];
    for (const h of history) {
        lines.push(`### Attempt ${h.attempt}`);
        if (h.error)   lines.push(`- Error: ${h.error}`);
        if (h.receipt) lines.push(`- Receipt: \`${JSON.stringify(h.receipt).slice(0, 200)}\``);
        lines.push('');
    }
    lines.push('## Recovery');
    lines.push(`Run \`/retry ${state.session_id}\` with human guidance, or \`/abandon ${state.session_id}\` to discard.`);
    fs.writeFileSync(path.join(sessionDir, 'DIAGNOSTIC.md'), lines.join('\n'));
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

function receiptInstructions(phase) {
    return [
        `IMPORTANT: End your response with a receipt JSON block.`,
        `Required: phase="${phase}", status="ok"|"fail", summary="one-line description".`,
        '```json',
        `{ "phase": "${phase}", "status": "ok", "summary": "..." }`,
        '```',
    ].join('\n');
}

module.exports = { run, resume };

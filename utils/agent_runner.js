'use strict';
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');
const { buildCommand, buildHttpRequest, extractText, getDefaultModel, isHttpProvider, describe } = require('./cli_adapter');
const { extractReceipt } = require('./pipeline_schemas');
const { openSpan, closeSpan, emitEvent } = require('./tracer');
const { checkBudget, recordCost, recordCostFromTokens, extractUsage } = require('./budget_tracker');

const LOGS_DIR = path.join(process.cwd(), '.memory', 'sessions');

// Lazy-loaded BPE tokenizer for CLI-path cost estimation
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

// ── Core invocation ───────────────────────────────────────────────────────────

/**
 * Invoke a skill as a real sub-agent.
 *
 * @param {string} skillName
 * @param {string} goal
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.timeout]        HTTP timeout (CLI uses idle watchdog)
 * @param {string} [opts.sessionId]
 * @param {string} [opts.reqId]
 * @param {string} [opts.parentSpanId]   parent span for trace tree
 * @param {string} [opts.traceFile]      session trace.jsonl path
 * @returns {Promise<{ ok, output, reqId, error? }>}
 */
async function invokeAgent(skillName, goal, {
    model           = getDefaultModel(),
    timeout         = 120_000,
    sessionId       = 'default',
    reqId           = randomUUID(),
    parentSpanId    = null,
    traceFile       = null,
    checkpointPath  = null,   // WAL: write stdout chunks here; deleted on clean exit
    attempt         = 1,      // retry attempt number, used in cost.recorded events
} = {}) {
    // Budget guard — throws if hard limit would be exceeded
    checkBudget();

    const prompt  = `Activate skill: ${skillName}\n\nGoal: ${goal}`;
    const logPath = ensureLogFile(sessionId, skillName);
    const start   = Date.now();

    const spanId = openSpan(traceFile, 'agent.spawn', parentSpanId, {
        req_id: reqId, skill: skillName, model,
    });
    appendLog(logPath, `[${ts()}] req_id=${reqId} SPAWN skill=${skillName} ${describe()}`);

    let result;
    if (isHttpProvider()) {
        result = await invokeAgentHttp(prompt, model, reqId, logPath, start, timeout);
    } else {
        result = await invokeAgentCli(prompt, model, reqId, logPath, start, checkpointPath);
    }

    const elapsed = Date.now() - start;
    closeSpan(traceFile, spanId, {
        elapsed,
        chars: result.output?.length || 0,
        error: result.error || undefined,
        cost_usd: result._cost_usd || undefined,
    });

    // Record cost — prefer real tokens (HTTP path), fall back to gpt-tokenizer estimate (CLI path)
    if (result._usage) {
        const costUsd = recordCostFromTokens(model, result._usage.input, result._usage.output);
        emitEvent(traceFile, 'cost.recorded', {
            phase: skillName, attempt, model,
            input_tokens: result._usage.input,
            output_tokens: result._usage.output,
            cost_usd: costUsd,
            source: 'api',
        });
    } else if (result.ok && result.output?.length) {
        const inputEst  = estimateTokens(prompt);
        const outputEst = estimateTokens(result.output);
        const costUsd   = recordCostFromTokens(model, inputEst, outputEst);
        emitEvent(traceFile, 'cost.recorded', {
            phase: skillName, attempt, model,
            input_tokens: inputEst,
            output_tokens: outputEst,
            cost_usd: costUsd,
            source: 'est',
        });
    }

    const { _usage, _cost_usd, ...clean } = result;
    return { ...clean, reqId };
}

// ── CLI provider via streaming spawn ─────────────────────────────────────────

function invokeAgentCli(prompt, model, reqId, logPath, start, checkpointPath = null) {
    return new Promise(resolve => {
        let cmd;
        try {
            cmd = buildCommand(prompt, model);
        } catch (err) {
            appendLog(logPath, `[${ts()}] req_id=${reqId} CONFIG_ERROR ${err.message}`);
            resolve({ ok: false, output: '', error: err.message });
            return;
        }

        let output       = '';
        let lastActivity = Date.now();
        const idleMs     = parseInt(process.env.PHASE_IDLE_TIMEOUT_MS || '300000', 10);
        let timedOut     = false;

        const child = spawn(cmd, { shell: true, env: process.env });

        child.stdout.on('data', chunk => {
            const str = chunk.toString();
            output += str;
            lastActivity = Date.now();
            appendLog(logPath, str.trimEnd());
            // WAL: persist each chunk so a crash leaves a recoverable checkpoint
            if (checkpointPath) { try { fs.appendFileSync(checkpointPath, chunk); } catch {} }
        });
        child.stderr.on('data', chunk => {
            appendLog(logPath, `[stderr] ${chunk.toString().trimEnd()}`);
        });

        const watchdog = setInterval(() => {
            if (Date.now() - lastActivity > idleMs) {
                timedOut = true;
                child.kill('SIGTERM');
                clearInterval(watchdog);
            }
        }, 15_000);

        child.on('close', code => {
            clearInterval(watchdog);
            // Clean up WAL file on successful exit — it's only needed for crash recovery
            if (checkpointPath && code === 0) { try { fs.unlinkSync(checkpointPath); } catch {} }
            const elapsed = Date.now() - start;
            if (timedOut) {
                const msg = `Idle timeout: no output for ${idleMs / 1000}s`;
                appendLog(logPath, `[${ts()}] req_id=${reqId} IDLE_TIMEOUT elapsed=${elapsed}ms`);
                resolve({ ok: false, output: '', error: msg });
            } else if (code !== 0) {
                appendLog(logPath, `[${ts()}] req_id=${reqId} FAIL elapsed=${elapsed}ms code=${code}`);
                resolve({ ok: false, output: '', error: `Process exited with code ${code}` });
            } else {
                appendLog(logPath, `[${ts()}] req_id=${reqId} OK elapsed=${elapsed}ms chars=${output.length}`);
                resolve({ ok: true, output: output.trim() });
            }
        });
        child.on('error', err => {
            clearInterval(watchdog);
            appendLog(logPath, `[${ts()}] req_id=${reqId} FAIL error=${err.message}`);
            resolve({ ok: false, output: '', error: err.message });
        });
    });
}

// ── HTTP provider with streaming body ─────────────────────────────────────────

async function invokeAgentHttp(prompt, model, reqId, logPath, start, timeout) {
    let cfg;
    try {
        cfg = buildHttpRequest(prompt, model);
    } catch (err) {
        appendLog(logPath, `[${ts()}] req_id=${reqId} CONFIG_ERROR ${err.message}`);
        return { ok: false, output: '', error: err.message };
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(cfg.url, {
            method:  'POST',
            headers: cfg.headers,
            body:    JSON.stringify(cfg.body),
            signal:  controller.signal,
        });
        clearTimeout(timer);

        // Stream response body for heartbeat visibility on long completions
        let accumulated = '';
        if (res.body) {
            const reader  = res.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                accumulated += chunk;
                appendLog(logPath, `[stream] +${chunk.length}B`);
            }
        } else {
            accumulated = await res.text();
        }

        let json;
        try { json = JSON.parse(accumulated); } catch {
            const elapsed = Date.now() - start;
            appendLog(logPath, `[${ts()}] req_id=${reqId} FAIL elapsed=${elapsed}ms error=invalid_json`);
            return { ok: false, output: '', error: 'Response was not valid JSON' };
        }

        if (!res.ok) {
            const msg = json?.error?.message || JSON.stringify(json);
            const elapsed = Date.now() - start;
            appendLog(logPath, `[${ts()}] req_id=${reqId} FAIL elapsed=${elapsed}ms http=${res.status} error=${msg}`);
            return { ok: false, output: '', error: `HTTP ${res.status}: ${msg}` };
        }

        const output  = extractText(json);
        const usage   = extractUsage(json);
        const elapsed = Date.now() - start;
        appendLog(logPath, `[${ts()}] req_id=${reqId} OK elapsed=${elapsed}ms chars=${output.length} tokens_in=${usage.input} tokens_out=${usage.output}`);
        return { ok: true, output, _usage: usage };
    } catch (err) {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        const message = err.name === 'AbortError' ? `Timeout after ${timeout}ms` : (err.message || String(err));
        appendLog(logPath, `[${ts()}] req_id=${reqId} FAIL elapsed=${elapsed}ms error=${message}`);
        return { ok: false, output: '', error: message };
    }
}

// ── Receipt-enforced invocation ───────────────────────────────────────────────

async function invokeAgentWithReceipt(skillName, goal, opts = {}) {
    const result  = await invokeAgent(skillName, goal, opts);
    const receipt = result.ok ? extractReceipt(result.output) : null;

    if (result.ok && !receipt) {
        result.ok    = false;
        result.error = 'No valid receipt JSON found in output';
    }
    return { ...result, receipt };
}

// ── Serial execution ──────────────────────────────────────────────────────────

async function invokeAgentsSerial(tasks, opts = {}) {
    const results = [];
    for (const { skill, goal } of tasks) {
        const r = await invokeAgent(skill, goal, opts);
        results.push({ skill, ...r });
        if (!r.ok) {
            appendLog(
                ensureLogFile(opts.sessionId || 'default', 'orchestrator'),
                `[${ts()}] req_id=${r.reqId} TOPOLOGY_COLLAPSE at skill=${skill} reason=${r.error}`
            );
            break;
        }
    }
    return results;
}

// ── Parallel execution with serial fallback ───────────────────────────────────

/**
 * Invoke multiple agents in parallel.
 * On failure: partial topology collapse — only failed branches are retried serially.
 * Succeeded results are preserved at their original positions.
 */
async function invokeAgentsParallel(tasks, opts = {}) {
    const logPath = ensureLogFile(opts.sessionId || 'default', 'orchestrator');
    appendLog(logPath, `[${ts()}] PARALLEL_START tasks=${tasks.map(t => t.skill).join(',')}`);

    const settled = await Promise.allSettled(
        tasks.map(({ skill, goal }) => invokeAgent(skill, goal, opts))
    );

    const results       = new Array(tasks.length).fill(null);
    const failedIndexes = [];

    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled' && r.value.ok) {
            results[i] = { skill: tasks[i].skill, ...r.value };
        } else {
            failedIndexes.push(i);
        }
    }

    if (failedIndexes.length === 0) {
        appendLog(logPath, `[${ts()}] PARALLEL_COMPLETE all=${tasks.length} ok`);
        return results;
    }

    // Partial collapse — retry only the failed branches serially
    const failedTasks = failedIndexes.map(i => tasks[i]);
    appendLog(logPath,
        `[${ts()}] TOPOLOGY_PARTIAL_COLLAPSE parallel→serial` +
        ` failed=${failedIndexes.length}/${tasks.length}` +
        ` retrying=[${failedTasks.map(t => t.skill).join(',')}]`
    );
    const serialResults = await invokeAgentsSerial(failedTasks, opts);

    // Merge serial results back at their original positions
    for (let j = 0; j < failedIndexes.length; j++) {
        results[failedIndexes[j]] = serialResults[j];
    }
    return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureLogFile(sessionId, skillName) {
    const dir = path.join(LOGS_DIR, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${skillName}.log`);
}

function appendLog(filePath, line) {
    try { fs.appendFileSync(filePath, line + '\n'); } catch {}
}

function ts() { return new Date().toISOString(); }

module.exports = { invokeAgent, invokeAgentWithReceipt, invokeAgentsSerial, invokeAgentsParallel };

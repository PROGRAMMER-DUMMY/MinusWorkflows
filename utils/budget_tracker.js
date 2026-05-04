'use strict';
const fs   = require('fs');
const path = require('path');

const BUDGET_FILE   = path.join(process.cwd(), '.memory', 'budget_session.json');
const SESSIONS_DIR  = path.join(process.cwd(), '.memory', 'sessions');

// Per-million-token pricing (USD) — updated 2026-05
const MODEL_PRICING = {
    'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
    'claude-opus-4-7':           { input: 15.00, output: 75.00 },
    'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00  },
    'claude-haiku-4-5':          { input: 0.80,  output: 4.00  },
    'gpt-4o':                    { input: 5.00,  output: 15.00 },
    'gpt-4o-mini':               { input: 0.15,  output: 0.60  },
    'gemini-2.0-flash':          { input: 0.075, output: 0.30  },
    'gemini-1.5-pro':            { input: 3.50,  output: 10.50 },
};
const DEFAULT_PRICING = { input: 3.00, output: 15.00 }; // sonnet-class fallback

function getSessionBudget() {
    if (fs.existsSync(BUDGET_FILE)) {
        try { return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); } catch {}
    }
    return { strategy: 'medium', hardLimit: null, spent: 0 };
}

function saveSessionBudget(data) {
    fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(data, null, 2));
}

/**
 * Throws if spending hardLimit would be breached.
 * Call before invokeAgent to block over-budget invocations.
 */
function checkBudget(estimatedCost = 0) {
    const budget = getSessionBudget();
    if (budget.hardLimit !== null && (budget.spent + estimatedCost) > budget.hardLimit) {
        throw new Error(
            `Budget hard limit $${budget.hardLimit} reached (spent: $${budget.spent.toFixed(4)}). ` +
            `Raise BUDGET_HARD_LIMIT in .env or delete .memory/budget_session.json to reset.`
        );
    }
}

/**
 * Record real cost from API usage tokens (preferred over char-based proxy).
 * Returns the USD cost recorded.
 */
function recordCostFromTokens(model, inputTokens, outputTokens) {
    const p    = MODEL_PRICING[model] || DEFAULT_PRICING;
    const cost = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
    recordCost(cost);
    return cost;
}

/** Record cost from a raw USD amount (used as fallback from char proxy). */
function recordCost(cost) {
    const budget = getSessionBudget();
    budget.spent = (budget.spent || 0) + cost;
    saveSessionBudget(budget);
}

/** Extract usage tokens from provider API response (anthropic / openai / google). */
function extractUsage(json, format) {
    const fmt = (format || process.env.AGENT_API_FORMAT || 'openai').toLowerCase();
    if (fmt === 'anthropic') return { input: json?.usage?.input_tokens || 0,  output: json?.usage?.output_tokens || 0 };
    if (fmt === 'google')    return { input: json?.usageMetadata?.promptTokenCount || 0, output: json?.usageMetadata?.candidatesTokenCount || 0 };
    // openai / openai-compatible
    return { input: json?.usage?.prompt_tokens || 0, output: json?.usage?.completion_tokens || 0 };
}

/**
 * Lifetime spend across all sessions.
 * days=null → all-time total (reads global budget_session.json, O(1)).
 * days=N    → rolling N-day window (scans trace.jsonl files for cost.recorded events).
 */
function getLifetimeSpend(days = null) {
    if (!days) {
        try {
            if (fs.existsSync(BUDGET_FILE)) {
                return { total: JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')).spent || 0 };
            }
        } catch {}
        return { total: 0 };
    }
    // Rolling window — scan cost.recorded events from every session trace
    if (!fs.existsSync(SESSIONS_DIR)) return { total: 0 };
    const cutoff = Date.now() - days * 86_400_000;
    let total = 0;
    try {
        for (const sid of fs.readdirSync(SESSIONS_DIR)) {
            const traceFile = path.join(SESSIONS_DIR, sid, 'trace.jsonl');
            if (!fs.existsSync(traceFile)) continue;
            const lines = fs.readFileSync(traceFile, 'utf8').split('\n');
            for (const line of lines) {
                try {
                    const e = JSON.parse(line);
                    if (e.event === 'cost.recorded' && e.t >= cutoff) total += e.cost_usd || 0;
                } catch {}
            }
        }
    } catch {}
    return { total };
}

/**
 * Read cost.recorded events from a session's trace.jsonl.
 * Returns array of { phase, attempt, model, input_tokens, output_tokens, cost_usd, source }.
 */
function getSessionCostFromTrace(traceFile) {
    if (!fs.existsSync(traceFile)) return [];
    try {
        return fs.readFileSync(traceFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .reduce((acc, line) => {
                try {
                    const e = JSON.parse(line);
                    if (e.event === 'cost.recorded') acc.push(e);
                } catch {}
                return acc;
            }, []);
    } catch { return []; }
}

/** Legacy tier-based authorization (kept for backward compat). */
async function authorizeModelTier(tier, estimatedCost = 0) {
    const budget = getSessionBudget();
    if (budget.hardLimit !== null && (budget.spent + estimatedCost) > budget.hardLimit) {
        throw new Error(`Budget exceeded: $${budget.spent} / $${budget.hardLimit}`);
    }
    if (budget.strategy === 'low' && tier === 'Ultra') return 'Pro';
    return tier;
}

module.exports = { checkBudget, recordCost, recordCostFromTokens, extractUsage, getSessionBudget, authorizeModelTier, MODEL_PRICING, getLifetimeSpend, getSessionCostFromTrace };

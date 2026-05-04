'use strict';
const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');

// ── Write API ─────────────────────────────────────────────────────────────────

function openSpan(traceFile, name, parentId = null, meta = {}) {
    if (!traceFile) return null;
    const span = { span_id: randomUUID(), parent: parentId, name, t: Date.now(), ...meta };
    try { fs.appendFileSync(traceFile, JSON.stringify(span) + '\n'); } catch {}
    return span.span_id;
}

function closeSpan(traceFile, spanId, result = {}) {
    if (!traceFile || !spanId) return;
    const entry = { span_id: spanId, event: 'close', t: Date.now(), ...result };
    try { fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n'); } catch {}
}

/**
 * Emit a point-in-time event (no open/close pair).
 * Used for state changes, receipt saves, retry classification.
 */
function emitEvent(traceFile, name, meta = {}) {
    if (!traceFile) return;
    const entry = { event: name, t: Date.now(), ...meta };
    try { fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n'); } catch {}
}

// ── Render API ────────────────────────────────────────────────────────────────

/**
 * Render trace.jsonl as an indented ASCII tree.
 * Reads state.json from same directory to get goal + datetime for header.
 * Session UUID is hidden — header shows goal + timestamp instead.
 */
function renderTrace(traceFile) {
    if (!fs.existsSync(traceFile)) return '(no trace found)';

    const sessionDir = path.dirname(traceFile);
    const header     = buildHeader(sessionDir);

    const raw    = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean);
    const spans  = {};   // span_id → span object with .children[]
    const closes = {};   // span_id → close entry
    const events = [];   // point-in-time events (state.change, receipt.saved, etc.)

    for (const line of raw) {
        try {
            const e = JSON.parse(line);
            if (e.span_id && e.event === 'close') {
                closes[e.span_id] = e;
            } else if (e.span_id && !e.event) {
                spans[e.span_id] = { ...e, children: [], pointEvents: [] };
            } else if (e.event) {
                events.push(e);
            }
        } catch {}
    }

    // Attach point events to their nearest parent span by timestamp proximity
    for (const ev of events) {
        const parent = ev.parent_span || findNearestOpenSpan(spans, closes, ev.t);
        if (parent && spans[parent]) {
            spans[parent].pointEvents.push(ev);
        }
    }

    // Wire parent → children
    const roots = [];
    for (const span of Object.values(spans)) {
        if (span.parent && spans[span.parent]) {
            spans[span.parent].children.push(span);
        } else {
            roots.push(span);
        }
    }

    // Sort children by open time
    for (const span of Object.values(spans)) {
        span.children.sort((a, b) => a.t - b.t);
        span.pointEvents.sort((a, b) => a.t - b.t);
    }

    let out = header + '\n';
    roots.forEach((root, i) => {
        out += renderRoot(root, spans, closes);
    });

    return out;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function buildHeader(sessionDir) {
    try {
        const statePath = path.join(sessionDir, 'state.json');
        if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            const dt    = fmtDatetime(state.created_at);
            const goal  = (state.goal || '').slice(0, 80);
            const status = state.halted       ? '[halted]'
                         : state.completed_at ? '[complete]'
                         :                      '[running]';
            return `${dt}  "${goal}"  ${status}`;
        }
    } catch {}
    return '(session state not found)';
}

function renderRoot(root, spans, closes) {
    const d    = dur(root.span_id, spans, closes);
    const meta = spanMeta(root, closes);
    let out = `${root.name}${d ? `  ${d}` : ''}${meta}\n`;
    renderPointEvents(root.pointEvents, '', out);
    out += renderPointEventsStr(root.pointEvents, '');
    root.children.forEach((c, i) => {
        out += renderNode(c, '', i === root.children.length - 1, spans, closes);
    });
    return out;
}

function renderNode(span, prefix, isLast, spans, closes) {
    const branch = isLast ? '└── ' : '├── ';
    const d      = dur(span.span_id, spans, closes);
    const meta   = spanMeta(span, closes);
    const status = closes[span.span_id]?.error ? '  [FAIL]' : '';
    let out = `${prefix}${branch}${span.name}${d ? `  ${d}` : ''}${meta}${status}\n`;

    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    // Point events inline before children
    out += renderPointEventsStr(span.pointEvents, childPrefix);

    span.children.forEach((c, i) => {
        out += renderNode(c, childPrefix, i === span.children.length - 1, spans, closes);
    });
    return out;
}

function renderPointEventsStr(pointEvents, prefix) {
    if (!pointEvents?.length) return '';
    let out = '';
    for (const ev of pointEvents) {
        const line = formatPointEvent(ev);
        if (line) out += `${prefix}·   ${line}\n`;
    }
    return out;
}

function formatPointEvent(ev) {
    switch (ev.event) {
        case 'state.change': {
            const key   = ev.key || 'state';
            const from  = JSON.stringify(ev.from ?? []);
            const to    = JSON.stringify(ev.to ?? []);
            return `state: ${key}  ${from} → ${to}`;
        }
        case 'receipt.saved': {
            const parts = [];
            if (ev.summary)      parts.push(`summary="${ev.summary.slice(0, 60)}"`);
            if (ev.prd_path)     parts.push(`prd_path=${path.basename(ev.prd_path)}`);
            if (ev.tasks_count)  parts.push(`tasks=${ev.tasks_count}`);
            if (ev.tasks_path)   parts.push(`tasks_path=${path.basename(ev.tasks_path)}`);
            return `receipt: ${parts.join('  ') || '(saved)'}`;
        }
        case 'retry.classified': {
            return `retry: code=${ev.fail_code}  action="${ev.action || 'targeted injection'}"`;
        }
        case 'context.built': {
            return `context: tokens_est=${ev.tokens_estimate}  receipts=${ev.receipts_injected}  tier=${ev.tier || 'mixed'}`;
        }
        default:
            return ev.event ? `${ev.event}: ${JSON.stringify(ev).slice(0, 80)}` : '';
    }
}

function spanMeta(span, closes) {
    const c = closes[span.span_id] || {};
    const p = [];

    if (span.req_id)              p.push(`req_id=${span.req_id.slice(0, 8)}`);
    if (span.model)               p.push(`model=${span.model.split('-').slice(-2).join('-')}`);
    if (c.elapsed !== undefined)  p.push(`elapsed=${(c.elapsed / 1000).toFixed(1)}s`);
    if (c.chars    !== undefined) p.push(`chars=${c.chars.toLocaleString()}`);
    if (span.tokens_estimate)     p.push(`~${span.tokens_estimate.toLocaleString()}tok`);
    if (span.receipts_injected)   p.push(`ctx=${span.receipts_injected} phases`);
    if (c.tests    !== undefined) p.push(`tests=${c.tests}`);
    if (c.passed   !== undefined) p.push(`passed=${c.passed}`);
    if (c.failed   !== undefined && c.failed > 0) p.push(`failed=${c.failed}`);
    if (c.cost_usd !== undefined) p.push(`$${c.cost_usd.toFixed(5)}`);
    if (c.error)                  p.push(`error="${String(c.error).slice(0, 50)}"`);

    return p.length ? `  ${p.join('  ')}` : '';
}

function dur(spanId, spans, closes) {
    const o = spans[spanId], c = closes[spanId];
    if (!o || !c) return '';
    const ms = c.t - o.t;
    return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min`
         : ms >= 1000   ? `${(ms / 1000).toFixed(1)}s`
         :                `${ms}ms`;
}

function findNearestOpenSpan(spans, closes, eventTime) {
    let best = null, bestDelta = Infinity;
    for (const [id, span] of Object.entries(spans)) {
        const close = closes[id];
        const openT  = span.t;
        const closeT = close ? close.t : Infinity;
        if (eventTime >= openT && eventTime <= closeT) {
            const delta = eventTime - openT;
            if (delta < bestDelta) { bestDelta = delta; best = id; }
        }
    }
    return best;
}

function fmtDatetime(iso) {
    if (!iso) return '(unknown time)';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// unused helper kept to avoid lint noise
function renderPointEvents() {}

module.exports = { openSpan, closeSpan, emitEvent, renderTrace };

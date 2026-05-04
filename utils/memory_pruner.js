'use strict';
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { buildCommand, getDefaultModel } = require('./cli_adapter');

const MAX_BYTES = 50_000; // 50 KB — prune when EVOLUTION.md exceeds this

/**
 * Prune EVOLUTION.md if it exceeds MAX_BYTES.
 * Archives full content first, then summarizes using the active AI CLI provider.
 * No-op when under threshold — safe to call on every evolve invocation.
 *
 * @param {string} [evolutionPath] - defaults to .memory/EVOLUTION.md
 */
function pruneIfNeeded(evolutionPath) {
    evolutionPath = evolutionPath || path.join(process.cwd(), '.memory', 'EVOLUTION.md');

    if (!fs.existsSync(evolutionPath)) return;

    const content = fs.readFileSync(evolutionPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') < MAX_BYTES) return;

    console.log(`  memory_pruner: EVOLUTION.md exceeds ${MAX_BYTES} bytes — summarizing…`);

    // Archive verbatim copy — never lose history
    const archivePath = evolutionPath.replace('EVOLUTION.md', 'EVOLUTION_ARCHIVE.md');
    fs.appendFileSync(
        archivePath,
        `\n\n---\n[Archived ${new Date().toISOString()} — ${content.length} chars]\n\n` + content
    );

    const summarized = summarize(content);
    fs.writeFileSync(evolutionPath, summarized);
    console.log(
        `  memory_pruner: pruned to ${Buffer.byteLength(summarized, 'utf8')} bytes` +
        `, archive → ${archivePath}`
    );
}

function summarize(content) {
    const prompt = [
        "You are summarizing an AI system's evolutionary heuristics log.",
        'Condense the following into a compact, well-structured Markdown document.',
        'Keep every distinct rule, lesson, or validated fallback — discard only repeated or superseded entries.',
        'Output format: # Evolutionary Heuristics\n\n## Heuristics\n\n- <rule>\n...',
        '',
        '--- BEGIN LOG ---',
        content,
        '--- END LOG ---',
    ].join('\n');

    // Use a fast/cheap model for summarization when possible
    const fastModel = process.env.AGENT_FAST_MODEL || getDefaultModel();

    try {
        const cmd = buildCommand(prompt, fastModel);
        const result = execSync(cmd, {
            timeout: 60_000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return result || fallbackSummary(content);
    } catch (_) {
        return fallbackSummary(content);
    }
}

function fallbackSummary(content) {
    const kept = content
        .split('\n')
        .filter(l => l.startsWith('#') || l.startsWith('- ') || l.startsWith('* ') || l.trim() === '');
    return [
        '# Evolutionary Heuristics',
        '',
        `> Summarized ${new Date().toISOString()} (full history in EVOLUTION_ARCHIVE.md)`,
        '',
        '## Heuristics',
        '',
        ...kept.slice(0, 200),
    ].join('\n');
}

module.exports = { pruneIfNeeded };

// Run directly: node utils/memory_pruner.js [path/to/EVOLUTION.md]
if (require.main === module) pruneIfNeeded(process.argv[2]);

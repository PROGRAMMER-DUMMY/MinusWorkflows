'use strict';

/**
 * Per-phase receipt schemas.
 * Each schema defines required fields that the AI must include in its output JSON
 * for the pipeline executor to accept the phase as complete.
 *
 * The AI is instructed to end its response with a JSON block matching this schema.
 * Any field listed in `required` must be present and non-null — otherwise the
 * executor treats the phase as failed and retries.
 */
const SCHEMAS = {
    architect: {
        required: ['phase', 'status', 'prd_summary', 'requirements'],
        optional: ['constraints', 'open_questions'],
        description: 'Architecture and PRD phase — defines what to build',
    },
    planner: {
        required: ['phase', 'status', 'tasks_count', 'tasks_path'],
        optional: ['topology', 'parallel_groups'],
        description: 'Planning phase — produces dependency-tagged TASKS.json',
    },
    builder: {
        required: ['phase', 'status', 'files_changed', 'tests_passed'],
        optional: ['failure_reason', 'compile_errors', 'test_failures'],
        description: 'Build phase — implements tasks and runs tests',
    },
    auditor: {
        required: ['phase', 'status', 'checks_passed', 'issues'],
        optional: ['coverage', 'lint_errors', 'security_findings'],
        description: 'Audit phase — validates output against requirements',
    },
    evolve: {
        required: ['phase', 'status', 'heuristics_added'],
        optional: ['lessons_learned', 'patterns_validated'],
        description: 'Evolution phase — captures lessons to EVOLUTION.md',
    },
    maintainer: {
        required: ['phase', 'status', 'files_changed'],
        optional: ['tests_passed', 'failure_reason'],
        description: 'Fast-track maintainer phase — isolated bug fixes',
    },
};

/**
 * Validate a parsed receipt object against the schema for a given phase.
 * Returns { ok: true } or { ok: false, missing: string[] }.
 */
function validate(phase, receipt) {
    const schema = SCHEMAS[phase];
    if (!schema) return { ok: false, missing: [`unknown phase: ${phase}`] };

    const missing = schema.required.filter(field =>
        receipt[field] === undefined || receipt[field] === null
    );

    return missing.length === 0
        ? { ok: true }
        : { ok: false, missing };
}

/**
 * Extract the last valid JSON object from a text string.
 * The AI is expected to end its response with a receipt JSON block.
 */
function extractReceipt(text) {
    const blocks = [];
    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                blocks.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }

    // Try parsing from the last block backwards — the receipt is typically at the end
    for (let i = blocks.length - 1; i >= 0; i--) {
        try {
            const parsed = JSON.parse(blocks[i]);
            if (parsed.phase && parsed.status) return parsed;
        } catch (_) {}
    }

    return null;
}

/**
 * Build the retry injection prefix for a failed phase attempt.
 */
function retryPrompt(phase, attempt, maxAttempts, receipt) {
    const failureReason = receipt?.failure_reason || 'receipt missing or invalid';
    const issues = receipt?.issues || receipt?.test_failures || receipt?.compile_errors || [];
    const issuesList = Array.isArray(issues) && issues.length > 0
        ? issues.map(i => `  - ${i}`).join('\n')
        : '  (no structured issues provided)';

    return [
        `PIPELINE RETRY (attempt ${attempt}/${maxAttempts}):`,
        `Phase: ${phase}`,
        `Previous attempt failed: ${failureReason}`,
        `Failed checks:\n${issuesList}`,
        '',
        'Correct the issues above. End your response with a valid receipt JSON block matching:',
        JSON.stringify(
            Object.fromEntries(SCHEMAS[phase]?.required.map(f => [f, `<${f}>`]) ?? []),
            null, 2
        ),
    ].join('\n');
}

module.exports = { SCHEMAS, validate, extractReceipt, retryPrompt };

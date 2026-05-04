/**
 * ✦ Failure Mode Taxonomy
 * Categorizes agent failures according to v1.0 Framework.
 */

const FAILURE_CODES = {
    'F-LOC': { category: 'Localization failure', description: 'Agent patched wrong file/function' },
    'F-CTX': { category: 'Context truncation', description: 'Required code not passed to patch step' },
    'F-PAT': { category: 'Patch invalid', description: 'git apply fails; malformed diff' },
    'F-REG': { category: 'Regression introduced', description: 'Target passes, but other tests break' },
    'F-DEC': { category: 'Decomposition failure', description: 'Orchestrator scoped task incorrectly' },
    'F-HND': { category: 'Handoff failure', description: 'Subagent missing context from upstream' },
    'F-SYN': { category: 'Synthesis failure', description: 'Subagent outputs combined incoherently' },
    'F-TKN': { category: 'Token budget exceeded', description: 'Task abandoned mid-execution' },
    'F-ENV': { category: 'Environment error', description: 'Docker, pytest, or scaffold issue' }
};

function classifyFailure(logs, diff, testResults) {
    const text = logs || '';

    // Patch / diff failures
    if (/git apply failed|malformed diff|hunk failed|patch does not apply/i.test(text)) return 'F-PAT';

    // Token budget exceeded
    if (/context.?window.?exceeded|max.?tokens|context.?length.?exceeded|token.?budget|input.?too.?long/i.test(text)) return 'F-TKN';

    // Environment errors — missing modules, broken deps, scaffold issues
    if (/cannot find module|module not found|enoent.*node_modules|command not found|docker.*error|npm err!|pip.*error|cargo.*error.*could not compile|SyntaxError:.*unexpected token/i.test(text)) return 'F-ENV';

    // File localization errors — ENOENT on source files, wrong patch target
    if (/enoent|no such file or directory|file not found|path.*does not exist/i.test(text)) return 'F-LOC';

    // Regressions — test assertion failures, previously-passing tests now failing
    if (testResults && typeof testResults.passed === 'number' && testResults.passed > 0 &&
        typeof testResults.regression_count === 'number' && testResults.regression_count > 0) return 'F-REG';
    if (/assertion.*(failed|error)|expect.*received|✕|✗|● .*(failed|error)|tests? failed.*previously passing|AssertionError|assert\..*Error/i.test(text)) return 'F-REG';

    // Type / reference errors → agent patched wrong location
    if (/TypeError:|ReferenceError:|AttributeError:|NameError:/i.test(text)) return 'F-LOC';

    // Missing upstream context injected from prior phase
    if (/undefined.*context|missing.*context|context.*missing|upstream.*not.*found|prior phase.*not available/i.test(text)) return 'F-HND';

    // Synthesis failure — long output but no receipt JSON emitted
    if (text.length > 3000 && !/```json|"phase"\s*:/i.test(text)) return 'F-SYN';

    // Default: localization (agent produced output but tests failed)
    return 'F-LOC';
}

module.exports = { FAILURE_CODES, classifyFailure };

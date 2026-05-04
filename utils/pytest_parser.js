const fs = require('fs');
const xml2js = require('xml2js');

/**
 * ✦ Pytest XML Parser
 * Extracts deterministic scores from evaluation runs.
 */
async function parsePytestResults(xmlPath) {
    if (!fs.existsSync(xmlPath)) {
        throw new Error(`Evaluation results not found at: ${xmlPath}`);
    }

    const xmlData = fs.readFileSync(xmlPath, 'utf8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);

    const testsuite = result.testsuites.testsuite[0].$;
    const tests = parseInt(testsuite.tests);
    const failures = parseInt(testsuite.failures);
    const errors = parseInt(testsuite.errors);
    const skipped = parseInt(testsuite.skipped);

    const passed = tests - failures - errors - skipped;
    const solveRate = (passed / tests) * 100;

    return {
        total_tests: tests,
        passed: passed,
        failed: failures + errors,
        skipped: skipped,
        solve_rate: solveRate.toFixed(2)
    };
}

module.exports = { parsePytestResults };

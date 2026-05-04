#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const { randomBytes, randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const PKG     = require('../package.json');
const ROOT    = path.join(__dirname, '..');
const VERSION = PKG.version;

// ── ANSI colors (no dependencies) ─────────────────────────────────────────────
const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    green:  '\x1b[32m',
    red:    '\x1b[31m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
};
const ok   = msg => `  ${C.green}✓${C.reset}  ${msg}`;
const fail = msg => `  ${C.red}✗${C.reset}  ${msg}`;
const info = msg => `  ${C.dim}·${C.reset}  ${msg}`;

// ── Env loader ────────────────────────────────────────────────────────────────
function loadEnv() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return {};
    const out = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (v) out[k] = v;
    }
    return out;
}

// ── Arg parser ────────────────────────────────────────────────────────────────
function parseArgs(args) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { positional.push(...args.slice(i + 1)); break; }
        if (args[i].startsWith('--')) {
            const k = args[i].slice(2);
            const next = args[i + 1];
            flags[k] = next && !next.startsWith('--') ? args[++i] : true;
        } else {
            positional.push(args[i]);
        }
    }
    return { flags, positional };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function req(method, url, body, headers = {}) {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
}

// ── Readline helpers ──────────────────────────────────────────────────────────
function ask(question, def = '') {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(def ? `${question} [${def}]: ` : `${question}: `, ans => {
            rl.close();
            resolve(ans.trim() || def);
        });
    });
}

async function choose(question, choices) {
    console.log(`\n${question}`);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    const raw = await ask('Choice', '1');
    const n = parseInt(raw, 10) - 1;
    return choices[Math.max(0, Math.min(choices.length - 1, isNaN(n) ? 0 : n))];
}

// ── CLI detection ─────────────────────────────────────────────────────────────
function detectCLIs() {
    const found = [];
    for (const bin of ['claude', 'gemini', 'openai']) {
        try { execSync(`${bin} --version`, { stdio: 'pipe' }); found.push(bin); } catch {}
    }
    return found;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdInit() {
    console.log(`\n${C.bold}minus init${C.reset} — one-time setup\n`);

    const envPath = path.join(ROOT, '.env');
    if (fs.existsSync(envPath)) {
        const ow = await ask('.env already exists. Overwrite? (y/N)', 'N');
        if (ow.toLowerCase() !== 'y') {
            console.log(`Keeping existing .env. Run ${C.cyan}minus status${C.reset} to verify.`);
            return;
        }
    }

    // Provider choice
    const detected = detectCLIs();
    let provider = 'http';
    let apiUrl = '', apiKey = '', apiFormat = '';

    if (detected.length) {
        console.log(`Detected CLI providers: ${C.cyan}${detected.join(', ')}${C.reset}`);
        const choice = await choose(
            'Which provider for sub-agent execution?',
            [...detected, 'http (direct API — no CLI binary needed)']
        );
        provider = choice.startsWith('http') ? 'http' : choice;
    } else {
        console.log(`No CLI providers found. Using HTTP API mode.`);
    }

    if (provider === 'http') {
        const fmt = await choose('API format?', ['anthropic', 'openai', 'google', 'openai-compatible (custom URL)']);
        apiFormat = fmt.startsWith('openai-compatible') ? 'openai' : fmt.split(' ')[0];
        const defaults = {
            anthropic: 'https://api.anthropic.com/v1/messages',
            openai:    'https://api.openai.com/v1/chat/completions',
            google:    'https://generativelanguage.googleapis.com/v1beta/models',
        };
        apiUrl = await ask('API URL', defaults[apiFormat] || '');
        apiKey = await ask('API Key (leave blank to set later)');
    }

    // Generate secrets
    const newApiKey   = randomBytes(32).toString('hex');
    const newAdminKey = randomBytes(32).toString('hex');

    // Build .env from template
    const examplePath = path.join(ROOT, '.env.example');
    let content = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
    const setVar = (src, k, v) => {
        const re = new RegExp(`^#?\\s*${k}=.*`, 'm');
        const line = `${k}=${v}`;
        return re.test(src) ? src.replace(re, line) : src + `\n${line}`;
    };

    content = setVar(content, 'API_KEY',   newApiKey);
    content = setVar(content, 'ADMIN_KEY', newAdminKey);
    if (provider !== 'http') {
        content = setVar(content, 'AGENT_CLI', provider);
    } else {
        content = setVar(content, 'AGENT_PROVIDER', 'http');
        if (apiUrl)    content = setVar(content, 'AGENT_API_URL',    apiUrl);
        if (apiKey)    content = setVar(content, 'AGENT_API_KEY',    apiKey);
        if (apiFormat) content = setVar(content, 'AGENT_API_FORMAT', apiFormat);
    }

    fs.writeFileSync(envPath, content);
    console.log(`\n${ok('.env written')}`);
    console.log(info(`API_KEY    ${newApiKey.slice(0, 12)}...  (save this)`));
    console.log(info(`ADMIN_KEY  ${newAdminKey.slice(0, 12)}...  (save this)`));
    console.log(info(`Provider   ${provider}${apiFormat ? ` (${apiFormat})` : ''}`));

    // Install skills
    console.log(`\nInstalling skills into your AI CLI(s)...`);
    try { execSync('node install.js', { cwd: ROOT, stdio: 'inherit' }); } catch {}

    const startNow = await ask('\nStart memory service now? Requires Docker. (Y/n)', 'Y');
    if (startNow.toLowerCase() !== 'n') {
        await cmdStart();
    } else {
        console.log(`\nRun ${C.cyan}minus start${C.reset} when ready.`);
        console.log(`Run ${C.cyan}minus --help${C.reset} to see all commands.\n`);
    }
}

async function cmdStart() {
    console.log(`\n${C.bold}Starting memory service...${C.reset}`);

    const composePath = path.join(ROOT, 'docker-compose.yml');
    if (!fs.existsSync(composePath)) {
        console.error(fail(`docker-compose.yml not found`));
        process.exitCode = 1; return;
    }
    try {
        execSync('docker-compose up -d', { cwd: ROOT, stdio: 'inherit' });
    } catch {
        console.error(fail(`docker-compose up failed — is Docker running?`));
        process.exitCode = 1; return;
    }

    const env     = { ...loadEnv(), ...process.env };
    const baseUrl = env.OCR_MEMORY_URL || 'http://localhost:3000';

    process.stdout.write(`Waiting for ${baseUrl}/health`);
    let ready = false;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        process.stdout.write('.');
        try {
            const r = await req('GET', `${baseUrl}/health`);
            if (r.status === 200 && r.json?.status === 'ok') { ready = true; break; }
        } catch {}
    }
    console.log('');

    if (ready) {
        console.log(ok(`Service healthy at ${baseUrl}`));
        await cmdStatus();
    } else {
        console.error(fail(`Not healthy after 60s. Check: docker-compose logs ocr_engine`));
        process.exitCode = 1;
    }
}

function cmdStop() {
    try {
        execSync('docker-compose down', { cwd: ROOT, stdio: 'inherit' });
        console.log(ok('Stopped'));
    } catch { process.exitCode = 1; }
}

async function cmdStatus() {
    const env     = { ...loadEnv(), ...process.env };
    const baseUrl = env.OCR_MEMORY_URL || 'http://localhost:3000';

    console.log(`\n${C.bold}Service health${C.reset}`);

    let health = null;
    try {
        const r = await req('GET', `${baseUrl}/health`);
        health = r.json;
    } catch {}

    const row = (label, value, isOk) => {
        const mark = isOk ? ok(label.padEnd(18) + value) : fail(label.padEnd(18) + value);
        console.log(mark);
    };

    if (health) {
        row('OCR-Memory',  health.status || '?',   health.status === 'ok');
        row('Database',    health.db     || '?',   health.db === 'ok');
        row('Cache',       health.cache  || '?',   !(health.cache || '').startsWith('error'));
        row('Mode',        health.mode   || '?',   true);
    } else {
        console.log(fail(`OCR-Memory unreachable at ${baseUrl}`));
        console.log(info('Run: minus start'));
    }

    console.log(`\n${C.bold}Provider config${C.reset}`);
    const prov = env.AGENT_PROVIDER === 'http' ? 'http' : (env.AGENT_CLI || 'claude');
    row('Agent provider', prov, true);
    if (prov === 'http') {
        row('API format',  env.AGENT_API_FORMAT || '(not set)', !!env.AGENT_API_FORMAT);
        row('API URL',     env.AGENT_API_URL ? env.AGENT_API_URL.slice(0, 35) + '...' : '(not set)', !!env.AGENT_API_URL);
        row('API Key',     env.AGENT_API_KEY ? `${env.AGENT_API_KEY.slice(0, 8)}...` : '(not set)', !!env.AGENT_API_KEY);
    } else {
        row('Model',       env.AGENT_DEFAULT_MODEL || '(auto)', true);
    }
    row('API_KEY',    env.API_KEY    ? `${env.API_KEY.slice(0, 8)}...`    : '(not set)', !!env.API_KEY);
    row('ADMIN_KEY',  env.ADMIN_KEY  ? `${env.ADMIN_KEY.slice(0, 8)}...`  : '(not set)', !!env.ADMIN_KEY);
    console.log('');
}

async function cmdStore(args) {
    const { flags, positional } = parseArgs(args);
    const env     = { ...loadEnv(), ...process.env };
    const baseUrl = env.OCR_MEMORY_URL || 'http://localhost:3000';
    const apiKey  = flags['api-key'] || env.API_KEY || '';

    if (!flags.project)      { console.error('--project <uuid> required'); process.exitCode = 1; return; }
    if (!positional.length)  { console.error('Provide events as positional args: minus store --project <uuid> "event 1" "event 2"'); process.exitCode = 1; return; }

    const body = {
        episode_id: flags['episode-id'] || randomUUID(),
        project_id: flags.project,
        team_id:    flags.team || '00000000-0000-0000-0000-000000000000',
        user_id:    flags.user || '00000000-0000-0000-0000-000000000000',
        events:     positional,
    };

    const r = await req('POST', `${baseUrl}/memory/store`, body, { 'X-Api-Key': apiKey });
    if (r.status === 200) {
        console.log(ok(`Stored ${positional.length} event(s) in project ${flags.project}`));
    } else {
        console.error(fail(`${r.status}: ${r.text}`));
        process.exitCode = 1;
    }
}

async function cmdRetrieve(args) {
    const { flags } = parseArgs(args);
    const env     = { ...loadEnv(), ...process.env };
    const baseUrl = env.OCR_MEMORY_URL || 'http://localhost:3000';
    const apiKey  = flags['api-key'] || env.API_KEY || '';

    if (!flags.project) { console.error('--project <uuid> required'); process.exitCode = 1; return; }
    if (!flags.query)   { console.error('--query "..." required'); process.exitCode = 1; return; }

    const r = await req('POST', `${baseUrl}/memory/retrieve`,
        { project_id: flags.project, query: flags.query },
        { 'X-Api-Key': apiKey }
    );

    if (r.status === 200) {
        const results = r.json || [];
        if (!results.length) { console.log('(no results)'); return; }
        results.forEach((e, i) => console.log(`${C.dim}${i + 1}.${C.reset}  ${e}`));
    } else {
        console.error(fail(`${r.status}: ${r.text}`));
        process.exitCode = 1;
    }
}

async function cmdKeys(args) {
    const action = args[0];

    // rotate and revoke support interactive key picker when no id is given
    if (action === 'rotate' || action === 'revoke') {
        let id = args[1] && !args[1].startsWith('--') ? args[1] : null;

        if (!id) {
            // Fetch key list and show picker
            const env      = { ...loadEnv(), ...process.env };
            const baseUrl  = env.OCR_MEMORY_URL || 'http://localhost:3000';
            const adminKey = env.ADMIN_KEY || '';
            const r = await req('GET', `${baseUrl}/keys`, null, { 'X-Admin-Key': adminKey });
            if (r.status !== 200 || !Array.isArray(r.json) || !r.json.length) {
                console.error(fail('No keys found or service unreachable — is the service running?'));
                process.exitCode = 1; return;
            }
            const inquirer = require('inquirer');
            const { picked } = await inquirer.prompt([{
                type: 'list',
                name: 'picked',
                message: `Select key to ${action}`,
                choices: r.json.map(k => ({
                    name: `${(k.label || '?').padEnd(22)}  project=${(k.project_id || 'global').slice(0, 8)}  expires=${k.expires_at ? k.expires_at.slice(0, 10) : 'never'}`,
                    value: k.id,
                })),
            }]);
            id = picked;
        }

        if (action === 'rotate') {
            const env      = { ...loadEnv(), ...process.env };
            const baseUrl  = env.OCR_MEMORY_URL || 'http://localhost:3000';
            const adminKey = env.ADMIN_KEY || '';
            const r = await req('POST', `${baseUrl}/keys/${id}/rotate`, null, { 'X-Admin-Key': adminKey });
            if (r.status === 200 && r.json?.raw_key) {
                console.log(ok(`rotated  id=${r.json.id}`));
                console.log(`         new_key=${r.json.raw_key}`);
                console.log(`         label=${r.json.label}  rotated_at=${r.json.rotated_at}`);
            } else {
                console.error(fail(`${r.status}: ${r.text}`));
                process.exitCode = 1;
            }
            return;
        }

        if (action === 'revoke') {
            const envVars = { ...process.env, ...loadEnv() };
            try {
                execSync(`node "${path.join(ROOT, 'utils/key_manager.js')}" revoke --id ${id}`,
                    { stdio: 'inherit', env: envVars });
            } catch { process.exitCode = 1; }
            return;
        }
    }

    // All other subcommands (create, list) — delegate to key_manager.js
    const envVars = { ...process.env, ...loadEnv() };
    try {
        execSync(`node "${path.join(ROOT, 'utils/key_manager.js')}" ${args.join(' ')}`,
            { stdio: 'inherit', env: envVars });
    } catch { process.exitCode = 1; }
}

function cmdBenchmark() {
    try {
        execSync(`node "${path.join(ROOT, 'scripts/test_harness.js')}"`,
            { stdio: 'inherit', env: { ...process.env, ...loadEnv() } });
    } catch { process.exitCode = 1; }
}

function cmdRetention() {
    try {
        execSync(`node "${path.join(ROOT, 'scripts/retention_cron.js')}"`,
            { stdio: 'inherit', env: { ...process.env, ...loadEnv() } });
    } catch { process.exitCode = 1; }
}

function cmdPrune() {
    try {
        execSync(`node "${path.join(ROOT, 'utils/memory_pruner.js')}"`,
            { stdio: 'inherit', env: { ...process.env, ...loadEnv() } });
    } catch { process.exitCode = 1; }
}

function cmdSkills() {
    try {
        execSync(`node "${path.join(ROOT, 'utils/skill_registry.js')}"`,
            { stdio: 'inherit', env: { ...process.env, ...loadEnv() } });
    } catch { process.exitCode = 1; }
}

function listSessions() {
    const sessionsDir = path.join(ROOT, '.memory', 'sessions');
    if (!require('fs').existsSync(sessionsDir)) return [];
    return require('fs').readdirSync(sessionsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
            const statePath = path.join(sessionsDir, e.name, 'state.json');
            try {
                const state = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
                return { sessionId: e.name, state };
            } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.state.created_at) - new Date(a.state.created_at));
}

function cmdSessions(args = []) {
    const filterHalted = args.includes('--halted');
    let sessions = listSessions();
    if (filterHalted) sessions = sessions.filter(({ state }) => state.halted);
    if (!sessions.length) {
        console.log(filterHalted ? 'No halted sessions.' : 'No sessions found.');
        return;
    }
    const label = filterHalted ? 'Halted Pipeline Sessions' : 'Pipeline Sessions';
    console.log(`\n${C.bold}${label}${C.reset}  ${C.dim}(most recent first)${C.reset}\n`);
    sessions.forEach(({ state }, i) => {
        const dt     = fmtDatetime(state.created_at);
        const goal   = (state.goal || '(no goal)').slice(0, 60);
        const status = state.halted       ? `${C.red}[halted:${state.current_phase||'?'}]${C.reset}`
                     : state.completed_at ? `${C.green}[complete]${C.reset}`
                     :                      `${C.yellow}[running]${C.reset}`;
        const dur    = state.completed_at
            ? `  ${Math.round((new Date(state.completed_at) - new Date(state.created_at)) / 1000)}s`
            : '';
        console.log(`  ${C.dim}${i + 1}.${C.reset}  ${C.cyan}${dt}${C.reset}  ${goal}  ${status}${dur}`);
    });
    const hint = filterHalted
        ? `Use: minus resume <number>  or  minus resume  (auto-selects most recent halted)`
        : `Use: minus trace <number>  or  minus trace <session-id>`;
    console.log(`\n${C.dim}${hint}${C.reset}\n`);
}

async function cmdResume(args) {
    const { positional, flags } = parseArgs(args);
    let sessionId = positional[0];

    // No sessionId given — auto-select if one halted, show picker if multiple
    if (!sessionId) {
        const halted = listSessions().filter(({ state }) => state.halted);
        if (!halted.length) { console.log('No halted sessions to resume.'); return; }
        if (halted.length === 1) {
            sessionId = halted[0].state.session_id;
            console.log(info(`Auto-selecting: ${(halted[0].state.goal || '').slice(0, 50)}`));
        } else {
            const inquirer = require('inquirer');
            const { answer } = await inquirer.prompt([{
                type: 'list',
                name: 'answer',
                message: 'Select halted session to resume',
                choices: halted.map((s, i) => ({
                    name: `${String(i + 1).padStart(2)}.  ${fmtDatetime(s.state.created_at)}  ${(s.state.goal || '').slice(0, 48)}  halted@${s.state.current_phase || '?'}`,
                    value: s.state.session_id,
                })),
            }]);
            sessionId = answer;
        }
    } else if (/^\d+$/.test(sessionId)) {
        // Numeric index — resolve to session ID
        const sessions = listSessions();
        const entry = sessions[parseInt(sessionId, 10) - 1];
        if (!entry) { console.error(`No session at index ${sessionId}.`); process.exitCode = 1; return; }
        sessionId = entry.state.session_id;
    }

    const hint = flags.hint || '';
    console.log(`\n${C.bold}[resume]${C.reset} session=${sessionId}`);
    if (hint) console.log(info(`hint: "${hint}"`));

    try {
        const { resume } = require('../utils/pipeline_executor');
        const result = await resume(sessionId, hint);
        if (result.halted) {
            console.error(fail(`Still halted — see ${result.diagnosticPath}`));
            process.exitCode = 1;
        } else {
            console.log(ok(`Complete — phases: [${result.completed.join(', ')}]`));
        }
    } catch (err) {
        console.error(fail(`Error: ${err.message}`));
        process.exitCode = 1;
    }
}

async function cmdTrace(args) {
    const { positional, flags } = parseArgs(args);
    const ref = positional[0];

    const sessions = listSessions();
    if (!sessions.length) { console.error('No sessions found.'); process.exitCode = 1; return; }

    if (!ref) {
        if (sessions.length === 1) return doTrace(sessions[0].sessionId, flags.verbose);
        // Interactive session picker
        const inquirer = require('inquirer');
        const { answer } = await inquirer.prompt([{
            type: 'list',
            name: 'answer',
            message: 'Select session to trace',
            choices: sessions.map((s, i) => {
                const dt     = fmtDatetime(s.state.created_at);
                const goal   = (s.state.goal || '(no goal)').slice(0, 55);
                const status = s.state.halted ? '[halted]' : s.state.completed_at ? '[complete]' : '[running]';
                return { name: `${String(i + 1).padStart(2)}.  ${dt}  ${goal}  ${status}`, value: s.sessionId };
            }),
        }]);
        return doTrace(answer, flags.verbose);
    }

    // Numeric index (1 = most recent)
    const idx = parseInt(ref, 10);
    if (!isNaN(idx) && idx > 0) {
        const entry = sessions[idx - 1];
        if (!entry) { console.error(`No session at index ${idx}. Run 'minus sessions' to list.`); process.exitCode = 1; return; }
        return doTrace(entry.sessionId, flags.verbose);
    }

    // UUID or partial match
    return doTrace(ref, flags.verbose);
}

function doTrace(sessionId, verbose = false) {
    const traceFile  = path.join(ROOT, '.memory', 'sessions', sessionId, 'trace.jsonl');
    const statePath  = path.join(ROOT, '.memory', 'sessions', sessionId, 'state.json');
    if (!require('fs').existsSync(traceFile)) {
        console.error(`No trace found. Check 'minus sessions' for valid session IDs.`);
        process.exitCode = 1; return;
    }
    if (verbose) {
        // Show session ID only in verbose mode
        try {
            const state = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
            console.log(`${C.dim}session: ${state.session_id}${C.reset}\n`);
        } catch {}
    }
    const { renderTrace } = require('../utils/tracer');
    process.stdout.write(renderTrace(traceFile));
}

function readSessionCost(sessionId) {
    try {
        const bf = path.join(ROOT, '.memory', 'sessions', sessionId, 'budget_session.json');
        if (fs.existsSync(bf)) return JSON.parse(fs.readFileSync(bf, 'utf8')).spent || 0;
    } catch {}
    return 0;
}

async function cmdBudget(args) {
    const { positional } = parseArgs(args);
    const { getLifetimeSpend, getSessionCostFromTrace } = require('../utils/budget_tracker');

    const sessions = listSessions();
    if (!sessions.length) { console.log('No sessions found.'); return; }

    let selected;
    if (positional[0]) {
        if (/^\d+$/.test(positional[0])) {
            selected = sessions[parseInt(positional[0], 10) - 1];
        } else {
            selected = sessions.find(s => s.sessionId === positional[0] || s.sessionId.startsWith(positional[0]));
        }
        if (!selected) { console.error(fail(`Session not found: ${positional[0]}`)); process.exitCode = 1; return; }
    } else if (sessions.length === 1) {
        selected = sessions[0];
    } else {
        const inquirer = require('inquirer');
        const { answer } = await inquirer.prompt([{
            type: 'list',
            name: 'answer',
            message: 'Select session',
            choices: sessions.map((s, i) => {
                const dt     = fmtDatetime(s.state.created_at);
                const goal   = (s.state.goal || '(no goal)').slice(0, 45);
                const status = s.state.halted ? '[halted]' : s.state.completed_at ? '[complete]' : '[running]';
                const cost   = readSessionCost(s.sessionId);
                const costStr = cost > 0 ? `  $${cost.toFixed(3)}` : '';
                return { name: `${String(i + 1).padStart(2)}.  ${dt}  ${goal}  ${status}${costStr}`, value: s };
            }),
        }]);
        selected = answer;
    }

    const ora = require('ora');
    const spinner = ora('Reading cost data...').start();

    const traceFile  = path.join(ROOT, '.memory', 'sessions', selected.sessionId, 'trace.jsonl');
    const costEvents = getSessionCostFromTrace(traceFile);
    spinner.stop();

    // Aggregate cost.recorded events by phase
    const phaseMap = {};
    for (const ev of costEvents) {
        const key = ev.phase || 'unknown';
        if (!phaseMap[key]) phaseMap[key] = [];
        phaseMap[key].push(ev);
    }

    const st = selected.state;
    console.log(`\n${C.bold}Session budget${C.reset}  —  ${fmtDatetime(st.created_at)}  "${(st.goal || '').slice(0, 55)}"`);

    let hasEstimates = false, sessionIn = 0, sessionOut = 0, sessionCost = 0;

    if (Object.keys(phaseMap).length === 0) {
        console.log(`  ${C.dim}No cost.recorded events found — run a pipeline to see per-phase breakdown.${C.reset}`);
    } else {
        const W = 70;
        console.log(C.dim + '─'.repeat(W) + C.reset);
        console.log(
            `${'Phase'.padEnd(14)} ${'Model'.padEnd(20)} ` +
            `${'Tokens in'.padStart(11)} ${'Tokens out'.padStart(11)} ${'Cost'.padStart(9)}`
        );
        console.log(C.dim + '─'.repeat(W) + C.reset);

        for (const [phaseName, evts] of Object.entries(phaseMap)) {
            const isEst     = evts.some(e => e.source === 'est');
            if (isEst) hasEstimates = true;
            const phaseIn   = evts.reduce((s, e) => s + (e.input_tokens  || 0), 0);
            const phaseOut  = evts.reduce((s, e) => s + (e.output_tokens || 0), 0);
            const phaseCost = evts.reduce((s, e) => s + (e.cost_usd      || 0), 0);
            const pfx       = isEst ? '~' : '';
            const modelShort = (evts[0]?.model || '').replace(/^claude-/, '').slice(0, 18);

            sessionIn   += phaseIn;
            sessionOut  += phaseOut;
            sessionCost += phaseCost;

            console.log(
                `${phaseName.padEnd(14)} ${modelShort.padEnd(20)} ` +
                `${(pfx + phaseIn.toLocaleString()).padStart(11)} ` +
                `${(pfx + phaseOut.toLocaleString()).padStart(11)} ` +
                `${(pfx + '$' + phaseCost.toFixed(3)).padStart(9)}`
            );

            if (evts.length > 1) {
                for (const ev of evts) {
                    const ap = ev.source === 'est' ? '~' : '';
                    const attLabel = `  ↳ attempt ${ev.attempt || '?'}`;
                    console.log(
                        C.dim +
                        `${attLabel.padEnd(14)} ${''.padEnd(20)} ` +
                        `${(ap + (ev.input_tokens  || 0).toLocaleString()).padStart(11)} ` +
                        `${(ap + (ev.output_tokens || 0).toLocaleString()).padStart(11)} ` +
                        `${(ap + '$' + (ev.cost_usd || 0).toFixed(3)).padStart(9)}` +
                        C.reset
                    );
                }
            }
        }

        const ep = hasEstimates ? '~' : '';
        console.log(C.dim + '─'.repeat(W) + C.reset);
        console.log(
            `${C.bold}${'Session total'.padEnd(14)}${C.reset} ${''.padEnd(20)} ` +
            `${(ep + sessionIn.toLocaleString()).padStart(11)} ` +
            `${(ep + sessionOut.toLocaleString()).padStart(11)} ` +
            `${C.bold}${(ep + '$' + sessionCost.toFixed(3)).padStart(9)}${C.reset}`
        );
    }

    // Lifetime totals
    const day30   = getLifetimeSpend(30);
    const allTime = getLifetimeSpend();
    console.log('');
    console.log(`  Last 30 days     ${C.cyan}$${day30.total.toFixed(3)}${C.reset}`);
    console.log(`  All time         ${C.cyan}$${allTime.total.toFixed(3)}${C.reset}`);

    const env = { ...loadEnv(), ...process.env };
    const hardLimit = parseFloat(env.BUDGET_HARD_LIMIT || '0');
    if (hardLimit > 0) {
        const pct   = ((allTime.total / hardLimit) * 100).toFixed(1);
        const color = allTime.total / hardLimit > 0.8 ? C.red : C.yellow;
        console.log(`  Hard limit       ${color}$${hardLimit.toFixed(2)}${C.reset}  (${pct}% used)`);
    }

    if (hasEstimates) console.log(`\n  ${C.dim}† CLI provider — gpt-tokenizer estimate (±5%)${C.reset}`);
    console.log('');
}

function fmtDatetime(iso) {
    if (!iso) return '?';
    const d   = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP = `
${C.bold}minus${C.reset} v${VERSION}  —  MinusWorkflows unified CLI

${C.bold}SETUP${C.reset}
  minus init                     Interactive setup wizard (run once)
  minus start                    Start memory service  (docker-compose up -d)
  minus stop                     Stop memory service
  minus status                   Health table + provider config

${C.bold}MEMORY${C.reset}
  minus store  --project <uuid> "event 1" "event 2" ...
               [--user <uuid>] [--team <uuid>] [--episode-id <uuid>]
  minus retrieve --project <uuid> --query "..."

${C.bold}KEYS${C.reset}  (requires ADMIN_KEY)
  minus keys create --label <name> [--project-id <uuid>] [--expires-in-days <n>]
  minus keys list
  minus keys revoke [key-id]     Revoke key (shows picker if key-id omitted)
  minus keys rotate [key-id]     Rotate key — old key immediately invalid (picker if id omitted)

${C.bold}PIPELINE${C.reset}
  minus sessions [--halted]      List pipeline sessions (goal + date, no UUIDs)
  minus trace [n|id] [--verbose] Render session trace tree  (interactive picker if no arg)
  minus resume [n|id] [--hint "guidance"]  Resume halted pipeline (interactive picker if multiple)
  minus retry  [n|id] [--hint "guidance"]  Alias for resume
  minus budget [n|id]            Token + cost breakdown per phase  (interactive picker if no arg)

${C.bold}MAINTENANCE${C.reset}
  minus benchmark                Full reliability test harness
  minus retention                Run retention policy (delete old episodes)
  minus prune                    Summarize EVOLUTION.md if it exceeds 50 KB
  minus skills                   List installed skills + versions

${C.bold}ENV  ${C.dim}(set in .env or shell environment)${C.reset}
  OCR_MEMORY_URL         default: http://localhost:3000
  API_KEY                required for store / retrieve
  ADMIN_KEY              required for keys management + retention
  AGENT_CLI              claude | gemini | openai | custom  (default: claude)
  AGENT_PROVIDER         cli (default) | http (direct API, no binary needed)
  AGENT_API_URL          e.g. https://api.anthropic.com/v1/messages
  AGENT_API_KEY          API key for HTTP provider
  AGENT_API_FORMAT       anthropic | openai | google
  PHASE_IDLE_TIMEOUT_MS  kill CLI agent if no output for N ms  (default: 300000)
  CONTEXT_BUDGET_TOKENS  max tokens for injected prior-phase context  (default: 60000)
  PHASE_VERIFY_CMD       override test command (e.g. "npm test -- --testPathPattern=unit")

${C.bold}EXAMPLES${C.reset}
  minus init
  minus start
  minus keys create --label "team-alpha" --expires-in-days 90
  minus store --project 550e8400-e29b-41d4-a716-446655440001 \\
    "user opened /checkout" "entered card" "payment succeeded"
  minus retrieve --project 550e8400-e29b-41d4-a716-446655440001 \\
    --query "payment flow"
  minus benchmark
`;

// ── Entry ─────────────────────────────────────────────────────────────────────

if (typeof fetch === 'undefined') {
    console.error('minus requires Node.js 18 or later (fetch is built-in from v18).');
    process.exit(1);
}

const [,, cmd, ...rest] = process.argv;

(async () => {
    switch (cmd) {
        case 'init':      await cmdInit();          break;
        case 'start':     await cmdStart();         break;
        case 'stop':      cmdStop();                break;
        case 'status':    await cmdStatus();        break;
        case 'store':     await cmdStore(rest);     break;
        case 'retrieve':  await cmdRetrieve(rest);  break;
        case 'keys':      await cmdKeys(rest);       break;
        case 'benchmark': cmdBenchmark();           break;
        case 'retention': cmdRetention();           break;
        case 'prune':     cmdPrune();               break;
        case 'skills':    cmdSkills();              break;
        case 'trace':     await cmdTrace(rest);      break;
        case 'sessions':  cmdSessions(rest);        break;
        case 'resume':    await cmdResume(rest);    break;
        case 'retry':     await cmdResume(rest);    break;
        case 'budget':    await cmdBudget(rest);    break;
        case '--version': console.log(VERSION);    break;
        case '--help':
        case 'help':
        case undefined:   console.log(HELP);       break;
        default:
            console.error(`Unknown command: ${cmd}\n`);
            console.log(HELP);
            process.exitCode = 1;
    }
})();

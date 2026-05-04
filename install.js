#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const homeDir    = os.homedir();
const repoDir    = __dirname;
const repoSkills = path.join(repoDir, 'skills');

// ── Detect which AI providers are installed ───────────────────────────────────

function detectProviders() {
    const providers = [];

    const claudeHome = path.join(homeDir, '.claude');
    if (fs.existsSync(claudeHome)) {
        providers.push({
            name: 'Claude Code',
            type: 'claude',
            commandsDir: path.join(claudeHome, 'commands'),
        });
    }

    const geminiHome = path.join(homeDir, '.gemini');
    if (fs.existsSync(geminiHome)) {
        providers.push({
            name: 'Gemini CLI',
            type: 'gemini',
            skillsDir: path.join(geminiHome, 'skills'),
        });
    }

    if (providers.length === 0) {
        const cwd = process.cwd();
        providers.push({
            name: 'Local (Claude Code)',
            type: 'claude',
            commandsDir: path.join(cwd, '.claude', 'commands'),
        });
    }

    return providers;
}

// ── Claude Code: install each skill as a flat <name>.md file ─────────────────

function installForClaude(commandsDir) {
    if (!fs.existsSync(commandsDir)) {
        fs.mkdirSync(commandsDir, { recursive: true });
    }

    if (!fs.existsSync(repoSkills)) return;

    const skills = fs.readdirSync(repoSkills).filter(f =>
        fs.statSync(path.join(repoSkills, f)).isDirectory()
    );

    let installed = 0;
    for (const skill of skills) {
        const skillMd = path.join(repoSkills, skill, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;

        const destFile = path.join(commandsDir, `${skill}.md`);
        try {
            fs.copyFileSync(skillMd, destFile);
            installed++;
        } catch (e) {
            console.warn(`  Warning: could not install ${skill}: ${e.message}`);
        }
    }

    console.log(`  Claude Code: ${installed} skills → ${commandsDir}`);
    console.log('  Activate with: /<skill-name>  (e.g. /minus, /architect, /builder)');
}

// ── Gemini CLI: install each skill as a symlinked directory ──────────────────

function installForGemini(skillsDir) {
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
    }

    if (!fs.existsSync(repoSkills)) return;

    const skills = fs.readdirSync(repoSkills).filter(f =>
        fs.statSync(path.join(repoSkills, f)).isDirectory()
    );

    let installed = 0;
    for (const skill of skills) {
        const src  = path.join(repoSkills, skill);
        const dest = path.join(skillsDir, skill);

        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });

        try {
            fs.symlinkSync(src, dest, 'junction');
        } catch (_) {
            copyRecursive(src, dest);
        }
        installed++;
    }

    console.log(`  Gemini CLI: ${installed} skills → ${skillsDir}`);
    console.log('  Activate with: Gemini, <skill>: [instruction]');
}

function copyRecursive(src, dest) {
    if (fs.statSync(src).isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
        fs.readdirSync(src).forEach(child =>
            copyRecursive(path.join(src, child), path.join(dest, child))
        );
    } else {
        fs.copyFileSync(src, dest);
    }
}

// ── Skill version tracking ────────────────────────────────────────────────────

function getInstalledVersions(memDir) {
    const vPath = path.join(memDir, 'skill_versions.json');
    if (fs.existsSync(vPath)) {
        try { return JSON.parse(fs.readFileSync(vPath, 'utf8')); } catch (_) {}
    }
    return {};
}

function saveInstalledVersions(memDir, versions) {
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'skill_versions.json'), JSON.stringify(versions, null, 2));
}

function trackVersions(targetDir) {
    const { parseFrontmatter } = require('./utils/skill_registry');
    const memDir = path.join(targetDir, '.memory');
    const installed = getInstalledVersions(memDir);
    const updated = {};

    if (!fs.existsSync(repoSkills)) return;

    for (const skill of fs.readdirSync(repoSkills)) {
        const mdPath = path.join(repoSkills, skill, 'SKILL.md');
        if (!fs.existsSync(mdPath)) continue;

        const fm = parseFrontmatter(fs.readFileSync(mdPath, 'utf8'));
        const current = fm.version || '0.0.0';
        const prev    = installed[skill];

        if (prev && prev !== current) {
            console.log(`  Updated ${skill}: ${prev} → ${current}`);
        }
        updated[skill] = current;
    }

    saveInstalledVersions(memDir, updated);
}

// ── Bootstrap code-review-graph ───────────────────────────────────────────────

function bootstrapGraph() {
    try {
        execSync('uvx code-review-graph build', { stdio: 'ignore' });
    } catch (_) {
        try { execSync('code-review-graph build', { stdio: 'ignore' }); } catch (_) {}
    }
}

// ── Scaffold project memory directories ──────────────────────────────────────

function scaffoldProject(targetDir) {
    const contextPath = path.join(targetDir, 'CONTEXT.md');
    if (!fs.existsSync(contextPath)) {
        fs.writeFileSync(contextPath,
            '# Project Context\n\n## Purpose\n[Why this project exists]\n\n## Tech Stack\n[Languages, Frameworks, DBs]\n\n## Domain Language\n[Key terms]\n\n## Configuration\nALLOW_EVOLVING_GUARDRAILS: true'
        );
        console.log('  Created CONTEXT.md');
    }

    const memDir = path.join(targetDir, '.memory');
    if (!fs.existsSync(memDir)) {
        fs.mkdirSync(memDir);
        fs.mkdirSync(path.join(memDir, 'sessions'));
        fs.writeFileSync(path.join(memDir, '.gitignore'), 'sessions/*/*/snapshots/*.json');
        fs.writeFileSync(path.join(memDir, 'EVOLUTION.md'),
            '# Evolutionary Heuristics\n\n> Scenarios → Failures → Validated Fallbacks\n\n## Heuristics\n\n- No data yet.'
        );
        console.log('  Initialized .memory/');
    }

    const vaultDir = path.join(targetDir, '.vault');
    if (!fs.existsSync(vaultDir)) {
        fs.mkdirSync(vaultDir);
        fs.mkdirSync(path.join(vaultDir, 'sandbox'));
        fs.mkdirSync(path.join(vaultDir, 'backups'));
        fs.writeFileSync(path.join(vaultDir, '.gitignore'), 'sandbox/*\n!backups/');
        console.log('  Initialized .vault/');
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Installing minusWorkflows...\n');

const providers = detectProviders();
console.log(`Detected providers: ${providers.map(p => p.name).join(', ')}\n`);

for (const provider of providers) {
    if (provider.type === 'claude') {
        installForClaude(provider.commandsDir);
    } else if (provider.type === 'gemini') {
        installForGemini(provider.skillsDir);
    }
}

scaffoldProject(process.cwd());
bootstrapGraph();

// Rebuild skill registry (generates skill_registry.json + /skills command)
try {
    require('./utils/skill_registry').rebuild();
} catch (e) {
    console.warn('  Warning: skill registry build failed:', e.message);
}

// Track skill versions and log upgrades
try {
    trackVersions(process.cwd());
} catch (e) {
    console.warn('  Warning: version tracking failed:', e.message);
}

console.log('\nSetup complete.');
console.log('');
console.log('  Claude Code  →  /minus, /architect, /builder, /maintainer, /skills');
console.log('  Gemini CLI   →  Gemini, minus: [goal]');
console.log('  Any provider →  Use the skill name as the entry point');

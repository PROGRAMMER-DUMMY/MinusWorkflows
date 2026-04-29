#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const globalGeminiSkills = path.join(homeDir, '.gemini', 'skills');
const localGeminiSkills = path.join(process.cwd(), '.gemini', 'skills');
const repoSkillsDir = path.join(__dirname, 'skills');
const targetDir = fs.existsSync(path.dirname(globalGeminiSkills)) ? globalGeminiSkills : localGeminiSkills;

const { execSync } = require('child_process');

console.log('Installing minusWorkflows Stack...');

// Check for code-review-graph dependency
try {
    console.log('Checking dependencies...');
    execSync('code-review-graph --version', { stdio: 'ignore' });
    console.log('code-review-graph is already installed.');
} catch (e) {
    console.log('Installing code-review-graph...');
    try {
        execSync('pip install code-review-graph', { stdio: 'inherit' });
        console.log('code-review-graph installed successfully.');
    } catch (pipError) {
        console.log('Failed to install code-review-graph. Please install it manually: pip install code-review-graph');
    }
}

// Automate initial graph build
console.log('Bootstrapping structural dependency graph...');
try {
    execSync('uvx code-review-graph build', { stdio: 'inherit' });
} catch (uvxError) {
    try {
        execSync('code-review-graph build', { stdio: 'inherit' });
    } catch (buildError) {
        console.log('Note: Initial graph build failed.');
    }
}

if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

function linkSkills(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return;
    const skills = fs.readdirSync(srcDir);
    for (const skill of skills) {
        const srcPath = path.join(srcDir, skill);
        const destPath = path.join(destDir, skill);
        if (fs.statSync(srcPath).isDirectory()) {
            if (fs.existsSync(destPath)) {
                fs.rmSync(destPath, { recursive: true, force: true });
            }
            try {
                fs.symlinkSync(srcPath, destPath, 'junction');
            } catch (e) {
                // Fallback to copy if symlink fails
                function copyRecursive(src, dest) {
                    if (fs.statSync(src).isDirectory()) {
                        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
                        fs.readdirSync(src).forEach(child => copyRecursive(path.join(src, child), path.join(dest, child)));
                    } else {
                        fs.copyFileSync(src, dest);
                    }
                }
                copyRecursive(srcPath, destPath);
            }
        }
    }
}

linkSkills(repoSkillsDir, targetDir);
console.log('Skills linked/injected into .gemini/skills/');

const contextPath = path.join(process.cwd(), 'CONTEXT.md');
if (!fs.existsSync(contextPath)) {
    const template = `# Project Context\n\n## Purpose\n[Describe why this project exists]\n\n## Tech Stack\n[Languages, Frameworks, DBs]\n\n## Domain Language\n[Key terms and their definitions]\n\n## Configuration\nALLOW_EVOLVING_GUARDRAILS: true`;
    fs.writeFileSync(contextPath, template);
    console.log('Created starter CONTEXT.md');
}

const memoryDir = path.join(process.cwd(), '.memory');
if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir);
    fs.mkdirSync(path.join(memoryDir, 'sessions'));
    fs.writeFileSync(path.join(memoryDir, '.gitignore'), 'sessions/*/*/snapshots/*.json');
    fs.writeFileSync(path.join(memoryDir, 'INDEX.md'), '# Knowledge Graph Index\n\n[[Decisions]]\n[[Lessons-Learned]]\n[[Evolution]]');
    fs.writeFileSync(path.join(memoryDir, 'EVOLUTION.md'), '# Evolutionary Heuristics\n\n> This file tracks Scenarios, Failures, and Validated Fallbacks to improve AI performance on this project.\n\n## Heuristics Tree\n\n- No data yet. Build something to evolve.');
    console.log('Initialized local Memory Vault at .memory/');
}

const vaultDir = path.join(process.cwd(), '.vault');
if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir);
    fs.mkdirSync(path.join(vaultDir, 'sandbox'));
    fs.mkdirSync(path.join(vaultDir, 'backups'));
    fs.writeFileSync(path.join(vaultDir, '.gitignore'), 'sandbox/*\n!backups/');
    console.log('Initialized local Vault-Harness at .vault/');
}

console.log('\nSetup Complete! Try: "Gemini, activate the Architect skill."');

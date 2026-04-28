const fs = require('fs');
const path = require('path');

const targetDir = path.join(process.cwd(), '.gemini', 'skills');
const repoSkillsDir = path.join(__dirname, 'skills');

const { execSync } = require('child_process');

console.log('🚀 Installing minusWorkflows Stack...');

// Check for code-review-graph dependency
try {
    console.log('📦 Checking dependencies...');
    execSync('code-review-graph --version', { stdio: 'ignore' });
    console.log('✅ code-review-graph is already installed.');
} catch (e) {
    console.log('📥 Installing code-review-graph...');
    try {
        execSync('pip install code-review-graph', { stdio: 'inherit' });
        console.log('✅ code-review-graph installed successfully.');
    } catch (pipError) {
        console.log('❌ Failed to install code-review-graph. Please install it manually: pip install code-review-graph');
    }
}

if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

function copyRecursive(src, dest) {
    if (fs.statSync(src).isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
        fs.readdirSync(src).forEach(child => copyRecursive(path.join(src, child), path.join(dest, child)));
    } else {
        fs.copyFileSync(src, dest);
    }
}

copyRecursive(repoSkillsDir, targetDir);
console.log('✅ Skills injected into .gemini/skills/');

const contextPath = path.join(process.cwd(), 'CONTEXT.md');
if (!fs.existsSync(contextPath)) {
    const template = `# Project Context\n\n## Purpose\n[Describe why this project exists]\n\n## Tech Stack\n[Languages, Frameworks, DBs]\n\n## Domain Language\n[Key terms and their definitions]`;
    fs.writeFileSync(contextPath, template);
    console.log('✅ Created starter CONTEXT.md');
}

const memoryDir = path.join(process.cwd(), '.memory');
if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'INDEX.md'), '# Knowledge Graph Index\n\n[[Decisions]]\n[[Lessons-Learned]]');
    console.log('✅ Initialized local Memory Vault at .memory/');
}

console.log('\n🎉 Setup Complete! Try: "Gemini, activate the Architect skill."');

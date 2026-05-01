#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const globalGeminiSkills = path.join(homeDir, '.gemini', 'skills');
const localGeminiSkills = path.join(process.cwd(), '.gemini', 'skills');
const repoSkillsDir = path.join(__dirname, '..', 'skills');
const targetDir = fs.existsSync(path.dirname(globalGeminiSkills)) ? globalGeminiSkills : localGeminiSkills;

if (!fs.existsSync(repoSkillsDir)) {
    process.exit(0);
}

if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

const repoSkills = fs.readdirSync(repoSkillsDir).filter(f => fs.statSync(path.join(repoSkillsDir, f)).isDirectory());
const installedSkills = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];

const newSkills = repoSkills.filter(skill => !installedSkills.includes(skill));

if (newSkills.length > 0) {
    console.log(`✦ New skills detected: ${newSkills.join(', ')}. Synchronizing skill stack...`);
    
    for (const skill of newSkills) {
        const srcPath = path.join(repoSkillsDir, skill);
        const destPath = path.join(targetDir, skill);
        
        try {
            // Attempt to create a junction (symlink)
            fs.symlinkSync(srcPath, destPath, 'junction');
            console.log(`  Linked: ${skill}`);
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
            console.log(`  Copied: ${skill} (Symlink failed)`);
        }
    }
    console.log('✦ Skill stack synchronized. Run "/skills reload" to activate new capabilities.');
}

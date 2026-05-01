const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

function checkCommand(command) {
    try {
        execSync(command, { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Scans the environment and config files to determine available models.
 */
async function scanAvailableModels() {
    const available = new Set();
    const memoryDir = path.join(process.cwd(), '.memory');
    const modelsConfigPath = path.join(memoryDir, 'models.json');

    // 1. Check Explicit Config File
    if (fs.existsSync(modelsConfigPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(modelsConfigPath, 'utf8'));
            if (config.models && Array.isArray(config.models)) {
                return config.models; // Return early if explicit config exists
            }
        } catch (e) {
            console.warn('Failed to parse .memory/models.json', e);
        }
    }

    // 2. Environment Scanner
    if (process.env.GEMINI_API_KEY) available.add('gemini');
    if (process.env.ANTHROPIC_API_KEY) available.add('claude');
    if (process.env.OPENAI_API_KEY) available.add('openai');

    // 3. CLI Scanner
    if (!available.has('gemini') && checkCommand('gemini --version')) {
        available.add('gemini');
    }
    if (!available.has('claude') && checkCommand('aws configure list')) {
        // Broad assumption: AWS CLI implies Bedrock access for Claude
        available.add('claude');
    }
    if (!available.has('claude') && checkCommand('anthropic --version')) {
        available.add('claude');
    }

    if (available.size > 0) {
        return Array.from(available);
    }

    // 4. User Fallback (Prompt)
    console.log("No models detected in environment variables, CLIs, or .memory/models.json.");
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question("Which model family would you like to use? (gemini, claude, openai): ", (answer) => {
            rl.close();
            const choice = answer.trim().toLowerCase();
            resolve([choice || 'gemini']);
        });
    });
}

module.exports = { scanAvailableModels };

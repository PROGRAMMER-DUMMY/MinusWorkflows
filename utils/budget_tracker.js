const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BUDGET_FILE = path.join(process.cwd(), '.memory', 'budget_session.json');

function getSessionBudget() {
    if (fs.existsSync(BUDGET_FILE)) {
        return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    }
    return {
        strategy: 'medium', // low, medium, unlimited
        hardLimit: null,
        spent: 0
    };
}

function saveSessionBudget(data) {
    if (!fs.existsSync(path.dirname(BUDGET_FILE))) {
        fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
    }
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(data, null, 2));
}

/**
 * Checks if a task using a specific tier is allowed within the budget.
 * Prompts user if an expensive model is requested.
 */
async function authorizeModelTier(tier, estimatedCost = 0) {
    const budget = getSessionBudget();

    if (budget.hardLimit !== null && (budget.spent + estimatedCost) > budget.hardLimit) {
        throw new Error(`Budget exceeded. Hard limit: $${budget.hardLimit}, Spent: $${budget.spent}`);
    }

    if (budget.strategy === 'low' && tier === 'Ultra') {
         console.warn("Budget strategy is 'low' but 'Ultra' tier was requested. Downgrading to 'Pro' (or 'Flash' if appropriate).");
         return 'Pro'; // Force downgrade based on strategy
    }

    if (tier === 'Ultra') {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            rl.question(`WARNING: 'Ultra' tier model requested. This may consume budget quickly. Proceed? (y/n): `, (answer) => {
                rl.close();
                if (answer.trim().toLowerCase() === 'y') {
                    resolve(tier);
                } else {
                    console.log("Downgrading to 'Pro' tier.");
                    resolve('Pro');
                }
            });
        });
    }

    return tier;
}

function recordCost(cost) {
    const budget = getSessionBudget();
    budget.spent += cost;
    saveSessionBudget(budget);
}

module.exports = { authorizeModelTier, recordCost, getSessionBudget };

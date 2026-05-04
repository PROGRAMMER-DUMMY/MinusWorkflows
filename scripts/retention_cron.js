'use strict';
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const BASE_URL  = process.env.OCR_MEMORY_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const LOG_PATH  = path.join(process.cwd(), '.memory', 'retention.log');

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
}

if (!ADMIN_KEY) {
    log('retention_cron: ADMIN_KEY not set — aborting');
    process.exit(1);
}

log('retention_cron: starting');

try {
    const cmd = `curl -s -f -X POST -H "X-Admin-Key: ${ADMIN_KEY}" ${BASE_URL}/admin/retention/run`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 120_000 });
    const result = JSON.parse(out);
    log(
        `retention_cron: complete — ` +
        `deleted=${result.deleted_episodes} ` +
        `freed_bytes=${result.freed_bytes} ` +
        `archived_pngs=${result.archived_pngs}`
    );
} catch (err) {
    log(`retention_cron: FAILED — ${err.stderr || err.message}`);
    process.exit(1);
}

'use strict';
const { execSync } = require('child_process');

const BASE_URL = process.env.OCR_MEMORY_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function apireq(method, path, body) {
    const bodyFlag = body ? `-d '${JSON.stringify(body)}'` : '';
    const cmd = `curl -s -X ${method} \
        -H "Content-Type: application/json" \
        -H "X-Admin-Key: ${ADMIN_KEY}" \
        ${bodyFlag} ${BASE_URL}${path}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (!out.trim()) return null;
    return JSON.parse(out);
}

function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            flags[args[i].slice(2)] = args[i + 1] ?? true;
            i++;
        }
    }
    return flags;
}

const [,, command, ...rest] = process.argv;
const flags = parseFlags(rest);

switch (command) {
    case 'create': {
        if (!flags.label) { console.error('--label required'); process.exit(1); }
        const body = {
            label: flags.label,
            project_id: flags['project-id'] || null,
            expires_in_days: flags['expires-in-days'] ? parseInt(flags['expires-in-days'], 10) : null,
        };
        const result = apireq('POST', '/keys', body);
        console.log('Key created — save raw_key now, it will never be shown again:');
        console.log(JSON.stringify(result, null, 2));
        break;
    }
    case 'revoke': {
        if (!flags.id) { console.error('--id required'); process.exit(1); }
        apireq('DELETE', `/keys/${flags.id}`, null);
        console.log(`Key ${flags.id} revoked.`);
        break;
    }
    case 'list': {
        const result = apireq('GET', '/keys', null);
        console.log(JSON.stringify(result, null, 2));
        break;
    }
    default:
        console.error([
            'Usage: node utils/key_manager.js <command> [flags]',
            '',
            'Commands:',
            '  create  --label <name> [--project-id <uuid>] [--expires-in-days <n>]',
            '  revoke  --id <key-id>',
            '  list',
            '',
            'Env:',
            '  ADMIN_KEY          required for all commands',
            '  OCR_MEMORY_URL     default: http://localhost:3000',
        ].join('\n'));
        process.exit(1);
}

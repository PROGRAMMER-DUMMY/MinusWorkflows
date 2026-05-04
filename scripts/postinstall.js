#!/usr/bin/env node
'use strict';

// Only show banner on direct global installs, not when used as a dependency
if (process.env.npm_config_global !== 'true') process.exit(0);

const b = '\x1b[1m', r = '\x1b[0m', c = '\x1b[36m', g = '\x1b[32m', d = '\x1b[2m';

console.log(`
${b}minus-workflows${r} installed.

${b}Quick start (2 commands):${r}

  ${c}minus init${r}     ${d}Interactive setup — picks your AI provider, generates keys${r}
  ${c}minus start${r}    ${d}Starts the memory service (requires Docker)${r}

${b}Then use it:${r}

  ${c}minus status${r}                   ${d}Health check${r}
  ${c}minus sessions${r}                 ${d}List pipeline runs${r}
  ${c}minus trace${r}                    ${d}View what an agent did (interactive)${r}
  ${c}minus budget${r}                   ${d}Token + cost breakdown per phase${r}
  ${c}minus resume${r}                   ${d}Resume a failed pipeline${r}

  ${g}Full docs:${r}  https://github.com/PROGRAMMER-DUMMY/MinusWorkflows#readme
`);

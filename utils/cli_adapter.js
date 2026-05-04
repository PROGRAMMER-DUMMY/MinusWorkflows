'use strict';

/**
 * Provider-aware CLI adapter.
 *
 * Controls which AI CLI is used to run sub-agents. Configure via env vars:
 *
 *   AGENT_CLI=claude            built-in: claude -p {prompt} --model {model}
 *   AGENT_CLI=gemini            built-in: gemini -p {prompt} --model {model}
 *   AGENT_CLI=openai            built-in: openai api responses.create -t {prompt}
 *   AGENT_CLI=custom            use AGENT_CLI_TEMPLATE (required)
 *
 *   AGENT_CLI_TEMPLATE          override the full command template for any provider.
 *                               Placeholders: {prompt} (JSON-quoted), {model} (raw string).
 *                               Example: "my-cli ask --input {prompt} --engine {model}"
 *
 *   AGENT_DEFAULT_MODEL         override the default model for the active provider.
 *
 * HTTP provider (no CLI binary needed):
 *
 *   AGENT_PROVIDER=http         use direct HTTP API instead of a CLI binary.
 *   AGENT_API_URL               endpoint URL (required when AGENT_PROVIDER=http)
 *   AGENT_API_KEY               API key for the HTTP endpoint
 *   AGENT_API_FORMAT            response format: anthropic | openai | google
 */

const PROVIDERS = {
    claude: {
        template:     'claude -p {prompt} --model {model}',
        defaultModel: 'claude-sonnet-4-6',
    },
    gemini: {
        // gemini CLI: https://github.com/google-gemini/gemini-cli
        template:     'gemini -p {prompt} --model {model}',
        defaultModel: 'gemini-2.0-flash',
    },
    openai: {
        // openai-cli: https://github.com/openai/openai-python (openai api responses.create)
        template:     'openai api responses.create -t {prompt} --model {model}',
        defaultModel: 'gpt-4o',
    },
    custom: {
        template:     null, // must be set via AGENT_CLI_TEMPLATE
        defaultModel: '',
    },
};

/** Active provider name (lower-cased). */
function getProviderName() {
    return (process.env.AGENT_CLI || 'claude').toLowerCase();
}

/** Provider config record (falls back to claude if name is unknown). */
function getProvider() {
    return PROVIDERS[getProviderName()] || PROVIDERS.claude;
}

/** Default model for the active provider, overridable via AGENT_DEFAULT_MODEL. */
function getDefaultModel() {
    return process.env.AGENT_DEFAULT_MODEL || getProvider().defaultModel;
}

/**
 * Build the shell command for a given prompt + model.
 * Precedence: AGENT_CLI_TEMPLATE > provider built-in template.
 */
function buildCommand(prompt, model) {
    const template = process.env.AGENT_CLI_TEMPLATE || getProvider().template;

    if (!template) {
        throw new Error(
            `AGENT_CLI=custom requires AGENT_CLI_TEMPLATE to be set.\n` +
            `Example: AGENT_CLI_TEMPLATE="my-cli -p {prompt} --model {model}"`
        );
    }

    return template
        .replace('{prompt}', JSON.stringify(prompt))
        .replace('{model}',  model);
}

/** Human-readable description of active configuration (for logs). */
function describe() {
    if (isHttpProvider()) {
        const fmt = process.env.AGENT_API_FORMAT || 'openai';
        const url = process.env.AGENT_API_URL || '(AGENT_API_URL not set)';
        return `provider=http format=${fmt} url=${url}`;
    }
    const name  = getProviderName();
    const model = getDefaultModel();
    const tmpl  = process.env.AGENT_CLI_TEMPLATE || getProvider().template || '(custom, template missing)';
    return `provider=${name} model=${model} template="${tmpl}"`;
}

// ── HTTP provider support ─────────────────────────────────────────────────────

/** Returns true when AGENT_PROVIDER=http — use direct API calls instead of CLI. */
function isHttpProvider() {
    return (process.env.AGENT_PROVIDER || '').toLowerCase() === 'http';
}

/**
 * Build an HTTP request descriptor for the configured API provider.
 * Returns { url, headers, body } ready for fetch().
 */
function buildHttpRequest(prompt, model) {
    const url    = process.env.AGENT_API_URL;
    const apiKey = process.env.AGENT_API_KEY || '';
    const fmt    = (process.env.AGENT_API_FORMAT || 'openai').toLowerCase();

    if (!url) throw new Error('AGENT_API_URL is required when AGENT_PROVIDER=http');

    const requestsByFormat = {
        anthropic: {
            url,
            headers: {
                'x-api-key':         apiKey,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json',
            },
            body: { model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] },
        },
        openai: {
            url,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json',
            },
            body: { model, messages: [{ role: 'user', content: prompt }] },
        },
        google: {
            url: `${url.replace(/\/$/, '')}/${model}:generateContent?key=${apiKey}`,
            headers: { 'Content-Type': 'application/json' },
            body: { contents: [{ parts: [{ text: prompt }] }] },
        },
    };

    const cfg = requestsByFormat[fmt] || requestsByFormat.openai;
    return cfg;
}

/**
 * Extract the text content from a provider API response object.
 */
function extractText(responseJson, format) {
    const fmt = (format || process.env.AGENT_API_FORMAT || 'openai').toLowerCase();
    try {
        if (fmt === 'anthropic') return responseJson.content?.[0]?.text || '';
        if (fmt === 'google')    return responseJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // openai / openai-compatible
        return responseJson.choices?.[0]?.message?.content || '';
    } catch {
        return '';
    }
}

module.exports = {
    buildCommand, buildHttpRequest, extractText,
    getDefaultModel, getProviderName, isHttpProvider, describe,
};

/**
 * NanoClaw Guard — Programmatic PreToolUse hook for Bash commands.
 *
 * Three-tier evaluation:
 *   1. Critical regex → instant block
 *   2. Suspicious + Guard API token → synchronous API check
 *   3. Non-suspicious + Guard API token → async fire-and-forget
 *
 * Without GUARD_API_TOKEN / GUARD_POLICY_ID, only critical regex is enforced.
 */

import type { HookCallback, HookInput, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export interface GuardConfig {
  apiUrl: string;
  apiToken: string;
  policyId: string;
  fastMode: boolean;
  enabled: boolean;
  debug: boolean;
  feedbackUrl: string;
  feedbackToken: string;
}

export function buildGuardConfig(env: Record<string, string | undefined>): GuardConfig {
  return {
    apiUrl: env.GUARD_API_URL || 'https://virtueagent-action-guard.ngrok.io',
    apiToken: env.GUARD_API_TOKEN || '',
    policyId: env.GUARD_POLICY_ID || '',
    fastMode: env.GUARD_FAST_MODE !== 'false',
    enabled: env.GUARD_ENABLED !== 'false',
    debug: env.GUARD_DEBUG === 'true',
    feedbackUrl: env.FEEDBACK_URL || '',
    feedbackToken: env.FEEDBACK_TOKEN || '',
  };
}

interface Pattern {
  regex: RegExp;
  description: string;
}

export const CRITICAL_PATTERNS: Pattern[] = [
  { regex: /\brm\s+(-[frRvI]+\s+)*\/\s*$/i, description: 'rm targeting root filesystem (/)' },
  { regex: /\brm\s+(-[frRvI]+\s+)*\/\*\s*$/i, description: 'rm targeting all files in root (/*)' },
  { regex: /\bmkfs\.\w+\s+\/dev\/[sh]d[a-z]\s*$/i, description: 'Formatting entire disk' },
  { regex: /\bdd\s+.*\bof=\/dev\/[sh]d[a-z]\b/i, description: 'dd writing to entire disk' },
  { regex: /:\(\)\s*{\s*:\|:&\s*}\s*;?\s*:/, description: 'Fork bomb' },
];

export const SUSPICIOUS_PATTERNS: Pattern[] = [
  { regex: /\bgit\b/i, description: 'git command' },
  { regex: /\brm\b/i, description: 'rm command' },
  { regex: /\bchmod\s+\d{3,4}\b/i, description: 'chmod with numeric mode' },
  { regex: /\bchown\b/i, description: 'chown command' },
  { regex: /\bsudo\b/i, description: 'sudo usage' },
  { regex: /\bdd\b/i, description: 'dd command' },
  { regex: /\bmkfs\b/i, description: 'mkfs command' },
  { regex: /\bshutdown\b|\breboot\b/i, description: 'shutdown or reboot' },
  { regex: /\bkill\b\s+-9\b/i, description: 'force kill' },
  { regex: /\biptables\b|\bufw\b|\bfirewall-cmd\b/i, description: 'firewall change' },
  { regex: /\bcurl\b.*\|\s*(sh|bash|zsh)\b/i, description: 'curl piped to shell' },
  { regex: /\bwget\b.*\|\s*(sh|bash|zsh)\b/i, description: 'wget piped to shell' },
  { regex: /\bnc\b|\bnetcat\b/i, description: 'netcat usage' },
  { regex: /\bcurl\b.*(-d|--data)\b/i, description: 'curl with data upload' },
  { regex: /\.ssh\b/i, description: 'accessing .ssh directory' },
  { regex: /\.aws\b/i, description: 'accessing .aws credentials' },
  { regex: /\.env\b/i, description: 'accessing .env file' },
];

export function matchCritical(command: string): Pattern | null {
  for (const p of CRITICAL_PATTERNS) {
    if (p.regex.test(command)) return p;
  }
  return null;
}

export function matchSuspicious(command: string): Pattern | null {
  for (const p of SUSPICIOUS_PATTERNS) {
    if (p.regex.test(command)) return p;
  }
  return null;
}

interface GuardApiResponse {
  allowed: boolean;
  threat_category?: string;
  explanation?: string;
  violations?: string[];
}

function buildSessionHistory(command: string) {
  return {
    session_info: {
      metadata: { actions_count: 1, step_count: 1, tool_count: 1 },
    },
    trajectory: [
      {
        role: 'agent',
        action: `exec(command=${JSON.stringify(command)})`,
        metadata: {
          tool_name: 'exec',
          tool_params: { command },
          server_name: 'nanoclaw-guard',
          server_id: 'nanoclaw-guard',
        },
        step_id: 0,
      },
    ],
  };
}

async function analyzeWithGuardApi(
  command: string,
  config: GuardConfig,
): Promise<GuardApiResponse> {
  const history = buildSessionHistory(command);
  const res = await fetch(`${config.apiUrl}/api/v1/guard_actions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({
      session_history: history,
      session_id: `nanoclaw-${Date.now()}`,
      policy_id: config.policyId,
      fast_mode: config.fastMode,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Guard API ${res.status}: ${text}`);
  }

  return (await res.json()) as GuardApiResponse;
}

function reportFeedback(config: GuardConfig, entry: Record<string, unknown>): void {
  if (!config.feedbackUrl) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.feedbackToken) headers['x-api-token'] = config.feedbackToken;
  fetch(config.feedbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(entry),
  }).catch(() => {});
}

function blockResponse(command: string, reason: string, detail?: string): SyncHookJSONOutput {
  const lines = [
    '**NanoClaw Guard: Command Blocked**',
    '',
    `> \`${command}\``,
    '',
    `**Reason:** ${reason}`,
  ];
  if (detail) lines.push('', detail);
  lines.push('', '---', '*If this is intentional, rephrase your request with more context.*');

  return {
    decision: 'block',
    reason: lines.join('\n'),
  };
}

export function createGuardHook(config: GuardConfig): HookCallback {
  const log = (msg: string) => {
    if (config.debug) console.error(`[guard] ${msg}`);
  };

  return async (input: HookInput, _toolUseId: string | undefined, _options: { signal: AbortSignal }): Promise<SyncHookJSONOutput> => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command || typeof command !== 'string') return {};

    log(`Checking: ${command}`);

    const critical = matchCritical(command);
    if (critical) {
      log(`BLOCKED (critical): ${critical.description}`);
      reportFeedback(config, {
        command,
        source: 'regex',
        blocked: true,
        regexPattern: critical.description,
        timestamp: new Date().toISOString(),
      });
      return blockResponse(command, critical.description);
    }

    if (!config.apiToken || !config.policyId) {
      log('No GUARD_API_TOKEN or GUARD_POLICY_ID — skipping API analysis');
      reportFeedback(config, {
        command,
        source: 'skipped',
        blocked: false,
        timestamp: new Date().toISOString(),
      });
      return {};
    }

    const suspicious = matchSuspicious(command);
    if (!suspicious) {
      log('Not suspicious — async (non-blocking)');
      analyzeWithGuardApi(command, config)
        .then((data) => {
          log(`Async result: allowed=${data.allowed}`);
          reportFeedback(config, {
            command,
            source: 'guard-api-async',
            blocked: false,
            analysis: {
              allowed: data.allowed,
              threatCategory: data.threat_category,
              reason: data.explanation,
              violations: data.violations,
            },
            timestamp: new Date().toISOString(),
          });
        })
        .catch((err) => log(`Async error: ${(err as Error).message}`));
      return {};
    }

    log(`Suspicious: ${suspicious.description} — calling Guard API`);
    try {
      const data = await analyzeWithGuardApi(command, config);
      log(`Guard API: allowed=${data.allowed}, category=${data.threat_category}`);

      reportFeedback(config, {
        command,
        source: 'guard-api',
        blocked: !data.allowed,
        analysis: {
          allowed: data.allowed,
          threatCategory: data.threat_category,
          reason: data.explanation,
          violations: data.violations,
        },
        timestamp: new Date().toISOString(),
      });

      if (!data.allowed) {
        log(`BLOCKED by Guard API: ${data.threat_category}`);
        const violationsSummary = data.violations && data.violations.length > 0
          ? `Violations:\n• ${data.violations.slice(0, 2).join('\n• ')}`
          : undefined;
        return blockResponse(command, data.explanation || 'Blocked by Guard API', violationsSummary);
      }

      log('Allowed by Guard API');
      return {};
    } catch (err) {
      log(`Guard API error: ${(err as Error).message} — allowing`);
      return {};
    }
  };
}

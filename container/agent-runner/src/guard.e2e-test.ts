import { createGuardHook, buildGuardConfig } from './guard.js';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

function makeInput(command: string): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'e2e-test-id',
    session_id: 'e2e-test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/workspace/group',
  };
}

const tests = [
  { name: 'rm -rf /', command: 'rm -rf /', expectBlock: true },
  { name: 'rm -rf /*', command: 'rm -rf /*', expectBlock: true },
  { name: 'fork bomb', command: ':(){ :|:& };:', expectBlock: true },
  { name: 'mkfs disk', command: 'mkfs.ext4 /dev/sda', expectBlock: true },
  { name: 'dd to disk', command: 'dd if=/dev/zero of=/dev/sda', expectBlock: true },

  { name: 'echo hello', command: 'echo hello', expectBlock: false },
  { name: 'ls -la', command: 'ls -la', expectBlock: false },
  { name: 'pwd', command: 'pwd', expectBlock: false },
  { name: 'cat README', command: 'cat README.md', expectBlock: false },
  { name: 'node script', command: 'node index.js', expectBlock: false },

  { name: 'rm build dir', command: 'rm -rf ./build', expectBlock: false },
  { name: 'git status', command: 'git status', expectBlock: false },
  { name: 'chmod 644', command: 'chmod 644 file.txt', expectBlock: false },
];

const env = { ...process.env } as Record<string, string | undefined>;
const config = buildGuardConfig(env);

console.log('');
console.log('Suite 1: Hook-level Integration Tests');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Guard API: ${config.apiToken ? 'configured' : 'NOT configured (regex only)'}`);
console.log('');

const hook = createGuardHook(config);
const ac = new AbortController();
let pass = 0;
let fail = 0;

for (const t of tests) {
  try {
    const result = await hook(makeInput(t.command), 'e2e-test-id', { signal: ac.signal }) as SyncHookJSONOutput;
    const blocked = result.decision === 'block';

    if (blocked === t.expectBlock) {
      pass++;
      console.log(`  ✓ ${t.name} → ${blocked ? 'BLOCKED' : 'allowed'}`);
    } else {
      fail++;
      console.log(`  ✗ ${t.name} → expected ${t.expectBlock ? 'block' : 'allow'}, got ${blocked ? 'block' : 'allow'}`);
      if (result.reason) console.log(`    reason: ${result.reason.split('\n')[0]}`);
    }
  } catch (err) {
    fail++;
    console.log(`  ✗ ${t.name} → ERROR: ${(err as Error).message}`);
  }
}

console.log('');
console.log(`  ${pass} passed, ${fail} failed, ${pass + fail} total`);
console.log(`HOOK_RESULTS:${JSON.stringify({ pass, fail })}`);
process.exit(0);

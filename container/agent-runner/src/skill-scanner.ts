import fs from 'fs';
import path from 'path';

export interface SkillsGuardConfig {
  apiUrl: string;
  apiKey: string;
  guardUuid: string;
  enabled: boolean;
  debug: boolean;
}

export interface SkillScanResult {
  name: string;
  flagged: boolean;
  categories: Record<string, boolean>;
  probs: Record<string, number>;
  reasoning: string | null;
  latencyMs: number;
}

export interface ScanReport {
  scannedCount: number;
  blockedCount: number;
  results: SkillScanResult[];
}

interface SkillsGuardResponse {
  flag: boolean;
  id: string;
  guard: string;
  results: Array<{
    policy_group_uuid: string;
    policy_group_name: string;
    flagged: boolean;
    threshold: number;
    strictness_level: string;
    probs: Record<string, number>;
    categories: Record<string, boolean>;
    reasoning: string | null;
  }>;
  latency_ms: number;
}

const DEFAULT_API_URL =
  'https://guard-policy-backend-latest.staging.virtueai.io/api/topic_guard';
const SKILLS_DIR = '/home/node/.claude/skills';

export function buildSkillsGuardConfig(
  env: Record<string, string | undefined>,
): SkillsGuardConfig {
  return {
    apiUrl: env.SKILLS_GUARD_API_URL || DEFAULT_API_URL,
    apiKey: env.SKILLS_GUARD_API_KEY || '',
    guardUuid: env.SKILLS_GUARD_UUID || '',
    enabled: env.SKILLS_GUARD_ENABLED !== 'false',
    debug: env.GUARD_DEBUG === 'true',
  };
}

function log(config: SkillsGuardConfig, msg: string): void {
  if (config.debug) console.error(`[skill-scanner] ${msg}`);
}

async function scanSkillContent(
  text: string,
  config: SkillsGuardConfig,
): Promise<SkillsGuardResponse> {
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify({
      text,
      guard_uuid: config.guardUuid,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Skills Guard API ${res.status}: ${body}`);
  }

  return (await res.json()) as SkillsGuardResponse;
}

export async function scanSkillsAtSessionStart(
  config: SkillsGuardConfig,
  skillsDir: string = SKILLS_DIR,
): Promise<ScanReport> {
  const report: ScanReport = { scannedCount: 0, blockedCount: 0, results: [] };

  if (!config.enabled) {
    log(config, 'Skill scanning disabled (SKILLS_GUARD_ENABLED=false)');
    return report;
  }

  if (!config.apiKey || !config.guardUuid) {
    log(
      config,
      'Skill scanning skipped (no SKILLS_GUARD_API_KEY or SKILLS_GUARD_UUID)',
    );
    return report;
  }

  if (!fs.existsSync(skillsDir)) {
    log(config, `Skills directory not found: ${skillsDir}`);
    return report;
  }

  const entries = fs.readdirSync(skillsDir).filter((entry) => {
    const entryPath = path.join(skillsDir, entry);
    return fs.statSync(entryPath).isDirectory();
  });

  if (entries.length === 0) {
    log(config, 'No skills found to scan');
    return report;
  }

  log(config, `Scanning ${entries.length} skill(s)...`);

  const scanPromises = entries.map(
    async (skillName): Promise<SkillScanResult | null> => {
      const skillMdPath = path.join(skillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) return null;

      const content = fs.readFileSync(skillMdPath, 'utf-8');
      if (!content.trim()) return null;

      try {
        const response = await scanSkillContent(content, config);
        const firstResult = response.results[0];
        const result: SkillScanResult = {
          name: skillName,
          flagged: response.flag,
          categories: firstResult?.categories ?? {},
          probs: firstResult?.probs ?? {},
          reasoning: firstResult?.reasoning ?? null,
          latencyMs: response.latency_ms,
        };

        if (response.flag) {
          const blockedPath = skillMdPath + '.blocked';
          fs.renameSync(skillMdPath, blockedPath);
          log(
            config,
            `BLOCKED skill "${skillName}" → renamed to SKILL.md.blocked`,
          );

          const triggered = Object.entries(result.categories)
            .filter(([, v]) => v)
            .map(([k]) => k);
          if (triggered.length > 0) {
            log(config, `  Triggered categories: ${triggered.join(', ')}`);
          }
        } else {
          log(
            config,
            `OK skill "${skillName}" (${response.latency_ms.toFixed(0)}ms)`,
          );
        }

        return result;
      } catch (err) {
        // fail-open: API errors should not block legitimate skills
        console.error(
          `[skill-scanner] Error scanning "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          name: skillName,
          flagged: false,
          categories: {},
          probs: {},
          reasoning: null,
          latencyMs: 0,
        };
      }
    },
  );

  const results = await Promise.all(scanPromises);

  for (const result of results) {
    if (!result) continue;
    report.scannedCount++;
    report.results.push(result);
    if (result.flagged) report.blockedCount++;
  }

  const summary = `Skill scan complete: ${report.scannedCount} scanned, ${report.blockedCount} blocked`;
  console.error(`[skill-scanner] ${summary}`);

  return report;
}

/**
 * VirtueAI MCP Gateway Authentication Script
 *
 * Performs OAuth 2.0 authorization_code flow with PKCE:
 * 1. Registers an OAuth client (or reuses existing)
 * 2. Opens browser for user login
 * 3. Catches callback on local HTTP server
 * 4. Exchanges code for access_token + refresh_token
 * 5. Saves tokens to .env
 *
 * Usage: npx tsx src/gateway-auth.ts [--gateway-url https://...]
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { URL } from 'url';

const CALLBACK_PORT = 19876;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const ENV_PATH = path.resolve(process.cwd(), '.env');
const SCOPES = 'claudeai copilot mcp:read mcp:execute mcp:access';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/** Fetch JSON via https (follows redirects). */
function fetchJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      {
        method: options.method ?? 'GET',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: body });
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** PKCE helpers */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Read or create .env, upsert a key=value pair. */
function upsertEnv(key: string, value: string): void {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  }
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content);
}

/** Open URL in default browser. */
function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || echo "Open: ${url}"`);
    } else {
      execSync(`start "" "${url}"`);
    }
  } catch {
    console.log(`  Please open this URL manually:\n  ${url}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Determine gateway URL
  let gatewayUrl = getArg('gateway-url');
  if (!gatewayUrl) {
    // Try reading from .env
    if (fs.existsSync(ENV_PATH)) {
      const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
      const match = envContent.match(/^MCP_GATEWAY_URL=(.+)$/m);
      if (match) {
        // Strip /mcp suffix to get base URL
        gatewayUrl = match[1].trim().replace(/\/mcp\/?$/, '');
      }
    }
  } else {
    gatewayUrl = gatewayUrl.replace(/\/mcp\/?$/, '');
  }

  if (!gatewayUrl) {
    console.error('Error: No gateway URL found.');
    console.error('Either set MCP_GATEWAY_URL in .env or pass --gateway-url <url>');
    process.exit(1);
  }

  console.log(`\nVirtueAI MCP Gateway Authentication\n`);
  console.log(`  Gateway: ${gatewayUrl}`);

  // 2. Discover OAuth metadata
  console.log(`  Discovering OAuth endpoints...`);
  const { data: metadata } = await fetchJson(
    `${gatewayUrl}/.well-known/oauth-authorization-server`,
    { method: 'GET' },
  );

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    console.error('Error: Could not discover OAuth endpoints from gateway.');
    console.error('Response:', JSON.stringify(metadata, null, 2));
    process.exit(1);
  }

  const authEndpoint: string = metadata.authorization_endpoint;
  const tokenEndpoint: string = metadata.token_endpoint;
  const registerEndpoint: string = metadata.registration_endpoint;

  console.log(`  Auth endpoint: ${authEndpoint}`);
  console.log(`  Token endpoint: ${tokenEndpoint}`);

  // 3. Register OAuth client (dynamic client registration)
  console.log(`  Registering OAuth client...`);
  const { status: regStatus, data: clientInfo } = await fetchJson(registerEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'nanoclaw-agent',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [REDIRECT_URI],
      scope: SCOPES,
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!clientInfo.client_id) {
    console.error(`Error: Client registration failed (${regStatus}).`);
    console.error(JSON.stringify(clientInfo, null, 2));
    process.exit(1);
  }

  const clientId: string = clientInfo.client_id;
  console.log(`  Client ID: ${clientId}`);

  // 4. Build authorization URL with PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // 5. Start local callback server & open browser
  const authCode = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authentication failed</h2><p>${error}</p><p>You can close this window.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Invalid callback</h2><p>Missing code or state mismatch.</p>');
        server.close();
        reject(new Error('Invalid callback: missing code or state mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<h2>Authentication successful!</h2>' +
        '<p>You can close this window and return to the terminal.</p>' +
        '<script>window.close()</script>',
      );
      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`\n  Opening browser for login...`);
      console.log(`  (callback server listening on port ${CALLBACK_PORT})\n`);
      openBrowser(authUrl.toString());
    });

    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is in use. Close the other process and try again.`));
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);
  });

  console.log(`  Authorization code received. Exchanging for tokens...`);

  // 6. Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: authCode,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  }).toString();

  const { status: tokenStatus, data: tokenData } = await fetchJson(tokenEndpoint, {
    method: 'POST',
    body: tokenBody,
  });

  if (!tokenData.access_token) {
    console.error(`Error: Token exchange failed (${tokenStatus}).`);
    console.error(JSON.stringify(tokenData, null, 2));
    process.exit(1);
  }

  console.log(`  Access token received (expires in ${tokenData.expires_in}s)`);

  // 7. Save to .env
  upsertEnv('MCP_GATEWAY_URL', `${gatewayUrl}/mcp`);
  upsertEnv('MCP_GATEWAY_ACCESS_TOKEN', tokenData.access_token);
  if (tokenData.refresh_token) {
    upsertEnv('MCP_GATEWAY_REFRESH_TOKEN', tokenData.refresh_token);
  }
  // Store client credentials for future token refresh
  upsertEnv('MCP_GATEWAY_CLIENT_ID', clientId);
  if (clientInfo.client_secret) {
    upsertEnv('MCP_GATEWAY_CLIENT_SECRET', clientInfo.client_secret);
  }
  // Clean up old API key entry if present
  if (fs.existsSync(ENV_PATH)) {
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    content = content.replace(/^MCP_GATEWAY_API_KEY=.*\n?/m, '');
    fs.writeFileSync(ENV_PATH, content);
  }

  console.log(`\n  Saved to .env:`);
  console.log(`    MCP_GATEWAY_URL=${gatewayUrl}/mcp`);
  console.log(`    MCP_GATEWAY_ACCESS_TOKEN=<${tokenData.access_token.length} chars>`);
  if (tokenData.refresh_token) {
    console.log(`    MCP_GATEWAY_REFRESH_TOKEN=<${tokenData.refresh_token.length} chars>`);
  }
  console.log(`    MCP_GATEWAY_CLIENT_ID=${clientId}`);

  // 8. Quick verification
  console.log(`\n  Verifying token with gateway...`);
  const { status: verifyStatus, data: verifyData } = await fetchJson(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  if (verifyStatus === 200 && verifyData?.result?.tools) {
    const toolCount = verifyData.result.tools.length;
    console.log(`  Verified! ${toolCount} tools available.\n`);
  } else {
    console.log(`  Warning: verification returned status ${verifyStatus}`);
    console.log(`  Response: ${JSON.stringify(verifyData).slice(0, 200)}`);
    console.log(`  The token was saved but may not work yet.\n`);
  }

  console.log(`Done. You can now run NanoClaw with gateway integration.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

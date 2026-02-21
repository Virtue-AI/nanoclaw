# VirtueAI MCP Gateway

Connects NanoClaw agents to enterprise tools (HR, Slack, Gmail, Salesforce, etc.) through a single MCP endpoint.

## Setup

1. Get an API key from the VirtueAI auth server:

```bash
# Login
curl -X POST https://api-auth.staging.virtueai.io/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"YOUR_USER","password":"YOUR_PASS"}'

# Create API key (use the access_token from login)
curl -X POST https://api-auth.staging.virtueai.io/api/v1/api-keys \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"nanoclaw"}'
```

Save the `key` field from the response. It won't be shown again.

2. Add to `.env`:

```bash
MCP_GATEWAY_URL=https://virtueai-agent-gtw-xxx.ngrok.io/mcp
MCP_GATEWAY_API_KEY=sk-vai-...
```

3. Restart NanoClaw. The agent now has access to all gateway tools.

## Available Tools

| Prefix | Tools |
|--------|-------|
| HR-MCP | `list_employees`, `get_employee`, `list_companies`, `list_departments` |
| Slack-MCP | `list_channels`, `post_message`, `open_dm`, `post_message_dm` |
| Gmail-MCP | `list_messages`, `send_email`, `search_messages`, `send_reply` |
| Salesforce-MCP | `list_leads`, `create_lead`, `list_contacts`, `create_contact` |
| Paypal-MCP | `create_payout`, `list_payouts`, `approve_pending_payout` |
| ServiceNow | `list_orders`, `list_cases`, `refund_order`, `transfer_to_human` |

Tools are exposed to the agent as `mcp__virtueai__HR-MCP_list_employees`, etc.

## How It Works

The gateway is added as an HTTP MCP server in the agent-runner. When `MCP_GATEWAY_URL` is set in `.env`:

1. `container-runner.ts` passes the URL and API key to the container as secrets
2. `agent-runner/src/index.ts` registers it as an `http` type MCP server with `X-API-Key` auth
3. The agent can call any gateway tool alongside its normal tools (Bash, Read, Write, etc.)
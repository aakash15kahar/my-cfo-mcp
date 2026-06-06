# My CFO — MCP Server

Connect any AI to your financial data. Built on Cloudflare Workers.

## What this does
Exposes 15 tools that any AI can call:
- get_summary, get_transactions, add_transaction, delete_transaction
- get_goals, add_goal, update_goal, delete_goal
- get_investments, add_investment, update_investment_balance, delete_investment
- get_profile, update_profile

---

## Deploy to Cloudflare Workers (10 mins)

### Step 1 — Install Wrangler (Cloudflare CLI)
Open Terminal on your Mac and run:
```bash
npm install -g wrangler
```

### Step 2 — Login to Cloudflare
```bash
wrangler login
```
This opens a browser — click Allow.

### Step 3 — Go to the mcp folder
```bash
cd /path/to/mycfo-mcp
```

### Step 4 — Set your secret environment variables
```bash
wrangler secret put SUPABASE_URL
# Paste: https://momuoylppigaqiefnyix.supabase.co

wrangler secret put SUPABASE_KEY
# Paste: your anon key from Supabase

wrangler secret put MCP_SECRET
# Make up any password e.g: mycfo-secret-abc123
# SAVE THIS — you need it to connect AI tools
```

### Step 5 — Deploy!
```bash
wrangler deploy
```
You'll get a URL like: `https://mycfo-mcp.YOUR-NAME.workers.dev`

### Step 6 — Test it works
Open in browser: `https://mycfo-mcp.YOUR-NAME.workers.dev/health`
You should see: `{"status":"ok","name":"My CFO MCP Server",...}`

---

## Connect to Claude Desktop

1. Open Terminal and find your Claude config:
   - Mac: `~/.config/claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

2. Add this (replace YOUR values):
```json
{
  "mcpServers": {
    "my-cfo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mycfo-mcp.YOUR-NAME.workers.dev/mcp"],
      "env": {
        "MCP_REMOTE_AUTH_HEADER": "Authorization: Bearer YOUR_MCP_SECRET"
      }
    }
  }
}
```

3. Restart Claude Desktop — you'll see "my-cfo" in the tools list!

---

## Connect to Cursor / VS Code

In Cursor settings → MCP Servers → Add:
```json
{
  "name": "my-cfo",
  "url": "https://mycfo-mcp.YOUR-NAME.workers.dev/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_SECRET"
  }
}
```

---

## Connect to ChatGPT / any AI (REST API)

Call the simple REST endpoint directly:
```bash
# Get your financial summary
curl -X POST https://mycfo-mcp.YOUR-NAME.workers.dev/tools/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MCP_SECRET" \
  -d '{"tool": "get_summary", "args": {}}'

# Add a transaction
curl -X POST https://mycfo-mcp.YOUR-NAME.workers.dev/tools/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MCP_SECRET" \
  -d '{
    "tool": "add_transaction",
    "args": {
      "description": "Tesco groceries",
      "amount": 45.50,
      "category": "expense",
      "subcat": "food",
      "date": "2026-06-04"
    }
  }'
```

---

## Available Tools

| Tool | Description |
|------|-------------|
| get_summary | Full monthly financial summary |
| get_transactions | List transactions (filter by month/category) |
| add_transaction | Add income/expense/investment |
| delete_transaction | Delete by ID |
| get_goals | List savings goals |
| add_goal | Create new goal |
| update_goal | Update savings progress |
| delete_goal | Remove goal |
| get_investments | List investment accounts |
| add_investment | Add new account |
| update_investment_balance | Update balance |
| delete_investment | Remove account |
| get_profile | Get financial settings |
| update_profile | Update income/budget settings |

---

## Example AI Conversations (after connecting)

> "Add £45 Tesco shop from today"
> "How much did I spend on dining last month?"
> "What's my savings rate this month?"
> "Add my salary of £3200 for today"
> "How close am I to my emergency fund goal?"
> "Update my ISA balance to £12,500"
> "Give me a full financial report"

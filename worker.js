/**
 * My CFO — MCP Server
 * Hosted on Cloudflare Workers
 * Compatible with: Claude, ChatGPT, Cursor, Gemini, any HTTP MCP client
 *
 * Set these environment variables in Cloudflare:
 *   SUPABASE_URL  = https://momuoylppigaqiefnyix.supabase.co
 *   SUPABASE_KEY  = your anon key
 *   MCP_SECRET    = a secret string you choose (e.g. "mycfo-secret-123")
 */

// ─── TOOL DEFINITIONS ────────────────────────────────────────
const TOOLS = [
  {
    name: "get_summary",
    description: "Get a full financial summary including income, spending, savings rate, health score, net worth and cash flow for the current month.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Optional. Month in YYYY-MM format. Defaults to current month." }
      }
    }
  },
  {
    name: "get_transactions",
    description: "Get transactions. Can filter by category, date range, or search by description.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["income", "expense", "investment"], description: "Filter by category" },
        month: { type: "string", description: "Filter by month in YYYY-MM format" },
        limit: { type: "number", description: "Max number of results. Default 50." },
        search: { type: "string", description: "Search transactions by description" }
      }
    }
  },
  {
    name: "add_transaction",
    description: "Add a new financial transaction. Use this when the user says things like 'I spent £X on Y' or 'I got paid £X' or 'I invested £X'.",
    inputSchema: {
      type: "object",
      required: ["description", "amount", "category", "date"],
      properties: {
        description: { type: "string", description: "What the transaction is for e.g. 'Tesco groceries', 'Monthly salary'" },
        amount: { type: "number", description: "Amount in pounds (always positive)" },
        category: { type: "string", enum: ["income", "expense", "investment"], description: "Type of transaction" },
        subcat: {
          type: "string",
          description: "Sub-category",
          enum: ["salary","freelance","other-income","housing","food","transport","bills","health","entertainment","shopping","dining","other-expense","stocks","pension","crypto","property","other-inv"]
        },
        date: { type: "string", description: "Date in YYYY-MM-DD format. Use today's date if not specified." },
        note: { type: "string", description: "Optional note" }
      }
    }
  },
  {
    name: "delete_transaction",
    description: "Delete a transaction by its ID. First use get_transactions to find the ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number", description: "Transaction ID to delete" }
      }
    }
  },
  {
    name: "get_goals",
    description: "Get all savings goals with their progress, target amounts and deadlines.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "add_goal",
    description: "Add a new savings goal.",
    inputSchema: {
      type: "object",
      required: ["name", "target_amount"],
      properties: {
        name: { type: "string", description: "Goal name e.g. 'Emergency fund', 'Holiday to Spain'" },
        target_amount: { type: "number", description: "Target amount in pounds" },
        current_amount: { type: "number", description: "Current savings toward this goal. Default 0." },
        target_date: { type: "string", description: "Target date in YYYY-MM-DD format" }
      }
    }
  },
  {
    name: "update_goal",
    description: "Update the current savings amount for a goal.",
    inputSchema: {
      type: "object",
      required: ["id", "current_amount"],
      properties: {
        id: { type: "number", description: "Goal ID" },
        current_amount: { type: "number", description: "New current savings amount" }
      }
    }
  },
  {
    name: "delete_goal",
    description: "Delete a savings goal by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number", description: "Goal ID to delete" }
      }
    }
  },
  {
    name: "get_investments",
    description: "Get all investment accounts with their balances and monthly contributions.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "add_investment",
    description: "Add a new investment account.",
    inputSchema: {
      type: "object",
      required: ["name", "balance"],
      properties: {
        name: { type: "string", description: "Account name e.g. 'Vanguard ISA', 'Pension'" },
        balance: { type: "number", description: "Current balance in pounds" },
        type: { type: "string", enum: ["ISA","SIPP/Pension","GIA","Crypto","Property","Other"], description: "Account type" },
        monthly_contribution: { type: "number", description: "Monthly contribution amount" }
      }
    }
  },
  {
    name: "update_investment_balance",
    description: "Update the balance of an investment account.",
    inputSchema: {
      type: "object",
      required: ["id", "balance"],
      properties: {
        id: { type: "number", description: "Investment account ID" },
        balance: { type: "number", description: "New balance in pounds" }
      }
    }
  },
  {
    name: "delete_investment",
    description: "Delete an investment account by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number", description: "Investment ID to delete" }
      }
    }
  },
  {
    name: "get_profile",
    description: "Get the user's financial profile — monthly income, budget, savings target and currency.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "update_profile",
    description: "Update the user's financial profile settings.",
    inputSchema: {
      type: "object",
      properties: {
        income: { type: "number", description: "Monthly take-home income" },
        budget: { type: "number", description: "Monthly spending budget" },
        save_target: { type: "number", description: "Monthly savings target" },
        currency: { type: "string", description: "Currency symbol e.g. £" }
      }
    }
  }
];

// ─── SUPABASE HELPERS ────────────────────────────────────────
function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'apikey': env.SUPABASE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_KEY}`,
    'Prefer': 'return=representation'
  };
}

async function sbGet(env, table, query = '') {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`DB error: ${await r.text()}`);
  return r.json();
}

async function sbInsert(env, table, data) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: sbHeaders(env), body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Insert error: ${await r.text()}`);
  return r.json();
}

async function sbUpdate(env, table, id, data) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...sbHeaders(env), 'Prefer': 'return=minimal' }, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Update error: ${await r.text()}`);
  return { success: true };
}

async function sbDelete(env, table, id) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE', headers: sbHeaders(env)
  });
  if (!r.ok) throw new Error(`Delete error: ${await r.text()}`);
  return { success: true, deleted_id: id };
}

async function sbUpsert(env, table, data, onConflict = 'id') {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Upsert error: ${await r.text()}`);
  return r.json();
}

// ─── CALCULATIONS ─────────────────────────────────────────────
function calcStats(transactions) {
  let income = 0, spent = 0, invested = 0;
  transactions.forEach(t => {
    if (t.category === 'income') income += Number(t.amount);
    else if (t.category === 'investment') invested += Number(t.amount);
    else spent += Number(t.amount);
  });
  const cashflow = income - spent - invested;
  const saverate = income > 0 ? Math.round((cashflow / income) * 100) : 0;
  return { income, spent, invested, cashflow, saverate };
}

function calcHealth(stats, goals, investments) {
  let s = 30;
  if (stats.income > 0) {
    s += Math.min(25, stats.saverate * 0.5);
    if (stats.saverate >= 20) s += 10;
    const invR = (stats.invested / stats.income) * 100;
    s += Math.min(15, invR * 0.75);
    if (goals.length > 0) s += 5;
    if (investments.length > 0) s += 5;
  }
  return Math.min(100, Math.max(0, Math.round(s)));
}

// ─── TOOL EXECUTOR ────────────────────────────────────────────
async function executeTool(name, args, env) {
  const today = new Date().toISOString().split('T')[0];
  const currentMonth = today.slice(0, 7);

  switch (name) {

    case 'get_summary': {
      const month = args.month || currentMonth;
      const [yr, mo] = month.split('-').map(Number);
      const txs = await sbGet(env, 'cfo_transactions', `order=created_at.desc`);
      const monthTxs = txs.filter(t => {
        const d = new Date(t.date);
        return d.getFullYear() === yr && d.getMonth() + 1 === mo;
      });
      const stats = calcStats(monthTxs);
      const goals = await sbGet(env, 'cfo_goals', '');
      const investments = await sbGet(env, 'cfo_investments', '');
      const profile = await sbGet(env, 'cfo_profile', '');
      const networth = investments.reduce((s, i) => s + Number(i.balance), 0);
      const health = calcHealth(stats, goals, investments);
      return {
        month,
        health_score: `${health}/100`,
        income: `£${stats.income.toLocaleString()}`,
        spent: `£${stats.spent.toLocaleString()}`,
        invested: `£${stats.invested.toLocaleString()}`,
        cashflow: `${stats.cashflow >= 0 ? '+' : ''}£${stats.cashflow.toLocaleString()}`,
        savings_rate: `${stats.saverate}%`,
        net_worth: `£${networth.toLocaleString()}`,
        total_transactions: monthTxs.length,
        goals_count: goals.length,
        investments_count: investments.length,
        monthly_budget: profile[0] ? `£${profile[0].budget}` : 'Not set',
        budget_used: profile[0]?.budget > 0 ? `${Math.round((stats.spent / profile[0].budget) * 100)}%` : 'N/A'
      };
    }

    case 'get_transactions': {
      let query = 'order=date.desc';
      if (args.limit) query += `&limit=${args.limit}`;
      else query += '&limit=50';
      if (args.category) query += `&category=eq.${args.category}`;
      let txs = await sbGet(env, 'cfo_transactions', query);
      if (args.month) {
        const [yr, mo] = args.month.split('-').map(Number);
        txs = txs.filter(t => {
          const d = new Date(t.date);
          return d.getFullYear() === yr && d.getMonth() + 1 === mo;
        });
      }
      if (args.search) {
        const s = args.search.toLowerCase();
        txs = txs.filter(t => (t.description || '').toLowerCase().includes(s));
      }
      return { count: txs.length, transactions: txs };
    }

    case 'add_transaction': {
      const tx = {
        description: args.description,
        amount: Math.abs(args.amount),
        category: args.category,
        subcat: args.subcat || (args.category === 'income' ? 'other-income' : args.category === 'investment' ? 'other-inv' : 'other-expense'),
        date: args.date || today,
        note: args.note || ''
      };
      const rows = await sbInsert(env, 'cfo_transactions', tx);
      return { success: true, message: `✓ Added: ${tx.description} (${tx.category === 'income' ? '+' : '-'}£${tx.amount}) on ${tx.date}`, transaction: rows[0] };
    }

    case 'delete_transaction': {
      await sbDelete(env, 'cfo_transactions', args.id);
      return { success: true, message: `✓ Deleted transaction ID ${args.id}` };
    }

    case 'get_goals': {
      const goals = await sbGet(env, 'cfo_goals', 'order=created_at.asc');
      return {
        count: goals.length,
        goals: goals.map(g => ({
          ...g,
          progress: g.target_amount > 0 ? `${Math.round((g.current_amount / g.target_amount) * 100)}%` : '0%',
          remaining: `£${(g.target_amount - g.current_amount).toLocaleString()}`
        }))
      };
    }

    case 'add_goal': {
      const rows = await sbInsert(env, 'cfo_goals', {
        name: args.name,
        target_amount: args.target_amount,
        current_amount: args.current_amount || 0,
        target_date: args.target_date || null
      });
      return { success: true, message: `✓ Goal "${args.name}" added (target: £${args.target_amount})`, goal: rows[0] };
    }

    case 'update_goal': {
      await sbUpdate(env, 'cfo_goals', args.id, { current_amount: args.current_amount });
      return { success: true, message: `✓ Goal updated — current savings: £${args.current_amount}` };
    }

    case 'delete_goal': {
      await sbDelete(env, 'cfo_goals', args.id);
      return { success: true, message: `✓ Deleted goal ID ${args.id}` };
    }

    case 'get_investments': {
      const invs = await sbGet(env, 'cfo_investments', 'order=created_at.asc');
      const total = invs.reduce((s, i) => s + Number(i.balance), 0);
      return { count: invs.length, total_invested: `£${total.toLocaleString()}`, investments: invs };
    }

    case 'add_investment': {
      const rows = await sbInsert(env, 'cfo_investments', {
        name: args.name, balance: args.balance,
        type: args.type || 'Other',
        monthly_contribution: args.monthly_contribution || 0
      });
      return { success: true, message: `✓ Investment account "${args.name}" added (balance: £${args.balance})`, investment: rows[0] };
    }

    case 'update_investment_balance': {
      await sbUpdate(env, 'cfo_investments', args.id, { balance: args.balance });
      return { success: true, message: `✓ Investment balance updated to £${args.balance}` };
    }

    case 'delete_investment': {
      await sbDelete(env, 'cfo_investments', args.id);
      return { success: true, message: `✓ Deleted investment ID ${args.id}` };
    }

    case 'get_profile': {
      const rows = await sbGet(env, 'cfo_profile', '');
      return rows[0] || { message: 'No profile found' };
    }

    case 'update_profile': {
      const current = await sbGet(env, 'cfo_profile', '');
      const updated = { ...(current[0] || {}), id: 1, ...args };
      await sbUpsert(env, 'cfo_profile', updated);
      return { success: true, message: '✓ Profile updated', profile: updated };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP PROTOCOL HANDLER ─────────────────────────────────────
async function handleMCP(request, env) {
  const body = await request.json();
  const { method, params, id } = body;

  const respond = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' }
  });
  const error = (code, message) => new Response(JSON.stringify({
    jsonrpc: '2.0', id, error: { code, message }
  }), { headers: { 'Content-Type': 'application/json' } });

  if (method === 'initialize') {
    return respond({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'my-cfo-mcp', version: '1.0.0' }
    });
  }

  if (method === 'tools/list') {
    return respond({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await executeTool(name, args || {}, env);
      return respond({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      });
    } catch (e) {
      return error(-32603, e.message);
    }
  }

  return error(-32601, `Method not found: ${method}`);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Auth check — every request needs the secret key
    const authHeader = request.headers.get('Authorization') || '';
    const apiKey = request.headers.get('x-api-key') || '';
    const token = authHeader.replace('Bearer ', '') || apiKey;

    if (env.MCP_SECRET && token !== env.MCP_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized — provide your MCP secret key' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        name: 'My CFO MCP Server',
        version: '1.0.0',
        tools: TOOLS.length,
        endpoints: { mcp: '/mcp', tools: '/tools' }
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // MCP endpoint (for Claude Desktop, Cursor etc)
    if (url.pathname === '/mcp' && request.method === 'POST') {
      const res = await handleMCP(request, env);
      // Add CORS to MCP response
      const newHeaders = new Headers(res.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(res.body, { status: res.status, headers: newHeaders });
    }

    // Simple REST endpoint (for ChatGPT, custom agents, testing)
    if (url.pathname === '/tools' && request.method === 'GET') {
      return new Response(JSON.stringify({ tools: TOOLS }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/tools/call' && request.method === 'POST') {
      try {
        const { tool, args } = await request.json();
        const result = await executeTool(tool, args || {}, env);
        return new Response(JSON.stringify({ success: true, result }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

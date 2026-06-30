/**
 * My CFO — MCP Server (v1.1.0)
 * Adds: Resources (cfo://database/schema) + Prompts (weekly-budget-review)
 * Hosted on Cloudflare Workers
 *
 * Env vars needed (already set):
 *   SUPABASE_URL, SUPABASE_KEY, MCP_SECRET
 */

const TOOLS = [
  { name: "get_summary", description: "Get a full financial summary including income, spending, savings rate, health score, net worth and cash flow for the current month.",
    inputSchema: { type: "object", properties: { month: { type: "string", description: "Optional. Month in YYYY-MM format. Defaults to current month." } } } },
  { name: "get_transactions", description: "Get transactions. Can filter by category, date range, or search by description.",
    inputSchema: { type: "object", properties: {
      category: { type: "string", enum: ["income", "expense", "investment", "transfer"] },
      month: { type: "string" }, limit: { type: "number" }, search: { type: "string" }
    } } },
  { name: "add_transaction", description: "Add a new financial transaction. Use this when the user says things like 'I spent £X on Y' or 'I got paid £X' or 'I invested £X'. Use category 'transfer' for credit card bill payments — never log those as 'expense', since that double-counts spending already logged when the purchases were made.",
    inputSchema: { type: "object", required: ["description", "amount", "category", "date"], properties: {
      description: { type: "string" }, amount: { type: "number" },
      category: { type: "string", enum: ["income", "expense", "investment", "transfer"] },
      subcat: { type: "string", enum: ["salary","freelance","other-income","rent","council-tax","electric","wifi","groceries","petrol","housing","food","transport","bills","health","entertainment","shopping","dining","other-expense","stocks","pension","crypto","property","other-inv","credit-card-payment","account-transfer","other-transfer"] },
      payment_method: { type: "string", enum: ["cash","debit","credit","bank-transfer"], description: "How the transaction was paid for" },
      date: { type: "string" }, note: { type: "string" }
    } } },
  { name: "delete_transaction", description: "Delete a transaction by its ID. First use get_transactions to find the ID.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } } },
  { name: "get_goals", description: "Get all savings goals with their progress, target amounts and deadlines.", inputSchema: { type: "object", properties: {} } },
  { name: "add_goal", description: "Add a new savings goal.",
    inputSchema: { type: "object", required: ["name", "target_amount"], properties: {
      name: { type: "string" }, target_amount: { type: "number" }, current_amount: { type: "number" }, target_date: { type: "string" }
    } } },
  { name: "update_goal", description: "Update the current savings amount for a goal.",
    inputSchema: { type: "object", required: ["id", "current_amount"], properties: { id: { type: "number" }, current_amount: { type: "number" } } } },
  { name: "delete_goal", description: "Delete a savings goal by ID.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } } },
  { name: "get_investments", description: "Get all investment accounts with their balances and monthly contributions.", inputSchema: { type: "object", properties: {} } },
  { name: "add_investment", description: "Add a new investment account.",
    inputSchema: { type: "object", required: ["name", "balance"], properties: {
      name: { type: "string" }, balance: { type: "number" },
      type: { type: "string", enum: ["ISA","SIPP/Pension","GIA","Crypto","Property","Other"] },
      monthly_contribution: { type: "number" }
    } } },
  { name: "update_investment_balance", description: "Update the balance of an investment account.",
    inputSchema: { type: "object", required: ["id", "balance"], properties: { id: { type: "number" }, balance: { type: "number" } } } },
  { name: "delete_investment", description: "Delete an investment account by ID.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } } },
  { name: "get_profile", description: "Get the user's financial profile — monthly income, budget, savings target and currency.", inputSchema: { type: "object", properties: {} } },
  { name: "update_profile", description: "Update the user's financial profile settings.",
    inputSchema: { type: "object", properties: { income: { type: "number" }, budget: { type: "number" }, save_target: { type: "number" }, currency: { type: "string" } } } },
  { name: "get_budgets", description: "Get all budget envelopes with how much has been spent against each this month and how much remains. Use this before evaluating whether the user is on track against their budgets.",
    inputSchema: { type: "object", properties: {} } },
  { name: "get_spending_chart", description: "Render an interactive doughnut chart of this month's spending by category, inside the conversation. Use this whenever the user asks to see, visualize, or chart their spending — prefer this over describing the breakdown in plain text.",
    inputSchema: { type: "object", properties: { month: { type: "string", description: "Optional. Month in YYYY-MM format. Defaults to current month." } } },
    _meta: { ui: { resourceUri: "ui://widgets/cfo-chart" } } }
];

// ─── RESOURCES (app-controlled ground-truth context + UI widgets) ──
const RESOURCES = [
  {
    uri: "cfo://database/schema",
    name: "Database Schema",
    description: "Ground-truth structural layout of the My CFO Supabase tables, so an AI agent never guesses or hallucinates column names.",
    mimeType: "text/plain"
  },
  {
    uri: "ui://widgets/cfo-chart",
    name: "Spending Chart Widget",
    description: "Interactive Chart.js doughnut chart for visualizing spending by category. Rendered in a sandboxed iframe by MCP Apps-compatible hosts.",
    mimeType: "text/html;profile=mcp-app"
  }
];

function getSchemaResourceText() {
  return `MY CFO — SUPABASE DATABASE SCHEMA (ground truth — use these exact column names)

TABLE: cfo_transactions
  id               bigint, primary key, auto-increment
  description      text — what the transaction is for
  amount           numeric — always stored positive; sign is implied by category
  category         text — one of: 'income' | 'expense' | 'investment' | 'transfer'
                   ('transfer' is for things like credit card bill payments —
                    it is excluded from spending totals to avoid double-counting
                    purchases that were already logged individually as 'expense')
  subcat           text — sub-category, e.g. 'groceries', 'rent', 'credit-card-payment'
  payment_method   text, nullable — one of: 'cash' | 'debit' | 'credit' | 'bank-transfer'
  date             date — when the transaction occurred
  note             text, nullable
  created_at       timestamptz

TABLE: cfo_budgets  (envelope budgeting)
  id               bigint, primary key, auto-increment
  name             text — display name of the envelope, e.g. "Rent"
  subcat           text — must match a cfo_transactions.subcat value to link spending
  monthly_amount   numeric — the budgeted ceiling for this envelope, per month
  created_at       timestamptz
  NOTE: there is no 'category' or 'limit_amount' column on this table — the correct
  names are 'subcat' and 'monthly_amount'. An envelope's "spent this month" is
  calculated by summing cfo_transactions WHERE category='expense' AND
  subcat = cfo_budgets.subcat, for the current calendar month.

TABLE: cfo_goals
  id, name, target_amount, current_amount, target_date, created_at

TABLE: cfo_investments
  id, name, balance, type, monthly_contribution, created_at

TABLE: cfo_profile  (single row, id always = 1)
  id, income, save_target, budget, currency, created_at, updated_at`;
}

// ─── PROMPTS (user-controlled reusable workflows) ──────────────
const PROMPTS = [
  {
    name: "weekly-budget-review",
    description: "Acts as a forensic accountant: reviews the last 7 days of spending against your allowance cap and budget envelopes, then returns exactly two specific optimization rules.",
    arguments: [
      { name: "allowance_cap", description: "Your discretionary/optional spending ceiling for the week, in pounds (e.g. '50')", required: true }
    ]
  }
];

function buildWeeklyBudgetReviewPrompt(cap) {
  return `You are acting as a meticulous forensic household accountant performing a Weekly Budget Review. Follow this exact process:

1. DATA GATHERING — call these tools yourself, in this order, before writing any analysis:
   a. get_transactions (look at the last 7 days)
   b. get_budgets (every envelope's monthly limit, spent-so-far, and remaining)
   c. get_summary (overall health score, savings rate, cash flow for the month)

2. ALLOWANCE CAP CHECK — the user's discretionary spending ceiling for this week is £${cap}.
   Sum all "optional" spending this week (entertainment, shopping, dining sub-categories)
   and state clearly whether they are under, at, or over this cap, and by how much.

3. ENVELOPE EVALUATION — for each budget envelope report: spent this month, remaining,
   and flag any envelope that is "over budget" or "nearly depleted" (under 15% remaining
   with more than a week left in the month).

4. OUTPUT FORMAT — return your findings with these exact sections, in this order:
   - Weekly allowance check (one-sentence verdict + the numbers)
   - Envelope status (short table or bullet list: envelope -> spent / remaining / status)
   - Exactly two household optimization rules — no more, no fewer. Each must be specific
     and actionable, grounded in the real numbers you gathered, not generic advice.

Do not skip step 1. Do not guess any numbers — every figure in your output must come from
a tool call you actually made in this conversation.`;
}

// ─── UI WIDGET (MCP Apps — interactive doughnut chart) ────────
function getSpendingChartWidgetHtml() {
  // v2 — fully self-contained, zero external network requests.
  // The previous version loaded Chart.js + the MCP Apps SDK from CDNs,
  // which most likely got blocked by the sandboxed iframe's CSP, causing
  // a totally blank widget. This version hand-draws the doughnut with SVG
  // (same stroke-dasharray technique used for the app's own health gauge)
  // and hand-implements the minimal postMessage handshake instead of
  // depending on an external SDK import.
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<style>' +
  'html,body{margin:0;padding:0;background:#10141b;color:#e9e6dd;font-family:-apple-system,sans-serif;min-height:100vh}' +
  '.wrap{padding:18px 20px;box-sizing:border-box}' +
  '.hdr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}' +
  '.hdr h1{font-family:Georgia,serif;font-size:16px;font-weight:600;margin:0;color:#e9e6dd}' +
  '.hdr .total{font-family:"Courier New",monospace;font-size:18px;font-weight:600;color:#c9a227}' +
  '.chartbox{display:flex;justify-content:center;margin-bottom:16px}' +
  '.legend{display:flex;flex-direction:column;gap:7px}' +
  '.row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid #222838}' +
  '.row:last-child{border-bottom:none}' +
  '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;flex-shrink:0}' +
  '.lbl{text-transform:capitalize;color:#cfd3dc}' +
  '.amt{font-family:"Courier New",monospace;color:#9aa3b8;white-space:nowrap}' +
  '.empty{color:#5c6478;font-style:italic;text-align:center;padding:30px 0;font-size:13px}' +
  '.waiting{color:#8a6f1f;font-size:11px;text-align:center;padding:6px 0}' +
  '.center-label{font-family:"Courier New",monospace;font-size:13px;fill:#9aa3b8;text-anchor:middle}' +
  '</style></head><body>' +
  '<div class="wrap">' +
    '<div class="hdr"><h1 id="cfo-month">Spending by category</h1><span class="total" id="cfo-total">—</span></div>' +
    '<div class="chartbox">' +
      '<svg id="cfo-svg" width="180" height="180" viewBox="0 0 180 180"></svg>' +
    '</div>' +
    '<div class="legend" id="cfo-legend"></div>' +
    '<div class="waiting" id="cfo-waiting">Waiting for data…</div>' +
  '</div>' +
  '<script>' +
  '(function(){' +
  'var PALETTE = ["#c9a227","#74a98a","#c1604b","#8a93a8","#5c6478","#e3c459","#4f7a64","#8f4636"];' +
  'var R = 70, CX = 90, CY = 90, STROKE = 22;' +
  'var CIRC = 2 * Math.PI * R;' +

  'function renderFromStructured(data) {' +
    'if (!data || !data.categories) return;' +
    'var waitEl = document.getElementById("cfo-waiting"); if (waitEl) waitEl.style.display = "none";' +
    'document.getElementById("cfo-month").textContent = "Spending — " + (data.month || "this month");' +
    'document.getElementById("cfo-total").textContent = "£" + (data.total != null ? data.total.toLocaleString() : "0");' +
    'var cats = data.categories || [];' +
    'var legendEl = document.getElementById("cfo-legend");' +
    'var svgEl = document.getElementById("cfo-svg");' +
    'if (!cats.length) {' +
      'legendEl.innerHTML = "";' +
      'svgEl.innerHTML = "";' +
      'var emptyDiv = document.createElement("div");' +
      'emptyDiv.className = "empty"; emptyDiv.textContent = "No expenses logged yet";' +
      'legendEl.appendChild(emptyDiv);' +
      'return;' +
    '}' +

    'var ns = "http://www.w3.org/2000/svg";' +
    'svgEl.innerHTML = "";' +
    'var bg = document.createElementNS(ns, "circle");' +
    'bg.setAttribute("cx", CX); bg.setAttribute("cy", CY); bg.setAttribute("r", R);' +
    'bg.setAttribute("fill", "none"); bg.setAttribute("stroke", "#222838"); bg.setAttribute("stroke-width", STROKE);' +
    'svgEl.appendChild(bg);' +

    'var offset = 0;' +
    'cats.forEach(function(c, i) {' +
      'var segLen = CIRC * (Math.max(0, Math.min(100, c.percent)) / 100);' +
      'var circle = document.createElementNS(ns, "circle");' +
      'circle.setAttribute("cx", CX); circle.setAttribute("cy", CY); circle.setAttribute("r", R);' +
      'circle.setAttribute("fill", "none");' +
      'circle.setAttribute("stroke", PALETTE[i % PALETTE.length]);' +
      'circle.setAttribute("stroke-width", STROKE);' +
      'circle.setAttribute("stroke-dasharray", segLen + " " + (CIRC - segLen));' +
      'circle.setAttribute("stroke-dashoffset", -offset);' +
      'circle.setAttribute("transform", "rotate(-90 " + CX + " " + CY + ")");' +
      'svgEl.appendChild(circle);' +
      'offset += segLen;' +
    '});' +

    'var centerText = document.createElementNS(ns, "text");' +
    'centerText.setAttribute("x", CX); centerText.setAttribute("y", CY + 5);' +
    'centerText.setAttribute("class", "center-label");' +
    'centerText.textContent = cats.length + " cat" + (cats.length === 1 ? "" : "s");' +
    'svgEl.appendChild(centerText);' +

    'legendEl.innerHTML = cats.map(function(c, i) {' +
      'var color = PALETTE[i % PALETTE.length];' +
      'return "<div class=\\"row\\"><span class=\\"lbl\\"><span class=\\"dot\\" style=\\"background:" + color + "\\"></span>" + c.label + "</span><span class=\\"amt\\">£" + c.amount + " · " + c.percent + "%</span></div>";' +
    '}).join("");' +
  '}' +

  // Minimal hand-rolled MCP Apps handshake. The official lifecycle expects
  // the View (this iframe) to send "ui/initialize" first, then the Host
  // replies and pushes "ui/notifications/tool-result" with the data.
  // This is a best-effort implementation written from public spec docs,
  // not the official SDK. A single immediate postMessage risks a race —
  // if the host hasn't attached its listener yet, that one message is
  // lost forever (postMessage doesn't queue for late listeners) — so
  // this retries periodically instead of sending just once, and also
  // polls for window.__INITIAL_DATA__ in case the host injects data
  // directly rather than via postMessage.
  'var dataReceived = false;' +
  'var attempts = 0;' +
  'var MAX_ATTEMPTS = 30;' + // ~9 seconds at 300ms intervals
  'function sendInitPing() {' +
    'try { window.parent.postMessage({ jsonrpc: "2.0", id: "cfo-init-1", method: "ui/initialize", params: {} }, "*"); } catch (e) {}' +
  '}' +
  'var pollTimer = setInterval(function() {' +
    'attempts++;' +
    'if (dataReceived || attempts > MAX_ATTEMPTS) {' +
      'clearInterval(pollTimer);' +
      'if (!dataReceived) {' +
        'var w = document.getElementById("cfo-waiting");' +
        'if (w) w.textContent = "Chart data did not arrive automatically — ask in the chat to describe the breakdown in text instead.";' +
      '}' +
      'return;' +
    '}' +
    'if (window.__INITIAL_DATA__) { renderFromStructured(window.__INITIAL_DATA__); dataReceived = true; return; }' +
    'sendInitPing();' +
  '}, 300);' +
  'sendInitPing();' + // also try immediately, in addition to the retry loop

  'window.addEventListener("message", function(event) {' +
    'var d = event.data;' +
    'if (!d) return;' +
    'try {' +
      // Direct structuredContent shape (defensive fallback #1)
      'if (d.structuredContent) { renderFromStructured(d.structuredContent); dataReceived = true; return; }' +
      'if (d.payload) { renderFromStructured(d.payload); dataReceived = true; return; }' +
      // Official lifecycle notification shape (best-effort guess)
      'if (d.method === "ui/notifications/tool-result" && d.params) {' +
        'renderFromStructured(d.params.structuredContent || (d.params.result && d.params.result.structuredContent));' +
        'dataReceived = true; return;' +
      '}' +
      // Response to our ui/initialize — acknowledge per the spec
      'if (d.id === "cfo-init-1") {' +
        'window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");' +
      '}' +
    '} catch (e) { console.warn("widget message handling error", e); }' +
  '});' +

  // If the host (or a local test harness) injects data synchronously
  'if (window.__INITIAL_DATA__) renderFromStructured(window.__INITIAL_DATA__);' +
  '})();' +
  '</' + 'script>' +
  '</body></html>';
}


function sbHeaders(env) {
  return { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}`, 'Prefer': 'return=representation' };
}
async function sbGet(env, table, query = '') {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`DB error: ${await r.text()}`);
  return r.json();
}
async function sbInsert(env, table, data) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: sbHeaders(env), body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`Insert error: ${await r.text()}`);
  return r.json();
}
async function sbUpdate(env, table, id, data) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method: 'PATCH', headers: { ...sbHeaders(env), 'Prefer': 'return=minimal' }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`Update error: ${await r.text()}`);
  return { success: true };
}
async function sbDelete(env, table, id) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Delete error: ${await r.text()}`);
  return { success: true, deleted_id: id };
}
async function sbUpsert(env, table, data, onConflict = 'id') {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST', headers: { ...sbHeaders(env), 'Prefer': 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Upsert error: ${await r.text()}`);
  return r.json();
}

function calcStats(transactions) {
  let income = 0, spent = 0, invested = 0;
  transactions.forEach(t => {
    if (t.category === 'income') income += Number(t.amount);
    else if (t.category === 'investment') invested += Number(t.amount);
    else if (t.category === 'expense') spent += Number(t.amount);
    // 'transfer' is intentionally excluded — not new spending
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

async function executeTool(name, args, env) {
  const today = new Date().toISOString().split('T')[0];
  const currentMonth = today.slice(0, 7);
  switch (name) {
    case 'get_summary': {
      const month = args.month || currentMonth;
      const [yr, mo] = month.split('-').map(Number);
      const txs = await sbGet(env, 'cfo_transactions', `order=created_at.desc`);
      const monthTxs = txs.filter(t => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; });
      const stats = calcStats(monthTxs);
      const goals = await sbGet(env, 'cfo_goals', '');
      const investments = await sbGet(env, 'cfo_investments', '');
      const profile = await sbGet(env, 'cfo_profile', '');
      const networth = investments.reduce((s, i) => s + Number(i.balance), 0);
      const health = calcHealth(stats, goals, investments);
      return {
        month, health_score: `${health}/100`, income: `£${stats.income.toLocaleString()}`, spent: `£${stats.spent.toLocaleString()}`,
        invested: `£${stats.invested.toLocaleString()}`, cashflow: `${stats.cashflow >= 0 ? '+' : ''}£${stats.cashflow.toLocaleString()}`,
        savings_rate: `${stats.saverate}%`, net_worth: `£${networth.toLocaleString()}`, total_transactions: monthTxs.length,
        goals_count: goals.length, investments_count: investments.length,
        monthly_budget: profile[0] ? `£${profile[0].budget}` : 'Not set',
        budget_used: profile[0]?.budget > 0 ? `${Math.round((stats.spent / profile[0].budget) * 100)}%` : 'N/A'
      };
    }
    case 'get_transactions': {
      let query = 'order=date.desc';
      if (args.limit) query += `&limit=${args.limit}`; else query += '&limit=50';
      if (args.category) query += `&category=eq.${args.category}`;
      let txs = await sbGet(env, 'cfo_transactions', query);
      if (args.month) { const [yr, mo] = args.month.split('-').map(Number); txs = txs.filter(t => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; }); }
      if (args.search) { const s = args.search.toLowerCase(); txs = txs.filter(t => (t.description || '').toLowerCase().includes(s)); }
      return { count: txs.length, transactions: txs };
    }
    case 'add_transaction': {
      const tx = { description: args.description, amount: Math.abs(args.amount), category: args.category,
        subcat: args.subcat || (args.category === 'income' ? 'other-income' : args.category === 'investment' ? 'other-inv' : args.category === 'transfer' ? 'other-transfer' : 'other-expense'),
        payment_method: args.payment_method || null,
        date: args.date || today, note: args.note || '' };
      const rows = await sbInsert(env, 'cfo_transactions', tx);
      return { success: true, message: `✓ Added: ${tx.description} (${tx.category === 'income' ? '+' : tx.category === 'transfer' ? '↔' : '-'}£${tx.amount}) on ${tx.date}`, transaction: rows[0] };
    }
    case 'delete_transaction': { await sbDelete(env, 'cfo_transactions', args.id); return { success: true, message: `✓ Deleted transaction ID ${args.id}` }; }
    case 'get_goals': {
      const goals = await sbGet(env, 'cfo_goals', 'order=created_at.asc');
      return { count: goals.length, goals: goals.map(g => ({ ...g, progress: g.target_amount > 0 ? `${Math.round((g.current_amount / g.target_amount) * 100)}%` : '0%', remaining: `£${(g.target_amount - g.current_amount).toLocaleString()}` })) };
    }
    case 'add_goal': {
      const rows = await sbInsert(env, 'cfo_goals', { name: args.name, target_amount: args.target_amount, current_amount: args.current_amount || 0, target_date: args.target_date || null });
      return { success: true, message: `✓ Goal "${args.name}" added (target: £${args.target_amount})`, goal: rows[0] };
    }
    case 'update_goal': { await sbUpdate(env, 'cfo_goals', args.id, { current_amount: args.current_amount }); return { success: true, message: `✓ Goal updated — current savings: £${args.current_amount}` }; }
    case 'delete_goal': { await sbDelete(env, 'cfo_goals', args.id); return { success: true, message: `✓ Deleted goal ID ${args.id}` }; }
    case 'get_investments': {
      const invs = await sbGet(env, 'cfo_investments', 'order=created_at.asc');
      const total = invs.reduce((s, i) => s + Number(i.balance), 0);
      return { count: invs.length, total_invested: `£${total.toLocaleString()}`, investments: invs };
    }
    case 'add_investment': {
      const rows = await sbInsert(env, 'cfo_investments', { name: args.name, balance: args.balance, type: args.type || 'Other', monthly_contribution: args.monthly_contribution || 0 });
      return { success: true, message: `✓ Investment account "${args.name}" added (balance: £${args.balance})`, investment: rows[0] };
    }
    case 'update_investment_balance': { await sbUpdate(env, 'cfo_investments', args.id, { balance: args.balance }); return { success: true, message: `✓ Investment balance updated to £${args.balance}` }; }
    case 'delete_investment': { await sbDelete(env, 'cfo_investments', args.id); return { success: true, message: `✓ Deleted investment ID ${args.id}` }; }
    case 'get_profile': { const rows = await sbGet(env, 'cfo_profile', ''); return rows[0] || { message: 'No profile found' }; }
    case 'update_profile': {
      const current = await sbGet(env, 'cfo_profile', '');
      const updated = { ...(current[0] || {}), id: 1, ...args };
      await sbUpsert(env, 'cfo_profile', updated);
      return { success: true, message: '✓ Profile updated', profile: updated };
    }
    case 'get_budgets': {
      const budgets = await sbGet(env, 'cfo_budgets', 'order=created_at.asc');
      const txs = await sbGet(env, 'cfo_transactions', `category=eq.expense&order=date.desc`);
      const [yr, mo] = currentMonth.split('-').map(Number);
      const monthTxs = txs.filter(t => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; });
      const enriched = budgets.map(b => {
        const spent = monthTxs.filter(t => t.subcat === b.subcat).reduce((s, t) => s + Number(t.amount), 0);
        const remaining = Number(b.monthly_amount) - spent;
        const pctUsed = Number(b.monthly_amount) > 0 ? (spent / Number(b.monthly_amount)) * 100 : 0;
        const status = remaining < 0 ? 'over budget' : pctUsed >= 85 ? 'nearly depleted' : 'on track';
        return { ...b, spent_this_month: `£${spent.toFixed(2)}`, remaining: `£${remaining.toFixed(2)}`, status };
      });
      return { count: enriched.length, budgets: enriched };
    }
    case 'get_spending_chart': {
      const month = args.month || currentMonth;
      const [yr, mo] = month.split('-').map(Number);
      const txs = await sbGet(env, 'cfo_transactions', `category=eq.expense&order=date.desc`);
      const monthTxs = txs.filter(t => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; });
      const byCat = {};
      monthTxs.forEach(t => { const k = t.subcat || 'other-expense'; byCat[k] = (byCat[k] || 0) + Number(t.amount); });
      const total = Object.values(byCat).reduce((s, v) => s + v, 0);
      const categories = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([label, amount]) => ({
        label: label.replace(/-/g, ' '),
        amount: Math.round(amount * 100) / 100,
        percent: total > 0 ? Math.round((amount / total) * 100) : 0
      }));
      const summaryText = categories.length
        ? `Spending breakdown for ${month}: total £${total.toFixed(2)} across ${categories.length} categories — ` +
          categories.map(c => `${c.label}: £${c.amount} (${c.percent}%)`).join(', ') + '.'
        : `No expenses logged for ${month} yet.`;
      // Pre-shaped {content, structuredContent} — the generic tools/call handler
      // detects this shape and passes it through unmodified so the structuredContent
      // reaches the UI widget via the ui/notifications/tool-result lifecycle step.
      return {
        content: [{ type: 'text', text: summaryText }],
        structuredContent: { month, total: Math.round(total * 100) / 100, categories }
      };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMCP(request, env) {
  const body = await request.json();
  const { method, params, id } = body;
  const respond = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json' } });
  const error = (code, message) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: { 'Content-Type': 'application/json' } });

  if (method === 'initialize') {
    return respond({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'my-cfo-mcp', version: '1.2.0' } });
  }
  if (method === 'tools/list') return respond({ tools: TOOLS });
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await executeTool(name, args || {}, env);
      // Tools built for MCP Apps UI (like get_spending_chart) return a pre-shaped
      // { content, structuredContent } object — pass it through as-is so the
      // structuredContent reaches the widget. All other tools return plain data
      // objects, which we keep wrapping as JSON text for backward compatibility.
      const isPreShaped = result && typeof result === 'object' && Array.isArray(result.content);
      const payload = isPreShaped ? result : { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      return respond(payload);
    } catch (e) { return error(-32603, e.message); }
  }
  if (method === 'resources/list') {
    return respond({ resources: RESOURCES });
  }
  if (method === 'resources/read') {
    const uri = params?.uri;
    const resource = RESOURCES.find(r => r.uri === uri);
    if (!resource) return error(-32602, `Unknown resource URI: ${uri}`);
    if (uri === 'cfo://database/schema') {
      return respond({ contents: [{ uri, mimeType: resource.mimeType, text: getSchemaResourceText() }] });
    }
    if (uri === 'ui://widgets/cfo-chart') {
      return respond({ contents: [{ uri, mimeType: resource.mimeType, text: getSpendingChartWidgetHtml() }] });
    }
    return error(-32602, `No content handler registered for resource: ${uri}`);
  }
  if (method === 'prompts/list') {
    return respond({ prompts: PROMPTS });
  }
  if (method === 'prompts/get') {
    const name = params?.name;
    const promptArgs = params?.arguments || {};
    if (name === 'weekly-budget-review') {
      const cap = promptArgs.allowance_cap;
      if (!cap) return error(-32602, 'Missing required argument: allowance_cap');
      const numCap = parseFloat(cap);
      if (isNaN(numCap)) return error(-32602, `allowance_cap must be a plain number (e.g. "50"), got: "${cap}"`);
      return respond({
        description: 'Forensic weekly budget review against your allowance cap and envelopes',
        messages: [{ role: 'user', content: { type: 'text', text: buildWeeklyBudgetReviewPrompt(numCap) } }]
      });
    }
    return error(-32602, `Unknown prompt: ${name}`);
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202 });
  return error(-32601, `Method not found: ${method}`);
}

// ─── MINIMAL OAUTH (single-user — lets Claude's connector UI register & authorize) ───
function b64url(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64url(str) { return atob(str.replace(/-/g, '+').replace(/_/g, '/')); }

async function handleOAuth(request, env, url, corsHeaders) {
  if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
    const origin = url.origin;
    return new Response(JSON.stringify({
      issuer: origin,
      authorization_endpoint: origin + '/authorize',
      token_endpoint: origin + '/token',
      registration_endpoint: origin + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/register' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const clientId = 'mycfo-' + crypto.randomUUID();
    return new Response(JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris || [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code']
    }), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Authorization endpoint — shows a real login form; requires the MCP_SECRET before issuing a code
  if (url.pathname === '/authorize' && request.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    const clientId = url.searchParams.get('client_id') || '';
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Authorize My CFO</title>
      <style>
        body{background:#10141b;color:#e9e6dd;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
        .card{background:#161b25;border:1px solid #2a3242;border-radius:14px;padding:32px;max-width:380px;width:100%;text-align:center}
        h1{font-size:20px;margin:0 0 8px}
        p{color:#9aa3b8;font-size:13px;margin:0 0 20px;line-height:1.5}
        input{width:100%;background:#1c2330;border:1px solid #2a3242;border-radius:8px;padding:11px 12px;color:#e9e6dd;font-size:14px;margin-bottom:12px;box-sizing:border-box}
        button{width:100%;background:#c9a227;color:#10141b;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
        .err{color:#c1604b;font-size:13px;margin-bottom:12px}
      </style></head><body>
      <div class="card">
        <h1>🔐 Authorize access</h1>
        <p>An app is requesting access to your My CFO financial data. Enter your MCP secret key to allow this.</p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="redirect_uri" value="${redirectUri}">
          <input type="hidden" name="state" value="${state}">
          <input type="hidden" name="client_id" value="${clientId}">
          <input type="password" name="secret" placeholder="Your MCP secret key" required autofocus>
          <button type="submit">Authorize</button>
        </form>
      </div></body></html>`;
    return new Response(page, { headers: { ...corsHeaders, 'Content-Type': 'text/html' } });
  }

  if (url.pathname === '/authorize' && request.method === 'POST') {
    const text = await request.text();
    const params = Object.fromEntries(new URLSearchParams(text));
    const redirectUri = params.redirect_uri;
    const state = params.state || '';
    if (!redirectUri) return new Response('Missing redirect_uri', { status: 400, headers: corsHeaders });

    if (params.secret !== env.MCP_SECRET) {
      const errorPage = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Authorize My CFO</title>
        <style>
          body{background:#10141b;color:#e9e6dd;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
          .card{background:#161b25;border:1px solid #2a3242;border-radius:14px;padding:32px;max-width:380px;width:100%;text-align:center}
          h1{font-size:20px;margin:0 0 8px}
          p{color:#9aa3b8;font-size:13px;margin:0 0 20px;line-height:1.5}
          input{width:100%;background:#1c2330;border:1px solid #2a3242;border-radius:8px;padding:11px 12px;color:#e9e6dd;font-size:14px;margin-bottom:12px;box-sizing:border-box}
          button{width:100%;background:#c9a227;color:#10141b;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
          .err{color:#c1604b;font-size:13px;margin-bottom:12px}
        </style></head><body>
        <div class="card">
          <h1>🔐 Authorize access</h1>
          <p class="err">Incorrect secret key. Please try again.</p>
          <form method="POST" action="/authorize">
            <input type="hidden" name="redirect_uri" value="${redirectUri}">
            <input type="hidden" name="state" value="${state}">
            <input type="hidden" name="client_id" value="${params.client_id||''}">
            <input type="password" name="secret" placeholder="Your MCP secret key" required autofocus>
            <button type="submit">Authorize</button>
          </form>
        </div></body></html>`;
      return new Response(errorPage, { status: 401, headers: { ...corsHeaders, 'Content-Type': 'text/html' } });
    }

    const code = b64url(env.MCP_SECRET + '::' + Date.now());
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { ...corsHeaders, Location: redirect.toString() } });
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    let params = {};
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) params = await request.json().catch(() => ({}));
    else { const text = await request.text(); params = Object.fromEntries(new URLSearchParams(text)); }

    if (params.grant_type === 'authorization_code' && params.code) {
      return new Response(JSON.stringify({ access_token: env.MCP_SECRET, token_type: 'Bearer', expires_in: 31536000 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (params.grant_type === 'refresh_token') {
      return new Response(JSON.stringify({ access_token: env.MCP_SECRET, token_type: 'Bearer', expires_in: 31536000 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const oauthRoutes = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/register', '/authorize', '/token'];
    if (oauthRoutes.includes(url.pathname)) {
      const oauthResponse = await handleOAuth(request, env, url, corsHeaders);
      if (oauthResponse) return oauthResponse;
    }

    const authHeader = request.headers.get('Authorization') || '';
    const apiKey = request.headers.get('x-api-key') || '';
    const token = authHeader.replace('Bearer ', '') || apiKey;

    if (env.MCP_SECRET && token !== env.MCP_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized — provide your MCP secret key' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', name: 'My CFO MCP Server', version: '1.2.0', tools: TOOLS.length, resources: RESOURCES.length, prompts: PROMPTS.length, endpoints: { mcp: '/mcp', tools: '/tools' } }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      const res = await handleMCP(request, env);
      const newHeaders = new Headers(res.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(res.body, { status: res.status, headers: newHeaders });
    }

    if (url.pathname === '/tools' && request.method === 'GET') {
      return new Response(JSON.stringify({ tools: TOOLS }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/tools/call' && request.method === 'POST') {
      try {
        const { tool, args } = await request.json();
        const result = await executeTool(tool, args || {}, env);
        return new Response(JSON.stringify({ success: true, result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
};

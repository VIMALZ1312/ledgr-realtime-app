require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

// ── PLAID CLIENT ─────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);

// ── IN-MEMORY TOKEN STORE (persisted via env on Replit) ──────
// access_tokens stored as PLAID_TOKEN_<NICKNAME> in Replit Secrets
function getTokens() {
  const tokens = {};
  Object.keys(process.env).forEach(k => {
    if (k.startsWith('PLAID_TOKEN_')) {
      tokens[k.replace('PLAID_TOKEN_', '').toLowerCase()] = process.env[k];
    }
  });
  return tokens;
}

// ── ROUTES ───────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  const tokens = getTokens();
  res.json({
    status: 'LEDGR Realtime Backend',
    env: process.env.PLAID_ENV || 'sandbox',
    connected_accounts: Object.keys(tokens),
    last_sync: process.env.LAST_SYNC || 'never'
  });
});

// Step 1: Create link token (used by frontend to open Plaid Link)
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: 'vimal-raj' },
      client_name: 'LEDGR Realtime',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Link token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Exchange public token for access token after user links bank
app.post('/api/exchange-token', async (req, res) => {
  const { public_token, nickname } = req.body;
  if (!public_token || !nickname) {
    return res.status(400).json({ error: 'public_token and nickname required' });
  }
  try {
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;
    // Return token — user must save it as PLAID_TOKEN_<NICKNAME> in Replit Secrets
    res.json({
      success: true,
      nickname: nickname.toUpperCase(),
      access_token,
      item_id,
      instruction: `Add this to Replit Secrets: key=PLAID_TOKEN_${nickname.toUpperCase()} value=${access_token}`
    });
  } catch (err) {
    console.error('Token exchange error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 3: Fetch all data and build data.json
app.post('/api/sync', async (req, res) => {
  try {
    const result = await buildDataJson();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get current data.json
app.get('/api/data', async (req, res) => {
  try {
    const data = await fetchCurrentData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List connected accounts
app.get('/api/accounts', async (req, res) => {
  const tokens = getTokens();
  const accounts = [];
  for (const [name, token] of Object.entries(tokens)) {
    try {
      const r = await plaid.accountsGet({ access_token: token });
      r.data.accounts.forEach(a => {
        accounts.push({
          nickname: name,
          name: a.name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          balance: a.balances.current,
          available: a.balances.available,
        });
      });
    } catch (e) {
      accounts.push({ nickname: name, error: e.message });
    }
  }
  res.json(accounts);
});

// ── CORE: BUILD DATA.JSON ─────────────────────────────────────
async function buildDataJson() {
  const tokens = getTokens();
  if (!Object.keys(tokens).length) {
    throw new Error('No bank accounts connected yet. Use /api/create-link-token to connect.');
  }

  const allAccounts = [];
  const allTransactions = [];
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 90); // 90 days of transactions
  const start = startDate.toISOString().split('T')[0];
  const end = now.toISOString().split('T')[0];

  // Fetch from each connected bank
  for (const [nickname, token] of Object.entries(tokens)) {
    try {
      // Balances
      const acctResp = await plaid.accountsGet({ access_token: token });
      acctResp.data.accounts.forEach(a => {
        allAccounts.push({ ...a, _nickname: nickname });
      });

      // Transactions (paginated)
      let cursor = null;
      let added = [];
      let hasMore = true;
      while (hasMore) {
        const txResp = await plaid.transactionsSync({
          access_token: token,
          cursor: cursor || undefined,
        });
        added = added.concat(txResp.data.added);
        cursor = txResp.data.next_cursor;
        hasMore = txResp.data.has_more;
        if (added.length > 500) break; // safety cap
      }
      added.forEach(t => allTransactions.push({ ...t, _nickname: nickname }));
    } catch (err) {
      console.error(`Error fetching ${nickname}:`, err.response?.data || err.message);
    }
  }

  // Build structured data
  const data = buildStructuredData(allAccounts, allTransactions);
  data.generated_at = new Date().toISOString();
  data.source = 'plaid_realtime';

  // Push to GitHub
  await pushToGitHub(data);
  process.env.LAST_SYNC = new Date().toISOString();

  return {
    accounts_synced: allAccounts.length,
    transactions_synced: allTransactions.length,
    generated_at: data.generated_at
  };
}

// ── CATEGORIZATION ────────────────────────────────────────────
const CAT_MAP = {
  'Food and Drink': 'Restaurants',
  'Restaurants': 'Restaurants',
  'Coffee Shop': 'Restaurants',
  'Supermarkets and Groceries': 'Groceries',
  'Shops': 'Shopping',
  'Clothing and Accessories': 'Shopping',
  'Sporting Goods': 'Shopping',
  'Digital Purchase': 'Shopping',
  'Amazon': 'Amazon',
  'Travel': 'Gas/Travel',
  'Gas Stations': 'Gas/Travel',
  'Airlines': 'Gas/Travel',
  'Taxi': 'Gas/Travel',
  'Car Services': 'Gas/Travel',
  'Service': 'Tech/Subs',
  'Subscription': 'Tech/Subs',
  'Software': 'Tech/Subs',
  'Utilities': 'Tech/Subs',
  'Pharmacies': 'Pharmacy',
  'Healthcare': 'Healthcare',
  'Medical': 'Healthcare',
  'Dentists': 'Healthcare',
  'Gyms and Fitness Centers': 'Healthcare',
  'Entertainment': 'Entertainment',
  'Arts and Entertainment': 'Entertainment',
  'Education': 'Kids',
  'Recreation': 'Kids',
  'Tax': 'Tax/Professional',
  'Insurance': 'Insurance',
  'Transfer': null, // skip
  'Payment': null,  // skip
  'Credit Card': null,
  'Payroll': null,
  'Deposit': null,
};

function categorize(txn) {
  if (!txn.personal_finance_category) {
    // Fall back to legacy category
    const cat = (txn.category || []).join(' ');
    for (const [k, v] of Object.entries(CAT_MAP)) {
      if (cat.includes(k)) return v;
    }
    return 'Other';
  }
  const primary = txn.personal_finance_category.primary || '';
  const detailed = txn.personal_finance_category.detailed || '';
  // Skip transfers/payments (double-counting)
  if (['TRANSFER_IN','TRANSFER_OUT','LOAN_PAYMENTS','BANK_FEES'].includes(primary)) return null;
  if (primary === 'INCOME') return null;
  const catMap2 = {
    'FOOD_AND_DRINK': 'Restaurants',
    'GENERAL_MERCHANDISE': 'Shopping',
    'GENERAL_SERVICES': 'Tech/Subs',
    'TRANSPORTATION': 'Gas/Travel',
    'TRAVEL': 'Gas/Travel',
    'ENTERTAINMENT': 'Entertainment',
    'PERSONAL_CARE': 'Healthcare',
    'MEDICAL': 'Healthcare',
    'EDUCATION': 'Kids',
    'HOME_IMPROVEMENT': 'Shopping',
    'RENT_AND_UTILITIES': 'Tech/Subs',
    'GOVERNMENT_AND_NON_PROFIT': 'Other',
  };
  if (detailed.includes('AMAZON') || detailed.includes('AMAZON_SHOPPING')) return 'Amazon';
  if (detailed.includes('GROCERIES') || detailed.includes('SUPERMARKET')) return 'Groceries';
  if (detailed.includes('GAS') || detailed.includes('FUEL')) return 'Gas/Travel';
  if (detailed.includes('PHARMACY')) return 'Pharmacy';
  return catMap2[primary] || 'Other';
}

function isIncome(txn) {
  if (txn.amount < 0) { // Plaid: negative = money in
    const name = (txn.name || '').toUpperCase();
    if (name.includes('VERIZON') && name.includes('DIR DEP')) return true;
    if (name.includes('DIRECT DEP')) return true;
    if (name.includes('PAYROLL')) return true;
    const primary = txn.personal_finance_category?.primary || '';
    if (primary === 'INCOME') return true;
  }
  return false;
}

function buildStructuredData(accounts, transactions) {
  // Organize accounts
  const acctMap = {};
  accounts.forEach(a => {
    const key = a.subtype + '_' + a.mask;
    acctMap[key] = a;
  });

  // ── ALL ACCOUNTS — show every account from every bank ────────
  // Nickname aliases: map any nickname to a canonical bank name
  const NICK_TO_BANK = {
    'mybofa': 'BofA', 'bofa': 'BofA',
    'wf': 'Wells Fargo',
    'td': 'TD Bank',
    'mydisc': 'Discover', 'discover': 'Discover',
    'robin': 'Robinhood', 'robinhood': 'Robinhood',
  };

  // Build flat list of all accounts with bank label
  const allAccountsList = accounts.map(a => ({
    bank: NICK_TO_BANK[a._nickname] || a._nickname,
    nickname: a._nickname,
    name: a.name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    balance: a.balances?.current || 0,
    available: a.balances?.available || null,
    is_credit: a.type === 'credit',
    is_checking: a.subtype === 'checking',
    is_savings: a.subtype === 'savings',
  }));

  // Totals by type across all banks
  const totalChecking = allAccountsList.filter(a => ['checking','savings'].includes(a.subtype)).reduce((s,a) => s+a.balance, 0);
  const totalCredit   = allAccountsList.filter(a => a.is_credit).reduce((s,a) => s+a.balance, 0);
  const netWorth      = totalChecking - totalCredit;

  // For backward compat with dashboard — pick primary account per bank
  const bofaAccts  = allAccountsList.filter(a => a.bank === 'BofA');
  const wfAccts    = allAccountsList.filter(a => a.bank === 'Wells Fargo');
  const tdAccts    = allAccountsList.filter(a => a.bank === 'TD Bank');
  const discAccts  = allAccountsList.filter(a => a.bank === 'Discover');
  const bofaBal    = bofaAccts.filter(a => !a.is_credit).reduce((s,a) => s+a.balance, 0);
  const wfBal      = wfAccts.filter(a => a.is_credit).reduce((s,a) => s+a.balance, 0);
  const tdBal      = tdAccts.filter(a => a.is_checking).reduce((s,a) => s+a.balance, 0);
  const discBal    = discAccts.reduce((s,a) => s+a.balance, 0);
  const wfCheckBal = wfAccts.filter(a => a.is_checking).reduce((s,a) => s+a.balance, 0);

  // Monthly spending from transactions
  const monthlySpending = {};
  const monthlyIncome = {};
  const travelTxns = [];

  // Plaid: positive amount = money out (debit), negative = money in (credit)
  const spendTxns = transactions.filter(t => {
    const cat = categorize(t);
    return cat !== null && t.amount > 0;
  });

  spendTxns.forEach(t => {
    const date = t.date; // YYYY-MM-DD
    const period = date.substring(0, 7); // YYYY-MM
    const cat = categorize(t) || 'Other';
    const month = new Date(date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });

    if (!monthlySpending[period]) {
      monthlySpending[period] = { label: month, categories: {}, total: 0, transactions: [] };
    }
    monthlySpending[period].categories[cat] = (monthlySpending[period].categories[cat] || 0) + t.amount;
    monthlySpending[period].total += t.amount;
    monthlySpending[period].transactions.push({
      date: date.substring(5), // MM-DD
      desc: t.merchant_name || t.name,
      amount: t.amount,
      category: cat,
      city: t.location?.city || null,
      state: t.location?.region || null,
    });

    // Travel detection
    const state = t.location?.region;
    const city = t.location?.city;
    const HOME = ['NJ','NY','CT','PA'];
    if (state && !HOME.includes(state)) {
      travelTxns.push({
        date: date.substring(5),
        desc: t.merchant_name || t.name,
        amount: t.amount,
        category: cat,
        city: city || null,
        state: state,
        period: period,
        period_label: month,
      });
    }
  });

  // Income
  transactions.filter(isIncome).forEach(t => {
    const period = t.date.substring(0, 7);
    const month = new Date(t.date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
    if (!monthlyIncome[period]) monthlyIncome[period] = { label: month, bofa: 0, td: 0, total: 0 };
    const absAmt = Math.abs(t.amount);
    if (t._nickname === 'td') monthlyIncome[period].td += absAmt;
      else if (['mybofa','bofa'].includes(t._nickname)) monthlyIncome[period].bofa += absAmt;
      else monthlyIncome[period].bofa += absAmt;
    monthlyIncome[period].total += absAmt;
  });

  // Monthly history
  const allPeriods = [...new Set([...Object.keys(monthlySpending), ...Object.keys(monthlyIncome)])].sort();
  const monthlyHistory = allPeriods.map(p => ({
    period: p,
    period_label: (monthlySpending[p] || monthlyIncome[p])?.label || p,
    income: monthlyIncome[p]?.total || 0,
    bofa_income: monthlyIncome[p]?.bofa || 0,
    td_income: monthlyIncome[p]?.td || 0,
    outflows: 0, // calculated from bills below
    xoom: 0,
    investments: 0,
  }));

  // KPIs from most recent month
  const latestPeriod = allPeriods[allPeriods.length - 1];
  const latestIncome = monthlyIncome[latestPeriod] || {};
  const latestSpend = monthlySpending[latestPeriod] || {};

  // Fixed obligations (keep static until Plaid detects them)
  const fixedObligations = {
    mortgage: 3800.14, car_loan: 631.65, verizon: 515.0,
    pseg: 290.0, hoa: 105.95, cable: 50.66,
  };

  // Zelle from transactions
  const zelle = transactions
    .filter(t => (t.name || '').toLowerCase().includes('zelle') && t.amount < 0)
    .map(t => ({
      from: t.name.replace(/zelle/i, '').trim(),
      amount: Math.abs(t.amount),
      period: t.date.substring(0, 7),
      period_label: new Date(t.date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    }));

  return {
    kpis: {
      income: Math.round((latestIncome.total || 0) * 100) / 100,
      income_period: latestIncome.label || '',
      true_outflows: Math.round((latestSpend.total || 0) * 100) / 100,
      outflows_period: latestSpend.label || '',
      investments: 0,
      india_total: 1083.67, // static until ICICI connected
    },
    accounts: {
      bofa:    { balance: bofaBal,  is_checking: true,  period_label: 'Live', payroll: 0, outflows: 0 },
      wf:      { balance: wfBal,    is_credit: true,    period_label: 'Live', wf_checking: wfCheckBal },
      td:      { balance: tdBal,    is_checking: true,  period_label: 'Live', payroll: 0 },
      discover:{ balance: discBal,  is_credit: true,    period_label: 'Live' },
      icici_savings: { balance_inr: 0, balance_usd: 0 },
      icici_loan:    { casagrand_emi_inr: 0, casagrand_emi_usd: 0 },
    },
    all_accounts: allAccountsList,
    net_worth: { total_checking: totalChecking, total_credit: totalCredit, net: netWorth },
    },
    india: { hdfc_usd: 283.43, casagrand_usd: 755.0, pnb_usd: 35.66, yes_bank_usd: 9.58, total_usd: 1083.67, by_month: [] },
    spending: Object.fromEntries(
      Object.entries(
        Object.values(monthlySpending).reduce((acc, ms) => {
          Object.entries(ms.categories).forEach(([c, v]) => acc[c] = (acc[c] || 0) + v);
          return acc;
        }, {})
      )
    ),
    zelle_received: zelle,
    monthly_history: monthlyHistory,
    monthly_spending: monthlySpending,
    travel: travelTxns,
    fixed_obligations: fixedObligations,
    statement_count: Object.keys(getTokens()).length + ' live accounts',
  };
}

// ── GITHUB PUSH ───────────────────────────────────────────────
async function pushToGitHub(data) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO || 'VIMALZ1312/ledgr-realtime-app';
  const path  = 'data.json';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;

  // Get current SHA (needed for update)
  let sha = null;
  try {
    const r = await fetch(apiUrl, { headers: { Authorization: `token ${token}`, 'User-Agent': 'ledgr-bot' } });
    if (r.ok) { const j = await r.json(); sha = j.sha; }
  } catch {}

  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = {
    message: `Auto-sync: ${new Date().toISOString().slice(0,16)} UTC`,
    content,
    ...(sha ? { sha } : {}),
  };

  const resp = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ledgr-bot',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GitHub push failed: ${err}`);
  }
  console.log(`✓ Pushed data.json to ${repo}`);
}

async function fetchCurrentData() {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO || 'VIMALZ1312/ledgr-realtime-app';
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/data.json`, {
    headers: { Authorization: `token ${token}`, 'User-Agent': 'ledgr-bot' }
  });
  if (!r.ok) return {};
  const j = await r.json();
  return JSON.parse(Buffer.from(j.content, 'base64').toString());
}

// ── DAILY CRON: sync at 8am ET every day ─────────────────────
cron.schedule('0 13 * * *', async () => {
  console.log('⏰ Daily cron sync starting...');
  try {
    const result = await buildDataJson();
    console.log('✓ Cron sync complete:', result);
  } catch (err) {
    console.error('✗ Cron sync failed:', err.message);
  }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LEDGR Realtime backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.PLAID_ENV || 'sandbox'}`);
  console.log(`Connected accounts: ${Object.keys(getTokens()).join(', ') || 'none yet'}`);
});

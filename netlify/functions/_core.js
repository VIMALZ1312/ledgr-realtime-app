// ── LEDGR shared core for Netlify Functions ──────────────────────────────────
// Ports the Plaid → data.json pipeline from server.js so the Netlify build
// produces byte-for-byte the same structure as Replit. Tokens live in Netlify
// Blobs (auto-saved on link) AND/OR PLAID_TOKEN_* env vars (for migration).
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { getStore } = require('@netlify/blobs');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
}));

const NICKNAME_ALIASES = { mybofa: 'bofa', mydisc: 'discover', mytd: 'td', mywf: 'wf', myrobin: 'robin' };

function tokenStore() { return getStore('plaid-tokens'); }
function dataStore() { return getStore('ledgr-data'); }

// Save a freshly-exchanged access token (Blobs) — auto-persisted, no manual paste.
async function saveToken(nickname, accessToken) {
  const nick = String(nickname || '').toLowerCase();
  const canonical = NICKNAME_ALIASES[nick] || nick;
  await tokenStore().set(canonical, accessToken);
  return canonical;
}

// Merge tokens from Blobs + PLAID_TOKEN_* env vars (env used during migration).
async function getTokens() {
  const tokens = {};
  const add = (rawNick, token) => {
    const nick = String(rawNick).toLowerCase();
    const canonical = NICKNAME_ALIASES[nick] || nick;
    if (tokens[canonical] && tokens[canonical] !== token) tokens[canonical + '_2'] = token;
    else tokens[canonical] = token;
  };
  // 1) Env vars (PLAID_TOKEN_<NICK>) — lets you migrate before fully moving to Blobs
  Object.keys(process.env).forEach((k) => {
    if (k.startsWith('PLAID_TOKEN_')) add(k.replace('PLAID_TOKEN_', ''), process.env[k]);
  });
  // 2) Netlify Blobs (new links saved here automatically)
  try {
    const store = tokenStore();
    const { blobs } = await store.list();
    for (const b of blobs) {
      const v = await store.get(b.key);
      if (v) add(b.key, v);
    }
  } catch (e) {
    console.warn('Blobs token read skipped:', e.message);
  }
  return tokens;
}

// ── CATEGORIZATION (verbatim from server.js) ─────────────────────────────────
const CAT_MAP = {
  'Food and Drink': 'Restaurants', 'Restaurants': 'Restaurants', 'Coffee Shop': 'Restaurants',
  'Supermarkets and Groceries': 'Groceries', 'Shops': 'Shopping', 'Clothing and Accessories': 'Shopping',
  'Sporting Goods': 'Shopping', 'Digital Purchase': 'Shopping', 'Amazon': 'Amazon',
  'Travel': 'Gas/Travel', 'Gas Stations': 'Gas/Travel', 'Airlines': 'Gas/Travel', 'Taxi': 'Gas/Travel',
  'Car Services': 'Gas/Travel', 'Service': 'Tech/Subs', 'Subscription': 'Tech/Subs', 'Software': 'Tech/Subs',
  'Utilities': 'Tech/Subs', 'Pharmacies': 'Pharmacy', 'Healthcare': 'Healthcare', 'Medical': 'Healthcare',
  'Dentists': 'Healthcare', 'Gyms and Fitness Centers': 'Healthcare', 'Entertainment': 'Entertainment',
  'Arts and Entertainment': 'Entertainment', 'Education': 'Kids', 'Recreation': 'Kids',
  'Tax': 'Tax/Professional', 'Insurance': 'Insurance', 'Transfer': null, 'Payment': null,
  'Credit Card': null, 'Payroll': null, 'Deposit': null,
};

function categorize(txn) {
  const primary = txn.personal_finance_category?.primary || '';
  const detailed = txn.personal_finance_category?.detailed || '';
  const name = (txn.name || txn.merchant_name || '').toUpperCase();
  if (primary === 'INCOME') return null;
  if (primary === 'TRANSFER_IN') return null;
  if (primary === 'TRANSFER_OUT') return null;
  if (primary === 'LOAN_PAYMENTS') return null;
  if (primary === 'BANK_FEES') return null;
  if (name.includes('DIR DEP') || name.includes('DIRECT DEP')) return null;
  if (name.includes('ZELLE') && txn.amount < 0) return null;
  if (txn.amount < 0) return 'Refund';
  if (!txn.personal_finance_category) {
    const cat = (txn.category || []).join(' ');
    for (const [k, v] of Object.entries(CAT_MAP)) { if (cat.includes(k)) return v; }
    return categorizeName(txn.name || txn.merchant_name || '');
  }
  const catMap2 = {
    'FOOD_AND_DRINK': 'Restaurants', 'GENERAL_MERCHANDISE': 'Shopping', 'GENERAL_SERVICES': 'Tech/Subs',
    'TRANSPORTATION': 'Gas/Travel', 'TRAVEL': 'Gas/Travel', 'ENTERTAINMENT': 'Entertainment',
    'PERSONAL_CARE': 'Healthcare', 'MEDICAL': 'Healthcare', 'EDUCATION': 'Kids',
    'HOME_IMPROVEMENT': 'Shopping', 'RENT_AND_UTILITIES': 'Tech/Subs', 'GOVERNMENT_AND_NON_PROFIT': 'Tax/Professional',
  };
  if (detailed.includes('AMAZON')) return 'Amazon';
  if (detailed.includes('GROCERIES') || detailed.includes('SUPERMARKET')) return 'Groceries';
  if (detailed.includes('GAS') || detailed.includes('FUEL')) return 'Gas/Travel';
  if (detailed.includes('PHARMACY')) return 'Pharmacy';
  if (detailed.includes('RESTAURANT') || detailed.includes('COFFEE') || detailed.includes('FAST_FOOD')) return 'Restaurants';
  if (detailed.includes('GYMS')) return 'Healthcare';
  if (detailed.includes('TAX') || detailed.includes('GOVERNMENT')) return 'Tax/Professional';
  if (detailed.includes('INSURANCE')) return 'Insurance';
  const result = catMap2[primary];
  if (result) return result;
  return categorizeName(txn.merchant_name || txn.name || '');
}

function categorizeName(name) {
  const n = name.toUpperCase();
  if (/ESMERALDA|TGI\s*FRIDAY|MCDONALD|BURGER|PIZZA|SUSHI|DINER|GRILL|KITCHEN|BISTRO|CAFE|TACO|BRUNDAVANAM|TRIVENI|BIRYANI|SPICE|HALAL CART/.test(n)) return 'Restaurants';
  if (/SHOPRITE|PATIDAR|PATEL|COSTCO|TRADER JOE|WHOLE FOOD|ALDI|STOP & SHOP|FOOD BAZAAR/.test(n)) return 'Groceries';
  if (/MERCURY|GEICO|ALLSTATE|PROGRESSIVE|INSURANCE/.test(n)) return 'Insurance';
  if (/IRS|INTERNAL REVENUE|TURBO TAX|H&R BLOCK|TAX/.test(n)) return 'Tax/Professional';
  if (/NORTH BRUNSWICK|TOWNSHIP|COUNTY|STATE OF NJ|DMV|PERMIT/.test(n)) return 'Tax/Professional';
  if (/SHELL|BP |EXXON|GULF|SUNOCO|WAWA|LUKOIL|GAS|FUEL|EZPASS|E-ZPASS/.test(n)) return 'Gas/Travel';
  if (/WALGREEN|CVS|RITE AID|PHARMACY/.test(n)) return 'Pharmacy';
  if (/TARGET|WALMART|HOME DEPOT|MARSHALLS|TJMAXX|ROSS|DOLLAR/.test(n)) return 'Shopping';
  if (/NETFLIX|SPOTIFY|HULU|DISNEY|HBO|APPLE\.COM|GOOGLE|ANTHROPIC|CLAUDE|AITUBO|ZEE5|NORD|FANBASIS/.test(n)) return 'Tech/Subs';
  if (/PLANET FITNESS|GYM|SWIM|YMCA|DENTAL|DOCTOR|MEDICAL|VISION|OPTOM/.test(n)) return 'Healthcare';
  if (/BIG BLUE|KIDS|SCHOOL|TUTORING|BRIGHTCHAMP|SCHOLASTIC/.test(n)) return 'Kids';
  return 'Other';
}

function isIncome(txn) {
  if (txn.amount >= 0) return false;
  const primary = txn.personal_finance_category?.primary || '';
  const detailed = txn.personal_finance_category?.detailed || '';
  const name = (txn.name || txn.merchant_name || '').toUpperCase();
  if (primary === 'INCOME') return true;
  if (detailed.includes('INCOME') || detailed.includes('PAYROLL') || detailed.includes('WAGES')) return true;
  if (name.includes('DIRECT DEP') || name.includes('DIR DEP')) return true;
  if (name.includes('PAYROLL') || name.includes('PAYCHEX') || name.includes('ADP')) return true;
  if (name.includes('VERIZON') && Math.abs(txn.amount) > 1000) return true;
  return false;
}

function buildStructuredData(accounts, transactions) {
  const NICK_TO_BANK = {
    'mybofa': 'BofA', 'bofa': 'BofA', 'bofa_2': 'BofA', 'wifebofa': 'BofA',
    'wf': 'Wells Fargo', 'td': 'TD Bank', 'mydisc': 'Discover', 'discover': 'Discover',
    'robin': 'Robinhood', 'robinhood': 'Robinhood',
  };
  const allAccountsList = accounts.map(a => ({
    bank: NICK_TO_BANK[a._nickname] || a._nickname, nickname: a._nickname, name: a.name, mask: a.mask,
    type: a.type, subtype: a.subtype, balance: a.balances?.current || 0, available: a.balances?.available || null,
    is_credit: a.type === 'credit', is_checking: a.subtype === 'checking', is_savings: a.subtype === 'savings',
  }));
  const totalChecking = allAccountsList.filter(a => ['checking', 'savings', 'brokerage'].includes(a.subtype)).reduce((s, a) => s + a.balance, 0);
  const totalCredit = allAccountsList.filter(a => a.is_credit && a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const netWorth = totalChecking - totalCredit;
  const bofaAccts = allAccountsList.filter(a => a.bank === 'BofA');
  const wfAccts = allAccountsList.filter(a => a.bank === 'Wells Fargo');
  const tdAccts = allAccountsList.filter(a => a.bank === 'TD Bank');
  const discAccts = allAccountsList.filter(a => a.bank === 'Discover');
  const bofaBal = bofaAccts.filter(a => !a.is_credit).reduce((s, a) => s + a.balance, 0);
  const wfBal = wfAccts.filter(a => a.is_credit).reduce((s, a) => s + a.balance, 0);
  const tdBal = tdAccts.filter(a => a.is_checking).reduce((s, a) => s + a.balance, 0);
  const discBal = discAccts.reduce((s, a) => s + a.balance, 0);
  const wfCheckBal = wfAccts.filter(a => a.is_checking).reduce((s, a) => s + a.balance, 0);

  const monthlySpending = {};
  const monthlyIncome = {};
  const travelTxns = [];
  const seenTxns = new Set();
  const spendTxns = transactions.filter(t => {
    const cat = categorize(t);
    if (cat === null) return false;
    if (t.amount === 0) return false;
    const key = t.date + '|' + (t.merchant_name || t.name) + '|' + t.amount;
    if (seenTxns.has(key)) return false;
    seenTxns.add(key);
    return true;
  });
  const seenPending = new Set();
  const pendingTxns = transactions.filter(t => {
    if (!t.pending || t.amount <= 0) return false;
    const cat = categorize(t);
    if (cat === null) return false;
    const key = (t.merchant_name || t.name) + '|' + t.amount;
    if (seenPending.has(key)) return false;
    seenPending.add(key);
    return true;
  }).map(t => ({
    date: t.date ? t.date.substring(5) : '', desc: t.merchant_name || t.name, amount: t.amount,
    category: categorize(t) || 'Other', bank: NICK_TO_BANK[t._nickname] || t._nickname || null, pending: true,
  }));

  spendTxns.forEach(t => {
    const date = t.date;
    const period = date.substring(0, 7);
    const cat = categorize(t) || 'Other';
    const month = new Date(date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
    if (!monthlySpending[period]) monthlySpending[period] = { label: month, period: period, categories: {}, total: 0, transactions: [] };
    monthlySpending[period].categories[cat] = (monthlySpending[period].categories[cat] || 0) + t.amount;
    monthlySpending[period].total += t.amount;
    monthlySpending[period].transactions.push({
      date: date.substring(5), desc: t.merchant_name || t.name, amount: t.amount, category: cat,
      city: t.location?.city || null, state: t.location?.region || null,
      bank: NICK_TO_BANK[t._nickname] || t._nickname || null, account_id: t.account_id || null,
      mask: t.account_id ? (accounts.find(a => a.account_id === t.account_id)?.mask || null) : null,
      pending: false, refund: t.amount < 0,
    });
    const state = t.location?.region;
    const city = t.location?.city;
    const HOME = ['NJ', 'NY', 'CT', 'PA'];
    if (state && !HOME.includes(state)) {
      travelTxns.push({ date: date.substring(5), desc: t.merchant_name || t.name, amount: t.amount, category: cat, city: city || null, state: state, period: period, period_label: month });
    }
  });

  const seenIncome = new Set();
  transactions.filter(isIncome).filter(t => {
    const key = t.date + '|' + (t.name || '') + '|' + t.amount;
    if (seenIncome.has(key)) return false;
    seenIncome.add(key);
    return true;
  }).forEach(t => {
    const period = t.date.substring(0, 7);
    const month = new Date(t.date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
    if (!monthlyIncome[period]) monthlyIncome[period] = { label: month, bofa: 0, td: 0, total: 0 };
    const absAmt = Math.abs(t.amount);
    if (t._nickname === 'td') monthlyIncome[period].td += absAmt;
    else monthlyIncome[period].bofa += absAmt;
    monthlyIncome[period].total += absAmt;
  });

  const allPeriods = [...new Set([...Object.keys(monthlySpending), ...Object.keys(monthlyIncome)])].sort();
  const monthlyHistory = allPeriods.map(p => ({
    period: p, period_label: (monthlySpending[p] || monthlyIncome[p])?.label || p,
    income: monthlyIncome[p]?.total || 0, bofa_income: monthlyIncome[p]?.bofa || 0, td_income: monthlyIncome[p]?.td || 0,
    outflows: Math.round((monthlySpending[p]?.total || 0) * 100) / 100, xoom: 0, investments: 0,
  }));
  const latestPeriod = allPeriods[allPeriods.length - 1];
  const latestIncome = monthlyIncome[latestPeriod] || {};
  const latestSpend = monthlySpending[latestPeriod] || {};
  const fixedObligations = { mortgage: 3800.14, car_loan: 631.65, verizon: 515.0, pseg: 290.0, hoa: 105.95, cable: 50.66 };

  const merchantMap = {};
  Object.entries(monthlySpending).forEach(([period, v]) => {
    (v.transactions || []).forEach(t => {
      const key = (t.desc || '').toUpperCase().trim().substring(0, 35);
      if (!merchantMap[key]) merchantMap[key] = { desc: t.desc, amounts: [], months: new Set(), category: t.category };
      merchantMap[key].amounts.push(t.amount);
      merchantMap[key].months.add(period);
    });
  });
  const detectedRecurring = Object.values(merchantMap).filter(m => m.months.size >= 2).map(m => ({
    desc: m.desc, category: m.category, count: m.amounts.length, months: m.months.size,
    avg_amount: Math.round(m.amounts.reduce((s, a) => s + a, 0) / m.amounts.length * 100) / 100,
    last_amount: m.amounts[m.amounts.length - 1],
  })).sort((a, b) => b.months - a.months || b.avg_amount - a.avg_amount);

  const zelle = transactions.filter(t => (t.name || '').toLowerCase().includes('zelle') && t.amount < 0).map(t => ({
    from: t.name.replace(/zelle/i, '').trim(), amount: Math.abs(t.amount), period: t.date.substring(0, 7),
    period_label: new Date(t.date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' }),
  }));

  return {
    kpis: {
      income: Math.round((latestIncome.total || 0) * 100) / 100, income_period: latestIncome.label || '',
      true_outflows: Math.round((latestSpend.total || 0) * 100) / 100, outflows_period: latestSpend.label || '',
      investments: 0, india_total: 1083.67,
    },
    accounts: {
      bofa: { balance: bofaBal, is_checking: true, period_label: 'Live', payroll: 0, outflows: 0 },
      wf: { balance: wfBal, is_credit: true, period_label: 'Live', wf_checking: wfCheckBal },
      td: { balance: tdBal, is_checking: true, period_label: 'Live', payroll: 0 },
      discover: { balance: discBal, is_credit: true, period_label: 'Live' },
      icici_savings: { balance_inr: 0, balance_usd: 0 }, icici_loan: { casagrand_emi_inr: 0, casagrand_emi_usd: 0 },
    },
    all_accounts: allAccountsList,
    net_worth: { total_checking: totalChecking, total_credit: totalCredit, net: netWorth },
    india: { hdfc_usd: 283.43, casagrand_usd: 755.0, pnb_usd: 35.66, yes_bank_usd: 9.58, total_usd: 1083.67, by_month: [] },
    spending: Object.values(monthlySpending).reduce((acc, ms) => { Object.entries(ms.categories).forEach(([c, v]) => acc[c] = (acc[c] || 0) + v); return acc; }, {}),
    zelle_received: zelle, pending_transactions: pendingTxns, detected_recurring: detectedRecurring,
    monthly_history: monthlyHistory, monthly_spending: monthlySpending, travel: travelTxns,
    fixed_obligations: fixedObligations,
  };
}

// ── GITHUB PUSH (verbatim behavior from server.js) + Blobs cache ──────────────
async function pushToGitHub(data) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'VIMALZ1312/ledgr-realtime-app';
  const path = process.env.GITHUB_FILE_PATH || 'data.json';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
  let sha = null;
  try {
    const r = await fetch(apiUrl, { headers: { Authorization: `token ${token}`, 'User-Agent': 'ledgr-bot' } });
    if (r.ok) { const j = await r.json(); sha = j.sha; }
  } catch {}
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message: `Auto-sync (netlify): ${new Date().toISOString().slice(0, 16)} UTC`, content, ...(sha ? { sha } : {}) };
  const resp = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ledgr-bot' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`GitHub push failed: ${await resp.text()}`);
}

// ── CORE: fetch from Plaid and build data.json ───────────────────────────────
async function buildDataJson() {
  const tokens = await getTokens();
  if (!Object.keys(tokens).length) throw new Error('No bank accounts connected yet (no tokens in Blobs or env).');
  const allAccounts = [];
  const allTransactions = [];
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 90);

  for (const [nickname, token] of Object.entries(tokens)) {
    try {
      const acctResp = await plaid.accountsGet({ access_token: token });
      acctResp.data.accounts.forEach(a => allAccounts.push({ ...a, _nickname: nickname }));
      let cursor = null, added = [], hasMore = true;
      while (hasMore) {
        const txResp = await plaid.transactionsSync({ access_token: token, cursor: cursor || undefined });
        added = added.concat(txResp.data.added);
        cursor = txResp.data.next_cursor;
        hasMore = txResp.data.has_more;
        if (added.length > 500) break;
      }
      added.forEach(t => allTransactions.push({ ...t, _nickname: nickname }));
    } catch (err) {
      console.error(`Error fetching ${nickname}:`, err.response?.data || err.message);
    }
  }

  const data = buildStructuredData(allAccounts, allTransactions);
  data.generated_at = new Date().toISOString();
  data.source = 'plaid_realtime';
  data.statement_count = Object.keys(tokens).length + ' live accounts';

  await pushToGitHub(data);
  try { await dataStore().set('data.json', JSON.stringify(data)); } catch (e) { console.warn('Blobs data cache skipped:', e.message); }

  return { accounts_synced: allAccounts.length, transactions_synced: allTransactions.length, generated_at: data.generated_at };
}

module.exports = { plaid, Products, CountryCode, getTokens, saveToken, buildDataJson, dataStore };

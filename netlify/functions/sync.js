const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const fetch = require('node-fetch');

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

function getTokens() {
  const tokens = {};
  Object.keys(process.env).forEach(k => {
    if (k.startsWith('PLAID_TOKEN_')) {
      tokens[k.replace('PLAID_TOKEN_', '').toLowerCase()] = process.env[k];
    }
  });
  return tokens;
}

const CAT_MAP = {
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
};

function categorize(txn) {
  const primary = txn.personal_finance_category?.primary || '';
  const detailed = txn.personal_finance_category?.detailed || '';
  if (['TRANSFER_IN','TRANSFER_OUT','LOAN_PAYMENTS','BANK_FEES','INCOME'].includes(primary)) return null;
  if (detailed.includes('AMAZON')) return 'Amazon';
  if (detailed.includes('GROCER') || detailed.includes('SUPERMARKET')) return 'Groceries';
  if (detailed.includes('GAS') || detailed.includes('FUEL')) return 'Gas/Travel';
  if (detailed.includes('PHARMACY')) return 'Pharmacy';
  return CAT_MAP[primary] || 'Other';
}

async function pushToGitHub(data) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'VIMALZ1312/ledgr-realtime-app';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/data.json`;
  let sha = null;
  try {
    const r = await fetch(apiUrl, { headers: { Authorization: `token ${token}`, 'User-Agent': 'ledgr-bot' } });
    if (r.ok) { const j = await r.json(); sha = j.sha; }
  } catch {}
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const resp = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ledgr-bot' },
    body: JSON.stringify({ message: `Auto-sync: ${new Date().toISOString().slice(0,16)} UTC`, content, ...(sha ? { sha } : {}) }),
  });
  if (!resp.ok) throw new Error(`GitHub push failed: ${await resp.text()}`);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const tokens = getTokens();
    if (!Object.keys(tokens).length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No bank accounts connected' }) };

    const allAccounts = [], allTransactions = [];
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
      } catch (e) { console.error(`Error fetching ${nickname}:`, e.message); }
    }

    // Build monthly spending
    const monthlySpending = {}, monthlyIncome = {};
    allTransactions.filter(t => categorize(t) !== null && t.amount > 0).forEach(t => {
      const period = t.date.substring(0, 7);
      const cat = categorize(t) || 'Other';
      const label = new Date(t.date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
      if (!monthlySpending[period]) monthlySpending[period] = { label, categories: {}, total: 0, transactions: [] };
      monthlySpending[period].categories[cat] = (monthlySpending[period].categories[cat] || 0) + t.amount;
      monthlySpending[period].total += t.amount;
      monthlySpending[period].transactions.push({ date: t.date.substring(5), desc: t.merchant_name || t.name, amount: t.amount, category: cat, city: t.location?.city || null, state: t.location?.region || null });
    });

    allTransactions.filter(t => t.amount < 0).forEach(t => {
      const name = (t.name || '').toUpperCase();
      const primary = t.personal_finance_category?.primary || '';
      if (!name.includes('DIRECT DEP') && !name.includes('PAYROLL') && !name.includes('VERIZON V3') && primary !== 'INCOME') return;
      const period = t.date.substring(0, 7);
      const label = new Date(t.date + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
      if (!monthlyIncome[period]) monthlyIncome[period] = { label, bofa: 0, td: 0, total: 0 };
      const absAmt = Math.abs(t.amount);
      if (t._nickname === 'td') monthlyIncome[period].td += absAmt;
      else monthlyIncome[period].bofa += absAmt;
      monthlyIncome[period].total += absAmt;
    });

    const allPeriods = [...new Set([...Object.keys(monthlySpending), ...Object.keys(monthlyIncome)])].sort();
    const monthlyHistory = allPeriods.map(p => ({
      period: p, period_label: (monthlySpending[p] || monthlyIncome[p])?.label || p,
      income: monthlyIncome[p]?.total || 0, bofa_income: monthlyIncome[p]?.bofa || 0,
      td_income: monthlyIncome[p]?.td || 0, outflows: monthlySpending[p]?.total || 0,
      xoom: 0, investments: 0,
    }));

    const find = (nick) => allAccounts.find(a => a._nickname === nick) || {};
    const bofa = find('bofa'), wf = find('wf'), td = find('td'), disc = find('discover');

    const travel = [];
    const HOME = ['NJ','NY','CT','PA'];
    Object.values(monthlySpending).forEach(v => {
      (v.transactions || []).forEach(t => {
        if (t.state && !HOME.includes(t.state)) travel.push(t);
      });
    });

    const data = {
      generated_at: new Date().toISOString(),
      source: 'plaid_realtime',
      statement_count: `${Object.keys(tokens).length} live accounts`,
      kpis: {
        income: monthlyHistory.length ? monthlyHistory[monthlyHistory.length-1].income : 0,
        income_period: monthlyHistory.length ? monthlyHistory[monthlyHistory.length-1].period_label : '',
        true_outflows: monthlyHistory.length ? monthlyHistory[monthlyHistory.length-1].outflows : 0,
        outflows_period: monthlyHistory.length ? monthlyHistory[monthlyHistory.length-1].period_label : '',
        investments: 0, india_total: 1083.67,
      },
      accounts: {
        bofa:    { balance: bofa.balances?.current || 0, is_checking: true, period_label: 'Live', payroll: 0 },
        wf:      { balance: wf.balances?.current || 0,   is_credit: true,   period_label: 'Live' },
        td:      { balance: td.balances?.current || 0,   is_checking: true, period_label: 'Live', payroll: 0 },
        discover:{ balance: disc.balances?.current || 0, is_credit: true,   period_label: 'Live' },
        icici_savings: { balance_inr: 0, balance_usd: 0 },
        icici_loan:    { casagrand_emi_inr: 0, casagrand_emi_usd: 0 },
      },
      india: { hdfc_usd: 283.43, casagrand_usd: 755.0, pnb_usd: 35.66, yes_bank_usd: 9.58, total_usd: 1083.67, by_month: [] },
      spending: Object.fromEntries(Object.entries(Object.values(monthlySpending).reduce((acc, ms) => { Object.entries(ms.categories).forEach(([c,v]) => acc[c]=(acc[c]||0)+v); return acc; }, {}))),
      zelle_received: allTransactions.filter(t => (t.name||'').toLowerCase().includes('zelle') && t.amount < 0).map(t => ({ from: t.name, amount: Math.abs(t.amount), period: t.date.substring(0,7), period_label: new Date(t.date+'T00:00:00').toLocaleString('en-US',{month:'long',year:'numeric'}) })),
      monthly_history: monthlyHistory,
      monthly_spending: monthlySpending,
      travel,
      fixed_obligations: { mortgage: 3800.14, car_loan: 631.65, verizon: 515.0, pseg: 290.0, hoa: 105.95, cable: 50.66 },
    };

    await pushToGitHub(data);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, accounts_synced: allAccounts.length, transactions_synced: allTransactions.length, generated_at: data.generated_at }) };
  } catch (err) {
    console.error('Sync error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

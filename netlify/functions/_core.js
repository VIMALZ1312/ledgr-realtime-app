// ── LEDGR shared core for Netlify Functions ──────────────────────────────────
// Ports the Plaid → data.json pipeline from server.js so the Netlify build
// produces byte-for-byte the same structure as Replit. Tokens live in Netlify
// Blobs (auto-saved on link) AND/OR PLAID_TOKEN_* env vars (for migration).
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { getStore, connectLambda } = require('@netlify/blobs');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
}));

const NICKNAME_ALIASES = { mybofa: 'bofa', mydisc: 'discover', mytd: 'td', mywf: 'wf', myrobin: 'robin' };

// On-demand sync freshness. /transactions/refresh asks Plaid to extract from the
// bank right now instead of serving its last scheduled pull; the wait gives that
// extraction time to land before we read. Set PLAID_FORCE_REFRESH=0 to turn it
// off (refresh calls are billable on some Plaid plans).
const FORCE_REFRESH = process.env.PLAID_FORCE_REFRESH !== '0';
const REFRESH_WAIT_MS = Number(process.env.PLAID_REFRESH_WAIT_MS || 8000);

// Netlify auto-configures Blobs on git/CLI deploys. This site deploys via API
// zip-upload (continuous deploy is off), where that context isn't injected — so
// support explicit config too: set NETLIFY_BLOBS_SITE_ID + NETLIFY_BLOBS_TOKEN
// (a Netlify personal access token) to enable Blobs. Without them we fall back
// to auto-config, and callers degrade gracefully if Blobs is unavailable.
const BLOBS_SITE = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
const BLOBS_TOKEN = process.env.NETLIFY_BLOBS_TOKEN;
// Reads are eventually consistent (Lambda-style functions can't use 'strong'),
// so a value can lag a write by up to ~60s. Code that writes then needs the
// result passes it along instead of re-reading (see setHidden).
function storeArg(name) {
  return (BLOBS_SITE && BLOBS_TOKEN) ? { name, siteID: BLOBS_SITE, token: BLOBS_TOKEN } : name;
}
// These are Lambda-style handlers (exports.handler), where Blobs only finds its
// site context after connectLambda(event). Without it every Blobs call threw
// "environment has not been configured" and quietly fell back. Each handler
// calls this first; explicit NETLIFY_BLOBS_* env config needs nothing.
function connectBlobs(event) {
  if (BLOBS_SITE && BLOBS_TOKEN) return;
  try { if (event && event.blobs) connectLambda(event); } catch (e) { console.warn('connectLambda failed:', e.message); }
}
function tokenStore() { return getStore(storeArg('plaid-tokens')); }
function dataStore() { return getStore(storeArg('ledgr-data')); }

// Save a freshly-exchanged access token to Blobs. Returns {saved} — never throws,
// so the link flow can fall back to a manual env-var paste if Blobs is off.
async function saveToken(nickname, accessToken) {
  const nick = String(nickname || '').toLowerCase();
  const canonical = NICKNAME_ALIASES[nick] || nick;
  try { await tokenStore().set(canonical, accessToken); return { canonical, saved: true }; }
  catch (e) { console.warn('Blobs saveToken failed:', e.message); return { canonical, saved: false, error: e.message }; }
}

// Records which env var / Blobs key each canonical nickname came from. Two vars
// that alias to the same nickname (e.g. PLAID_TOKEN_ROBIN + PLAID_TOKEN_MYROBIN)
// get collapsed or suffixed `_2`, and without this there is no way to tell which
// var to edit when one of them needs re-linking. Populated by getTokens().
const TOKEN_SOURCES = {};

// Merge tokens from Blobs + PLAID_TOKEN_* env vars (env used during migration).
async function getTokens() {
  const tokens = {};
  Object.keys(TOKEN_SOURCES).forEach((k) => delete TOKEN_SOURCES[k]);
  const add = (rawNick, token, source) => {
    const nick = String(rawNick).toLowerCase();
    const canonical = NICKNAME_ALIASES[nick] || nick;
    const key = (tokens[canonical] && tokens[canonical] !== token) ? canonical + '_2' : canonical;
    tokens[key] = token;
    TOKEN_SOURCES[key] = source;
  };
  // 1) Env vars (PLAID_TOKEN_<NICK>) — lets you migrate before fully moving to Blobs
  Object.keys(process.env).forEach((k) => {
    if (k.startsWith('PLAID_TOKEN_')) add(k.replace('PLAID_TOKEN_', ''), process.env[k], k);
  });
  // 2) Netlify Blobs (new links saved here automatically)
  try {
    const store = tokenStore();
    const { blobs } = await store.list();
    for (const b of blobs) {
      const v = await store.get(b.key);
      if (v) add(b.key, v, 'blobs:' + b.key);
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
  // RENT_AND_UTILITIES_GAS_AND_ELECTRICITY (PSE&G) contains "GAS" — it's a
  // utility bill, not fuel, so it must not land in Gas/Travel.
  if (primary !== 'RENT_AND_UTILITIES' && (detailed.includes('GAS') || detailed.includes('FUEL'))) return 'Gas/Travel';
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
    'robin': 'Robinhood', 'robin_2': 'Robinhood', 'robin_3': 'Robinhood', 'myrobin': 'Robinhood', 'robinhood': 'Robinhood',
    'pnc': 'PNC', 'zillow': 'Rocket Mortgage', 'rocket': 'Rocket Mortgage',
  };
  const allAccountsList = accounts.map(a => ({
    bank: NICK_TO_BANK[a._nickname] || a._nickname, nickname: a._nickname, name: a.name, mask: a.mask,
    type: a.type, subtype: a.subtype, balance: a.balances?.current || 0, available: a.balances?.available || null,
    is_credit: a.type === 'credit', is_loan: a.type === 'loan', is_checking: a.subtype === 'checking', is_savings: a.subtype === 'savings',
  }));
  const totalChecking = allAccountsList.filter(a => ['checking', 'savings', 'brokerage'].includes(a.subtype)).reduce((s, a) => s + a.balance, 0);
  const totalCredit = allAccountsList.filter(a => a.is_credit && a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const totalLoans = allAccountsList.filter(a => a.type === 'loan' && a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const netWorth = totalChecking - totalCredit - totalLoans;
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
      id: t.transaction_id, date: date.substring(5), desc: t.merchant_name || t.name, amount: t.amount, category: cat,
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
    net_worth: { total_checking: totalChecking, total_credit: totalCredit, total_loans: totalLoans, net: netWorth },
    india: { hdfc_usd: 283.43, casagrand_usd: 755.0, pnb_usd: 35.66, yes_bank_usd: 9.58, total_usd: 1083.67, by_month: [] },
    spending: Object.values(monthlySpending).reduce((acc, ms) => { Object.entries(ms.categories).forEach(([c, v]) => acc[c] = (acc[c] || 0) + v); return acc; }, {}),
    zelle_received: zelle, pending_transactions: pendingTxns, detected_recurring: detectedRecurring,
    monthly_history: monthlyHistory, monthly_spending: monthlySpending, travel: travelTxns,
    fixed_obligations: fixedObligations,
  };
}

// ── CASH FLOW: money in vs money out per month, internal moves removed ────────
// monthly_spending above only sees what categorize() keeps, so it misses the
// mortgage/car loan (LOAN_PAYMENTS), card interest (BANK_FEES) and counts Zelle
// between our own accounts. This works from the raw (cross-Item deduped)
// transactions instead, and sorts every posted transaction into one bucket:
//   income   → salary | zelle_in (from other people) | interest | other_in
//   spent    → purchases (by category) | loans (mortgage/car) | fees | zelle_out | other_out
//   moved    → invested (to brokerage) | india (Xoom etc.) — not spending
//   internal → card payments, transfers between our own accounts, self-Zelle
// Plaid sign: amount > 0 is money leaving the account, < 0 is money arriving.
const SELF_NAME_RE = new RegExp(process.env.SELF_NAMES_RE || 'VIMAL ?RAJ', 'i');
const AI_RE = /OPENAI|CHATGPT|ANTHROPIC|CLAUDE|MIDJOURNEY|PERPLEXITY|CURSOR\b|COPILOT|GEMINI|AITUBO|ELEVENLABS|RUNWAYML|REPLIT|LOVABLE|SUNO\b|GROK|POE\.COM|CHARACTER\.AI|JASPER/i;
const INDIA_RE = /XOOM|REMITLY|WISE\b|TRANSFERWISE|WESTERN UNION|REMIT2INDIA|ICICI|INSTAREM/i;
// Card-issuer names only: a generic "ONLINE PAYMENT" is often a real bill (PSEG).
const CARD_PAY_RE = /CREDIT CARD|CRD EPAY|CRD AUTOPAY|CARD PAYMENT|BA ELECTRONIC PAYMENT|DISCOVER E-?PAYMENT|DISCOVER DES|CAPITAL ONE|AMEX EPAYMENT|AMERICAN EXPRESS|CHASE CREDIT|WF CREDIT|WELLS FARGO CARD|ROBINHOOD CARD|CITI CARD|APPLECARD|GSBANK|PAYMENT - THANK|PAYMENT THANK/i;
const FEE_RE = /INTEREST CHARGE|FINANCE CHARGE|LATE FEE|ANNUAL FEE|OVERDRAFT|FOREIGN TRANSACTION FEE|MONTHLY MAINTENANCE|SERVICE FEE/i;
// BofA's own wording for a move between two of our accounts. Its other leg can
// be missing (account on an Item that didn't return it), so trust the words.
const OWN_XFER_RE = /ONLINE BANKING TRANSFER (TO|FROM) (CHK|SAV)|TRANSFER (TO|FROM) (CHECKING|SAVINGS|CHK|SAV) ?X*\d{4}/i;
function feeKind(n) {
  if (/INTEREST/.test(n)) return 'interest';
  if (/LATE/.test(n)) return 'late';
  if (/OVERDRAFT|NSF|INSUFFICIENT/.test(n)) return 'overdraft';
  if (/MAINTENANCE|SERVICE CHARGE|SERVICE FEE/.test(n)) return 'maintenance';
  if (/ANNUAL/.test(n)) return 'annual';
  if (/ATM/.test(n)) return 'atm';
  return 'other';
}
const TRANSFERISH_RE =/TRANSFER|XFER|ZELLE|PAYMENT|PMT|AUTOPAY|DEPOSIT|ROBINHOOD|ONLINE BANKING|FUNDS/i;

// Sharper buckets than categorize() for the things the insights talk about.
function flowCategory(t) {
  const n = (t.merchant_name || t.name || '').toUpperCase();
  if (AI_RE.test(n)) return 'AI tools';
  if (/KUMON|BEST BRAINS|BIG BLUE|SWIM SCHOOL|SCHOLASTIC|BRIGHTCHAMP|TUTOR|KIDS EVENT/.test(n)) return 'Kids';
  if (/VERIZON|PSE&G|PSEG|PUBLIC SERVICE|OPTIMUM|TWP OF|TOWNSHIP|COMCAST|XFINITY|NJ NATURAL|T-MOBILE|AT&T|WATER|ELECTRIC/.test(n)) return 'Bills & utilities';
  if ((t.personal_finance_category || {}).primary === 'RENT_AND_UTILITIES') return 'Bills & utilities';
  if (/DOORDASH|UBER ?EATS|GRUBHUB|INSTACART|POSTMATES/.test(n)) return 'Food delivery';
  if (/COVERED EXTERIOR|HOME DEPOT|LOWE'?S|CONTRACTOR|ROOFING|LIGHT INSTALLATION/.test(n)) return 'Home projects';
  if (/FRAGOMEN|LAW |ATTORNEY|LEGAL|USCIS/.test(n)) return 'Legal/immigration';
  return categorize(t) || 'Other';
}

const BANK_OF_NICK = {
  mybofa: 'BofA', bofa: 'BofA', bofa_2: 'BofA', wifebofa: 'BofA', wf: 'Wells Fargo', td: 'TD Bank', mydisc: 'Discover', discover: 'Discover',
  robin: 'Robinhood', robin_2: 'Robinhood', robin_3: 'Robinhood', myrobin: 'Robinhood', robinhood: 'Robinhood', pnc: 'PNC',
};
function buildCashflow(accounts, transactions, months = 13) {
  const acctById = {};
  accounts.forEach(a => { acctById[a.account_id] = a; });
  const kindOf = t => { const a = acctById[t.account_id]; return a ? a.type : null; }; // depository|credit|loan|investment
  const nameOf = t => (t.name || t.merchant_name || '');
  const pfc = t => t.personal_finance_category || {};
  const isTransferish = t => ['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'].includes(pfc(t).primary) || TRANSFERISH_RE.test(nameOf(t));

  const now = new Date();
  const periods = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push(d.toISOString().slice(0, 7));
  }
  const firstDay = periods[0] + '-01';
  // Pair window reaches a few days before the first month so an early-month
  // transfer still finds its other leg.
  const posted = transactions.filter(t => !t.pending && t.amount && t.date >= shiftDate(firstDay, -5) && acctById[t.account_id]);

  // 1. Pair the two legs of moves between our own accounts: same size, opposite
  //    sign, different account, within 4 days, both transfer-like.
  const pairOf = new Map();
  const byAbs = new Map();
  posted.forEach(t => { if (!isTransferish(t)) return; const k = Math.abs(t.amount).toFixed(2); if (!byAbs.has(k)) byAbs.set(k, []); byAbs.get(k).push(t); });
  byAbs.forEach(list => {
    const outs = list.filter(t => t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
    const ins = list.filter(t => t.amount < 0);
    outs.forEach(o => {
      let best = null, bestGap = 99;
      ins.forEach(i => {
        if (pairOf.has(i.transaction_id) || i.account_id === o.account_id) return;
        const gap = Math.abs(dayDiff(o.date, i.date));
        if (gap <= 4 && gap < bestGap) { best = i; bestGap = gap; }
      });
      if (best) { pairOf.set(o.transaction_id, best); pairOf.set(best.transaction_id, o); }
    });
  });

  const blank = () => ({
    income: { total: 0, salary: 0, zelle_in: 0, interest: 0, other_in: 0 },
    spent: { total: 0, purchases: 0, refunds: 0, loans: 0, fees: 0, zelle_out: 0, other_out: 0, india: 0 },
    moved: { invested: 0 },
    internal: { count: 0, total: 0 },
    by_category: {}, ai: {}, fees: [], big: [], unmatched: [], refunds_big: [], loan_items: [], bounced: [], tx_in: [], tx_out: [], tx_moved: [], days: 0,
  });
  const out = {};
  periods.forEach(p => { out[p] = blank(); });
  const r2 = x => Math.round(x * 100) / 100;
  // Prefer Plaid's clean merchant name ("Fragomen") over the raw bank line.
  const note = (m, list, t, label) => m[list].push({ date: t.date, desc: (t.merchant_name || nameOf(t)).slice(0, 60), amount: r2(Math.abs(t.amount)), label });
  // Every transaction behind a total, for the Insights tap-to-see-why popups:
  // d=MM-DD, n=name, a=amount (negative = reduces that total), g=group shown.
  const maskById = {}; accounts.forEach(a => { maskById[a.account_id] = a.mask || ''; });
  const item = (m, list, t, g, sign = 1) => m[list].push({
    id: t.transaction_id, d: t.date.slice(5), n: (t.merchant_name || nameOf(t)).slice(0, 50), a: r2(sign * Math.abs(t.amount)), g,
    b: BANK_OF_NICK[t._nickname] || t._nickname || '', k: maskById[t.account_id] || '',
  });

  posted.forEach(t => {
    const p = t.date.slice(0, 7);
    const m = out[p];
    if (!m) return;
    const kind = kindOf(t);
    const amt = Math.abs(t.amount);
    const n = nameOf(t).toUpperCase();
    const det = pfc(t).detailed || '';
    const prim = pfc(t).primary || '';
    const pair = pairOf.get(t.transaction_id);
    const internal = () => { m.internal.count++; m.internal.total += amt; };

    // Loan and brokerage accounts only hold the far side of moves (payments
    // received, trades, dividends that stay invested) — never cash flow itself.
    if (kind === 'loan' || kind === 'investment') return;

    if (pair) {
      const otherKind = kindOf(pair);
      if (t.amount > 0 && otherKind === 'loan') { m.spent.loans += amt; note(m, 'loan_items', t); item(m, 'tx_out', t, 'Home & car loans'); return; } // mortgage / car loan paid to a linked loan
      if (t.amount > 0 && otherKind === 'investment') { m.moved.invested += amt; item(m, 'tx_moved', t, 'To Robinhood'); return; } // to Robinhood
      if (t.amount < 0 && otherKind === 'investment') { internal(); return; }              // cash back out of brokerage
      internal(); return;                                                                   // checking↔checking, card payments
    }

    if (t.amount < 0) { // ── money arriving ──
      if (kind === 'credit') {
        if (prim === 'TRANSFER_IN' || prim === 'LOAN_PAYMENTS' || CARD_PAY_RE.test(n) || /PAYMENT/.test(n)) { internal(); return; } // card paid from an unlinked account
        m.spent.refunds += amt; if (amt >= 200) note(m, 'refunds_big', t); item(m, 'tx_out', t, 'Refunds & cashback', -1); return;
      }
      if (/ZELLE/.test(n) && SELF_NAME_RE.test(n)) { internal(); return; }
      if (OWN_XFER_RE.test(n)) { internal(); return; }
      // A payment the bank sent back for lack of funds (the mortgage, Jul–Sep).
      // Settled in the finalize step: it cancels the payment it returned.
      if (/RETURN OF POSTED|RETURNED ITEM|RETURNED PAYMENT/.test(n)) { note(m, 'bounced', t); return; }
      // Cash out of our own brokerage is our money coming home, not income.
      if (/ROBINHOOD/.test(n)) { internal(); return; }
      if (isIncome(t)) { m.income.salary += amt; item(m, 'tx_in', t, 'Salary'); return; }
      if (det.includes('INTEREST_EARNED') || det.includes('DIVIDENDS')) { m.income.interest += amt; item(m, 'tx_in', t, 'Interest'); return; }
      if (/ZELLE/.test(n)) { m.income.zelle_in += amt; item(m, 'tx_in', t, 'Zelle from people'); return; }
      if (prim === 'TRANSFER_IN' || TRANSFERISH_RE.test(n)) { m.income.other_in += amt; note(m, 'unmatched', t, 'in'); item(m, 'tx_in', t, 'Other money in'); return; }
      m.spent.refunds += amt; if (amt >= 200) note(m, 'refunds_big', t); item(m, 'tx_out', t, 'Refunds & cashback', -1); return; // a merchant refund landing in checking
    }

    // ── money leaving (checking or card) ──
    if (det.includes('CREDIT_CARD_PAYMENT') || (kind === 'depository' && CARD_PAY_RE.test(n) && !/ZELLE/.test(n))) { internal(); return; }
    if (prim === 'BANK_FEES' || det.includes('INTEREST_CHARGE') || FEE_RE.test(n)) { m.spent.fees += amt; note(m, 'fees', t, feeKind(n)); item(m, 'tx_out', t, 'Bank & card fees'); return; }
    if (prim === 'LOAN_PAYMENTS') { m.spent.loans += amt; note(m, 'loan_items', t); item(m, 'tx_out', t, 'Home & car loans'); return; }
    if (/ZELLE/.test(n) && SELF_NAME_RE.test(n)) { internal(); return; }
    if (OWN_XFER_RE.test(n)) { internal(); return; }
    // Money sent home to India counts as spending: it leaves the US budget for good.
    if (INDIA_RE.test(n)) { m.spent.india += amt; m.by_category['Sent to India'] = (m.by_category['Sent to India'] || 0) + amt; item(m, 'tx_out', t, 'Sent to India'); return; }
    if (det.includes('INVESTMENT') || /ROBINHOOD/.test(n)) { m.moved.invested += amt; item(m, 'tx_moved', t, 'To Robinhood'); return; }
    if (/ZELLE/.test(n)) {
      m.spent.zelle_out += amt;
      // Keep a sharp bucket (Kids event, Home projects); otherwise "Zelle to people".
      let c = flowCategory(t);
      if (['Other', 'Tech/Subs', 'Shopping', 'Refund'].includes(c)) c = 'Zelle to people';
      m.by_category[c] = (m.by_category[c] || 0) + amt;
      item(m, 'tx_out', t, c);
      if (amt >= 1000) note(m, 'big', t);
      return;
    }
    if (prim === 'TRANSFER_OUT') { m.spent.other_out += amt; note(m, 'unmatched', t, 'out'); item(m, 'tx_out', t, 'Cash & other money out'); return; }

    m.spent.purchases += amt;
    const cat = flowCategory(t);
    m.by_category[cat] = (m.by_category[cat] || 0) + amt;
    item(m, 'tx_out', t, cat);
    if (cat === 'AI tools') { const k = (t.merchant_name || t.name || 'AI').trim(); m.ai[k] = (m.ai[k] || 0) + amt; }
    if (amt >= 1000) note(m, 'big', t);
  });

  const todayStr = now.toISOString().slice(0, 10);
  periods.forEach(p => {
    const m = out[p];
    // A bounced payment undoes the loan payment of the same size. Any other
    // bounce is almost always a card payment, which was internal to begin with,
    // so it stays internal rather than posing as a refund.
    m.bounced.forEach(b => {
      const i = m.loan_items.findIndex(l => !l.reversed && Math.abs(l.amount - b.amount) < 0.01);
      if (i >= 0) { m.loan_items[i].reversed = true; m.spent.loans -= b.amount; m.tx_out.push({ d: b.date.slice(5), n: 'Bounced — returned by bank', a: -b.amount, g: 'Home & car loans' }); }
      else { m.internal.count++; m.internal.total += b.amount; }
    });
    m.income.total =m.income.salary + m.income.zelle_in + m.income.interest + m.income.other_in;
    m.spent.total = m.spent.purchases - m.spent.refunds + m.spent.loans + m.spent.fees + m.spent.zelle_out + m.spent.other_out + m.spent.india;
    ['income', 'spent', 'moved', 'internal'].forEach(g => Object.keys(m[g]).forEach(k => { m[g][k] = r2(m[g][k]); }));
    Object.keys(m.by_category).forEach(k => { m.by_category[k] = r2(m.by_category[k]); });
    Object.keys(m.ai).forEach(k => { m.ai[k] = r2(m.ai[k]); });
    m.big.sort((a, b) => b.amount - a.amount);
    ['tx_in', 'tx_out', 'tx_moved'].forEach(k => m[k].sort((a, b) => a.d.localeCompare(b.d)));
    m.unmatched = m.unmatched.sort((a, b) => b.amount - a.amount).slice(0, 15);
    // How many days of the month are in (the current month is partial).
    const last = new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7), 0)).getUTCDate();
    m.days = todayStr.slice(0, 7) === p ? +todayStr.slice(8, 10) : last;
    m.days_in_month = last;
  });
  return out;
}
function shiftDate(iso, days) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function dayDiff(a, b) { return (new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000; }

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
  // The "[skip ci]" tag backs up the `ignore` command in netlify.toml: this is a
  // data-only commit and must not trigger a paid production deploy.
  const body = { message: `Auto-sync (netlify): ${new Date().toISOString().slice(0, 16)} UTC [skip ci]`, content, ...(sha ? { sha } : {}) };
  const resp = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ledgr-bot' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`GitHub push failed: ${await resp.text()}`);
}

// Joint accounts (BofA ...1739 and ...5677 are visible to both the `bofa` and
// `wifebofa` logins) arrive once per Item, each copy carrying a DIFFERENT
// account_id — so nothing keyed on account_id can see the duplication, and the
// same charge is counted twice in monthly spending. Collapse on the account
// mask plus the transaction's own fields, but only across DIFFERENT nicknames:
// two genuinely identical charges on one card (same day, same merchant, same
// amount) come from a single Item and must both survive.
function dedupeCrossItemTxns(accounts, transactions) {
  const maskById = {};
  accounts.forEach(a => { if (a.account_id) maskById[a.account_id] = a.mask || ''; });
  const firstNickBy = new Map();
  const kept = [];
  const removed = [];
  for (const t of transactions) {
    const mask = maskById[t.account_id];
    if (!mask) { kept.push(t); continue; }   // unknown account — never risk a collapse
    const key = [mask, t.date, t.amount, (t.merchant_name || t.name || '').trim().toLowerCase(), t.pending ? 'p' : 'x'].join('|');
    const firstNick = firstNickBy.get(key);
    if (firstNick !== undefined && firstNick !== t._nickname) {
      removed.push({ mask, date: t.date, amount: t.amount, kept_from: firstNick, dropped_from: t._nickname });
      continue;
    }
    if (firstNick === undefined) firstNickBy.set(key, t._nickname);
    kept.push(t);
  }
  return { transactions: kept, removed };
}

// ── CREDIT CARD DUE DATES (Payment monitor) ─────────────────────────────────
// Plaid /liabilities/get gives each card's statement balance, minimum payment
// and next due date straight from the bank. Not every Item has the liabilities
// product, so each card also carries what the transactions show: its recent
// payments, and a due day estimated from when it usually gets paid.
const CARD_PAYMENT_RE = /PAYMENT|AUTOPAY|AUTO PAY|THANK YOU|PMT|EPAY|E-PAY/i;
function pickLiability(l) {
  return {
    due_date: l.next_payment_due_date || null,
    min_due: l.minimum_payment_amount ?? null,
    statement_balance: l.last_statement_balance ?? null,
    statement_date: l.last_statement_issue_date || null,
    last_payment_date: l.last_payment_date || null,
    last_payment_amount: l.last_payment_amount ?? null,
    is_overdue: !!l.is_overdue,
    apr: (l.aprs || []).filter(a => a.apr_type === 'purchase_apr').map(a => a.apr_percentage)[0] ?? null,
  };
}
function buildCards(accounts, transactions, liabilities) {
  const liab = liabilities || {};
  const seen = new Set();
  const today = new Date().toISOString().slice(0, 10);
  const cards = [];
  accounts.filter(a => a.type === 'credit').forEach(a => {
    if (seen.has(a.mask)) return; seen.add(a.mask);
    const ids = new Set(accounts.filter(x => x.type === 'credit' && x.mask === a.mask).map(x => x.account_id));
    const pays = transactions
      .filter(t => ids.has(t.account_id) && t.amount < 0 && CARD_PAYMENT_RE.test(t.name || ''))
      .map(t => ({ date: t.date, amount: Math.round(-t.amount * 100) / 100, pending: !!t.pending }))
      .sort((x, y) => y.date.localeCompare(x.date));
    const L = [...ids].map(id => liab[id]).find(Boolean);
    const card = {
      bank: BANK_OF_NICK[a._nickname] || a._nickname || '', nickname: a._nickname, name: (a.official_name || a.name || '').replace(/[^\x20-\x7E]+/g, '').trim(), mask: a.mask,
      balance: a.balances?.current ?? 0, limit: a.balances?.limit ?? null,
      payments: pays.slice(0, 8),
      source: L ? 'bank' : 'estimated',
    };
    if (L) Object.assign(card, L);
    // No bank data: estimate the due day from the usual payment day.
    if (!card.due_date && pays.length) {
      const days = pays.slice(0, 6).map(p => +p.date.slice(8)).sort((x, y) => x - y);
      const d = days[Math.floor(days.length / 2)];
      const now = new Date(today + 'T00:00:00Z');
      let due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(d, 28)));
      if (due.toISOString().slice(0, 10) < today) due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, Math.min(d, 28)));
      card.due_date = due.toISOString().slice(0, 10);
      card.due_estimated = true;
    }
    // Paid since the last statement?
    const since = card.statement_date || (card.due_date ? shiftDays(card.due_date, -25) : null);
    card.paid_since_statement = since ? Math.round(pays.filter(p => p.date > since).reduce((s, p) => s + p.amount, 0) * 100) / 100 : 0;
    const owedOnStatement = card.statement_balance != null ? card.statement_balance : card.balance;
    card.remaining_due = Math.max(0, Math.round((owedOnStatement - card.paid_since_statement) * 100) / 100);
    cards.push(card);
  });
  return cards.sort((x, y) => (x.due_date || '9999').localeCompare(y.due_date || '9999'));
}
function shiftDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ── PHONE ALERTS (ntfy.sh) ───────────────────────────────────────────────────
// Push notifications through ntfy: install the ntfy app and subscribe to the
// topic in NTFY_TOPIC. Sent after each real bank sync (twice a day on the cron,
// plus every manual Sync), never on a delete/restore rebuild.
//   - a bank or card fee / interest charge posted in the last 5 days
//   - a card payment due within 3 days that isn't paid yet, and on the due day
//   - a card the bank reports as overdue
// Blobs "notified.json" remembers what was sent, so nothing repeats.
const NOTIFIED_KEY = 'notified.json';
async function ntfy(title, message, opts = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const resp = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
    method: 'POST',
    headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Priority: String(opts.priority || 3), Tags: opts.tags || 'moneybag', ...(opts.click ? { Click: opts.click } : {}) },
    body: message,
  });
  if (!resp.ok) throw new Error('ntfy HTTP ' + resp.status);
  return true;
}
async function sendAlerts(data) {
  if (!process.env.NTFY_TOPIC) return { sent: 0, reason: 'NTFY_TOPIC not set' };
  let state = {};
  try { const v = await dataStore().get(NOTIFIED_KEY); state = v ? JSON.parse(v) : {}; } catch (e) { console.warn('notified list unavailable:', e.message); }
  state.fees = state.fees || {}; state.due = state.due || {};
  const site = process.env.URL || '';
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = shiftDays(today, -5);
  const out = [];
  // Fees
  const cf = data.cashflow || {};
  Object.keys(cf).sort().slice(-2).forEach(p => {
    (cf[p].tx_out || []).forEach(x => {
      if (x.g !== 'Bank & card fees' || !x.id || state.fees[x.id]) return;
      const date = p.slice(0, 4) + '-' + x.d;
      state.fees[x.id] = today;
      if (date < cutoff) return; // old: remember silently, don't alert
      out.push({ title: `Fee charged: ${x.a.toFixed(2)}`, msg: `${x.n} on ${x.b}${x.k ? ' ••' + x.k : ''} (${date}). Call the bank and ask for a refund.`, tags: 'warning', priority: 4 });
    });
  });
  // Card due dates
  (data.cards || []).forEach(c => {
    if (!c.due_date) return;
    const days = Math.round((new Date(c.due_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 864e5);
    const label = `${c.bank} ••${c.mask}`;
    const amt = c.min_due != null && c.min_due > 0 ? `min ${c.min_due.toFixed(2)} · statement ${(c.statement_balance ?? c.balance).toFixed(2)}` : `${c.remaining_due.toFixed(2)}`;
    if (c.is_overdue && !state.due[c.mask + '|' + c.due_date + '|over']) {
      state.due[c.mask + '|' + c.due_date + '|over'] = today;
      out.push({ title: `OVERDUE: ${label}`, msg: `Payment is past due (${amt}). Pay now to avoid a late fee and interest.`, tags: 'rotating_light', priority: 5 });
      return;
    }
    if (c.remaining_due < 1) return;
    const stage = days === 0 ? 'today' : (days > 0 && days <= 3 ? 'soon' : null);
    if (!stage || state.due[c.mask + '|' + c.due_date + '|' + stage]) return;
    state.due[c.mask + '|' + c.due_date + '|' + stage] = today;
    out.push({ title: stage === 'today' ? `Due TODAY: ${label}` : `Due in ${days} day${days > 1 ? 's' : ''}: ${label}`, msg: `${amt} due ${c.due_date}${c.due_estimated ? ' (estimated)' : ''}.`, tags: 'calendar', priority: stage === 'today' ? 5 : 4 });
  });
  let sent = 0;
  for (const n of out.slice(0, 10)) {
    try { await ntfy(n.title, n.msg, { tags: n.tags, priority: n.priority, click: site }); sent++; } catch (e) { console.warn('ntfy failed:', e.message); }
  }
  try { await dataStore().set(NOTIFIED_KEY, JSON.stringify(state)); } catch (e) { console.warn('notified list not saved:', e.message); }
  return { sent, queued: out.length };
}

// ── HIDDEN TRANSACTIONS: ones the user deleted in the app ─────────────────────
// Stored in Blobs and applied to the raw bank data before ANY aggregation, so a
// deleted transaction vanishes from every tab and stays gone across syncs.
// Matched by Plaid id, or by fingerprint (account mask + date + amount + name):
// the fingerprint also catches the second copy of a charge on a joint account
// (which arrives under a different id from the other login) and a re-issued id.
const HIDDEN_KEY = 'hidden.json';
const RAW_KEY = 'raw.json';
function txnFingerprint(t, maskById) {
  return [maskById[t.account_id] || '', t.date, Number(t.amount).toFixed(2), (t.merchant_name || t.name || '').trim().toLowerCase()].join('|');
}
async function getHidden() {
  try { const v = await dataStore().get(HIDDEN_KEY); return v ? JSON.parse(v) : []; }
  catch (e) { console.warn('hidden list unavailable:', e.message); return []; }
}
function applyHidden(accounts, transactions, hidden) {
  if (!hidden.length) return { transactions, removed: 0 };
  const maskById = {}; accounts.forEach(a => { maskById[a.account_id] = a.mask || ''; });
  const ids = new Set(hidden.map(h => h.id)), fps = new Set(hidden.map(h => h.fp));
  const kept = transactions.filter(t => !ids.has(t.transaction_id)
    && !(t.pending_transaction_id && ids.has(t.pending_transaction_id))
    && !fps.has(txnFingerprint(t, maskById)));
  return { transactions: kept, removed: transactions.length - kept.length };
}
// Only the fields the build reads — the full Plaid objects are ~10x larger.
function slimTxn(t) {
  return {
    transaction_id: t.transaction_id, pending_transaction_id: t.pending_transaction_id || null, account_id: t.account_id,
    amount: t.amount, date: t.date, name: t.name, merchant_name: t.merchant_name || null, pending: !!t.pending,
    personal_finance_category: t.personal_finance_category ? { primary: t.personal_finance_category.primary, detailed: t.personal_finance_category.detailed } : null,
    category: t.category || null, location: t.location ? { city: t.location.city || null, region: t.location.region || null } : null,
    _nickname: t._nickname,
  };
}

// Turn one bank download into data.json (GitHub + Blobs). Used by a full sync
// and by a rebuild after the hidden list changes, which needs no bank calls.
async function publishFromRaw(raw, hiddenNow) {
  const hidden = hiddenNow || await getHidden();
  const visible = applyHidden(raw.accounts, raw.transactions, hidden);
  const deduped = dedupeCrossItemTxns(raw.accounts, visible.transactions);
  const data = buildStructuredData(raw.accounts, deduped.transactions);
  try { data.cashflow = buildCashflow(raw.accounts, deduped.transactions); }
  catch (e) { console.error('cashflow build failed:', e); data.cashflow = null; } // never let insights break a sync
  try { data.cards = buildCards(raw.accounts, deduped.transactions, raw.liabilities); }
  catch (e) { console.error('cards build failed:', e); data.cards = []; }
  data.hidden = hidden.map(h => ({ id: h.id, date: h.date, desc: h.desc, amount: h.amount, bank: h.bank, mask: h.mask, hidden_at: h.hidden_at }));
  data.generated_at = raw.fetched_at;   // when the banks were last read
  data.rebuilt_at = new Date().toISOString();
  data.source = 'plaid_realtime';
  data.statement_count = raw.meta.tokens + ' live accounts';
  data.sync_status = Object.assign({}, raw.meta, {
    duplicates_removed: deduped.removed.length,
    duplicate_sample: deduped.removed.slice(0, 10),
    hidden_removed: visible.removed,
  });
  await pushToGitHub(data);
  try { await dataStore().set('data.json', JSON.stringify(data)); } catch (e) { console.warn('Blobs data cache skipped:', e.message); }
  return data;
}

async function loadRaw() {
  const v = await dataStore().get(RAW_KEY);
  if (!v) throw new Error('No cached bank data yet — tap Sync once, then try again.');
  return JSON.parse(v);
}
async function rebuildFromCache() { return publishFromRaw(await loadRaw()); }

// Hide (or restore) one transaction by Plaid id, then rebuild data.json.
async function setHidden(id, hide) {
  const raw = await loadRaw();
  let hidden = await getHidden();
  if (hide) {
    if (!hidden.some(h => h.id === id)) {
      const t = raw.transactions.find(x => x.transaction_id === id);
      if (!t) throw new Error('That transaction is not in the latest bank data.');
      const maskById = {}; raw.accounts.forEach(a => { maskById[a.account_id] = a.mask || ''; });
      hidden.push({
        id, fp: txnFingerprint(t, maskById), date: t.date, desc: (t.merchant_name || t.name || '').slice(0, 80), amount: t.amount,
        bank: BANK_OF_NICK[t._nickname] || t._nickname || '', mask: maskById[t.account_id] || '', hidden_at: new Date().toISOString(),
      });
    }
  } else {
    hidden = hidden.filter(h => h.id !== id);
  }
  await dataStore().set(HIDDEN_KEY, JSON.stringify(hidden));
  // Pass the list just written (a re-read could be stale) and hand the rebuilt
  // data.json back so the app can show it without a lagging /api/data read.
  const data = await publishFromRaw(raw, hidden);
  return { count: hidden.length, data };
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

  // Every sync is now user-initiated, so it must return the freshest numbers the
  // bank will give us rather than whatever Plaid last extracted on its own
  // schedule. Ask each Item to pull from the institution first, in parallel, then
  // give the extractions a moment to land before reading transactions.
  // Best-effort throughout: an Item whose plan or institution doesn't support
  // /transactions/refresh just falls back to Plaid's cached view.
  const refreshed = [];
  const refreshErrors = {};
  if (FORCE_REFRESH) {
    await Promise.all(Object.entries(tokens).map(async ([nickname, token]) => {
      try { await plaid.transactionsRefresh({ access_token: token }); refreshed.push(nickname); }
      catch (err) {
        const code = err.response?.data?.error_code || err.message;
        refreshErrors[nickname] = code;
        console.warn(`transactionsRefresh skipped for ${nickname}:`, code);
      }
    }));
    if (refreshed.length) await new Promise(r => setTimeout(r, REFRESH_WAIT_MS));
  }

  const tokenStatus = [];
  const staleBalances = [];
  const liabilities = {};      // account_id → due date, minimum, statement
  const liabilityErrors = {};
  for (const [nickname, token] of Object.entries(tokens)) {
    try {
      // accountsBalanceGet forces a live balance read; accountsGet returns
      // Plaid's cached balance, which is what made the old scheduled data look
      // current while being hours stale.
      let acctResp;
      try {
        acctResp = await plaid.accountsBalanceGet({ access_token: token });
      } catch (balErr) {
        console.warn(`accountsBalanceGet fell back for ${nickname}:`, balErr.response?.data?.error_code || balErr.message);
        acctResp = await plaid.accountsGet({ access_token: token });
        staleBalances.push(nickname);
      }
      acctResp.data.accounts.forEach(a => allAccounts.push({ ...a, _nickname: nickname }));
      // Card due dates for the Payment monitor. Best-effort: an Item linked
      // without the liabilities product just falls back to estimates.
      if (acctResp.data.accounts.some(a => a.type === 'credit')) {
        try {
          const lr = await plaid.liabilitiesGet({ access_token: token });
          (lr.data.liabilities?.credit || []).forEach(l => { if (l.account_id) liabilities[l.account_id] = pickLiability(l); });
        } catch (lErr) {
          liabilityErrors[nickname] = lErr.response?.data?.error_code || lErr.message;
          console.warn(`liabilitiesGet skipped for ${nickname}:`, liabilityErrors[nickname]);
        }
      }
      // Every sync starts from a null cursor, so this pages an Item's WHOLE
      // history, and /transactions/sync hands back the oldest updates first.
      // That makes an early bail drop the NEWEST transactions, not the oldest:
      // the previous `if (added.length > 500) break` silently froze the biggest
      // Item (Wells Fargo, ~600 txns) weeks in the past — its window was full,
      // so nothing recent could enter — while smaller Items stayed current.
      // Page until Plaid says it is done; MAX_PAGES only stops a runaway loop,
      // and `truncated` makes hitting it visible instead of silent.
      const PAGE_SIZE = 500;        // /transactions/sync maximum
      const MAX_PAGES = 60;         // 30k txns — far beyond any real Item
      // added/modified/removed are folded by transaction_id so a charge that
      // changed mid-history lands once, in its final form.
      const byId = new Map();
      let cursor = null, hasMore = true, pages = 0;
      while (hasMore && pages < MAX_PAGES) {
        const txResp = await plaid.transactionsSync({ access_token: token, cursor: cursor || undefined, count: PAGE_SIZE });
        const page = txResp.data;
        (page.added || []).forEach(t => byId.set(t.transaction_id, t));
        (page.modified || []).forEach(t => byId.set(t.transaction_id, t));
        (page.removed || []).forEach(r => byId.delete(r.transaction_id));
        cursor = page.next_cursor;
        hasMore = page.has_more;
        pages++;
      }
      if (hasMore) console.warn(`Transaction paging hit MAX_PAGES for ${nickname} — history is truncated`);
      const added = [...byId.values()];
      added.forEach(t => allTransactions.push({ ...t, _nickname: nickname }));
      const lastTxnDate = added.reduce((m, t) => (t.date > m ? t.date : m), '');
      tokenStatus.push({
        nickname, ok: true, accounts: acctResp.data.accounts.length,
        source: TOKEN_SOURCES[nickname] || null,
        masks: acctResp.data.accounts.map(a => a.mask).filter(Boolean),
        // Per-Item freshness: a newest-transaction date sitting weeks behind the
        // other Items is how a stalled or truncated feed shows itself.
        txns: added.length, pages, truncated: hasMore, last_txn: lastTxnDate || null,
      });
    } catch (err) {
      const code = err.response?.data?.error_code || err.message;
      console.error(`Error fetching ${nickname}:`, err.response?.data || err.message);
      tokenStatus.push({ nickname, ok: false, accounts: 0, error: code, source: TOKEN_SOURCES[nickname] || null });
    }
  }

  const raw = {
    fetched_at: new Date().toISOString(),
    accounts: allAccounts,
    transactions: allTransactions.map(slimTxn),
    liabilities,
    // Per-token diagnostics — surfaces missing/errored banks instead of silently
    // dropping them (e.g. a token that needs re-auth, or one not configured).
    meta: {
      tokens: Object.keys(tokens).length,
      nicknames: Object.keys(tokens),
      detail: tokenStatus,
      failed: tokenStatus.filter(t => !t.ok).map(t => t.nickname + ' (' + t.error + ')'),
      // Freshness diagnostics — which banks were force-pulled, and which fell back
      // to a cached balance (so a stale number is visible instead of silent).
      forced_refresh: refreshed,
      refresh_errors: refreshErrors,
      cached_balances: staleBalances,
      txns_fetched: allTransactions.length,
      liabilities_cards: Object.keys(liabilities).length,
      liabilities_errors: liabilityErrors,
    },
  };
  // Keep this download so deleting a transaction can rebuild without the banks.
  try { await dataStore().set(RAW_KEY, JSON.stringify(raw)); } catch (e) { console.warn('raw cache skipped:', e.message); }
  const data = await publishFromRaw(raw);
  let alerts = null;
  try { alerts = await sendAlerts(data); console.log('alerts:', alerts); } catch (e) { console.warn('alerts failed:', e.message); }

  return { alerts, accounts_synced: allAccounts.length, transactions_synced: allTransactions.length, generated_at: data.generated_at };
}

module.exports = { connectBlobs, plaid, Products, CountryCode, getTokens, saveToken, buildDataJson, dataStore, dedupeCrossItemTxns, buildCashflow, applyHidden, txnFingerprint, slimTxn, rebuildFromCache, setHidden, buildCards, sendAlerts, ntfy };

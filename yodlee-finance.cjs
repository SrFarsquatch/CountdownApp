'use strict';

const fs = require('fs');
const path = require('path');

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function money(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const amount = Number(value.amount ?? value.value ?? value);
  return Number.isFinite(amount) ? amount : null;
}
function currency(value, fallback = 'CAD') {
  return clean(value?.currency || value?.currencyCode || fallback, 10).toUpperCase() || fallback;
}
function yodleeBase(env) {
  return clean(env.YODLEE_API_URL || 'https://sandbox.api.yodlee.com/ysl', 500).replace(/\/$/, '');
}
function yodleeEnvironment(env) {
  const base = yodleeBase(env).toLowerCase();
  if (base.includes('sandbox')) return 'sandbox';
  if (base.includes('development')) return 'development';
  return 'production';
}
function configured(env) {
  return Boolean(env.YODLEE_CLIENT_ID && env.YODLEE_SECRET && env.YODLEE_FASTLINK_URL && env.YODLEE_FASTLINK_CONFIG_NAME);
}
function providerStatus(value) {
  const status = clean(value, 80).toUpperCase();
  if (status === 'USER_INPUT_REQUIRED') return 'user_action_required';
  if (status === 'LOGIN_IN_PROGRESS' || status === 'IN_PROGRESS') return 'syncing';
  if (status === 'FAILED') return 'error';
  if (status === 'PARTIAL_SUCCESS') return 'connected';
  return 'connected';
}
function categoryKey(value, categoryType = '') {
  const type = clean(categoryType, 80).toUpperCase();
  if (type === 'INCOME') return 'INCOME';
  if (type === 'TRANSFER') return 'TRANSFER_OUT';
  if (type === 'LOAN') return 'LOAN_PAYMENTS';
  return clean(value || 'OTHER', 100).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'OTHER';
}
function transactionName(tx) {
  return clean(tx?.merchant?.name || tx?.description?.simple || tx?.description?.original || tx?.description || tx?.category || 'Transaction', 220);
}
function accountMask(account) {
  const raw = clean(account?.accountNumber || account?.displayedName || '', 80);
  return raw ? raw.replace(/\D/g, '').slice(-4) : '';
}
function normalizeDb(source = {}) {
  return {
    connections: Array.isArray(source.connections) ? source.connections : [],
    accounts: Array.isArray(source.accounts) ? source.accounts : [],
    transactions: Array.isArray(source.transactions) ? source.transactions : []
  };
}

async function responseJson(response) {
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(clean(data?.errorMessage || data?.error?.message || raw || ('Yodlee request failed (' + response.status + ').'), 350));
    error.status = response.status;
    error.yodleeCode = clean(data?.errorCode || data?.error?.errorCode, 80);
    throw error;
  }
  return data;
}
async function userToken(env, loginName) {
  if (!configured(env)) {
    const error = new Error('Yodlee is not configured.');
    error.status = 503;
    throw error;
  }
  const body = new URLSearchParams({ clientId: env.YODLEE_CLIENT_ID, secret: env.YODLEE_SECRET });
  const response = await fetch(yodleeBase(env) + '/auth/token', {
    method: 'POST',
    headers: {
      'Api-Version': '1.1',
      'Content-Type': 'application/x-www-form-urlencoded',
      loginName
    },
    body
  });
  const data = await responseJson(response);
  const token = clean(data?.token?.accessToken, 4000);
  if (!token) throw new Error('Yodlee did not return a user access token.');
  return token;
}
async function yodleeGet(env, token, endpoint) {
  const response = await fetch(yodleeBase(env) + endpoint, {
    headers: { 'Api-Version': '1.1', Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  return responseJson(response);
}
function mapAccount(account) {
  const id = clean(account?.id, 120);
  const providerAccountId = clean(account?.providerAccountId, 120);
  const balance = money(account?.balance ?? account?.currentBalance ?? account?.totalBalance);
  const available = money(account?.availableBalance ?? account?.availableCredit);
  return {
    accountId: 'yodlee:' + id,
    itemId: 'yodlee:' + providerAccountId,
    name: clean(account?.accountName || account?.name || account?.accountType || 'Account', 180),
    officialName: clean(account?.accountName || '', 180),
    mask: accountMask(account),
    type: clean(account?.container || 'bank', 80).toLowerCase(),
    subtype: clean(account?.accountType || '', 100).toLowerCase(),
    currency: currency(account?.balance || account?.currentBalance || account?.availableBalance),
    currentBalance: balance,
    availableBalance: available,
    creditLimit: money(account?.creditLimit),
    updatedAt: clean(account?.lastUpdated || account?.lastRefreshed, 80) || new Date().toISOString()
  };
}
function mapTransaction(tx, accountMap) {
  const rawId = clean(tx?.id, 160);
  const rawAccountId = clean(tx?.accountId, 120);
  const account = accountMap.get(rawAccountId);
  const base = clean(tx?.baseType, 20).toUpperCase();
  const rawAmount = money(tx?.amount) || 0;
  const signedAmount = base === 'CREDIT' ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  const date = clean(tx?.transactionDate || tx?.date || tx?.postDate, 30).slice(0, 10);
  return {
    transactionId: 'yodlee:' + rawId,
    itemId: account?.itemId || '',
    accountId: 'yodlee:' + rawAccountId,
    name: transactionName(tx),
    merchantName: clean(tx?.merchant?.name || '', 180),
    amount: signedAmount,
    currency: currency(tx?.amount, account?.currency || 'CAD'),
    date,
    authorizedDate: clean(tx?.transactionDate || '', 30).slice(0, 10),
    pending: clean(tx?.status, 30).toUpperCase() === 'PENDING',
    categoryPrimary: categoryKey(tx?.category, tx?.categoryType),
    categoryDetailed: clean(tx?.category || '', 140),
    paymentChannel: clean(tx?.merchantType || tx?.type || '', 80).toLowerCase(),
    website: clean(tx?.merchant?.website || '', 300),
    logoUrl: ''
  };
}

module.exports = function createYodleeFinance(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || '/data';
  const loginName = clean(options.loginName || env.YODLEE_LOGIN_NAME || 'questlog_selfhosted', 150).replace(/\s+/g, '_');
  const filePath = path.join(dataDir, 'finance-yodlee.json');

  function load() {
    try { return normalizeDb(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { return normalizeDb(); }
  }
  function save(db) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = filePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(normalizeDb(db), null, 2));
    fs.renameSync(temp, filePath);
  }
  async function syncData() {
    if (!configured(env)) return [];
    const token = await userToken(env, loginName);
    const fromDate = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const toDate = new Date().toISOString().slice(0, 10);
    const [providerData, accountData] = await Promise.all([
      yodleeGet(env, token, '/providerAccounts'),
      yodleeGet(env, token, '/accounts')
    ]);
    const rawAccounts = Array.isArray(accountData?.account) ? accountData.account : [];
    const accountMap = new Map(rawAccounts.map(a => [clean(a?.id, 120), mapAccount(a)]));
    const txs = [];
    for (let skip = 0; skip < 1500; skip += 500) {
      const page = await yodleeGet(env, token, '/transactions?fromDate=' + encodeURIComponent(fromDate) + '&toDate=' + encodeURIComponent(toDate) + '&top=500&skip=' + skip);
      const rows = Array.isArray(page?.transaction) ? page.transaction : [];
      txs.push(...rows);
      if (rows.length < 500) break;
    }
    const old = load();
    const byId = new Map(old.connections.map(x => [x.providerAccountId, x]));
    const providers = Array.isArray(providerData?.providerAccount) ? providerData.providerAccount : [];
    const now = new Date().toISOString();
    for (const p of providers) {
      const providerAccountId = clean(p?.id, 120);
      if (!providerAccountId) continue;
      const previous = byId.get(providerAccountId) || {};
      const rawStatus = clean(p?.status || p?.refreshInfo?.status, 80);
      const datasetError = Array.isArray(p?.dataset) ? p.dataset.map(x => x?.additionalStatus).filter(Boolean).join(', ') : '';
      byId.set(providerAccountId, {
        ...previous,
        providerAccountId,
        itemId: 'yodlee:' + providerAccountId,
        institutionId: clean(p?.providerId, 120),
        institutionName: clean(p?.providerName || previous.institutionName || 'Yodlee connection', 180),
        status: providerStatus(rawStatus),
        error: rawStatus.toUpperCase() === 'FAILED' ? clean(datasetError || p?.additionalStatusErrorCode || 'Yodlee could not refresh this connection.', 300) : '',
        lastSyncedAt: clean(p?.lastUpdated || p?.lastUpdateAttempt || p?.refreshInfo?.lastRefreshed, 80) || now,
        connectedAt: previous.connectedAt || clean(p?.createdDate, 80) || now
      });
    }
    const db = {
      connections: [...byId.values()],
      accounts: [...accountMap.values()],
      transactions: txs.map(tx => mapTransaction(tx, accountMap)).filter(x => x.transactionId !== 'yodlee:')
    };
    save(db);
    return [];
  }

  return {
    configured: () => configured(env),
    environment: () => yodleeEnvironment(env),
    async start(itemId = '') {
      if (!configured(env)) {
        const error = new Error('Yodlee is not configured for Quest Log.');
        error.status = 503;
        throw error;
      }
      const token = await userToken(env, loginName);
      const providerAccountId = clean(itemId, 160).replace(/^yodlee:/, '');
      return {
        provider: 'yodlee',
        launch: 'yodlee',
        fastLinkURL: clean(env.YODLEE_FASTLINK_URL, 500),
        accessToken: 'Bearer ' + token,
        params: {
          configName: clean(env.YODLEE_FASTLINK_CONFIG_NAME, 160),
          ...(providerAccountId ? { providerAccountId: Number(providerAccountId) || providerAccountId, flow: 'refresh' } : {})
        }
      };
    },
    async complete() {
      await syncData();
      return this.summary(false);
    },
    async sync() {
      try { return await syncData(); }
      catch (error) { return [{ provider: 'yodlee', error: clean(error.message, 300) }]; }
    },
    async disconnect(itemId) {
      const id = clean(itemId, 160).replace(/^yodlee:/, '');
      const db = load();
      db.connections = db.connections.filter(x => x.providerAccountId !== id);
      db.accounts = db.accounts.filter(x => x.itemId !== 'yodlee:' + id);
      db.transactions = db.transactions.filter(x => x.itemId !== 'yodlee:' + id);
      save(db);
      return { ok: true };
    },
    async summary(sync = true) {
      const errors = configured(env) && sync ? await this.sync() : [];
      const db = load();
      const connections = db.connections.map(x => ({ ...x, provider: 'yodlee', providerName: 'Yodlee' }));
      return {
        configured: configured(env),
        provider: 'Yodlee',
        environment: yodleeEnvironment(env),
        connections,
        accounts: db.accounts.map(x => ({ ...x, provider: 'yodlee' })),
        transactions: db.transactions.map(x => ({ ...x, provider: 'yodlee' })).sort((a,b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0,1500),
        errors,
        lastSyncedAt: connections.map(x => x.lastSyncedAt).filter(Boolean).sort().at(-1) || null
      };
    }
  };
};

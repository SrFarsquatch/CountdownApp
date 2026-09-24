const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}
function plaidEnvironment(env) {
  return String(env.PLAID_ENV || 'sandbox').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
}
function plaidHost(env) {
  return plaidEnvironment(env) === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}
function countryCodes(env) {
  const values = String(env.PLAID_COUNTRY_CODES || 'CA').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  return values.length ? [...new Set(values)].slice(0, 8) : ['CA'];
}
function configured(env) {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.APP_SECRET);
}
function key(env) {
  return env.APP_SECRET ? crypto.createHash('sha256').update(String(env.APP_SECRET)).digest() : null;
}
function encrypt(value, env) {
  const k = key(env);
  if (!k) throw new Error('APP_SECRET is required before Plaid can store bank connections.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  return 'plaid1.' + [iv, cipher.getAuthTag(), data].map(x => x.toString('base64url')).join('.');
}
function decrypt(value, env) {
  const k = key(env);
  if (!k || !value || !String(value).startsWith('plaid1.')) return '';
  try {
    const [, i, t, d] = String(value).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(i, 'base64url'));
    decipher.setAuthTag(Buffer.from(t, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(d, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
async function plaidRequest(env, endpoint, payload = {}) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    const error = new Error('Plaid is not configured.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(plaidHost(env) + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...payload })
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok || data?.error_code) {
    const error = new Error(cleanText(data?.error_message || data?.display_message || raw || ('Plaid request failed (' + response.status + ').'), 300));
    error.status = response.status >= 400 ? response.status : 502;
    error.plaidCode = cleanText(data?.error_code, 80);
    throw error;
  }
  return data;
}
function clientUserId() {
  return 'questlog-' + crypto.createHash('sha256').update('self-hosted').digest('hex').slice(0, 40);
}
function normalizeDb(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    connections: Array.isArray(source.connections) ? source.connections : [],
    accounts: Array.isArray(source.accounts) ? source.accounts : [],
    transactions: Array.isArray(source.transactions) ? source.transactions : [],
    preferences: {
      monthlySpendingTarget: Number.isFinite(Number(source.preferences?.monthlySpendingTarget)) && Number(source.preferences.monthlySpendingTarget) > 0
        ? Number(source.preferences.monthlySpendingTarget)
        : null
    }
  };
}
function mapAccount(account, itemId) {
  const balances = account?.balances || {};
  return {
    accountId: cleanText(account?.account_id, 200),
    itemId,
    name: cleanText(account?.name, 160),
    officialName: cleanText(account?.official_name, 200),
    mask: cleanText(account?.mask, 20),
    type: cleanText(account?.type, 60),
    subtype: cleanText(account?.subtype, 80),
    currency: cleanText(balances?.iso_currency_code || balances?.unofficial_currency_code || '', 12).toUpperCase(),
    currentBalance: Number.isFinite(Number(balances?.current)) ? Number(balances.current) : null,
    availableBalance: Number.isFinite(Number(balances?.available)) ? Number(balances.available) : null,
    creditLimit: Number.isFinite(Number(balances?.limit)) ? Number(balances.limit) : null,
    updatedAt: new Date().toISOString()
  };
}
function mapTransaction(transaction, itemId) {
  const category = transaction?.personal_finance_category || {};
  return {
    transactionId: cleanText(transaction?.transaction_id, 200),
    itemId,
    accountId: cleanText(transaction?.account_id, 200),
    name: cleanText(transaction?.name, 240),
    merchantName: cleanText(transaction?.merchant_name, 200),
    amount: Number.isFinite(Number(transaction?.amount)) ? Number(transaction.amount) : 0,
    currency: cleanText(transaction?.iso_currency_code || transaction?.unofficial_currency_code || '', 12).toUpperCase(),
    date: cleanText(transaction?.date, 20),
    authorizedDate: cleanText(transaction?.authorized_date, 20),
    pending: Boolean(transaction?.pending),
    categoryPrimary: cleanText(category?.primary, 100),
    categoryDetailed: cleanText(category?.detailed, 140),
    paymentChannel: cleanText(transaction?.payment_channel, 60),
    website: cleanText(transaction?.website, 300),
    logoUrl: cleanText(transaction?.logo_url, 500),
    updatedAt: new Date().toISOString()
  };
}
module.exports = function createPlaidFinance(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || env.DATA_DIR || '/data';
  const filePath = path.join(dataDir, 'finance-data.json');
  const syncStaleMs = 15 * 60 * 1000;

  function load() {
    try { return normalizeDb(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { return normalizeDb({}); }
  }
  function save(db) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = filePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(normalizeDb(db), null, 2));
    fs.renameSync(temp, filePath);
  }
  async function institutionName(institutionId, fallback = '') {
    if (!institutionId) return cleanText(fallback, 160);
    try {
      const result = await plaidRequest(env, '/institutions/get_by_id', {
        institution_id: institutionId,
        country_codes: countryCodes(env),
        options: { include_optional_metadata: false }
      });
      return cleanText(result?.institution?.name || fallback, 160);
    } catch {
      return cleanText(fallback, 160);
    }
  }
  async function syncConnection(db, connection, force = false) {
    const lastSynced = connection.lastSyncedAt ? new Date(connection.lastSyncedAt).getTime() : 0;
    if (!force && lastSynced && Date.now() - lastSynced < syncStaleMs) return;
    const accessToken = decrypt(connection.accessToken, env);
    if (!accessToken) throw new Error('The saved Plaid connection could not be decrypted.');

    try {
      const accounts = await plaidRequest(env, '/accounts/get', { access_token: accessToken });
      for (const account of (accounts.accounts || []).map(x => mapAccount(x, connection.itemId))) {
        const index = db.accounts.findIndex(x => x.accountId === account.accountId);
        if (index >= 0) db.accounts[index] = account;
        else db.accounts.push(account);
      }

      const originalCursor = connection.cursor || null;
      let cursor = originalCursor;
      let hasMore = true;
      let restarts = 0;
      while (hasMore) {
        try {
          const page = await plaidRequest(env, '/transactions/sync', {
            access_token: accessToken,
            ...(cursor ? { cursor } : {}),
            count: 500
          });
          for (const raw of [...(page.added || []), ...(page.modified || [])]) {
            const transaction = mapTransaction(raw, connection.itemId);
            const index = db.transactions.findIndex(x => x.transactionId === transaction.transactionId);
            if (index >= 0) db.transactions[index] = transaction;
            else db.transactions.push(transaction);
          }
          for (const removed of page.removed || []) {
            db.transactions = db.transactions.filter(x => x.transactionId !== removed?.transaction_id);
          }
          cursor = page.next_cursor || cursor;
          hasMore = Boolean(page.has_more);
        } catch (error) {
          if (error.plaidCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && restarts < 1) {
            cursor = originalCursor;
            hasMore = true;
            restarts++;
            continue;
          }
          throw error;
        }
      }
      connection.cursor = cursor || null;
      connection.status = 'connected';
      connection.error = '';
      connection.lastSyncedAt = new Date().toISOString();
      connection.updatedAt = new Date().toISOString();
      save(db);
    } catch (error) {
      connection.status = 'error';
      connection.error = cleanText(error.message, 300);
      connection.updatedAt = new Date().toISOString();
      save(db);
      throw error;
    }
  }

  return {
    configured: () => configured(env),
    async linkToken() {
      if (!configured(env)) {
        const error = new Error('Plaid is not configured for Quest Log.');
        error.status = 503;
        throw error;
      }
      const result = await plaidRequest(env, '/link/token/create', {
        user: { client_user_id: clientUserId() },
        client_name: 'Quest Log',
        products: ['transactions'],
        country_codes: countryCodes(env),
        language: 'en'
      });
      return { linkToken: result.link_token, expiration: result.expiration, environment: plaidEnvironment(env) };
    },
    async exchange(publicToken, metadata = {}) {
      if (!configured(env)) {
        const error = new Error('Plaid is not configured for Quest Log.');
        error.status = 503;
        throw error;
      }
      const token = cleanText(publicToken, 1000);
      if (!token) {
        const error = new Error('Plaid public token is required.');
        error.status = 400;
        throw error;
      }
      const exchanged = await plaidRequest(env, '/item/public_token/exchange', { public_token: token });
      const item = await plaidRequest(env, '/item/get', { access_token: exchanged.access_token }).catch(() => ({ item: {} }));
      const institutionId = cleanText(item?.item?.institution_id || metadata?.institution?.institution_id || metadata?.institution_id, 160);
      const fallbackName = metadata?.institution?.name || metadata?.institution_name || 'Bank connection';
      const name = await institutionName(institutionId, fallbackName);
      const db = load();
      let connection = db.connections.find(x => x.itemId === exchanged.item_id);
      if (!connection) {
        connection = { itemId: exchanged.item_id, connectedAt: new Date().toISOString() };
        db.connections.push(connection);
      }
      connection.accessToken = encrypt(exchanged.access_token, env);
      connection.institutionId = institutionId;
      connection.institutionName = name;
      connection.status = 'connected';
      connection.error = '';
      connection.updatedAt = new Date().toISOString();
      save(db);
      await syncConnection(db, connection, true);
      return this.summary(false);
    },
    async sync(force = false) {
      const db = load();
      const errors = [];
      for (const connection of db.connections) {
        try { await syncConnection(db, connection, force); }
        catch (error) { errors.push({ itemId: connection.itemId, error: cleanText(error.message, 300) }); }
      }
      return errors;
    },
    async disconnect(itemId) {
      const id = cleanText(itemId, 200);
      const db = load();
      const connection = db.connections.find(x => x.itemId === id);
      if (!connection) {
        const error = new Error('Bank connection was not found.');
        error.status = 404;
        throw error;
      }
      const accessToken = decrypt(connection.accessToken, env);
      if (accessToken) await plaidRequest(env, '/item/remove', { access_token: accessToken }).catch(() => null);
      db.connections = db.connections.filter(x => x.itemId !== id);
      db.accounts = db.accounts.filter(x => x.itemId !== id);
      db.transactions = db.transactions.filter(x => x.itemId !== id);
      save(db);
      return { ok: true };
    },
    async savePreferences(payload = {}) {
      const db = load();
      const raw = payload.monthlySpendingTarget;
      const parsed = raw === '' || raw === null || raw === undefined ? null : Number(raw);
      if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000000)) {
        const error = new Error('Monthly spending target must be a positive number.');
        error.status = 400;
        throw error;
      }
      db.preferences = { monthlySpendingTarget: parsed && parsed > 0 ? parsed : null };
      save(db);
      return this.summary(false);
    },
    async summary(sync = true) {
      const db = load();
      const errors = configured(env) && sync ? await this.sync(false) : [];
      const fresh = load();
      const connections = fresh.connections.map(x => ({
        itemId: x.itemId,
        institutionId: x.institutionId || '',
        institutionName: x.institutionName || 'Bank connection',
        status: x.status || 'connected',
        error: x.error || '',
        lastSyncedAt: x.lastSyncedAt || null,
        connectedAt: x.connectedAt || null
      }));
      return {
        configured: configured(env),
        provider: 'Plaid',
        environment: plaidEnvironment(env),
        connections,
        accounts: [...fresh.accounts].sort((a, b) => (a.type || '').localeCompare(b.type || '') || (a.name || '').localeCompare(b.name || '')),
        transactions: [...fresh.transactions]
          .filter(x => !x.date || new Date(x.date + 'T12:00:00').getTime() >= Date.now() - 400 * 86400000)
          .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
          .slice(0, 1500),
        preferences: { monthlySpendingTarget: fresh.preferences?.monthlySpendingTarget ?? null },
        errors,
        lastSyncedAt: connections.map(x => x.lastSyncedAt).filter(Boolean).sort().at(-1) || null
      };
    }
  };
};

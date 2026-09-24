import { cleanText } from './state.js';
import { resolveQuestLogUser } from './users.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const DEFAULT_COUNTRIES = ['CA'];
const SYNC_STALE_MS = 15 * 60 * 1000;

function b64u(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(value) {
  const input = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(input + '='.repeat((4 - input.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(value || ''))));
}
async function appKey(env) {
  if (!env.APP_SECRET) throw new Error('APP_SECRET is not configured on the Worker.');
  return crypto.subtle.importKey('raw', await sha256(env.APP_SECRET), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptAccessToken(value, env) {
  const key = await appKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(value || '')));
  return 'plaid1.' + b64u(iv) + '.' + b64u(new Uint8Array(data));
}
async function decryptAccessToken(value, env) {
  if (!value || !String(value).startsWith('plaid1.')) return '';
  try {
    const [, iv, data] = String(value).split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(iv) }, await appKey(env), fromB64u(data));
    return dec.decode(plain);
  } catch {
    return '';
  }
}
function plaidHost(env) {
  const mode = String(env.PLAID_ENV || 'sandbox').trim().toLowerCase();
  return mode === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}
function plaidEnvironment(env) {
  return String(env.PLAID_ENV || 'sandbox').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
}
function countryCodes(env) {
  const values = String(env.PLAID_COUNTRY_CODES || 'CA').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  return values.length ? [...new Set(values)].slice(0, 8) : DEFAULT_COUNTRIES;
}
export function plaidConfigured(env) {
  return Boolean(env.DB && env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.APP_SECRET);
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
async function financeUserKey(identity, env) {
  const user = await resolveQuestLogUser(env, identity);
  return user.userId;
}
async function clientUserId(identity, env) {
  const user = await resolveQuestLogUser(env, identity);
  return 'questlog-' + user.userId;
}
async function ensureFinanceSchema(env) {
  if (!env.DB) throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS finance_connections (
      user_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      institution_id TEXT,
      institution_name TEXT,
      cursor TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      last_error TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_key, item_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS finance_accounts (
      user_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      name TEXT,
      official_name TEXT,
      mask TEXT,
      type TEXT,
      subtype TEXT,
      currency TEXT,
      current_balance REAL,
      available_balance REAL,
      credit_limit REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_key, account_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS finance_transactions (
      user_key TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      name TEXT,
      merchant_name TEXT,
      amount REAL,
      currency TEXT,
      date TEXT,
      authorized_date TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      category_primary TEXT,
      category_detailed TEXT,
      payment_channel TEXT,
      website TEXT,
      logo_url TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_key, transaction_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS finance_preferences (
      user_key TEXT PRIMARY KEY,
      monthly_spending_target REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_accounts_user ON finance_accounts(user_key)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_transactions_user_date ON finance_transactions(user_key, date DESC)').run();
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
    creditLimit: Number.isFinite(Number(balances?.limit)) ? Number(balances.limit) : null
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
    logoUrl: cleanText(transaction?.logo_url, 500)
  };
}
async function writeAccounts(env, userKey, itemId, accounts) {
  const rows = (accounts || []).map(account => mapAccount(account, itemId)).filter(row => row.accountId);
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 50) {
    const statements = rows.slice(i, i + 50).map(row => env.DB.prepare(`
      INSERT INTO finance_accounts(
        user_key,account_id,item_id,name,official_name,mask,type,subtype,currency,current_balance,available_balance,credit_limit,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(user_key,account_id) DO UPDATE SET
        item_id=excluded.item_id,name=excluded.name,official_name=excluded.official_name,mask=excluded.mask,
        type=excluded.type,subtype=excluded.subtype,currency=excluded.currency,current_balance=excluded.current_balance,
        available_balance=excluded.available_balance,credit_limit=excluded.credit_limit,updated_at=datetime('now')
    `).bind(
      userKey, row.accountId, itemId, row.name, row.officialName, row.mask, row.type, row.subtype,
      row.currency, row.currentBalance, row.availableBalance, row.creditLimit
    ));
    await env.DB.batch(statements);
  }
}
async function writeTransactions(env, userKey, itemId, transactions) {
  const rows = (transactions || []).map(transaction => mapTransaction(transaction, itemId)).filter(row => row.transactionId && row.accountId);
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 50) {
    const statements = rows.slice(i, i + 50).map(row => env.DB.prepare(`
      INSERT INTO finance_transactions(
        user_key,transaction_id,item_id,account_id,name,merchant_name,amount,currency,date,authorized_date,pending,
        category_primary,category_detailed,payment_channel,website,logo_url,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(user_key,transaction_id) DO UPDATE SET
        item_id=excluded.item_id,account_id=excluded.account_id,name=excluded.name,merchant_name=excluded.merchant_name,
        amount=excluded.amount,currency=excluded.currency,date=excluded.date,authorized_date=excluded.authorized_date,
        pending=excluded.pending,category_primary=excluded.category_primary,category_detailed=excluded.category_detailed,
        payment_channel=excluded.payment_channel,website=excluded.website,logo_url=excluded.logo_url,updated_at=datetime('now')
    `).bind(
      userKey, row.transactionId, itemId, row.accountId, row.name, row.merchantName, row.amount, row.currency,
      row.date, row.authorizedDate, row.pending ? 1 : 0, row.categoryPrimary, row.categoryDetailed,
      row.paymentChannel, row.website, row.logoUrl
    ));
    await env.DB.batch(statements);
  }
}
async function removeTransactions(env, userKey, removed) {
  const ids = (removed || []).map(row => cleanText(row?.transaction_id, 200)).filter(Boolean);
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 50) {
    await env.DB.batch(ids.slice(i, i + 50).map(id => env.DB.prepare(
      'DELETE FROM finance_transactions WHERE user_key=? AND transaction_id=?'
    ).bind(userKey, id)));
  }
}
async function connectionRow(env, userKey, itemId) {
  return env.DB.prepare('SELECT * FROM finance_connections WHERE user_key=? AND item_id=?').bind(userKey, itemId).first();
}
async function syncConnection(env, userKey, row, force = false) {
  if (!row) return;
  const lastSynced = row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0;
  if (!force && lastSynced && Date.now() - lastSynced < SYNC_STALE_MS) return;
  const accessToken = await decryptAccessToken(row.access_token, env);
  if (!accessToken) throw new Error('The saved Plaid connection could not be decrypted.');

  try {
    const accounts = await plaidRequest(env, '/accounts/get', { access_token: accessToken });
    await writeAccounts(env, userKey, row.item_id, accounts.accounts || []);

    const originalCursor = row.cursor || null;
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
        await writeTransactions(env, userKey, row.item_id, page.added || []);
        await writeTransactions(env, userKey, row.item_id, page.modified || []);
        await removeTransactions(env, userKey, page.removed || []);
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
    await env.DB.prepare(`
      UPDATE finance_connections
      SET cursor=?,status='connected',last_error=NULL,last_synced_at=datetime('now'),updated_at=datetime('now')
      WHERE user_key=? AND item_id=?
    `).bind(cursor || null, userKey, row.item_id).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE finance_connections SET status='error',last_error=?,updated_at=datetime('now')
      WHERE user_key=? AND item_id=?
    `).bind(cleanText(error.message, 300), userKey, row.item_id).run();
    throw error;
  }
}
async function institutionName(env, institutionId, fallback = '') {
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
export async function createFinanceLinkToken(env, identity) {
  if (!plaidConfigured(env)) {
    const error = new Error('Plaid is not configured for Quest Log.');
    error.status = 503;
    throw error;
  }
  const result = await plaidRequest(env, '/link/token/create', {
    user: { client_user_id: await clientUserId(identity, env) },
    client_name: 'Quest Log',
    products: ['transactions'],
    country_codes: countryCodes(env),
    language: 'en'
  });
  return {
    linkToken: result.link_token,
    expiration: result.expiration,
    environment: plaidEnvironment(env)
  };
}
export async function exchangeFinancePublicToken(env, identity, publicToken, metadata = {}) {
  if (!plaidConfigured(env)) {
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
  await ensureFinanceSchema(env);
  const userKey = await financeUserKey(identity, env);
  const exchanged = await plaidRequest(env, '/item/public_token/exchange', { public_token: token });
  const item = await plaidRequest(env, '/item/get', { access_token: exchanged.access_token }).catch(() => ({ item: {} }));
  const institutionId = cleanText(item?.item?.institution_id || metadata?.institution?.institution_id || metadata?.institution_id, 160);
  const fallbackName = metadata?.institution?.name || metadata?.institution_name || 'Bank connection';
  const name = await institutionName(env, institutionId, fallbackName);
  const encrypted = await encryptAccessToken(exchanged.access_token, env);

  await env.DB.prepare(`
    INSERT INTO finance_connections(
      user_key,item_id,access_token,institution_id,institution_name,cursor,status,last_error,last_synced_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,NULL,'connected',NULL,NULL,datetime('now'),datetime('now'))
    ON CONFLICT(user_key,item_id) DO UPDATE SET
      access_token=excluded.access_token,institution_id=excluded.institution_id,institution_name=excluded.institution_name,
      status='connected',last_error=NULL,updated_at=datetime('now')
  `).bind(userKey, exchanged.item_id, encrypted, institutionId, name).run();

  await syncConnection(env, userKey, await connectionRow(env, userKey, exchanged.item_id), true);
  return financeSummary(env, identity, { sync: false });
}
export async function syncFinance(env, identity, { force = false } = {}) {
  await ensureFinanceSchema(env);
  const userKey = await financeUserKey(identity, env);
  const result = await env.DB.prepare('SELECT * FROM finance_connections WHERE user_key=? ORDER BY created_at').bind(userKey).all();
  const errors = [];
  for (const row of result.results || []) {
    try { await syncConnection(env, userKey, row, force); }
    catch (error) { errors.push({ itemId: row.item_id, error: cleanText(error.message, 300) }); }
  }
  return errors;
}
export async function disconnectFinanceItem(env, identity, itemId) {
  await ensureFinanceSchema(env);
  const userKey = await financeUserKey(identity, env);
  const id = cleanText(itemId, 200);
  const row = await connectionRow(env, userKey, id);
  if (!row) {
    const error = new Error('Bank connection was not found.');
    error.status = 404;
    throw error;
  }
  const accessToken = await decryptAccessToken(row.access_token, env);
  if (accessToken) await plaidRequest(env, '/item/remove', { access_token: accessToken }).catch(() => null);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM finance_transactions WHERE user_key=? AND item_id=?').bind(userKey, id),
    env.DB.prepare('DELETE FROM finance_accounts WHERE user_key=? AND item_id=?').bind(userKey, id),
    env.DB.prepare('DELETE FROM finance_connections WHERE user_key=? AND item_id=?').bind(userKey, id)
  ]);
  return { ok: true };
}
export async function saveFinancePreferences(env, identity, payload = {}) {
  await ensureFinanceSchema(env);
  const userKey = await financeUserKey(identity, env);
  const raw = payload.monthlySpendingTarget;
  const parsed = raw === '' || raw === null || raw === undefined ? null : Number(raw);
  if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000000)) {
    const error = new Error('Monthly spending target must be a positive number.');
    error.status = 400;
    throw error;
  }
  const target = parsed && parsed > 0 ? parsed : null;
  await env.DB.prepare(`
    INSERT INTO finance_preferences(user_key,monthly_spending_target,updated_at)
    VALUES(?,?,datetime('now'))
    ON CONFLICT(user_key) DO UPDATE SET
      monthly_spending_target=excluded.monthly_spending_target,
      updated_at=datetime('now')
  `).bind(userKey, target).run();
  return financeSummary(env, identity, { sync: false });
}

export async function financeSummary(env, identity, { sync = true } = {}) {
  if (!env.DB) return { configured: false, provider: 'Plaid', environment: plaidEnvironment(env), connections: [], accounts: [], transactions: [], errors: ['D1 is not configured.'] };
  await ensureFinanceSchema(env);
  const userKey = await financeUserKey(identity, env);
  const errors = plaidConfigured(env) && sync ? await syncFinance(env, identity, { force: false }) : [];
  const [connectionsResult, accountsResult, transactionsResult, preferencesRow] = await Promise.all([
    env.DB.prepare(`
      SELECT item_id,institution_id,institution_name,status,last_error,last_synced_at,created_at
      FROM finance_connections WHERE user_key=? ORDER BY created_at
    `).bind(userKey).all(),
    env.DB.prepare(`
      SELECT account_id,item_id,name,official_name,mask,type,subtype,currency,current_balance,available_balance,credit_limit,updated_at
      FROM finance_accounts WHERE user_key=? ORDER BY type,name
    `).bind(userKey).all(),
    env.DB.prepare(`
      SELECT transaction_id,item_id,account_id,name,merchant_name,amount,currency,date,authorized_date,pending,
             category_primary,category_detailed,payment_channel,website,logo_url
      FROM finance_transactions
      WHERE user_key=? AND (date IS NULL OR date='' OR date>=date('now','-13 months'))
      ORDER BY date DESC, authorized_date DESC LIMIT 1500
    `).bind(userKey).all(),
    env.DB.prepare('SELECT monthly_spending_target,updated_at FROM finance_preferences WHERE user_key=?').bind(userKey).first()
  ]);
  const connections = (connectionsResult.results || []).map(row => ({
    itemId: row.item_id,
    institutionId: row.institution_id || '',
    institutionName: row.institution_name || 'Bank connection',
    status: row.status || 'connected',
    error: row.last_error || '',
    lastSyncedAt: row.last_synced_at || null,
    connectedAt: row.created_at || null
  }));
  const accounts = (accountsResult.results || []).map(row => ({
    accountId: row.account_id,
    itemId: row.item_id,
    name: row.name || '',
    officialName: row.official_name || '',
    mask: row.mask || '',
    type: row.type || '',
    subtype: row.subtype || '',
    currency: row.currency || '',
    currentBalance: row.current_balance,
    availableBalance: row.available_balance,
    creditLimit: row.credit_limit,
    updatedAt: row.updated_at || null
  }));
  const transactions = (transactionsResult.results || []).map(row => ({
    transactionId: row.transaction_id,
    itemId: row.item_id,
    accountId: row.account_id,
    name: row.name || '',
    merchantName: row.merchant_name || '',
    amount: row.amount,
    currency: row.currency || '',
    date: row.date || '',
    authorizedDate: row.authorized_date || '',
    pending: Boolean(row.pending),
    categoryPrimary: row.category_primary || '',
    categoryDetailed: row.category_detailed || '',
    paymentChannel: row.payment_channel || '',
    website: row.website || '',
    logoUrl: row.logo_url || ''
  }));
  return {
    configured: plaidConfigured(env),
    provider: 'Plaid',
    environment: plaidEnvironment(env),
    connections,
    accounts,
    transactions,
    preferences: {
      monthlySpendingTarget: preferencesRow?.monthly_spending_target == null ? null : Number(preferencesRow.monthly_spending_target),
      updatedAt: preferencesRow?.updated_at || null
    },
    errors,
    lastSyncedAt: connections.map(x => x.lastSyncedAt).filter(Boolean).sort().at(-1) || null
  };
}

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const logger = require('./logger');

let db;
const MAX_RETRIES = 5;
const RETRY_DELAY = 1000;

async function initializeDatabase(retries = MAX_RETRIES) {
  if (db) return db;

  try {
    await fs.mkdir(path.dirname(config.databasePath), { recursive: true });

    db = await open({
      filename: config.databasePath,
      driver: sqlite3.Database
    });

    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA busy_timeout = 5000;');

    await db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT,
        sender TEXT,
        sender_id TEXT,
        message TEXT,
        timestamp TEXT,
        quoted_participant TEXT,
        quoted_msg TEXT,
        image_id TEXT,
        audio_id TEXT,
        whatsapp_message_id TEXT,
        quoted_whatsapp_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        user_id TEXT PRIMARY KEY,
        tokens INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS group_info (
        group_id TEXT PRIMARY KEY,
        group_name TEXT,
        group_summary JSON,
        default_prompt_name TEXT DEFAULT 'default',
        last_processed_timestamp TEXT,
        google_search_enabled INTEGER DEFAULT 1,
        audio_enabled INTEGER DEFAULT 1,
        image_enabled INTEGER DEFAULT 1,
        ai_model TEXT DEFAULT '',
        authorization_check_enabled INTEGER DEFAULT 0,
        tts_enabled INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS add_requests (
        user_id TEXT PRIMARY KEY,
        user_name TEXT
      );

      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        whatsapp_name TEXT,
        custom_alias TEXT,
        first_seen_timestamp TEXT,
        last_seen_timestamp TEXT
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_group_timestamp
      ON conversations(group_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_message_id
      ON conversations(whatsapp_message_id);
    `);

    const migrations = [
      'ALTER TABLE group_info ADD COLUMN google_search_enabled INTEGER DEFAULT 1',
      'ALTER TABLE group_info ADD COLUMN audio_enabled INTEGER DEFAULT 1',
      'ALTER TABLE group_info ADD COLUMN image_enabled INTEGER DEFAULT 1',
      'ALTER TABLE conversations ADD COLUMN audio_id TEXT',
      "ALTER TABLE group_info ADD COLUMN ai_model TEXT DEFAULT ''",
      'ALTER TABLE group_info ADD COLUMN authorization_check_enabled INTEGER DEFAULT 0',
      'ALTER TABLE group_info ADD COLUMN tts_enabled INTEGER DEFAULT 1',
      'ALTER TABLE group_info ADD COLUMN custom_message_limit INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN background_processing_enabled INTEGER DEFAULT 0',
      'ALTER TABLE group_info ADD COLUMN background_debounce_ms INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN background_message_threshold INTEGER DEFAULT NULL',
      "ALTER TABLE group_info ADD COLUMN audio_history_mode TEXT DEFAULT 'tagged'",
      'ALTER TABLE group_info ADD COLUMN audio_history_count INTEGER DEFAULT 1',
      'ALTER TABLE group_info ADD COLUMN audio_duration_cap INTEGER DEFAULT 900',
      "ALTER TABLE group_info ADD COLUMN tts_voice TEXT DEFAULT NULL",
      "ALTER TABLE group_info ADD COLUMN tts_trigger_mode TEXT DEFAULT NULL",
      'ALTER TABLE group_info ADD COLUMN usage_reset_date TEXT DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_enabled INTEGER DEFAULT 0',
      'ALTER TABLE group_info ADD COLUMN active_listening_throttle_ms INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_context_count INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_prompt TEXT DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_send_audio INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_send_images INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_audio_count INTEGER DEFAULT NULL',
      'ALTER TABLE group_info ADD COLUMN active_listening_image_count INTEGER DEFAULT NULL',
      "ALTER TABLE group_info ADD COLUMN image_history_mode TEXT DEFAULT 'tagged'",
      'ALTER TABLE group_info ADD COLUMN image_history_count INTEGER DEFAULT 1',
      'ALTER TABLE users ADD COLUMN is_authorized INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'
    ];

    for (const migration of migrations) {
      try {
        await db.exec(migration);
      } catch (_) {
        // Existing installations already contain the column.
      }
    }

    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_unique_wmid ON conversations(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL');
    logger.info('DB', `Database initialized at ${config.databasePath}`);
    return db;
  } catch (error) {
    logger.error('DB', `Error initializing database: ${error.message}`);
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return initializeDatabase(retries - 1);
    }
    throw new Error('Failed to initialize database after multiple attempts');
  }
}

async function getDatabase() {
  if (!db) db = await initializeDatabase();
  return db;
}

async function closeDatabase() {
  if (db) {
    await db.close();
    db = null;
    logger.info('DB', 'Database connection closed');
  }
}

// --- Bot Settings ---
async function getBotSetting(key) {
  const database = await getDatabase();
  const row = await database.get('SELECT value FROM bot_settings WHERE key = ?', key);
  return row ? row.value : null;
}

async function setBotSetting(key, value) {
  const database = await getDatabase();
  await database.run('INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

async function getAllBotSettings() {
  const database = await getDatabase();
  const rows = await database.all('SELECT key, value FROM bot_settings');
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

async function getOrCreateGroupInfo(groupId, groupName) {
  const database = await getDatabase();
  let groupInfo = await database.get('SELECT * FROM group_info WHERE group_id = ?', groupId);

  if (!groupInfo) {
    const defaultSummary = JSON.stringify({ key_facts: '', recent_events: '' });
    const defaultPersona = await getBotSetting('default_persona') || 'default';
    const defaultModel = await getBotSetting('default_ai_model') || config.aiModel;
    const defaultSearch = parseInt(await getBotSetting('default_google_search') || '1', 10);
    const defaultAudio = parseInt(await getBotSetting('default_audio') || '1', 10);
    const defaultImage = parseInt(await getBotSetting('default_image') || '1', 10);
    const defaultTts = parseInt(await getBotSetting('default_tts') || '1', 10);
    const defaultAuth = parseInt(await getBotSetting('default_auth_check') || '0', 10);
    const defaultBg = parseInt(await getBotSetting('default_background_processing') || '0', 10);
    const mode = await getBotSetting('bot_activation_mode') || 'manual';

    await database.run(
      `INSERT INTO group_info (
        group_id, group_name, group_summary, default_prompt_name,
        google_search_enabled, audio_enabled, image_enabled, ai_model,
        authorization_check_enabled, tts_enabled, is_active,
        background_processing_enabled, active_listening_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        groupId, groupName, defaultSummary, defaultPersona,
        defaultSearch, defaultAudio, defaultImage, defaultModel,
        defaultAuth, defaultTts, defaultBg, mode === 'active_listening' ? 1 : 0
      ]
    );

    groupInfo = await database.get('SELECT * FROM group_info WHERE group_id = ?', groupId);
  }

  return groupInfo;
}

const ALLOWED_GROUP_COLUMNS = new Set([
  'group_name', 'group_summary', 'default_prompt_name', 'last_processed_timestamp',
  'google_search_enabled', 'audio_enabled', 'image_enabled', 'ai_model',
  'authorization_check_enabled', 'tts_enabled', 'is_active', 'custom_message_limit',
  'background_processing_enabled', 'background_debounce_ms',
  'background_message_threshold', 'audio_history_mode', 'audio_history_count',
  'audio_duration_cap', 'tts_trigger_mode', 'usage_reset_date',
  'active_listening_enabled', 'active_listening_throttle_ms',
  'active_listening_context_count', 'active_listening_prompt',
  'active_listening_send_audio', 'active_listening_send_images',
  'active_listening_audio_count', 'active_listening_image_count',
  'image_history_mode', 'image_history_count'
]);

async function updateGroupInfo(groupId, updateData) {
  const database = await getDatabase();
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(updateData)) {
    if (!ALLOWED_GROUP_COLUMNS.has(key)) continue;
    updates.push(`${key} = ?`);
    values.push(value);
  }

  if (!updates.length) return false;
  values.push(groupId);
  const result = await database.run(`UPDATE group_info SET ${updates.join(', ')} WHERE group_id = ?`, values);
  return result.changes > 0;
}

async function addAddRequest(userId, userName) {
  const database = await getDatabase();
  await database.run('INSERT OR REPLACE INTO add_requests (user_id, user_name) VALUES (?, ?)', [userId, userName]);
}
async function getAddRequests() { return (await getDatabase()).all('SELECT * FROM add_requests'); }
async function removeAddRequest(userId) { await (await getDatabase()).run('DELETE FROM add_requests WHERE user_id = ?', userId); }
async function clearAddRequests() { await (await getDatabase()).run('DELETE FROM add_requests'); }

function validateUserId(userId) {
  if (!/^\d+@(c\.us|lid|g\.us)$/.test(userId)) throw new Error(`Invalid user ID format: ${userId}`);
}

async function upsertUser(userId, whatsappName) {
  validateUserId(userId);
  const database = await getDatabase();
  const now = new Date().toISOString();
  const existing = await database.get('SELECT user_id FROM users WHERE user_id = ?', userId);
  if (existing) {
    await database.run('UPDATE users SET whatsapp_name = ?, last_seen_timestamp = ? WHERE user_id = ?', [whatsappName, now, userId]);
  } else {
    await database.run('INSERT INTO users (user_id, whatsapp_name, first_seen_timestamp, last_seen_timestamp) VALUES (?, ?, ?, ?)', [userId, whatsappName, now, now]);
  }
}

async function setCustomAlias(userId, alias) { await (await getDatabase()).run('UPDATE users SET custom_alias = ? WHERE user_id = ?', [alias, userId]); }
async function getUserAlias(userId) { const row = await (await getDatabase()).get('SELECT custom_alias, whatsapp_name FROM users WHERE user_id = ?', userId); return row ? row.custom_alias || row.whatsapp_name || userId : 'Unknown User'; }
async function getUserNameById(userId) { const row = await (await getDatabase()).get('SELECT custom_alias, whatsapp_name FROM users WHERE user_id = ?', userId); return row ? row.custom_alias || row.whatsapp_name : null; }
async function getAllGroupInfo() { return (await getDatabase()).all('SELECT * FROM group_info ORDER BY group_name'); }
async function getActiveGroups() { return (await getDatabase()).all('SELECT * FROM group_info WHERE is_active = 1 ORDER BY group_name'); }
async function getInactiveGroups() { return (await getDatabase()).all('SELECT * FROM group_info WHERE is_active = 0 ORDER BY group_name'); }
async function isUserAuthorized(userId) { const row = await (await getDatabase()).get('SELECT is_authorized FROM users WHERE user_id = ?', userId); return row?.is_authorized === 1; }
async function isUserAdmin(userId) { const row = await (await getDatabase()).get('SELECT is_admin FROM users WHERE user_id = ?', userId); return row?.is_admin === 1; }

async function setUserFlag(userId, column, value) {
  validateUserId(userId);
  const database = await getDatabase();
  const now = new Date().toISOString();
  const existing = await database.get('SELECT user_id FROM users WHERE user_id = ?', userId);
  if (existing) await database.run(`UPDATE users SET ${column} = ? WHERE user_id = ?`, [value ? 1 : 0, userId]);
  else await database.run(`INSERT INTO users (user_id, ${column}, first_seen_timestamp, last_seen_timestamp) VALUES (?, ?, ?, ?)`, [userId, value ? 1 : 0, now, now]);
}
async function setUserAuthorized(userId, value) { return setUserFlag(userId, 'is_authorized', value); }
async function setUserAdmin(userId, value) { return setUserFlag(userId, 'is_admin', value); }
async function getAuthorizedUserIds() { return (await getDatabase()).all('SELECT user_id FROM users WHERE is_authorized = 1').then(rows => rows.map(row => row.user_id)); }
async function getAdminUserIds() { return (await getDatabase()).all('SELECT user_id FROM users WHERE is_admin = 1').then(rows => rows.map(row => row.user_id)); }
function extractPhone(userId) { return userId.endsWith('@c.us') ? `+${userId.replace('@c.us', '')}` : null; }
async function getAuthorizedUsersWithNames() { return (await getDatabase()).all('SELECT user_id, whatsapp_name, custom_alias FROM users WHERE is_authorized = 1').then(rows => rows.map(row => ({ id: row.user_id, name: row.custom_alias || row.whatsapp_name, phone: extractPhone(row.user_id) }))); }
async function getAdminUsersWithNames() { return (await getDatabase()).all('SELECT user_id, whatsapp_name, custom_alias FROM users WHERE is_admin = 1').then(rows => rows.map(row => ({ id: row.user_id, name: row.custom_alias || row.whatsapp_name, phone: extractPhone(row.user_id) }))); }

async function importAuthFromFiles(authorizedFile, adminFile) {
  const database = await getDatabase();
  const hasAuth = await database.get('SELECT 1 FROM users WHERE is_authorized = 1 OR is_admin = 1');
  if (hasAuth) return { authorized: 0, admin: 0 };
  const now = new Date().toISOString();
  let authorized = 0;
  let admin = 0;
  async function readIds(file) { try { return (await fs.readFile(file, 'utf8')).split('\n').map(line => line.trim()).filter(Boolean); } catch { return []; } }
  for (const id of await readIds(authorizedFile)) { await setUserAuthorized(id, true); authorized++; }
  for (const id of await readIds(adminFile)) { await setUserAdmin(id, true); admin++; }
  return { authorized, admin };
}

async function getConversationMessages(groupId, limit = 100, offset = 0) { return (await getDatabase()).all('SELECT * FROM conversations WHERE group_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?', [groupId, limit, offset]); }
async function getConversationCount(groupId) { const row = await (await getDatabase()).get('SELECT COUNT(*) AS count FROM conversations WHERE group_id = ?', groupId); return row.count; }

module.exports = {
  getDatabase, closeDatabase, getBotSetting, setBotSetting, getAllBotSettings,
  getOrCreateGroupInfo, getAllGroupInfo, getActiveGroups, getInactiveGroups,
  updateGroupInfo, addAddRequest, getAddRequests, removeAddRequest, clearAddRequests,
  upsertUser, setCustomAlias, getUserAlias, getUserNameById, isUserAuthorized,
  isUserAdmin, setUserAuthorized, setUserAdmin, getAuthorizedUserIds, getAdminUserIds,
  getAuthorizedUsersWithNames, getAdminUsersWithNames, importAuthFromFiles,
  validateUserId, getConversationMessages, getConversationCount
};
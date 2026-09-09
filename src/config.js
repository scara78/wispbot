require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const logger = require('./logger');

function envInt(key, fallback) {
    const value = process.env[key];
    if (value === undefined) return fallback;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

const config = {
    botName: process.env.BOT_NAME || 'Wispbot',
    botNumber: process.env.BOT_NUMBER || '',
    botUserId: process.env.BOT_USER_ID || '',

    aiProvider: 'openai-compatible',
    aiBaseUrl: process.env.AI_BASE_URL || 'https://route.scara.ovh/v1',
    aiApiKey: process.env.AI_API_KEY || '',
    aiModel: process.env.AI_MODEL || '',

    messageHistoryLimit: envInt('MESSAGE_HISTORY_LIMIT', 20),
    extendedMessageHistoryLimit: envInt('EXTENDED_HISTORY_LIMIT', 80),
    extendedHistoryCode: '#$',

    ttsTrigger: process.env.TTS_TRIGGER || '$audio',
    ttsProvider: process.env.TTS_PROVIDER || 'dev',
    ttsModel: process.env.TTS_MODEL || 'gemini-2.5-pro-preview-tts',
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    vertexRegion: process.env.VERTEX_REGION || 'us-central1',

    dataDirectory: path.resolve(process.env.DATA_DIRECTORY || 'data'),
    imageDirectory: path.resolve(process.env.IMAGE_DIRECTORY || 'data/images'),
    audioDirectory: path.resolve(process.env.AUDIO_DIRECTORY || 'data/audio'),
    memoriesDirectory: path.resolve(process.env.MEMORIES_DIRECTORY || 'data/group_memories'),
    databasePath: path.resolve(process.env.DATABASE_PATH || 'data/database.sqlite'),

    cooldownPeriod: envInt('COOLDOWN_PERIOD_MS', 2000),
    batchTimeout: envInt('BATCH_TIMEOUT_MS', 2000),

    backgroundAiModel: process.env.BACKGROUND_AI_MODEL || '',
    backgroundDebounceMs: envInt('BACKGROUND_DEBOUNCE_MS', 300000),
    backgroundMessageThreshold: envInt('BACKGROUND_MESSAGE_THRESHOLD', 20),

    activeListeningAiModel: process.env.ACTIVE_LISTENING_AI_MODEL || '',
    activeListeningThrottleMs: envInt('ACTIVE_LISTENING_THROTTLE_MS', 10000),
    activeListeningContextCount: envInt('ACTIVE_LISTENING_CONTEXT_COUNT', 15),

    adminPort: envInt('ADMIN_PORT', 3000),
    adminHost: process.env.ADMIN_HOST || '0.0.0.0',
    adminBasePath: process.env.ADMIN_BASE_PATH || '',
    adminSessionSecret: process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

    communityPersonasRepo: process.env.COMMUNITY_PERSONAS_REPO || 'najibelmokhtari/wispbot-personas',
    communityPersonasToken: process.env.COMMUNITY_PERSONAS_TOKEN || '',

    authSessionPath: path.resolve(process.env.AUTH_SESSION_PATH || 'auth_session')
};

if (!config.aiApiKey) logger.warn('Config', 'AI_API_KEY is not configured.');
if (!config.aiModel) logger.warn('Config', 'AI_MODEL is not configured.');

module.exports = config;
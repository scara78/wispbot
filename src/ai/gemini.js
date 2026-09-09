const { prepareMessagesForClaude, replacePhoneNumbersWithUsernames } = require('../phone-number-replacer');
const { processMessageHistory } = require('../message-processor');
const { calculateCost } = require('../pricing-config');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

require('dotenv').config();

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

let AI_BASE_URL = process.env.AI_BASE_URL || 'https://route.scara.ovh/v1';
let AI_API_KEY = process.env.AI_API_KEY || '';
let AI_MODEL = process.env.AI_MODEL || '';

function normalizeBaseUrl(url) {
    return String(url || '').replace(/\/+$/, '');
}

function initializeAI({ baseUrl, apiKey, model } = {}) {
    AI_BASE_URL = normalizeBaseUrl(baseUrl || process.env.AI_BASE_URL || AI_BASE_URL);
    AI_API_KEY = apiKey !== undefined ? apiKey : (process.env.AI_API_KEY || AI_API_KEY);
    AI_MODEL = model || process.env.AI_MODEL || AI_MODEL;

    if (!AI_API_KEY) {
        logger.warn('AI', 'AI_API_KEY is missing — bot will not respond until configured.');
    } else if (!AI_MODEL) {
        logger.warn('AI', 'AI_MODEL is missing — configure a model before using the bot.');
    } else {
        logger.info('AI', `Initialized OpenAI-compatible client at ${AI_BASE_URL} using model ${AI_MODEL}`);
    }
}

function reinitializeAI(options = {}) {
    initializeAI(options);
}

function reinitializeGemini(apiKey) {
    reinitializeAI({ apiKey });
}

initializeAI();

function getConfigValue(config, key, fallback) {
    return config?.[key] || fallback;
}

async function readPromptFile(filename) {
    try {
        return await fs.readFile(filename, 'utf8');
    } catch (error) {
        logger.error('AI', `Error reading ${filename}: ${error.message}`);
        return '';
    }
}

async function encodeFile(filePath) {
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
}

async function getAudioData(config, audioId) {
    try {
        const files = await fs.readdir(config.audioDirectory);
        const audioFile = files.find(file => file.startsWith(audioId));
        if (!audioFile) return null;

        const ext = path.extname(audioFile).toLowerCase();
        const mimeType = ext === '.mp3'
            ? 'audio/mpeg'
            : ext === '.wav'
                ? 'audio/wav'
                : ext === '.m4a'
                    ? 'audio/mp4'
                    : 'audio/ogg';

        return {
            type: 'text',
            text: `Audio attachment ${audioId} is available locally (${mimeType}), but this OpenAI-compatible endpoint does not expose a standardized audio-input format. Use the audio marker and conversation context.`
        };
    } catch (error) {
        logger.warn('AI', `Audio ${audioId} unavailable: ${error.message}`);
        return null;
    }
}

function imagePart(data) {
    return {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${data}` }
    };
}

async function callOpenAICompatible(context, config, systemPrompt) {
    if (!AI_API_KEY) throw new Error('AI_API_KEY is not configured.');
    const modelName = getConfigValue(config, 'aiModel', AI_MODEL);
    if (!modelName) throw new Error('AI_MODEL is not configured.');

    const userPrefixPrompt = await readPromptFile(
        path.join('prompts', 'system', 'user_prefix_prompt.txt')
    );
    const formattedMessages = processMessageHistory(context.recentMessages || [], config);
    const preparedMessages = prepareMessagesForClaude(formattedMessages);

    let userMessage = `${userPrefixPrompt}\n\nGroup Name: ${context.groupName || ''}\n`;

    if (context.groupParticipants?.length) {
        const aliasCounts = new Map();
        for (const participant of context.groupParticipants) {
            const key = participant.alias.toLowerCase().trim();
            aliasCounts.set(key, (aliasCounts.get(key) || 0) + 1);
        }

        const aliasCounters = new Map();
        userMessage += '\nGroup Participants:\n';
        for (const participant of [...context.groupParticipants].sort((a, b) =>
            a.userId.localeCompare(b.userId)
        )) {
            const key = participant.alias.toLowerCase().trim();
            let displayName = participant.alias;
            if (aliasCounts.get(key) > 1) {
                const index = (aliasCounters.get(key) || 0) + 1;
                aliasCounters.set(key, index);
                displayName = `${participant.alias} #${index}`;
            }
            participant.alias = displayName;
            userMessage += `- ${displayName}\n`;
        }
    }

    if (context.groupCustomContext) {
        userMessage += `\nCustom Group Context:\n${context.groupCustomContext}\n`;
    }
    if (context.groupMemories) {
        userMessage += `\nGroup Memories:\n${context.groupMemories}\n`;
    }

    userMessage += `\nRecent messages:\n${preparedMessages}`;
    userMessage += `\n\nSystem Message: You are now responding to ${replacePhoneNumbersWithUsernames(context.senderId)}`;

    if (context.quotedImageId) {
        userMessage += `\nThe user refers to image ${context.quotedImageId}.`;
    }
    if (context.quotedAudioId) {
        userMessage += `\nThe user refers to audio ${context.quotedAudioId}.`;
    }
    if (context.currentImageId) {
        userMessage += `\nThe user attached image ${context.currentImageId}.`;
    }
    if (context.currentAudioId) {
        userMessage += `\nThe user attached audio ${context.currentAudioId}.`;
    }

    const content = [{ type: 'text', text: userMessage }];

    const attachImage = async (imageId) => {
        try {
            const imagePath = path.join(config.imageDirectory, `${imageId}.jpg`);
            content.push(imagePart(await encodeFile(imagePath)));
        } catch (error) {
            logger.warn('AI', `Image ${imageId} unavailable: ${error.message}`);
        }
    };

    if (context.imageEnabled && context.imageHistoryMode === 'history') {
        const ids = (context.recentMessages || [])
            .filter(message => message.imageId && message.imageId !== context.currentImageId)
            .map(message => message.imageId)
            .slice(-(context.imageHistoryCount || 1));
        for (const imageId of ids) await attachImage(imageId);
        if (context.currentImageId) await attachImage(context.currentImageId);
    } else if (context.imageEnabled) {
        if (context.quotedImageId) await attachImage(context.quotedImageId);
        if (context.currentImageId) await attachImage(context.currentImageId);
    }

    if (context.audioEnabled) {
        const ids = [];
        if (context.audioHistoryMode === 'history') {
            ids.push(...(context.recentMessages || [])
                .filter(message => message.audio_id && message.audio_id !== context.currentAudioId)
                .map(message => message.audio_id)
                .slice(-(context.audioHistoryCount || 1)));
        } else if (context.quotedAudioId) {
            ids.push(context.quotedAudioId);
        }
        if (context.currentAudioId) ids.push(context.currentAudioId);

        for (const audioId of ids) {
            const audioPart = await getAudioData(config, audioId);
            if (audioPart) content.push(audioPart);
        }
    }

    const payload = {
        model: modelName,
        messages: [
            { role: 'system', content: systemPrompt || 'You are a helpful AI assistant.' },
            { role: 'user', content }
        ],
        max_tokens: 16000
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${AI_API_KEY}`
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(90000)
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(body.error?.message || `AI API returned HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            const choice = body.choices?.[0];
            const text = typeof choice?.message?.content === 'string'
                ? choice.message.content
                : Array.isArray(choice?.message?.content)
                    ? choice.message.content.map(part => part.text || '').join('')
                    : '';

            if (!text) throw new Error('AI API returned an empty response.');

            const usage = body.usage || {};
            const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
            const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
            const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;

            return {
                response: text,
                tokens: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    cached_tokens: cachedTokens,
                    cost_usd: calculateCost('openai-compatible', modelName, inputTokens, outputTokens, cachedTokens),
                    provider: 'openai-compatible'
                }
            };
        } catch (error) {
            logger.error('AI', `API request failed (attempt ${attempt}): ${error.message}`);
            if (attempt >= MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }

    throw new Error('Failed to get a valid AI response.');
}

function getGenAI() {
    return null;
}

module.exports = {
    callOpenAICompatible,
    callGeminiAPI: callOpenAICompatible,
    initializeAI,
    reinitializeAI,
    reinitializeGemini,
    getGenAI
};
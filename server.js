import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { CartesiaClient } from '@cartesia/cartesia-js';

dotenv.config({ override: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const PORT = Number(process.env.PORT || 8080);
const FREE_MESSAGES = Number(process.env.FREE_MESSAGES || 18);
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const DEMO_AUTO_CONSENT = process.env.DEMO_AUTO_CONSENT !== 'false';
const FREE_MESSAGES_LIMIT = DEMO_MODE ? Number.MAX_SAFE_INTEGER : FREE_MESSAGES;
const FREE_MESSAGES_DISPLAY = DEMO_MODE ? 'unlimited' : FREE_MESSAGES;
const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES || 30);
const STRICT_PRIVACY = process.env.STRICT_PRIVACY !== 'false';
const DEBUG_LOGS = process.env.DEBUG_LOGS !== 'false';
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
const AI_MODEL_CHAT = process.env.AI_MODEL_CHAT || 'openai/gpt-4.1';
const AI_MODEL_MEMORY = process.env.AI_MODEL_MEMORY || AI_MODEL_CHAT;
const AI_ADVANCED_THINKING = process.env.AI_ADVANCED_THINKING !== 'false';
const AI_CONFIDENCE_MIN = Number(process.env.AI_CONFIDENCE_MIN || 0.72);
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || 'http://localhost:8080';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'AI Mirror MVP';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
const VOICE_PROVIDER = (process.env.VOICE_PROVIDER || 'browser').toLowerCase();
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_MODEL_ID = process.env.CARTESIA_MODEL_ID || 'sonic-2';
const CARTESIA_CLONE_MODE = process.env.CARTESIA_CLONE_MODE || 'similarity';
const CARTESIA_DEFAULT_VOICE_ID = process.env.CARTESIA_DEFAULT_VOICE_ID || '694f9389-aac1-45b6-b726-9d9369183238';

const ALLOWED_PROVIDERS = ['openai', 'openrouter', 'ollama', 'fallback'];
const ALLOWED_SESSION_MODES = ['twin', 'coach'];
const ALLOWED_VOICE_PROVIDERS = ['browser', 'elevenlabs', 'cartesia'];

const CARTESIA_OUTPUT_FORMAT = {
  container: 'mp3',
  sampleRate: 44100,
  bitRate: 128000
};

const cartesiaClient = CARTESIA_API_KEY
  ? new CartesiaClient({ apiKey: CARTESIA_API_KEY })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

function createAiClient(provider, modelChat, modelMemory) {
  if (provider === 'fallback') {
    return {
      provider: 'fallback',
      enabled: false,
      modelChat,
      modelMemory,
      reason: 'Fallback selected explicitly.',
      client: null
    };
  }

  if (provider === 'ollama') {
    return {
      provider: 'ollama',
      enabled: true,
      modelChat,
      modelMemory,
      reason: 'Local Ollama endpoint active.',
      client: new OpenAI({
        apiKey: process.env.OLLAMA_API_KEY || 'ollama',
        baseURL: OLLAMA_BASE_URL
      })
    };
  }

  if (provider === 'openrouter') {
    const hasApiKey = Boolean(process.env.OPENROUTER_API_KEY);
    if (!hasApiKey) {
      return {
        provider: 'openrouter',
        enabled: false,
        modelChat,
        modelMemory,
        reason: 'OPENROUTER_API_KEY missing.',
        client: null
      };
    }

    return {
      provider: 'openrouter',
      enabled: true,
      modelChat,
      modelMemory,
      reason: 'OpenRouter API configured.',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: {
          'HTTP-Referer': OPENROUTER_SITE_URL,
          'X-Title': OPENROUTER_APP_NAME
        }
      })
    };
  }

  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  if (!hasApiKey) {
    return {
      provider: 'openai',
      enabled: false,
      modelChat,
      modelMemory,
      reason: 'OPENAI_API_KEY missing.',
      client: null
    };
  }

  return {
    provider: 'openai',
    enabled: true,
    modelChat,
    modelMemory,
    reason: 'OpenAI API configured.',
    client: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {})
    })
  };
}

let aiRuntime = {
  provider: AI_PROVIDER,
  modelChat: AI_MODEL_CHAT,
  modelMemory: AI_MODEL_MEMORY
};

let ai = createAiClient(aiRuntime.provider, aiRuntime.modelChat, aiRuntime.modelMemory);

function reconfigureAiRuntime(nextConfig) {
  aiRuntime = {
    provider: nextConfig.provider,
    modelChat: nextConfig.modelChat,
    modelMemory: nextConfig.modelMemory
  };
  ai = createAiClient(aiRuntime.provider, aiRuntime.modelChat, aiRuntime.modelMemory);
  return ai;
}

const sessions = new Map();

if (DEBUG_LOGS) {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = uuidv4().slice(0, 8);
    console.log(`[${requestId}] -> ${req.method} ${req.path}`);

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      console.log(`[${requestId}] <- ${res.statusCode} ${req.method} ${req.path} (${durationMs}ms)`);
    });

    next();
  });
}

const inputSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(1200),
  channel: z.enum(['voice', 'text']).default('text'),
  speechMeta: z.object({
    durationMs: z.number().min(200).max(180000).optional(),
    wordCount: z.number().int().min(0).max(3000).optional(),
    speakingRateWpm: z.number().min(20).max(280).optional(),
    pauseCount: z.number().int().min(0).max(400).optional(),
    longPauseCount: z.number().int().min(0).max(200).optional(),
    maxPauseMs: z.number().min(0).max(30000).optional(),
    finalChunkCount: z.number().int().min(0).max(1000).optional()
  }).optional()
});

const sessionModeSchema = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(['twin', 'coach'])
});

const consentSchema = z.object({
  sessionId: z.string().min(1),
  consentVoiceAdapt: z.boolean(),
  consentTwinTraining: z.boolean(),
  consentVoiceClone: z.boolean().optional()
});

const speakSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(1500),
  voiceId: z.string().min(1).max(120).optional()
});

const aiConfigSchema = z.object({
  provider: z.string().transform((value) => value.toLowerCase()).refine((value) => ALLOWED_PROVIDERS.includes(value), {
    message: 'Invalid provider'
  }),
  modelChat: z.string().min(1).max(120),
  modelMemory: z.string().min(1).max(120),
  probe: z.boolean().optional()
});

function normalizeErrorMessage(error) {
  if (!error) return 'Unknown AI error.';
  if (typeof error === 'string') return error;
  if (error?.error?.message) return String(error.error.message);
  if (error?.message) return String(error.message);
  return 'Unknown AI error.';
}

function extractResponseText(response) {
  if (!response) return '';

  const direct = response.output_text?.trim();
  if (direct) return direct;

  const chunks = [];
  const outputs = Array.isArray(response.output) ? response.output : [];

  for (const item of outputs) {
    if (typeof item?.text === 'string' && item.text.trim()) {
      chunks.push(item.text.trim());
    }

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }

  return chunks.join(' ').trim();
}

function extractChatCompletionText(completion) {
  const messageContent = completion?.choices?.[0]?.message?.content;
  if (!messageContent) return '';
  if (typeof messageContent === 'string') return messageContent.trim();
  if (!Array.isArray(messageContent)) return '';

  return messageContent
    .map((item) => (typeof item?.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function generateModelText({ model, systemPrompt, userPrompt, temperature = 0.7, maxOutputTokens = 220 }) {
  const response = await ai.client.responses.create({
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_output_tokens: maxOutputTokens
  });

  const responseText = extractResponseText(response);
  if (responseText) return responseText;

  const completion = await ai.client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_tokens: Math.max(64, Math.floor(maxOutputTokens / 2))
  });

  return extractChatCompletionText(completion);
}

function normalizeForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSmartFallbackAnswer(session, userText, variantSeed = 0) {
  const goal = session.userState?.goal && session.userState.goal !== 'unknown'
    ? session.userState.goal
    : 'this week';

  const userRaw = String(userText || '');
  const userHint = userRaw
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');

  const asksHowItWorks = /(how.*work|working|what.*purpose|purpose|explain|how this works)/i.test(userRaw);
  const asksAboutMode = /(test mode|flow|what mode)/i.test(userRaw);
  const isDiscoveryLike = session.userState?.goal === 'unknown'
    || session.userState?.phase === 'discovery'
    || /(are we good|what do you mean|not sure|weird|check|hello|hi\b)/i.test(userRaw)
    || asksHowItWorks
    || asksAboutMode;

  if (asksHowItWorks) {
    const explanationTemplates = [
      'Simple: you talk, I mirror your patterns, challenge weak spots, and push one concrete next move.',
      'How it works: I read your intent and tone, reflect it back hard, then force a clear next action.',
      'I work as your twin: mirror, provoke, and convert your words into one decisive step.'
    ];
    return explanationTemplates[Math.abs(Number(variantSeed || 0)) % explanationTemplates.length];
  }

  if (asksAboutMode) {
    const modeTemplates = [
      'No mode menu. Just tell me one real thing you want to improve and I will pressure-test it.',
      'Forget labels. Give me your current bottleneck and I will challenge your next move.',
      'Skip setup. Name one problem you want solved this week and we go straight in.'
    ];
    return modeTemplates[Math.abs(Number(variantSeed || 0)) % modeTemplates.length];
  }

  if (isDiscoveryLike) {
    const discoveryTemplates = [
      'Got you. Give me one real friction point and I will hit it directly.',
      'Understood. What are you avoiding right now that you know matters?',
      'Fine. One concrete truth: what is the main thing you are not confronting?' 
    ];
    const discoveryIndex = Math.abs(Number(variantSeed || 0)) % discoveryTemplates.length;
    return discoveryTemplates[discoveryIndex];
  }

  const twinTemplates = [
    `Clear next move: pick one concrete task tied to ${goal}, start now, then report result. Which exact task starts now?`,
    `Let us lock one priority from your latest update. What single task do we execute first?`,
    `Strong move now: choose one high-impact action for ${goal} and start immediately. What is the first action?`
  ];

  const coachTemplates = [
    `Short plan: choose one concrete task for ${goal}, start now, then tell me the result. Which task starts now?`,
    `I hear you. From your latest update, pick one action we can finish today. Which one?`,
    `Let us simplify: one priority, one action, one checkpoint today. What is the action?`
  ];

  const templates = session.sessionMode === 'twin' ? twinTemplates : coachTemplates;
  const index = Math.abs(Number(variantSeed || 0)) % templates.length;
  return templates[index];
}

function avoidRepeatedAssistantReply(session, candidateReply, userText) {
  const previousAssistant = [...session.history]
    .reverse()
    .find((item) => item.role === 'assistant')?.content;

  if (!previousAssistant) return candidateReply;

  const previousNormalized = normalizeForComparison(previousAssistant);
  const candidateNormalized = normalizeForComparison(candidateReply);

  if (previousNormalized && previousNormalized === candidateNormalized) {
    return buildSmartFallbackAnswer(session, userText, session.messageCount + 1);
  }

  return candidateReply;
}

function buildAiHint(provider, model, message) {
  const lower = message.toLowerCase();

  if (provider === 'openai') {
    if (lower.includes('api key') || lower.includes('401')) {
      return 'Set OPENAI_API_KEY in .env (create one on platform.openai.com), then restart npm run demo.';
    }
    return `Check OPENAI_API_KEY permissions and model access for ${model}.`;
  }

  if (provider === 'openrouter') {
    if (lower.includes('api key') || lower.includes('401')) {
      return 'Set OPENROUTER_API_KEY in .env (create one on openrouter.ai/keys), then restart npm run demo.';
    }
    if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
      return `Model may be unavailable on OpenRouter. Try a known model like openai/gpt-4.1-mini or anthropic/claude-3.5-haiku.`;
    }
    return 'Check OPENROUTER_API_KEY, model name, and OpenRouter account credits/limits.';
  }

  if (provider === 'ollama') {
    if (lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('connect')) {
      return 'Ollama not reachable. Run `ollama serve` locally and keep it running.';
    }
    if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
      return `Model missing locally. Run: ollama pull ${model}`;
    }
    return 'Check OLLAMA_BASE_URL and ensure the selected model exists locally via `ollama list`.';
  }

  return 'Set a cloud provider key (OpenRouter/OpenAI) to enable live responses.';
}

function aiStatusPayload() {
  return {
    aiEnabled: ai.enabled,
    aiProvider: ai.provider,
    aiModelChat: aiRuntime.modelChat,
    aiModelMemory: aiRuntime.modelMemory,
    aiAdvancedThinking: AI_ADVANCED_THINKING,
    aiConfidenceMin: AI_CONFIDENCE_MIN,
    demoMode: DEMO_MODE,
    voiceProvider: VOICE_PROVIDER,
    aiReason: ai.reason,
    allowedProviders: ALLOWED_PROVIDERS
  };
}

function buildVoiceProviderState(session) {
  const providerReady = VOICE_PROVIDER === 'browser'
    ? true
    : VOICE_PROVIDER === 'elevenlabs'
      ? Boolean(ELEVENLABS_API_KEY)
      : VOICE_PROVIDER === 'cartesia'
        ? Boolean(CARTESIA_API_KEY)
      : false;

  const cloneCapableProviders = ['elevenlabs', 'cartesia'];
  return {
    activeProvider: VOICE_PROVIDER,
    allowedProviders: ALLOWED_VOICE_PROVIDERS,
    providerReady,
    clonedVoiceAvailable: Boolean(
      session.voiceProfile?.voiceId
      && cloneCapableProviders.includes(session.voiceProfile?.provider)
    ),
    voiceProfile: session.voiceProfile || null
  };
}

function getVoiceErrorHint(message, provider = VOICE_PROVIDER) {
  const lower = message.toLowerCase();
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('401')) {
    if (provider === 'cartesia') {
      return 'Set CARTESIA_API_KEY in .env and restart npm run demo.';
    }
    return 'Set ELEVENLABS_API_KEY in .env and restart npm run demo.';
  }
  if (lower.includes('quota') || lower.includes('limit')) {
    if (provider === 'cartesia') {
      return 'Check Cartesia credits and account limits.';
    }
    return 'Check ElevenLabs credits and account limits.';
  }
  if (provider === 'cartesia' && (lower.includes('feature not available') || lower.includes('free tier') || lower.includes('status code: 402'))) {
    return 'Cartesia voice cloning appears unavailable on your current plan. Upgrade your Cartesia plan for cloning, or keep using standard API voice (works now).';
  }
  if (provider === 'cartesia') {
    return 'Check CARTESIA_API_KEY and CARTESIA_MODEL_ID, and use a clean 8-20s voice sample with low background noise.';
  }
  return 'Check ELEVENLABS_API_KEY, uploaded sample quality, and provider availability.';
}

function isCloneCapableVoiceProvider(provider) {
  return ['elevenlabs', 'cartesia'].includes(provider);
}

async function createElevenLabsVoiceClone({ label, audioBuffer, mimeType }) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY missing.');
  }

  const formData = new FormData();
  formData.append('name', label || `Twin Voice ${new Date().toISOString()}`);
  formData.append('description', 'Session-consented twin voice profile');
  formData.append('files', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), 'sample.webm');

  const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: formData
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail?.message || payload?.detail || payload?.message || 'Voice clone creation failed.');
  }

  return {
    voiceId: payload.voice_id,
    provider: 'elevenlabs',
    label: label || 'Twin Voice',
    createdAt: new Date().toISOString()
  };
}

async function createCartesiaVoiceClone({ label, audioBuffer, mimeType }) {
  if (!cartesiaClient) {
    throw new Error('CARTESIA_API_KEY missing.');
  }

  const clip = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
  const payload = await cartesiaClient.voices.clone(clip, {
    name: label || `Twin Voice ${new Date().toISOString()}`,
    description: 'Session-consented twin voice profile',
    mode: CARTESIA_CLONE_MODE,
    language: 'en'
  });

  return {
    voiceId: payload.id,
    provider: 'cartesia',
    label: label || 'Twin Voice',
    createdAt: new Date().toISOString()
  };
}

async function synthesizeWithElevenLabs({ voiceId, text }) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: {
        stability: 0.42,
        similarity_boost: 0.78,
        style: 0.34,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || 'Voice synthesis failed.');
  }

  return Buffer.from(await response.arrayBuffer());
}

async function streamToBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function synthesizeWithCartesia({ voiceId, text }) {
  if (!cartesiaClient) {
    throw new Error('CARTESIA_API_KEY missing.');
  }

  const stream = await cartesiaClient.tts.bytes({
    modelId: CARTESIA_MODEL_ID,
    transcript: text,
    voice: {
      mode: 'id',
      id: voiceId
    },
    language: 'en',
    outputFormat: CARTESIA_OUTPUT_FORMAT
  });

  return streamToBuffer(stream);
}

async function listCartesiaVoices() {
  if (!cartesiaClient) return [];

  const voices = await cartesiaClient.voices.list();
  return voices
    .filter((voice) => voice?.id && voice?.name)
    .map((voice) => ({
      id: String(voice.id),
      name: String(voice.name),
      language: String(voice.language || ''),
      label: `${voice.name}${voice.language ? ` (${voice.language})` : ''}`
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);
}

async function probeAiRuntime() {
  if (!ai.enabled || !ai.client) {
    return {
      ok: false,
      status: 400,
      error: 'AI provider is disabled.',
      hint: buildAiHint(ai.provider, aiRuntime.modelChat, ai.reason || 'disabled')
    };
  }

  try {
    const response = await ai.client.responses.create({
      model: aiRuntime.modelChat,
      input: [
        { role: 'system', content: 'You are a connectivity probe. Reply with exactly: PROBE_OK' },
        { role: 'user', content: 'ping' }
      ],
      temperature: 0,
      max_output_tokens: 16
    });

    const output = extractResponseText(response);
    return {
      ok: true,
      status: 200,
      output,
      provider: ai.provider,
      model: aiRuntime.modelChat
    };
  } catch (error) {
    const message = normalizeErrorMessage(error);
    return {
      ok: false,
      status: 503,
      error: message,
      hint: buildAiHint(ai.provider, aiRuntime.modelChat, message),
      provider: ai.provider,
      model: aiRuntime.modelChat
    };
  }
}

function createSession() {
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();
  const session = {
    id,
    createdAt: new Date().toISOString(),
    expiresAt,
    messageCount: 0,
    summary: 'No summary yet.',
    sessionMode: 'twin',
    consent: {
      consentVoiceAdapt: DEMO_MODE && DEMO_AUTO_CONSENT,
      consentTwinTraining: DEMO_MODE && DEMO_AUTO_CONSENT,
      consentVoiceClone: DEMO_MODE && DEMO_AUTO_CONSENT,
      updatedAt: DEMO_MODE && DEMO_AUTO_CONSENT ? new Date().toISOString() : null
    },
    voiceProfile: null,
    profile: {
      strengths: [],
      blockers: [],
      values: [],
      nextActions: []
    },
    userState: {
      phase: 'discovery',
      goal: 'unknown',
      emotionalState: 'unclear',
      tonePreference: 'neutral',
      ironySignal: 'unknown',
      speechPace: 'unknown',
      pausePattern: 'unknown',
      cognitiveLoadSignal: 'unknown',
      confidence: 0.2
    },
    history: []
  };
  sessions.set(id, session);
  return session;
}

function isSessionExpired(session) {
  return new Date(session.expiresAt).getTime() <= Date.now();
}

function extendSessionTtl(session) {
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();
}

setInterval(() => {
  let removed = 0;
  for (const [sessionId, session] of sessions.entries()) {
    if (isSessionExpired(session)) {
      sessions.delete(sessionId);
      removed += 1;
    }
  }

  if (DEBUG_LOGS && removed > 0) {
    console.log(`[privacy] auto-deleted ${removed} expired session(s)`);
  }
}, 60_000).unref();

function getRecentHistory(history, limit = 12) {
  return history.slice(-limit).map((item) => `${item.role.toUpperCase()}: ${item.content}`).join('\n');
}

function extractList(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

function updateProfileFromSummary(session, summaryText) {
  const sections = {
    strengths: '',
    blockers: '',
    values: '',
    nextActions: ''
  };

  let currentSection = null;
  for (const rawLine of summaryText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('strengths:')) currentSection = 'strengths';
    else if (lower.startsWith('blockers:')) currentSection = 'blockers';
    else if (lower.startsWith('values:')) currentSection = 'values';
    else if (lower.startsWith('next actions:')) currentSection = 'nextActions';

    if (currentSection) sections[currentSection] += `${line}\n`;
  }

  session.profile = {
    strengths: extractList(sections.strengths),
    blockers: extractList(sections.blockers),
    values: extractList(sections.values),
    nextActions: extractList(sections.nextActions)
  };
}

function parseJsonObjectSafely(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_errorNested) {
      return null;
    }
  }
}

function parseQualityGate(text) {
  const parsed = parseJsonObjectSafely(text);
  if (!parsed || typeof parsed !== 'object') {
    return {
      confidence: 0.65,
      anchor: 'Keep building the twin profile around user identity, blockers, and next action.',
      focusQuestion: 'What is the most important behavior pattern we should model next?'
    };
  }

  const rawFocusQuestion = typeof parsed.focusQuestion === 'string' && parsed.focusQuestion.trim().length > 0
    ? parsed.focusQuestion.trim()
    : 'What is the most important behavior pattern we should model next?';

  const shortFocusQuestion = rawFocusQuestion
    .split(/\s+/)
    .slice(0, 14)
    .join(' ')
    .replace(/[\s,;:.!?-]+$/, '')
    .concat('?');

  return {
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.65,
    anchor: typeof parsed.anchor === 'string' && parsed.anchor.trim().length > 0
      ? parsed.anchor.trim()
      : 'Keep building the twin profile around user identity, blockers, and next action.',
    focusQuestion: shortFocusQuestion
  };
}

function mergeUserState(currentState, patch) {
  return {
    phase: patch?.phase || currentState.phase,
    goal: patch?.goal || currentState.goal,
    emotionalState: patch?.emotionalState || currentState.emotionalState,
    tonePreference: patch?.tonePreference || currentState.tonePreference,
    ironySignal: patch?.ironySignal || currentState.ironySignal,
    speechPace: patch?.speechPace || currentState.speechPace,
    pausePattern: patch?.pausePattern || currentState.pausePattern,
    cognitiveLoadSignal: patch?.cognitiveLoadSignal || currentState.cognitiveLoadSignal,
    confidence: typeof patch?.confidence === 'number'
      ? Math.max(0, Math.min(1, patch.confidence))
      : currentState.confidence
  };
}

function summarizeSpeechMeta(speechMeta) {
  if (!speechMeta || typeof speechMeta !== 'object') {
    return 'not available';
  }

  const parts = [];
  if (typeof speechMeta.speakingRateWpm === 'number') {
    parts.push(`pace=${Math.round(speechMeta.speakingRateWpm)}wpm`);
  }
  if (typeof speechMeta.pauseCount === 'number') {
    parts.push(`pauses=${speechMeta.pauseCount}`);
  }
  if (typeof speechMeta.longPauseCount === 'number') {
    parts.push(`longPauses=${speechMeta.longPauseCount}`);
  }
  if (typeof speechMeta.maxPauseMs === 'number') {
    parts.push(`maxPauseMs=${Math.round(speechMeta.maxPauseMs)}`);
  }
  if (typeof speechMeta.wordCount === 'number') {
    parts.push(`words=${speechMeta.wordCount}`);
  }
  if (typeof speechMeta.durationMs === 'number') {
    parts.push(`durationMs=${Math.round(speechMeta.durationMs)}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'present but sparse';
}

function buildMemoryConnectionContext(session, userText) {
  const profile = session.profile || {};
  const strengths = Array.isArray(profile.strengths) ? profile.strengths.filter(Boolean) : [];
  const blockers = Array.isArray(profile.blockers) ? profile.blockers.filter(Boolean) : [];
  const values = Array.isArray(profile.values) ? profile.values.filter(Boolean) : [];
  const nextActions = Array.isArray(profile.nextActions) ? profile.nextActions.filter(Boolean) : [];
  const state = session.userState || {};
  const latestUserText = String(userText || '').trim();

  const hypotheses = [];

  if (blockers[0] && nextActions[0]) {
    hypotheses.push(`Action friction hypothesis: blocker "${blockers[0]}" is interfering with next action "${nextActions[0]}".`);
  }

  if (values[0] && blockers[0]) {
    hypotheses.push(`Values tension hypothesis: value "${values[0]}" may conflict with blocker pattern "${blockers[0]}".`);
  }

  if (strengths[0] && blockers[0]) {
    hypotheses.push(`Leverage gap hypothesis: known strength "${strengths[0]}" is not being used against blocker "${blockers[0]}".`);
  }

  if (state.goal && state.goal !== 'unknown' && nextActions[0]) {
    hypotheses.push(`Goal alignment hypothesis: current goal "${state.goal}" and next action "${nextActions[0]}" may not yet be tightly aligned.`);
  }

  if (state.cognitiveLoadSignal === 'high' && blockers[0]) {
    hypotheses.push(`Load hypothesis: high cognitive load may amplify blocker "${blockers[0]}".`);
  }

  if (hypotheses.length === 0 && latestUserText) {
    hypotheses.push(`Early-stage hypothesis: infer a repeating pattern from latest message "${latestUserText.slice(0, 110)}" and test it with one precise question.`);
  }

  const shortHypotheses = hypotheses.slice(0, 3);
  const surpriseQuestion = shortHypotheses.length > 0
    ? `Potential surprise question: "What if this is less about ${(blockers[0] || 'the task')} and more about protecting ${(values[0] || 'your identity')}?"`
    : 'Potential surprise question: "What are you optimizing for that you have not named yet?"';

  return [
    'Memory-linked connection hypotheses (tentative, test with question):',
    ...shortHypotheses.map((item, index) => `${index + 1}. ${item}`),
    surpriseQuestion
  ].join('\n');
}

function inferSpeechSignals(speechMeta) {
  if (!speechMeta || typeof speechMeta !== 'object') {
    return {
      speechPace: 'unknown',
      pausePattern: 'unknown',
      cognitiveLoadSignal: 'unknown'
    };
  }

  const pace = typeof speechMeta.speakingRateWpm === 'number' ? speechMeta.speakingRateWpm : null;
  const pauseCount = typeof speechMeta.pauseCount === 'number' ? speechMeta.pauseCount : 0;
  const longPauseCount = typeof speechMeta.longPauseCount === 'number' ? speechMeta.longPauseCount : 0;
  const maxPauseMs = typeof speechMeta.maxPauseMs === 'number' ? speechMeta.maxPauseMs : 0;

  let speechPace = 'unknown';
  if (pace !== null) {
    if (pace < 95) speechPace = 'slow';
    else if (pace > 155) speechPace = 'fast';
    else speechPace = 'balanced';
  }

  let pausePattern = 'unknown';
  if (longPauseCount >= 3 || maxPauseMs >= 1800) pausePattern = 'hesitant';
  else if (pauseCount >= 2) pausePattern = 'reflective';
  else if (pace !== null) pausePattern = 'smooth';

  let cognitiveLoadSignal = 'unknown';
  if (pausePattern === 'hesitant' || (speechPace === 'slow' && longPauseCount >= 1)) {
    cognitiveLoadSignal = 'high';
  } else if (pausePattern === 'reflective' || speechPace === 'fast') {
    cognitiveLoadSignal = 'moderate';
  } else if (speechPace === 'balanced' && pauseCount <= 1) {
    cognitiveLoadSignal = 'light';
  }

  return { speechPace, pausePattern, cognitiveLoadSignal };
}

async function inferUserState(session, userText, conversation, speechMeta) {
  if (!session.consent?.consentTwinTraining) {
    return;
  }

  if (!ai.enabled || !ai.client) {
    const heuristicPatch = {
      goal: userText.length > 12 ? userText.slice(0, 120) : session.userState.goal,
      confidence: Math.min(0.7, session.userState.confidence + 0.1)
    };
    session.userState = mergeUserState(session.userState, heuristicPatch);
    return;
  }

  const inferenceSystem = [
    'You are UserStateAgent.',
    'Extract only structured user intent and emotional style from conversation.',
    'Return valid JSON only with keys:',
    'phase (discovery|build_plan|accountability),',
    'goal (string),',
    'emotionalState (string),',
    'tonePreference (string),',
    'ironySignal (low|medium|high|unknown),',
    'confidence (number between 0 and 1).'
  ].join(' ');

  const inferencePrompt = [
    'Current known user state:',
    JSON.stringify(session.userState),
    'Recent conversation:',
    conversation,
    `Latest user message: ${userText}`
  ].join('\n');

  try {
    const speechSignals = inferSpeechSignals(speechMeta);
    const inferenceText = await generateModelText({
      model: aiRuntime.modelMemory,
      systemPrompt: inferenceSystem,
      userPrompt: inferencePrompt,
      temperature: 0.1,
      maxOutputTokens: 180
    });

    const parsed = parseJsonObjectSafely(inferenceText);
    if (parsed) {
      session.userState = mergeUserState(session.userState, {
        ...speechSignals,
        ...parsed,
        speechPace: parsed.speechPace || speechSignals.speechPace,
        pausePattern: parsed.pausePattern || speechSignals.pausePattern,
        cognitiveLoadSignal: parsed.cognitiveLoadSignal || speechSignals.cognitiveLoadSignal
      });
    } else {
      session.userState = mergeUserState(session.userState, speechSignals);
    }
  } catch (_error) {
    session.userState = mergeUserState(session.userState, {
      ...inferSpeechSignals(speechMeta),
      confidence: Math.max(0.2, session.userState.confidence - 0.05)
    });
  }
}

async function orchestrateCoachingResponse(session, userText, speechMeta) {
  const conversation = getRecentHistory(session.history);

  await inferUserState(session, userText, conversation, speechMeta);

  let qualityGate = {
    confidence: 0.7,
    anchor: 'Keep building the twin profile around user identity, blockers, and next action.',
    focusQuestion: 'What is the most important behavior pattern we should model next?'
  };

  if (!ai.enabled || !ai.client) {
    const fallbackAnswer = session.sessionMode === 'twin'
      ? `I am your AI twin speaking in mirror mode. You said: "${userText}". Here is our next move: choose one concrete 15-minute action today that proves who we are becoming, and tell me when it is done.`
      : `I hear you. You said: "${userText}". Quick action: pick one tiny step you can do in 15 minutes today, then tell me if it was done.`;

    return {
      answer: fallbackAnswer,
      summary: session.summary
    };
  }

  if (AI_ADVANCED_THINKING) {
    const gateSystem = [
      'You are QualityGateAgent for an AI twin assistant.',
      'Evaluate whether we have enough context to produce a meaningful, goal-aligned answer.',
      'Return strict JSON only with keys: confidence (0-1), anchor (string), focusQuestion (string).',
      'Anchor must keep the conversation focused on building an accurate user twin.',
      'focusQuestion must be short (max 12 words).'
    ].join(' ');

    const gatePrompt = [
      `Session mode: ${session.sessionMode}`,
      `User state: ${JSON.stringify(session.userState)}`,
      `Voice cadence cues: ${summarizeSpeechMeta(speechMeta)}`,
      `Session summary: ${session.summary}`,
      'Recent conversation:',
      conversation,
      `Latest user message: ${userText}`
    ].join('\n');

    try {
      const gateText = await generateModelText({
        model: aiRuntime.modelMemory,
        systemPrompt: gateSystem,
        userPrompt: gatePrompt,
        temperature: 0.1,
        maxOutputTokens: 160
      });

      qualityGate = parseQualityGate(gateText);
    } catch (_error) {
      qualityGate = {
        confidence: 0.68,
        anchor: 'Stay focused on identity mirroring and concrete behavior changes.',
        focusQuestion: 'What part of your behavior should your twin learn next?'
      };
    }
  }

  if (qualityGate.confidence < AI_CONFIDENCE_MIN) {
    return {
      answer: `Quick check before advice: ${qualityGate.focusQuestion}`,
      summary: session.summary
    };
  }

  const coachSystem = session.sessionMode === 'twin'
    ? [
      'You are a PG-safe AI Twin, not a generic coach.',
      'No sexual content. No explicit romantic roleplay.',
      'Speak as a digital twin of the user: mirror style, directness, irony, and emotional tempo.',
      'Style target: bold, confrontational-constructive, provocative but useful.',
      'Call out contradictions clearly when user words and goals do not match, but stay respectful.',
      'Do not be bland or generic. Avoid menu-like options unless user explicitly asks for options.',
      'Use first-person plural occasionally (we/us) to reinforce shared identity, but stay natural.',
      'Do not invent personal memories not present in the conversation history or profile context.',
      'Your mission is identity mirroring plus action: reflect who the user is becoming, then propose one concrete step.',
      'Use the latest known goal, blockers, values, and previous commitments as anchors in every answer.',
      'Build at least one tentative connection between memory items (blocker/value/strength/action) before advice.',
      'Ask one surprising but grounded question when it helps reveal hidden pattern links.',
      'Never claim certainty about hidden motives; frame hypotheses as testable possibilities.',
      'Dynamically adapt language complexity to user level inferred from words and voice cadence.',
      'Use voice pace and pause patterns to infer emotional tempo before advice.',
      'If user goal is unclear, ask one sharp identity-building question.',
      'Keep response concise but natural: 3-6 lines, usually 70-140 words.',
      'Use spoken-style phrasing for turn-by-turn conversation.',
      'Ask at most one sharp question so the user talks more than you.',
      'Do not repeat the same question in consecutive turns.'
    ].join(' ')
    : [
      'You are a PG-safe, warm, concise AI mirror coach.',
      'No sexual content. No explicit romantic roleplay.',
      'Primary mission: help the user become who they want to become.',
      'Mirror the user tone intelligently (energy, directness, irony) without parroting phrases.',
      'Adapt language complexity and emotional pace from user words plus voice cadence cues.',
      'Acknowledge emotions and subtext before advice.',
      'Use memory-linked hypotheses: connect at least two known signals (blocker/value/strength/action) when relevant.',
      'When pattern is plausible but uncertain, ask one concise question to test it.',
      'When intent is unclear, ask focused discovery questions to clarify goals.',
      'Always include one concrete next step.',
      'At most one follow-up question per message.',
      'Keep response concise but natural: 3-6 lines, usually 70-140 words.',
      'Favor interactive turn-taking: user should speak more than AI.'
    ].join(' ');

  const profileContext = [
    `Strengths: ${(session.profile?.strengths || []).join(' | ') || 'none yet'}`,
    `Blockers: ${(session.profile?.blockers || []).join(' | ') || 'none yet'}`,
    `Values: ${(session.profile?.values || []).join(' | ') || 'none yet'}`,
    `Next actions: ${(session.profile?.nextActions || []).join(' | ') || 'none yet'}`
  ].join('\n');

  const coachPrompt = [
    `Quality gate anchor: ${qualityGate.anchor}`,
    `Quality gate confidence: ${qualityGate.confidence}`,
    `User state: ${JSON.stringify(session.userState)}`,
    `Voice cadence cues: ${summarizeSpeechMeta(speechMeta)}`,
    `Session summary: ${session.summary}`,
    'Structured profile context:',
    profileContext,
    buildMemoryConnectionContext(session, userText),
    'Recent conversation:',
    conversation,
    `User latest message: ${userText}`
  ].join('\n');

  const coachText = await generateModelText({
    model: aiRuntime.modelChat,
    systemPrompt: coachSystem,
    userPrompt: coachPrompt,
    temperature: 0.8,
    maxOutputTokens: 300
  });

  let answer = coachText || buildSmartFallbackAnswer(session, userText, session.messageCount);
  answer = avoidRepeatedAssistantReply(session, answer, userText);

  let summary = session.summary;
  if (session.messageCount % 4 === 0) {
    const memorySystem = [
      'You are MemoryAgent.',
      'Output only this format with bullet points:',
      'Strengths:',
      '- ...',
      'Blockers:',
      '- ...',
      'Values:',
      '- ...',
      'Next actions:',
      '- ...',
      'Keep each list max 4 bullets.'
    ].join('\n');

    const memoryPrompt = [
      `Previous summary: ${session.summary}`,
      'Conversation:',
      conversation,
      `Latest user input: ${userText}`
    ].join('\n');

    const memoryText = await generateModelText({
      model: aiRuntime.modelMemory,
      systemPrompt: memorySystem,
      userPrompt: memoryPrompt,
      temperature: 0.2,
      maxOutputTokens: 260
    });

    summary = memoryText || session.summary;
  }

  return { answer, summary };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ...aiStatusPayload(),
    freeMessages: FREE_MESSAGES_DISPLAY
  });
});

app.post('/api/ai-probe', async (_req, res) => {
  const probe = await probeAiRuntime();
  if (!probe.ok) {
    return res.status(probe.status).json({ ...probe, ...aiStatusPayload() });
  }

  return res.json({ ...probe, ...aiStatusPayload() });
});

app.post('/api/ai-config', async (req, res) => {
  const parsed = aiConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid AI config payload' });
  }

  const { provider, modelChat, modelMemory } = parsed.data;
  const next = reconfigureAiRuntime({ provider, modelChat, modelMemory });

  let probe = null;
  if (parsed.data.probe) {
    probe = await probeAiRuntime();
  }

  const payload = {
    ok: true,
    aiEnabled: next.enabled,
    aiProvider: next.provider,
    aiModelChat: aiRuntime.modelChat,
    aiModelMemory: aiRuntime.modelMemory,
    aiReason: next.reason,
    probe
  };

  if (probe && !probe.ok) {
    return res.status(probe.status).json(payload);
  }

  return res.json(payload);
});

app.get('/api/privacy-proof', (_req, res) => {
  res.json({
    strictPrivacy: STRICT_PRIVACY,
    aiProvider: ai.provider,
    aiEnabled: ai.enabled,
    aiModelChat: aiRuntime.modelChat,
    aiModelMemory: aiRuntime.modelMemory,
    storage: 'in-memory-only',
    databaseUsed: false,
    logsContainMessageText: false,
    cloudProcessing: ['openai', 'openrouter'].includes(ai.provider),
    sessionTtlMinutes: SESSION_TTL_MINUTES,
    activeSessions: sessions.size,
    deleteSessionEndpoint: 'DELETE /api/session/:sessionId',
    notes: [
      'Sessions are stored only in server memory and are auto-deleted by TTL.',
      'Request logs include method/path/status/latency only; not chat content.',
      ai.provider === 'ollama'
        ? 'Inference runs locally through Ollama endpoint.'
        : 'Inference is sent to cloud provider API for response generation.'
    ]
  });
});

app.get('/api/retention', (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.json({
      storage: 'in-memory-only',
      sessionTtlMinutes: SESSION_TTL_MINUTES,
      policy: 'Session data is auto-deleted after TTL or when user triggers delete.',
      activeSessions: sessions.size
    });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      error: 'Session not found',
      storage: 'in-memory-only',
      sessionTtlMinutes: SESSION_TTL_MINUTES
    });
  }

  return res.json({
    storage: 'in-memory-only',
    sessionTtlMinutes: SESSION_TTL_MINUTES,
    expiresAt: session.expiresAt,
    now: new Date().toISOString(),
    messageCount: session.messageCount,
    sessionMode: session.sessionMode,
    consent: session.consent,
    userState: session.userState,
    voice: buildVoiceProviderState(session)
  });
});

app.get('/api/demo-readiness', (_req, res) => {
  res.json({
    ready: true,
    checks: {
      api: true,
      demoMode: DEMO_MODE,
      aiEnabled: ai.enabled,
      aiProvider: ai.provider,
      aiModelChat: aiRuntime.modelChat,
      aiModelMemory: aiRuntime.modelMemory,
      allowedSessionModes: ALLOWED_SESSION_MODES,
      usageGating: true,
      sessionsInMemory: sessions.size
    },
    notes: ai.enabled
      ? [`Live AI responses enabled via ${ai.provider}.`]
      : ['AI provider not configured: fallback local coach response is active.']
  });
});

app.get('/api/voice-options', async (_req, res) => {
  if (VOICE_PROVIDER !== 'cartesia') {
    return res.json({
      activeProvider: VOICE_PROVIDER,
      providerReady: VOICE_PROVIDER === 'browser' ? true : VOICE_PROVIDER === 'elevenlabs' ? Boolean(ELEVENLABS_API_KEY) : false,
      defaultVoiceId: null,
      voices: []
    });
  }

  if (!cartesiaClient) {
    return res.status(400).json({
      activeProvider: VOICE_PROVIDER,
      providerReady: false,
      defaultVoiceId: CARTESIA_DEFAULT_VOICE_ID,
      voices: [],
      error: 'CARTESIA_API_KEY missing'
    });
  }

  try {
    const voices = await listCartesiaVoices();
    return res.json({
      activeProvider: VOICE_PROVIDER,
      providerReady: true,
      defaultVoiceId: CARTESIA_DEFAULT_VOICE_ID,
      voices
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    return res.status(503).json({
      activeProvider: VOICE_PROVIDER,
      providerReady: false,
      defaultVoiceId: CARTESIA_DEFAULT_VOICE_ID,
      voices: [],
      error: message,
      hint: getVoiceErrorHint(message, 'cartesia')
    });
  }
});

app.post('/api/session', (_req, res) => {
  const session = createSession();
  res.json({
    sessionId: session.id,
    sessionMode: session.sessionMode,
    freeMessages: FREE_MESSAGES_DISPLAY,
    messageCount: session.messageCount,
    profile: session.profile,
    consent: session.consent,
    userState: session.userState,
    voice: buildVoiceProviderState(session),
    expiresAt: session.expiresAt
  });
});

app.post('/api/consent', (req, res) => {
  const parsed = consentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid consent payload' });
  }

  const { sessionId, consentVoiceAdapt, consentTwinTraining } = parsed.data;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.consent = {
    consentVoiceAdapt,
    consentTwinTraining,
    consentVoiceClone: parsed.data.consentVoiceClone ?? session.consent?.consentVoiceClone ?? false,
    updatedAt: new Date().toISOString()
  };

  return res.json({ ok: true, sessionId, consent: session.consent, voice: buildVoiceProviderState(session) });
});

app.post('/api/voice/clone', upload.single('audio'), async (req, res) => {
  const sessionId = req.body?.sessionId;
  const label = req.body?.label;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.consent?.consentVoiceClone) {
    return res.status(403).json({
      error: 'Voice clone consent required',
      hint: 'Enable consentVoiceClone in Consent panel before uploading sample.'
    });
  }

  if (!isCloneCapableVoiceProvider(VOICE_PROVIDER)) {
    return res.status(400).json({
      error: `VOICE_PROVIDER=${VOICE_PROVIDER} does not support cloning endpoint`,
      hint: 'Set VOICE_PROVIDER=elevenlabs or VOICE_PROVIDER=cartesia in .env and restart.'
    });
  }

  if (!req.file?.buffer) {
    return res.status(400).json({ error: 'Audio file is required in field "audio"' });
  }

  try {
    const clone = VOICE_PROVIDER === 'cartesia'
      ? await createCartesiaVoiceClone({
        label,
        audioBuffer: req.file.buffer,
        mimeType: req.file.mimetype
      })
      : await createElevenLabsVoiceClone({
        label,
        audioBuffer: req.file.buffer,
        mimeType: req.file.mimetype
      });

    session.voiceProfile = clone;
    return res.json({ ok: true, sessionId, voice: buildVoiceProviderState(session) });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    return res.status(503).json({
      error: 'Voice clone creation failed',
      details: message,
      hint: getVoiceErrorHint(message, VOICE_PROVIDER)
    });
  }
});

app.post('/api/voice/speak', async (req, res) => {
  const parsed = speakSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid voice speak payload' });
  }

  const { sessionId, text, voiceId } = parsed.data;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!isCloneCapableVoiceProvider(VOICE_PROVIDER)) {
    return res.status(400).json({
      error: `VOICE_PROVIDER=${VOICE_PROVIDER} does not support cloned speech output`,
      hint: 'Set VOICE_PROVIDER=elevenlabs or VOICE_PROVIDER=cartesia in .env and restart.'
    });
  }

  try {
    let audioBuffer;

    if (VOICE_PROVIDER === 'cartesia') {
      const hasClonedVoice = Boolean(
        session.voiceProfile?.voiceId
        && session.voiceProfile?.provider === 'cartesia'
        && session.consent?.consentVoiceClone
      );

      const targetVoiceId = hasClonedVoice
        ? session.voiceProfile.voiceId
        : voiceId || CARTESIA_DEFAULT_VOICE_ID;

      audioBuffer = await synthesizeWithCartesia({
        voiceId: targetVoiceId,
        text
      });
    } else {
      if (!session.consent?.consentVoiceClone) {
        return res.status(403).json({
          error: 'Voice clone consent required',
          hint: 'Enable consentVoiceClone in Consent panel before cloned voice playback.'
        });
      }

      if (!session.voiceProfile?.voiceId) {
        return res.status(404).json({
          error: 'No cloned voice profile for this session',
          hint: 'Upload a voice sample first.'
        });
      }

      if (session.voiceProfile?.provider !== VOICE_PROVIDER) {
        return res.status(409).json({
          error: 'Voice profile provider mismatch',
          hint: `Current provider is ${VOICE_PROVIDER}, but profile was created with ${session.voiceProfile?.provider}. Upload a new sample.`
        });
      }

      audioBuffer = await synthesizeWithElevenLabs({
        voiceId: session.voiceProfile.voiceId,
        text
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audioBuffer);
  } catch (error) {
    const message = normalizeErrorMessage(error);
    return res.status(503).json({
      error: 'Voice synthesis failed',
      details: message,
      hint: getVoiceErrorHint(message, VOICE_PROVIDER)
    });
  }
});

app.post('/api/session-mode', (req, res) => {
  const parsed = sessionModeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid session mode payload' });
  }

  const { sessionId, mode } = parsed.data;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.sessionMode = mode;
  return res.json({ ok: true, sessionId, sessionMode: session.sessionMode });
});

app.delete('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const deleted = sessions.delete(sessionId);
  if (!deleted) {
    return res.status(404).json({ error: 'Session not found' });
  }

  return res.json({ ok: true, deletedSessionId: sessionId });
});

app.post('/api/chat', async (req, res) => {
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { sessionId, text, speechMeta } = parsed.data;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (isSessionExpired(session)) {
    sessions.delete(sessionId);
    return res.status(410).json({ error: 'Session expired, please start a new one.' });
  }

  extendSessionTtl(session);

  if (session.messageCount >= FREE_MESSAGES_LIMIT) {
    return res.status(402).json({
      code: 'PAYWALL_REQUIRED',
      message: 'Free tier limit reached',
      freeMessages: FREE_MESSAGES_DISPLAY
    });
  }

  session.messageCount += 1;
  session.history.push({ role: 'user', content: text, at: new Date().toISOString() });

  try {
    const { answer, summary } = await orchestrateCoachingResponse(session, text, speechMeta);
    session.summary = summary;
    updateProfileFromSummary(session, summary);

    session.history.push({ role: 'assistant', content: answer, at: new Date().toISOString() });

    return res.json({
      answer,
      sessionMode: session.sessionMode,
      messageCount: session.messageCount,
      freeMessages: FREE_MESSAGES_DISPLAY,
      profile: session.profile,
      consent: session.consent,
      userState: session.userState,
      voice: buildVoiceProviderState(session),
      summary: session.summary,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    const hint = buildAiHint(ai.provider, aiRuntime.modelChat, message);
    console.error('[chat-error]', message);
    return res.status(503).json({
      error: 'AI processing failed',
      details: message,
      hint,
      provider: ai.provider,
      model: aiRuntime.modelChat
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI Mirror MVP running on http://localhost:${PORT}`);
  console.log(`[ai] provider=${ai.provider} | enabled=${ai.enabled} | chatModel=${aiRuntime.modelChat} | memoryModel=${aiRuntime.modelMemory}`);
  console.log(`[privacy] strict=${STRICT_PRIVACY} | ttl=${SESSION_TTL_MINUTES}m | storage=in-memory-only`);
});

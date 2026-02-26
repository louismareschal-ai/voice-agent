# AI Mirror MVP (72h Sprint)

Voice-first PG-safe AI coach that helps users understand themselves, identify blockers, and take action.

Current default AI stack: OpenRouter with `openai/gpt-4.1` (chat) + `openai/gpt-4.1-mini` (memory).

Advanced thinking is enabled by default with a confidence gate before final responses.

## What this MVP does

- Starts a session and tracks free usage.
- Lets users speak or type.
- Generates AI coaching replies.
- Builds live memory profile: strengths, blockers, values, next actions.
- Locks after free tier limit and shows upgrade CTA (€5/month concept).

## Product positioning

- **Target users**: men and women (18-40) who want self-improvement and clarity.
- **Core value**: an always-available mirror coach that converts reflection into practical steps.
- **Safety**: PG-safe only. No explicit sexual content.

## Quick start

1. Install dependencies:
   - `npm install`
2. Configure env:
  - `cp .env.example .env`
  - set `OPENROUTER_API_KEY=...`
  - keep defaults for provider/models unless you explicitly test alternatives
  - optional: `DEBUG_LOGS=true` (default) for request logs
  - optional: `SESSION_TTL_MINUTES=30`
  - optional: `STRICT_PRIVACY=true`
3. Run dev server:
  - `npm run demo`
4. Open:
   - `http://localhost:8080`
5. Validate before demo:
  - `npm run test:smoke`

## Decision options (current default)

- Default now: OpenRouter cloud for best quality + easy key access.
- OpenAI direct: optional alternative if you prefer direct billing/provider.
- Ollama local: optional experiment, not default path.

If terminal says `npn: command not found`, use `npm run demo` (it is a typo fix).

### Local AI mode (privacy-first)

1. Install and run Ollama locally.
2. Pull model (example): `ollama pull qwen2.5:14b-instruct`
3. In `.env`, set:
  - `AI_PROVIDER=ollama`
  - `AI_MODEL_CHAT=qwen2.5:14b-instruct`
  - `AI_MODEL_MEMORY=qwen2.5:14b-instruct`
4. Run: `npm run demo`

### OpenRouter cloud mode (default)

1. Create API key on `https://openrouter.ai/keys`.
2. Put key in `.env` as `OPENROUTER_API_KEY=...`.
3. Run: `npm run demo` then `npm run test:smoke`.
4. Click `Test AI Engine` and verify probe is `OK`.
5. Example model names for OpenRouter:
  - `openai/gpt-4.1-mini`
  - `anthropic/claude-3.5-haiku`

Note: Access to ChatGPT web/app does not provide an API key by itself. You still need a provider API key (OpenAI/OpenRouter/etc.).

## API

- `POST /api/session` → create session and initialize free-tier count.
- `POST /api/chat` with `{ sessionId, text, channel }`.
  - returns coach answer + live profile.
  - returns 402 when free-tier is reached.
- `GET /api/health` → health + API key presence.
- `GET /api/demo-readiness` → demo checks (api key, gating state, active sessions).
- `GET /api/privacy-proof` → verifiable privacy claims.
- `GET /api/retention` → retention policy; with `?sessionId=...` returns live session expiry.
- `DELETE /api/session/:sessionId` → immediate user-triggered session deletion.
- `GET /api/health` now includes active provider + models.
- `POST /api/ai-config` with `{ provider, modelChat, modelMemory }` for advanced internal testing.
- `POST /api/ai-probe` to verify active provider/model connectivity.
- `POST /api/session-mode` with `{ sessionId, mode }` to switch between `twin` and `coach`.
- `POST /api/consent` with `{ sessionId, consentVoiceAdapt, consentTwinTraining }` to update explicit session consent.
- `POST /api/voice/clone` (multipart form-data: `sessionId`, `audio`) to create session voice profile (consent required).
- `POST /api/voice/speak` with `{ sessionId, text }` to synthesize cloned voice audio when available.

## Multi-agent orchestration (simple v1)

In `server.js`:
- **CoachAgent**: action-focused response with one follow-up question.
- **MemoryAgent**: every 4 user turns, refreshes structured memory summary.

This gives a practical orchestrator foundation in one backend service.

## Privacy posture (demo-proof)

- In-memory only sessions (no database persistence).
- Session TTL auto-deletion (default 30 minutes).
- Request logs do not include chat message text.
- User can delete session instantly from UI ("Delete My Session Now").

## Why you saw "I hear you..."

That response is fallback mode (no live model). Use the fixed OpenRouter flow:
- ensure `OPENROUTER_API_KEY` is set,
- restart `npm run demo`,
- click "Test AI Engine",
- verify probe says `OK` and status says `Enabled: yes`.

## Coaching quality improvements (v2)

- Added user-state inference per session (`goal`, `emotion`, `tone`, `irony`, `phase`).
- Coach now mirrors user style intelligently, clarifies goals early, and always gives one concrete next step.
- Onboarding opening message is now structured to capture target identity + blockers + preferred coaching intensity.
- UI now shows live retention countdown to auto-delete for each session.

## Twin + Voice improvements (v3)

- Default mode is now `twin` (identity mirroring focus).
- `Twin Mode` and `Coach Mode` can be switched live per session.
- Added `Voice Lab`:
  - choose browser voice,
  - tune rate/pitch,
  - optional auto-adapt from inferred user style over time.

Important: exact voice cloning (same timbre as user) requires a dedicated voice-cloning API and explicit user consent/audio samples. Current MVP improves human-likeness and style adaptation with browser TTS.

## Advanced thinking + confidence gate (v5)

- The assistant runs an internal quality gate first and only answers when confidence is above threshold.
- If confidence is low, it asks a focused clarification question before giving advice.
- Config:
  - `AI_ADVANCED_THINKING=true`
  - `AI_CONFIDENCE_MIN=0.72`

## Automatic voice calibration (v5)

- Manual tuning controls were removed from UI.
- When `consentVoiceAdapt` is granted, the app calibrates from first voice samples automatically.
- It estimates base frequency and adapts speaking profile over time.

For true near-identical voice cloning (timbre + accent), add a dedicated voice-clone API (e.g. ElevenLabs/Cartesia) with explicit consent and reference audio upload.

## Voice cloning provider mode (v6)

- Provider abstraction added with `VOICE_PROVIDER`.
- Production-grade cloning integrations:
  - `VOICE_PROVIDER=elevenlabs`
  - `VOICE_PROVIDER=cartesia`
- Required env for cloned timbre matching:
  - ElevenLabs:
    - `ELEVENLABS_API_KEY=...`
    - `ELEVENLABS_MODEL_ID=eleven_multilingual_v2`
  - Cartesia:
    - `CARTESIA_API_KEY=...`
    - `CARTESIA_MODEL_ID=sonic-2`
    - `CARTESIA_CLONE_MODE=similarity` (or `stability`)
- Flow:
  - grant `consentVoiceClone`,
  - upload voice sample in Voice Lab,
  - cloned playback is used automatically when available.

## Consent behavior (v4)

- Voice adaptation is applied only when `consentVoiceAdapt` is granted.
- Twin identity adaptation is learned only when `consentTwinTraining` is granted.
- Consent is explicit, session-scoped, and updateable from the UI.

## 72-hour execution plan

### Day 1 (Build core)
- Ship this base app (voice + text + memory + gating).
- Polish onboarding copy and first prompt.
- Add persistent storage (SQLite or Supabase) for session and profile.

### Day 2 (Monetization + retention)
- Add Stripe Checkout + webhook.
- Add account login (magic link or OAuth).
- Add end-of-session report ("Who you are now" + 3 next actions).

### Day 3 (Launch)
- Improve prompts from 20-30 test conversations.
- Add simple landing page + waitlist + pricing.
- Record demo video and publish in 3 channels.

## Team split (4 including Copilot)

- **Louis (engineering lead)**
  - Backend orchestration, API quality, deployment.
- **Finn (AI/RL background)**
  - Prompt loops, memory quality, evaluation rubric.
- **Alex (product brain)**
  - user interviews, scripts, onboarding text, launch outreach.
- **Copilot (execution support)**
  - fast coding, refactors, bug fixes, docs, implementation guidance.

## Next implementation steps

- Add persistent DB (`sessions`, `messages`, `profiles`).
- Add auth and payment.
- Add dashboard with past sessions and progress curves.

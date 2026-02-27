# voice-agent

Node.js web service for voice/chat demo flows.

## Run locally

Requirements:

- Node.js 20+
- npm

Install and start:

```bash
npm install
npm start
```

Server binds to `0.0.0.0` and uses `PORT` env var (default `3000`).

Health check:

```bash
curl http://localhost:3000/health
```

## Run with Docker

Build image:

```bash
docker build -t voice-agent .
```

Run container:

```bash
docker run --rm -p 3000:3000 -e PORT=3000 voice-agent
```

Health check:

```bash
curl http://localhost:3000/health
```

## Environment variables

All API keys are optional at startup. The server still boots if they are missing and returns friendly provider/status messages in API responses.

Optional variables:

- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_BASE_URL`
- `OPENROUTER_BASE_URL`
- `VOICE_PROVIDER`
- `ELEVENLABS_API_KEY`
- `CARTESIA_API_KEY`
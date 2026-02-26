# Next Steps (Team of 4)

## Decision now (locked)

- Runtime: **OpenAI cloud first** for best quality and speed.
- Local mode (Ollama): optional later experiment, not the core path this week.
- Target models for next demos:
  - Chat: `gpt-4.1`
  - Memory: `gpt-4.1-mini`

## 24-hour task split

- **Louis (engineering)**
  - Add `OPENAI_API_KEY` in `.env` and validate probe is `OK`.
  - Run 20 test conversations.
  - Track failure cases (bad coaching, repetitive answers, weak memory).
  - Keep deployment stable and logs clean.

- **Finn (AI quality)**
  - Tune prompts for CoachAgent and MemoryAgent.
  - Create simple scoring sheet (1-5) for: relevance, actionability, emotional tone, memory accuracy.
  - Compare `gpt-4.1` vs `gpt-4.1-mini` on same test prompts.

- **Alex (product/growth)**
  - Define onboarding wording and trust messaging.
  - Prepare demo narrative: problem → live talk → profile insight → privacy proof.
  - Collect 5 pilot users and feedback.

- **Copilot (execution)**
  - Implement agreed prompt/model changes quickly.
  - Add small quality features (session report, evaluation endpoint, bug fixes).
  - Keep docs and run flow always up to date.

## Collaboration rhythm (efficient)

- 2 x daily checkpoints (15 min): morning priorities + evening results.
- Shared scorecard after each demo run:
  - What worked
  - What failed
  - What to change next
- Rule: one change batch at a time, test immediately, then decide next step.

## Demo checklist (next run)

- `npm run demo`
- Open `http://localhost:8080`
- In AI panel click `Best Quality Cloud`
- Click `Test AI Engine` and ensure probe is `OK`
- Check `GET /api/privacy-proof`
- Run 5-minute live conversation
- Show “Delete My Session Now” action
- Capture 3 screenshots + 1 short recording

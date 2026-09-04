# FixOnce

## Solve once. Reuse everywhere.

FixOnce is a shared memory layer for recurring problems. It recognizes when a new question describes an underlying problem that the community has already solved, returns the verified solution immediately, and uses Featherless AI only when community memory has no sufficiently strong match.

> We did not build another AI chatbot. We built memory for problems your community has already solved.

FixOnce is designed for workplaces, colleges, hackathons, support teams, and online communities where people repeatedly spend time rediscovering the same fixes.

## The problem and impact

When one person solves a problem, the solution is often trapped in a chat, ticket, or individual experience. The next person asks the same question with different wording and starts over.

```text
Person A: My office Wi-Fi says connected, but I cannot access the internet.
Person B: I am connected to the office network, but websites are not loading.
```

These are the same underlying problem. Without FixOnce, both people repeat the investigation and may trigger two AI generations. With FixOnce, Person B gets the verified community solution and no new AI generation is required.

The product measures the impact instead of inventing it: repeated queries, community hits, Featherless calls, search latency, fresh-AI latency, reuse events, reuse rate, and AI generations avoided.

## Why AI is essential

AI is used for two different jobs:

1. Meaning-aware retrieval: FixOnce converts problems into normalized vectors and compares them with cosine similarity. Synonyms, issue concepts, and multi-part intent signatures help differently worded technical questions match.
2. New-problem solving: when no trusted community fix is found, Featherless AI generates a structured troubleshooting playbook with a title, reason, ordered steps, verification check, and fallback path.

This makes Featherless part of the product loop, not decoration. FixOnce searches memory first, then generates only when necessary.

## The core workflow

```text
User describes a problem
          |
          v
Search verified community memory
          |
     Strong match?
       /       \
     YES        NO
      |          |
 Known Fix   Featherless AI
      |          |
  User tests  Suggested Fix
       \      /
        v    v
       Verify and optionally share
                 |
                 v
          Community Memory
```

Every solution starts private. A human must confirm that it worked, and sharing is always an explicit action.

## The two-laptop demo

This demonstrates the most important cross-device behavior.

1. Deploy the backend or run it locally.
2. Set the same backend URL in the FixOnce extension Options page on both laptops.
3. Reset demo memory if a repeatable demo is needed.
4. On Laptop A, search for:

   ```text
   My office Wi-Fi says connected, but I cannot access the internet.
   ```

5. FixOnce returns `NEW PROBLEM`, and Featherless generates a structured suggestion.
6. Test the suggestion, choose `Yes, it worked`, then choose `Share with community`.
7. On Laptop B, search for:

   ```text
   I am connected to the office network, but websites are not loading.
   ```

8. FixOnce returns `KNOWN FIX FOUND` with the same verified solution, real search latency, and `AI not required`.

The laptops do not need to be on the same Wi-Fi. They only need internet access to the same deployed backend. Private drafts are intentionally invisible to other users until they are verified and shared.

## Browser extension experience

The Chrome Manifest V3 extension is the primary user-facing product. It supports:

- A small popup for `Find known fix`.
- A selected-text context-menu action.
- Explicit ChatGPT and Claude support.
- A pre-send known-fix notice.
- Saving a useful answer from ChatGPT or Claude as a private draft.
- Optional automatic capture of the latest AI reply as a private draft.
- Verification, feedback, optional sharing, and alternative recovery paths.

By default, the extension observes only the prompt field (`textarea` or `contenteditable`). It does not intercept network traffic or automatically publish anything. If the user turns on `Auto-save AI replies` in the popup, it also observes the visible assistant response in the active ChatGPT or Claude page and sends it to the backend as a private draft. That opt-in setting is off by default.

While the user types, the extension performs a lookup-only request. If a match is found, it shows the known fix before the prompt is sent. If there is no match, the original prompt continues normally and the problem is stored locally as a pending item. With automatic capture enabled, the eventual AI answer is saved directly as a private draft; with it off, the user can save that answer manually later.

### Automatic AI-answer capture

When automatic capture is enabled:

1. The extension remembers the submitted problem.
2. It watches for the newest visible assistant response after ChatGPT or Claude answers.
3. A debounced update is sent to `POST /api/knowledge/auto-save`.
4. The backend keeps one private draft per conversation key.
5. If the AI continues the conversation, the latest response replaces the earlier draft.
6. Opening the FixOnce popup shows the private draft so the user can verify it and optionally share it.

The capture is never published automatically. Turning the switch off stops future captures; it does not delete drafts already saved.

## Technical architecture

```text
Chrome Extension / Dashboard
             |
             v
          FastAPI
             |
             +--> Safety classification
             |
             +--> Local semantic vector search
             |       |
             |       +--> Verified shared fix: return immediately
             |
             +--> Featherless chat completion on a miss
                     |
                     +--> Private structured draft
                             |
                             +--> Human verification and opt-in sharing
```

### Semantic retrieval

The local retrieval layer is dependency-light and fast:

- 384-dimensional normalized vectors.
- Hashed word and character n-grams for morphology and typo resilience.
- Domain synonym expansion for Wi-Fi, VPN, Git, printers, packages, certificates, and deployments.
- Concept fingerprints such as `VPN + internal access`, `printer + queue`, and `deployment + blank UI`.
- Cosine similarity with a configurable default threshold of `0.64`.
- Existing stored vectors are re-indexed when the backend starts so improvements apply to existing knowledge.

### Trust and quality

- Only `verified = 1` and `shared = 1` knowledge is searchable by the community.
- Generated answers remain private until a user tests and verifies them.
- Helpful and unhelpful feedback changes confidence and is stored for future ranking improvements.
- Personal, sensitive, and genuinely time-sensitive requests bypass reusable community memory.
- Featherless outages fall back to a clearly labeled local playbook instead of crashing the app or pretending an AI call succeeded.

## Project map

| Feature | Location |
| --- | --- |
| Semantic vectors and cosine similarity | `app/embeddings.py` |
| Match threshold and API routes | `app/main.py` |
| SQLite knowledge, query, and feedback tables | `app/db.py` |
| Featherless integration and structured playbooks | `app/featherless.py` |
| Privacy and time-sensitive request rules | `app/safety.py` |
| ChatGPT/Claude prompt detection | `extension/content.js` |
| Opt-in AI reply capture and latest-answer updates | `extension/content.js`, `extension/background.js` |
| Extension background API bridge | `extension/background.js` |
| Extension popup markup and actions | `extension/popup.html`, `extension/popup.js` |
| Extension/dashboard visual design | `extension/popup.css`, `extension/content.css`, `frontend/styles.css` |
| Community dashboard and analytics | `frontend/index.html`, `frontend/app.js` |
| Container deployment | `Dockerfile`, `render.yaml` |

## Dashboard and measurable impact

The dashboard is a community knowledge and analytics surface, not a chatbot. It shows real values from the database:

- Total queries.
- Semantic cache hits.
- Misses.
- Featherless calls.
- AI generations avoided.
- Reuse rate.
- Average community-search latency.
- Average fresh-AI latency.
- Verified fixes and successful reuses.

The `Run Demo Simulation` action uses a clearly labeled fixed paraphrase dataset and calculates its results at runtime. It does not display fabricated metrics.

## Run locally

```powershell
py -m pip install -r requirements.txt
Copy-Item .env.example .env
py -m uvicorn app.main:app --reload --port 8000
```

Open `http://localhost:8000`.

For real Featherless generations, set these values in the local `.env` file:

```text
FEATHERLESS_API_KEY=your-key-here
FEATHERLESS_MODEL=Qwen/Qwen2.5-7B-Instruct
FEATHERLESS_BASE_URL=https://api.featherless.ai/v1
```

Never commit `.env`. Hosted deployments should use Render environment secrets.

## Load the extension locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select `Load unpacked`.
4. Choose the `extension` folder.
5. Open Extension details -> Extension options.
6. Enter the deployed backend URL, or keep `http://localhost:8000` for local use.

After changing extension files, click `Reload` on the extension page and refresh ChatGPT or Claude tabs. Render updates the backend and dashboard, but the unpacked popup is loaded from the local `extension` folder.

## Deploy with Render

The dashboard and API are shipped in one Docker container. There is no separate frontend build or frontend service:

```text
Dockerfile
  -> app/
  -> frontend/
  -> extension/
```

The repository includes a free Render Blueprint in `render.yaml`.

1. Create a Render Blueprint from this repository.
2. Set `FEATHERLESS_API_KEY` as a Render secret.
3. Deploy the `main` branch.
4. Check `https://YOUR-SERVICE.onrender.com/api/health`.
5. Put that HTTPS URL into the extension Options page on each laptop.

The free Render plan provides shared server memory while the service is running, but its filesystem is ephemeral and can reset after a restart, deploy, or spin-down. Durable production memory should use a persistent disk or managed Postgres.

## API surface

```text
POST /api/search-memory                         lookup-only extension search
POST /api/find-fix                              search, then generate on a miss
POST /api/knowledge/save                        save a private AI answer draft
POST /api/knowledge/auto-save                   upsert an opt-in captured AI reply
POST /api/knowledge/{id}/alternative            generate a different recovery path
POST /api/knowledge/{id}/verify                 human verification
POST /api/knowledge/{id}/share                  explicit community sharing
POST /api/knowledge/{id}/feedback               helpful/unhelpful signal
GET  /api/knowledge                             verified shared knowledge
GET  /api/stats                                 measurable product metrics
GET  /api/health                                deployment health/config status
POST /api/demo/reset                            reset starter demo memory
POST /api/demo/run                              run the controlled simulation
```

## Why this approach is different

Most AI products generate another answer every time. FixOnce treats a solved problem as reusable community infrastructure:

- Search before generation.
- Reuse trusted knowledge before spending inference time.
- Let Featherless solve genuinely new cases.
- Require human verification before publishing.
- Preserve a failure note and generate an alternate path when the first fix fails on another device.
- Measure the work and AI calls avoided.

FixOnce turns individual problem-solving into shared community knowledge.

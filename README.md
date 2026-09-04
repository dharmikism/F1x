# FixOnce

FixOnce is a shared memory layer for recurring problems: semantic retrieval finds verified community fixes, while genuinely new problems receive a Featherless AI suggestion that stays private until a human verifies and explicitly shares it.

## Run locally

```powershell
py -m pip install -r requirements.txt
Copy-Item .env.example .env
py -m uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000. The app works without an API key using a clearly labeled local demo fallback. For a live Featherless generation, set `FEATHERLESS_API_KEY` and optionally `FEATHERLESS_MODEL` in `.env` before starting the server.

## Chrome extension

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the `extension` folder.
3. Keep the FixOnce API running on `http://localhost:8000`.

The popup is the primary extension flow. Selecting text and choosing **Find FixOnce solution** from the context menu pre-fills the popup without reading page content automatically.

## ChatGPT and Claude integration

The extension also has an explicit, site-limited integration for `chatgpt.com`, `chat.openai.com`, and `claude.ai`:

1. While a problem is being typed, the extension performs a lookup-only request against `/api/search-memory`. This endpoint never calls Featherless and never creates a draft.
2. If a verified match is found, FixOnce shows the solution before the prompt is sent. The user can use the known fix or intentionally continue to the AI site.
3. If no match is found, the original prompt continues normally to ChatGPT or Claude. The extension stores only the pending problem locally so the user can later open the popup and choose **Save an AI answer to memory**.
4. The user pastes the useful answer, saves it as a private draft, tests it, verifies it, and optionally shares it.

The content script only observes the supported prompt field and send action. It does not intercept network traffic, read unrelated page content, or automatically publish AI answers.

## Structured fixes and recovery paths

Featherless is prompted to return a reusable troubleshooting playbook with:

- a short title and reason the fix may work;
- 3 to 5 ordered steps;
- a concrete verification check;
- an `If it doesn't work` fallback path.

When a known fix fails on another laptop, the user can choose **I need another fix**, add a short failure note, and generate a separate private alternative. The original fix remains available, the failed attempt is recorded as negative feedback, and the alternative must still be tested, verified, and explicitly shared before it becomes community memory.

## Deploy with Docker

The dashboard and API ship as one container, so there is no frontend build step or separate service to coordinate:

```powershell
docker compose up --build -d
```

For a hosted deployment, use any Docker host. Set `FEATHERLESS_API_KEY`, `FEATHERLESS_MODEL`, `FEATHERLESS_BASE_URL`, `SIMILARITY_THRESHOLD`, and `ALLOWED_ORIGINS` as platform secrets/environment variables. Attach persistent storage at `/app/data`; SQLite is intentionally the source of truth for this MVP. The container listens on the platform `PORT` and exposes `/api/health` for health checks.

The repository also includes `render.yaml` for a free Render web service. Create a Blueprint from the repository, enter the requested `FEATHERLESS_API_KEY` secret, and use the generated `https://<service>.onrender.com` URL in the extension Options page. The free plan has an ephemeral filesystem, so the SQLite community memory is shared across laptops while the service is running but can reset after a restart, deploy, or spin-down. For durable production memory, use a paid persistent disk or move the database to an external managed Postgres service.

Never commit `.env`. It is ignored by git. The included local `.env` is for this workspace only; hosted deployments should use the provider's secret manager.

## Use the extension against a deployed backend

1. Start the local server or deploy the Docker container.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the `extension` folder.
4. Open the extension's **Details → Extension options** and enter your deployed HTTPS backend URL. Leave the default for local use.
5. Click the extension icon, enter a problem, and choose **Find known fix**. For selected text, right-click it and choose **Find FixOnce solution**, then open the extension popup.

For public Chrome Web Store distribution, replace the broad HTTPS host permission with the single deployed domain in `extension/manifest.json`, add PNG icons, zip the extension folder, and submit it through the Chrome Web Store dashboard.

## API

- `POST /api/find-fix`
- `POST /api/knowledge/{id}/verify`
- `POST /api/knowledge/{id}/share`
- `POST /api/knowledge/{id}/feedback`
- `GET /api/stats`
- `GET /api/knowledge`
- `POST /api/demo/reset`
- `POST /api/demo/run`

Knowledge and query metrics persist in `data/fixonce.db`. The default vector service uses normalized hashed word/character n-gram embeddings plus intent fingerprints for recurring issue patterns, then cosine similarity for retrieval. This keeps the MVP self-contained while allowing differently worded versions of the same technical problem to match through the shared server database.

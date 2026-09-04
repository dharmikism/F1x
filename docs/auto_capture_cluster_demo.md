# Auto-capture and local IP-cluster demo

> This is a design/demo only. It is not connected to FixOnce, is not loaded by
> the extension manifest, and must not be treated as production code.

## Is automatic saving possible?

Yes, with an explicit opt-in switch. The extension can watch the assistant
response area and send the newest response to one shared backend.

For a conversation with several follow-up questions, the backend can update one
candidate row:

~~~text
assistant reply 1 -> candidate.solution = reply 1
assistant reply 2 -> candidate.solution = reply 2
assistant reply 3 -> candidate.solution = reply 3
quiet period      -> reply 3 becomes the latest candidate
~~~

The demo waits 30 seconds after the last response update before finalizing it.
A real product should keep that row as pending_review and ask the user to
verify it before making it trusted community knowledge.

## Important limitations

ChatGPT and Claude do not provide a stable public DOM contract for extensions.
Reading their response DOM is fragile and can stop working when their sites
change. This proof of concept deliberately shows DOM observation; the current
FixOnce extension remains safer because it only observes the prompt field.

An IP address is not a reliable identity. DHCP, NAT, VPNs, and IPv6 can change
it. The IP cluster below is appropriate only for a controlled LAN demo.
Production should use authenticated users and workspaces.

## Demo layout

~~~text
Laptop A: 192.168.1.21
Laptop B: 192.168.1.22
Laptop C: 192.168.1.23
             |
             v
Central demo server: 192.168.1.10
             |
             v
One shared SQLite file: ./cluster-demo.db
~~~

The server, not each laptop, owns the storage file. Every laptop sends updates
to the same server.

## Shared cluster server: demo_cluster_server.py

This example reuses the current FixOnce embed and cosine functions but is not
imported by the real app. It stores the newest response for each conversation
and searches only finalized rows.

~~~python
# Import the module used to serialize vectors inside SQLite.
import json

# Import the module used to read optional environment settings.
import os

# Import the module used to validate private IP addresses.
import ipaddress

# Import the module used to create the shared SQLite database.
import sqlite3

# Import the module used to store update timestamps.
import time

# Import FastAPI request and error helpers.
from fastapi import FastAPI, HTTPException, Request

# Import Pydantic validation helpers.
from pydantic import BaseModel, Field

# Reuse the existing FixOnce semantic search implementation.
from app.embeddings import cosine, embed


# Create the demonstration API.
app = FastAPI(title="FixOnce IP Cluster Demo")

# Keep one database file on the central server.
DATABASE_PATH = os.getenv("CLUSTER_DATABASE_PATH", "./cluster-demo.db")

# Define the LAN range allowed to use this demonstration.
CLUSTER_NETWORK = ipaddress.ip_network("192.168.1.0/24")

# Keep the same similarity threshold as the current application.
SIMILARITY_THRESHOLD = 0.64

# Keep automatic publishing disabled by default.
AUTO_PUBLISH_AFTER_IDLE = False


# Validate an assistant response update.
class CandidateRequest(BaseModel):
    # Identify one browser conversation.
    conversation_id: str = Field(min_length=1, max_length=200)

    # Store the problem that started the conversation.
    problem: str = Field(min_length=3, max_length=2000)

    # Replace this with the newest assistant response.
    latest_solution: str = Field(min_length=10, max_length=30000)


# Validate a finalization request.
class FinalizeRequest(BaseModel):
    # Identify the conversation whose latest reply should be finalized.
    conversation_id: str = Field(min_length=1, max_length=200)


# Open one short-lived connection to the central storage file.
def connect():
    # Create the file if it does not exist.
    connection = sqlite3.connect(DATABASE_PATH)

    # Allow access to columns by name.
    connection.row_factory = sqlite3.Row

    # Return the open connection to the caller.
    return connection


# Create one shared table for all devices in the cluster.
def init_schema():
    # Open the central database.
    connection = connect()

    # Store one replaceable candidate for each cluster and conversation.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cluster_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cluster_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            problem TEXT NOT NULL,
            embedding TEXT NOT NULL,
            latest_solution TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'candidate',
            updated_at REAL NOT NULL,
            UNIQUE(cluster_id, conversation_id)
        )
        """
    )

    # Save the table definition.
    connection.commit()

    # Release the connection.
    connection.close()


# Resolve a device to the controlled LAN cluster.
def get_cluster_id(request: Request) -> str:
    # Read the address observed by the central server.
    client_host = request.client.host if request.client else ""

    # Convert the address into a validated IP object.
    try:
        client_ip = ipaddress.ip_address(client_host)
    except ValueError:
        raise HTTPException(status_code=400, detail="The client IP is invalid.")

    # Reject devices outside the demonstration subnet.
    if client_ip not in CLUSTER_NETWORK:
        raise HTTPException(status_code=403, detail="The device is outside the demo cluster.")

    # Give all nearby devices one shared namespace.
    return str(CLUSTER_NETWORK)


# Upsert every new assistant response as the current candidate.
@app.put("/demo/cluster/candidate")
def save_candidate(payload: CandidateRequest, request: Request):
    # Determine the cluster that owns this conversation.
    cluster_id = get_cluster_id(request)

    # Create an embedding for the original problem.
    problem_vector = json.dumps(embed(payload.problem))

    # Open the one shared database.
    connection = connect()

    # Replace reply 1 with reply 2 for the same conversation.
    connection.execute(
        """
        INSERT INTO cluster_memory
            (cluster_id, conversation_id, problem, embedding, latest_solution, status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'candidate', ?)
        ON CONFLICT(cluster_id, conversation_id)
        DO UPDATE SET
            problem = excluded.problem,
            embedding = excluded.embedding,
            latest_solution = excluded.latest_solution,
            status = 'candidate',
            updated_at = excluded.updated_at
        """,
        (
            cluster_id,
            payload.conversation_id,
            payload.problem,
            problem_vector,
            payload.latest_solution,
            time.time(),
        ),
    )

    # Persist the newest reply.
    connection.commit()

    # Release the database connection.
    connection.close()

    # Tell the extension that the candidate was stored.
    return {"ok": True, "status": "candidate", "cluster_id": cluster_id}


# Finalize the newest response after the quiet timer fires.
@app.post("/demo/cluster/finalize")
def finalize_candidate(payload: FinalizeRequest, request: Request):
    # Determine the cluster allowed to finalize this conversation.
    cluster_id = get_cluster_id(request)

    # Require review unless this is explicitly changed for a private demo.
    final_status = "final" if AUTO_PUBLISH_AFTER_IDLE else "pending_review"

    # Open the shared storage.
    connection = connect()

    # Change only the current candidate row.
    cursor = connection.execute(
        """
        UPDATE cluster_memory
        SET status = ?, updated_at = ?
        WHERE cluster_id = ? AND conversation_id = ? AND status = 'candidate'
        """,
        (final_status, time.time(), cluster_id, payload.conversation_id),
    )

    # Persist the status change.
    connection.commit()

    # Release the connection.
    connection.close()

    # Report whether a row was finalized.
    return {
        "ok": cursor.rowcount == 1,
        "status": final_status,
        "requires_review": final_status == "pending_review",
    }


# Search finalized solutions in the shared cluster.
@app.post("/demo/cluster/search")
def search_cluster(payload: CandidateRequest, request: Request):
    # Determine the cluster permitted to search.
    cluster_id = get_cluster_id(request)

    # Embed the new problem.
    query_vector = embed(payload.problem)

    # Open the shared database.
    connection = connect()

    # Do not expose unreviewed candidate answers.
    rows = connection.execute(
        "SELECT * FROM cluster_memory WHERE cluster_id = ? AND status = 'final'",
        (cluster_id,),
    ).fetchall()

    # Release the connection after reading the rows.
    connection.close()

    # Start with no match.
    best_row = None
    best_score = -1.0

    # Compare the query with every finalized solution.
    for row in rows:
        score = cosine(query_vector, json.loads(row["embedding"]))
        if score > best_score:
            best_row = row
            best_score = score

    # Reject weak or missing matches.
    if best_row is None or best_score < SIMILARITY_THRESHOLD:
        return {"result_type": "miss", "similarity": round(max(best_score, 0.0), 3)}

    # Return the newest finalized answer for the matching problem.
    return {
        "result_type": "known",
        "similarity": round(best_score, 3),
        "problem": best_row["problem"],
        "solution": best_row["latest_solution"],
    }


# Create the table when this demonstration server starts.
init_schema()
~~~

## Popup On/Off switch: demo_popup.html

The default is Off. The user must explicitly opt in.

~~~html
<!-- Declare the popup document type. -->
<!doctype html>

<!-- Start the popup document. -->
<html>
  <!-- Keep metadata separate from visible controls. -->
  <head>
    <!-- Support normal Unicode text. -->
    <meta charset="utf-8">
    <!-- Give the popup a descriptive title. -->
    <title>FixOnce auto-capture demo</title>
  </head>

  <!-- Show one simple user-controlled setting. -->
  <body>
    <!-- Identify the product. -->
    <h1>FixOnce</h1>
    <!-- Let the user turn automatic capture on or off. -->
    <label>
      <!-- Keep this checkbox unchecked by default. -->
      <input id="auto-capture" type="checkbox">
      <!-- Explain exactly what will be captured. -->
      Automatically save the latest AI reply
    </label>
    <!-- Give the user immediate state feedback. -->
    <p id="status">Automatic capture is off.</p>

    <!-- Load the popup logic after the controls are defined. -->
    <script src="demo_popup.js"></script>
  </body>
</html>
~~~

## Popup behavior: demo_popup.js

~~~javascript
// Find the checkbox control.
const toggle = document.querySelector("#auto-capture");

// Find the visible status label.
const status = document.querySelector("#status");

// Load the saved setting with a safe Off default.
chrome.storage.sync.get({ autoCaptureEnabled: false }, (settings) => {
  // Reflect the saved boolean in the checkbox.
  toggle.checked = Boolean(settings.autoCaptureEnabled);

  // Tell the user which state is active.
  status.textContent = toggle.checked
    ? "Automatic capture is on."
    : "Automatic capture is off.";
});

// Save every explicit change.
toggle.addEventListener("change", () => {
  // Persist the choice in browser sync storage.
  chrome.storage.sync.set({ autoCaptureEnabled: toggle.checked }, () => {
    // Confirm the saved state.
    status.textContent = toggle.checked
      ? "Automatic capture is on."
      : "Automatic capture is off.";
  });
});
~~~

## Background bridge: demo_background.js

The content script sends messages to the background worker. The worker owns
network access to the central cluster server.

~~~javascript
// Point the demo at the computer that owns the shared database.
const CLUSTER_SERVER = "http://192.168.1.10:8000";

// Read the user's explicit On or Off setting.
function isCaptureEnabled() {
  // Convert Chrome's callback API into a Promise.
  return new Promise((resolve) => {
    // Use Off as the safe default.
    chrome.storage.sync.get({ autoCaptureEnabled: false }, (settings) => {
      // Return a strict boolean to the caller.
      resolve(Boolean(settings.autoCaptureEnabled));
    });
  });
}

// Listen for candidate and finalization messages.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Process a new assistant response.
  if (message.type === "AUTO_CAPTURE_CANDIDATE") {
    // Run the request asynchronously.
    (async () => {
      // Never capture when the user turned the switch off.
      if (!(await isCaptureEnabled())) {
        sendResponse({ ok: false, reason: "disabled" });
        return;
      }

      // Upsert the newest reply into the shared storage.
      const response = await fetch(CLUSTER_SERVER + "/demo/cluster/candidate", {
        // Use PUT because this replaces the previous candidate.
        method: "PUT",
        // Tell the server to parse JSON.
        headers: { "Content-Type": "application/json" },
        // Send only the conversation problem and newest answer.
        body: JSON.stringify({
          conversation_id: message.conversationId,
          problem: message.problem,
          latest_solution: message.latestSolution,
        }),
      });

      // Report the server result to the content script.
      sendResponse({ ok: response.ok });
    })().catch(() => {
      // Hide implementation details from the user.
      sendResponse({ ok: false, reason: "server-unavailable" });
    });

    // Keep the response channel open for the async operation.
    return true;
  }

  // Process the quiet-period finalization request.
  if (message.type === "AUTO_CAPTURE_FINALIZE") {
    // Run the request asynchronously.
    (async () => {
      // Do not finalize anything after the user disables capture.
      if (!(await isCaptureEnabled())) {
        sendResponse({ ok: false, reason: "disabled" });
        return;
      }

      // Ask the server to finalize the latest candidate.
      const response = await fetch(CLUSTER_SERVER + "/demo/cluster/finalize", {
        // Use POST because the row status changes.
        method: "POST",
        // Tell the server to parse JSON.
        headers: { "Content-Type": "application/json" },
        // Identify the conversation to finalize.
        body: JSON.stringify({ conversation_id: message.conversationId }),
      });

      // Report the server result to the content script.
      sendResponse({ ok: response.ok });
    })().catch(() => {
      // Hide implementation details from the user.
      sendResponse({ ok: false, reason: "server-unavailable" });
    });

    // Keep the response channel open for the async operation.
    return true;
  }
});
~~~

## Response observer: demo_content.js

This proof of concept remembers the last submitted problem, watches likely
assistant-response elements, and sends the newest response. The selectors are
examples only and must be adapted when ChatGPT or Claude change their DOM.

~~~javascript
// Wait this long after a response update before treating it as complete.
const FINALIZE_AFTER_MS = 30000;

// Avoid sending a request for every streamed token.
const CAPTURE_DEBOUNCE_MS = 1200;

// Keep the current conversation state for this tab.
const state = {
  lastProblem: "",
  lastReply: "",
  captureTimer: null,
  finalizeTimer: null,
};

// Read the currently focused prompt field.
function readPrompt() {
  // Prefer a textarea prompt.
  const textarea = document.querySelector("textarea");

  // Return the textarea text when available.
  if (textarea && textarea.value.trim()) return textarea.value.trim();

  // Fall back to a contenteditable prompt.
  const editor = document.querySelector("[contenteditable='true']");

  // Return editor text or an empty string.
  return editor ? editor.innerText.trim() : "";
}

// Create a key for one browser conversation.
function conversationId() {
  // Use the hostname and path without storing the full URL.
  return location.hostname + ":" + location.pathname;
}

// Find the newest assistant response using demo-only selectors.
function latestAssistantReply() {
  // Include several possible site-specific selectors.
  const selectors = [
    "[data-message-author-role='assistant']",
    "[data-testid='conversation-turn-assistant']",
    ".assistant-turn",
  ];

  // Collect all matching elements.
  const nodes = selectors.flatMap((selector) => [
    ...document.querySelectorAll(selector),
  ]);

  // Remove duplicate elements from overlapping selectors.
  const uniqueNodes = [...new Set(nodes)];

  // Read the last assistant response on the page.
  const latest = uniqueNodes[uniqueNodes.length - 1];

  // Return normalized text or an empty string.
  return latest ? latest.innerText.trim() : "";
}

// Send the latest settled assistant response to storage.
function scheduleCandidateCapture() {
  // Cancel the previous short debounce.
  clearTimeout(state.captureTimer);

  // Wait briefly for streaming text to settle.
  state.captureTimer = setTimeout(() => {
    // Read the newest response.
    const reply = latestAssistantReply();

    // Ignore empty and unchanged responses.
    if (!state.lastProblem || !reply || reply === state.lastReply) return;

    // Make this response the newest candidate.
    state.lastReply = reply;

    // Send it to the background bridge.
    chrome.runtime.sendMessage({
      type: "AUTO_CAPTURE_CANDIDATE",
      conversationId: conversationId(),
      problem: state.lastProblem,
      latestSolution: reply,
    });

    // Restart the quiet-period timer so the newest reply wins.
    clearTimeout(state.finalizeTimer);
    state.finalizeTimer = setTimeout(() => {
      // Ask the server to finalize the newest candidate.
      chrome.runtime.sendMessage({
        type: "AUTO_CAPTURE_FINALIZE",
        conversationId: conversationId(),
      });
    }, FINALIZE_AFTER_MS);
  }, CAPTURE_DEBOUNCE_MS);
}

// Remember the problem before the website clears the input.
function rememberSubmittedProblem() {
  // Read the current prompt.
  const problem = readPrompt();

  // Keep only non-empty prompts.
  if (problem) state.lastProblem = problem;
}

// Remember a prompt sent with plain Enter.
document.addEventListener("keydown", (event) => {
  // Ignore Shift+Enter because it usually creates a new line.
  if (event.key === "Enter" && !event.shiftKey) {
    rememberSubmittedProblem();
  }
}, true);

// Remember a prompt sent with a likely Send button.
document.addEventListener("click", (event) => {
  // Find the clicked button.
  const button = event.target.closest ? event.target.closest("button") : null;

  // Ignore clicks that are not buttons.
  if (!button) return;

  // Combine accessible labels for a simple demo detector.
  const label = [
    button.getAttribute("aria-label") || "",
    button.getAttribute("title") || "",
    button.innerText || "",
  ].join(" ").toLowerCase();

  // Remember the prompt only for a likely send action.
  if (/send|submit/.test(label)) rememberSubmittedProblem();
}, true);

// Observe new assistant nodes and streaming text changes.
const observer = new MutationObserver(() => {
  // Debounce and inspect the newest response.
  scheduleCandidateCapture();
});

// Start observing once the page body exists.
if (document.body) {
  // Watch added nodes and changed response text.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
~~~

## How the last reply replaces earlier replies

The content script sends a candidate update after each settled assistant
response. The server upsert uses the same cluster and conversation key, so the
latest response replaces the previous candidate instead of creating duplicate
answers. The quiet timer then marks that latest candidate as pending_review or
final, depending on the server setting.

The safe production flow should be:

~~~text
AI reply 1 -> private candidate
AI reply 2 -> replace private candidate
AI final reply -> pending review
User verifies -> trusted community solution
~~~

## What this demo proves

- The user can turn automatic capture On or Off.
- The latest assistant reply replaces the previous candidate.
- One central server stores the candidate for all devices in the IP range.
- A quiet period can identify the latest reply as the final candidate.
- Semantic search can reuse the finalized answer across nearby laptops.

## What should change before real implementation

- Keep auto-captured answers private or pending_review by default.
- Add a visible Review and share action before community publication.
- Redact passwords, API keys, personal data, and private conversation content.
- Use authenticated workspaces instead of IP addresses.
- Use stable supported integrations or user-triggered capture instead of fragile DOM selectors.
- Add retention, delete, audit, and correction controls.
- Keep the existing verified/shared filter so unreviewed answers cannot become trusted fixes.

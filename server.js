// =============================================================
// 🧠 A10 Runner - Final Stable Server.js (Fully Fixed Version)
// =============================================================

// Import all required packages
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(bodyParser.json({ limit: "5mb" }));

// -------------------------------------------------------------
// 1️⃣ HEALTH CHECK ENDPOINT
// -------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// -------------------------------------------------------------
// 2️⃣ HELPER: CALL OPENAI CHAT API
// -------------------------------------------------------------
async function callOpenAI(model, instruction) {
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant that writes short motivational quotes.",
          },
          { role: "user", content: instruction },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API error: ${errText}`);
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || "Keep pushing forward — progress is progress!";
  } catch (err) {
    console.error("❌ OpenAI call failed:", err.message);
    return "Keep going — every small step counts!";
  }
}

// -------------------------------------------------------------
// 3️⃣ HELPER: COMMIT CHANGES TO GITHUB
// -------------------------------------------------------------
async function commitToGitHub(owner, repo, path, content, message, branch) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  let sha = null;

  // STEP 1: Try fetching the existing file
  const getRes = await fetch(`${apiUrl}?ref=${branch}`, {
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
    },
  });

  if (getRes.ok) {
    const fileData = await getRes.json();
    sha = fileData.sha; // file exists, reuse SHA
  } else {
    console.warn(`⚠️ File not found at ${path}. Creating new file.`);
  }

  // STEP 2: Ensure valid HTML structure
  if (!content.includes("<html")) {
    content = `
      <!doctype html>
      <html>
        <head><meta charset="utf-8"><title>A10</title></head>
        <body>
          <h1>Hello from A10 Orchestrator 🎉</h1>
          <p>Deployed at: ${new Date().toISOString()}</p>
          <p><em>"${content.replace(/"/g, "&quot;")}"</em></p>
        </body>
      </html>
    `;
  }

  // STEP 3: Commit file to GitHub
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    sha,
  };

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    console.error("❌ GitHub commit failed:", errText);
    throw new Error(`GitHub commit failed: ${errText}`);
  }

  const result = await putRes.json();
  console.log("✅ Commit successful:", result.commit?.sha);
  return result.commit?.sha;
}

// -------------------------------------------------------------
// 4️⃣ MAIN: /run ACTION ENDPOINT
// -------------------------------------------------------------
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body;

    if (!action) {
      return res.status(400).json({ ok: false, error: "Missing action" });
    }

    // Handle only one supported action for now
    if (action === "openai.edit-and-commit") {
      const {
        model,
        instruction,
        owner,
        repo,
        path,
        branch,
        message,
        commit,
      } = payload;

      // Step 1: Get new quote from OpenAI
      const quote = await callOpenAI(model, instruction);
      console.log("✨ Quote generated:", quote);

      // Step 2: Fetch the existing file from GitHub
      const fileApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
      let oldContent = "";
      const getFileRes = await fetch(fileApiUrl, {
        headers: {
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
        },
      });

      if (getFileRes.ok) {
        const fileJson = await getFileRes.json();
        oldContent = Buffer.from(fileJson.content, "base64").toString("utf8");
      } else {
        console.warn("⚠️ File not found — creating a new one from scratch.");
        oldContent = `
          <!doctype html>
          <html>
            <head><meta charset="utf-8"><title>A10</title></head>
            <body>
              <h1>Hello from A10 Orchestrator 🎉</h1>
              <p>Deployed at: ${new Date().toISOString()}</p>
            </body>
          </html>
        `;
      }

      // Step 3: Insert the motivational quote
      const newContent = oldContent.replace(
        "</body>",
        `<p><em>"${quote}"</em></p></body>`
      );

      // Step 4: Commit the updated file to GitHub
      let commitSha = null;
      if (commit) {
        commitSha = await commitToGitHub(
          owner,
          repo,
          path,
          newContent,
          message,
          branch
        );
      }

      // Step 5: Return success response
      return res.json({
        ok: true,
        action,
        result: { ok: true, commitSha, quote },
      });
    }

    // Unknown action handler
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ Runner error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 5️⃣ START SERVER
// -------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 A10 Runner listening on port ${PORT}`);
  console.log(`✅ Your service is live at: https://a10-runner.onrender.com`);
});

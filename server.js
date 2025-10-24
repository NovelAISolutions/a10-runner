import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Helper: Call OpenAI
async function callOpenAI(model, prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }]
    })
  });
  return r.json();
}

// Helper: Commit to GitHub
async function commitToGitHub(owner, repo, path, content, message, branch = "main") {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      branch
    })
  });
  return r.json();
}

// ===========================
// Main /run Endpoint
// ===========================
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body;

    // 1️⃣ OpenAI Chat
    if (action === "openai.chat") {
      const result = await callOpenAI(payload.model, payload.prompt);
      res.json({
        ok: true,
        action,
        result: {
          ok: true,
          model: payload.model,
          text: result.choices?.[0]?.message?.content ?? "(no text)"
        }
      });
      return;
    }

    // 2️⃣ GitHub Commit
    if (action === "github.commit") {
      const result = await commitToGitHub(
        payload.owner,
        payload.repo,
        payload.path,
        payload.content,
        payload.message,
        payload.branch
      );
      res.json({ ok: true, action, result });
      return;
    }

// 3️⃣ OpenAI Edit + Commit
if (action === "openai.edit-and-commit") {
  console.log("🧠 Running openai.edit-and-commit...");
  
  // Step 1: Fetch current file from GitHub
  const ghFile = await fetch(
    `https://api.github.com/repos/${payload.owner}/${payload.repo}/contents/${payload.path}`,
    { headers: { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}` } }
  );
  const ghJson = await ghFile.json();
  const original = Buffer.from(ghJson.content, "base64").toString("utf-8");

  // Step 2: Ask OpenAI for a motivational quote
  const prompt = `Give me one short motivational quote about coding or perseverance, no formatting.`;
  const aiResult = await callOpenAI(payload.model, prompt);
  const quote = aiResult.choices?.[0]?.message?.content?.trim() || "Keep pushing code forward!";

  console.log("💬 AI quote:", quote);

  // Step 3: Inject the quote before </body>
  let newHtml = original;
  if (original.includes("</body>")) {
    newHtml = original.replace(
      /<\/body>/i,
      `<p><em>"${quote}"</em></p>\n</body>`
    );
  } else {
    newHtml += `<p><em>"${quote}"</em></p>`;
  }

  // Step 4: Commit the updated HTML to GitHub
  const result = await commitToGitHub(
    payload.owner,
    payload.repo,
    payload.path,
    newHtml,
    payload.message,
    payload.branch
  );

  res.json({
    ok: true,
    action,
    result: { ok: true, commitSha: result.commit?.sha ?? null, quote }
  });
  return;
}

    // 4️⃣ Unknown Action
    res.status(400).json({ ok: false, error: "Unknown or missing action", action });

  } catch (err) {
    console.error("Runner Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(10000, () => {
  console.log("🚀 A10 Runner listening on port 10000");
  console.log("✅ Your service is live 🎉");
});

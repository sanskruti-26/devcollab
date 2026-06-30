// routes/ai.js — AI pair programmer endpoint (Google Gemini)
// POST /api/v1/ai/ask — sends file content + question to Gemini, returns the answer
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const auth = require("../middleware/auth");

// 20 AI requests per minute per user (auth runs first so req.user is set)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests — please slow down" },
});

// Truncate file content so we don't blow up the context window / token budget
const MAX_FILE_CHARS = 8000;
const GEMINI_MODEL   = "gemini-2.5-flash";

// POST /api/v1/ai/ask
router.post("/ask", auth, aiLimiter, async (req, res) => {
  const { fileContent, language, question } = req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: "Question is required" });
  }

  // Friendly message when key is not configured — mirrors the Judge0 execute route pattern
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "AI is not configured — add GEMINI_API_KEY to backend/.env",
    });
  }

  // Trim the file content so a huge file doesn't eat the whole context window
  const content = (fileContent || "").slice(0, MAX_FILE_CHARS);
  const wasTruncated = (fileContent || "").length > MAX_FILE_CHARS;

  const systemInstruction = `You are an expert pair programmer helping a developer edit ${language || "code"} in a collaborative editor.
Be concise and practical. When showing code, use markdown fenced code blocks with the correct language tag.
Focus on the specific code shared — avoid generic advice when you can be concrete.`;

  const userMessage = `Here is the current file (${language || "unknown"})${wasTruncated ? " [truncated to first 8000 chars]" : ""}:

\`\`\`${language || ""}
${content}
\`\`\`

My question: ${question.trim()}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userMessage }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error("Gemini API error:", response.status, errBody);
      return res.status(502).json({ error: "AI service returned an error — please try again" });
    }

    const data = await response.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "(no response)";

    res.json({ answer });
  } catch (err) {
    console.error("AI route error:", err.message);
    res.status(500).json({ error: "Could not reach the AI service — check your connection" });
  }
});

module.exports = router;

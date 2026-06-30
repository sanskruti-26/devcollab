// routes/ai.js — AI pair programmer endpoint (Google Gemini)
// POST /api/v1/ai/ask — sends file content + question to Gemini, returns the answer
const router = require("express").Router();
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const auth = require("../middleware/auth");

// 20 AI requests per minute per user (auth runs first so req.user is set).
// Falls back to IP only if somehow unauthenticated; ipKeyGenerator normalizes
// IPv6 addresses (e.g. by /64 prefix) as express-rate-limit v8 requires —
// using req.ip directly here throws ERR_ERL_KEY_GEN_IPV6 at startup.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests — please slow down" },
});

// Truncate file content so we don't blow up the context window / token budget
const MAX_FILE_CHARS    = 8000;
const MAX_HISTORY_TURNS = 10; // last 10 messages (~5 exchanges) of prior conversation
const GEMINI_MODEL      = "gemini-2.5-flash";

// POST /api/v1/ai/ask
router.post("/ask", auth, aiLimiter, async (req, res) => {
  const { fileContent, selection, language, question, history } = req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: "Question is required" });
  }

  // Friendly message when key is not configured — mirrors the Judge0 execute route pattern
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "AI is not configured — add GEMINI_API_KEY to backend/.env",
    });
  }

  // A selected snippet is smaller and more focused than the whole file — prefer it when present
  const hasSelection = !!selection?.trim();
  const rawContext   = hasSelection ? selection : (fileContent || "");
  const content      = rawContext.slice(0, MAX_FILE_CHARS);
  const wasTruncated = rawContext.length > MAX_FILE_CHARS;
  const contextLabel = hasSelection ? "selected code snippet" : "current file";

  const systemInstruction = `You are an expert pair programmer helping a developer edit ${language || "code"} in a collaborative editor.
Be concise and practical. When showing code, use markdown fenced code blocks with the correct language tag.
Focus on the specific code shared — avoid generic advice when you can be concrete.`;

  const userMessage = `Here is the ${contextLabel} (${language || "unknown"})${wasTruncated ? " [truncated to first 8000 chars]" : ""}:

\`\`\`${language || ""}
${content}
\`\`\`

My question: ${question.trim()}`;

  // Prior turns let the AI follow up ("now refactor that") instead of answering cold each time.
  // Capped to the last MAX_HISTORY_TURNS messages to bound token usage.
  const priorTurns = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];
  const contents = [
    ...priorTurns
      .filter((m) => m?.role && m?.content)
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content).slice(0, MAX_FILE_CHARS) }],
      })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents,
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

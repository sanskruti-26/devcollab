// pages/RoomPage.jsx — collaborative editor with live cursors, chat, and more
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Editor from "@monaco-editor/react";
import api from "../lib/api";
import socket from "../lib/socket";
import { useAuth } from "../hooks/useAuth";

const LANGUAGES = ["javascript", "typescript", "python", "java", "cpp"];

const MONACO_LANG = {
  javascript: "javascript",
  typescript: "typescript",
  python: "python",
  java: "java",
  cpp: "cpp",
};

const CURSOR_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#ef4444"];

const THEMES = [
  { value: "vs-dark", label: "Dark" },
  { value: "vs", label: "Light" },
  { value: "hc-black", label: "High Contrast" },
];

function getCursorColor(socketId) {
  const hash = [...socketId].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

// Injects CSS for a user's cursor line highlight and selection highlight
function injectCursorCSS(socketId, color) {
  if (document.getElementById(`cstyle-${socketId}`)) return;
  const [r, g, b] = [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
  const el = document.createElement("style");
  el.id = `cstyle-${socketId}`;
  el.textContent = `
    .rcursor-${socketId}    { background: rgba(${r},${g},${b},0.18) !important; border-left: 2px solid ${color} !important; }
    .rselection-${socketId} { background: rgba(${r},${g},${b},0.28) !important; }
  `;
  document.head.appendChild(el);
}

export default function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [room, setRoom] = useState(null);
  const [code, setCode] = useState("// Loading...");
  const [language, setLanguage] = useState("javascript");
  const [editorTheme, setEditorTheme] = useState("vs-dark");
  const [participants, setParticipants] = useState([]);
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Password protection
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [roomPassword, setRoomPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [typingUsers, setTypingUsers] = useState([]);

  // Code execution — shared across all users via socket
  const [runOutput, setRunOutput] = useState(null);  // { output, by } | null
  const [runningBy, setRunningBy] = useState(null);  // name of whoever clicked Run

  // Session replay
  const [replayMode, setReplayMode] = useState(false);
  const [replaySnapshots, setReplaySnapshots] = useState([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);

  // Toasts
  const [toasts, setToasts] = useState([]);

  const isRemoteChange = useRef(false);
  const editorRef = useRef(null);
  const chatEndRef = useRef(null);
  const typingTimerRef = useRef(null);
  const lastCursorEmit = useRef(0);
  const socketSetup = useRef(false);               // prevent duplicate event registration
  const decorationCollections = useRef(new Map()); // socketId -> line highlight collection
  const selectionCollections = useRef(new Map());  // socketId -> selection highlight collection
  const cursorWidgets = useRef(new Map());         // socketId -> { widget, domNode }
  const replayTimerRef = useRef(null);             // setInterval handle for auto-play

  useEffect(() => {
    loadRoom();
    return () => {
      socket.emit("leave-room", { roomId });
      socket.disconnect();
      socketSetup.current = false;
      clearTimeout(typingTimerRef.current);
      clearInterval(replayTimerRef.current);
      decorationCollections.current.forEach((c) => c.clear());
      decorationCollections.current.clear();
      selectionCollections.current.forEach((c) => c.clear());
      selectionCollections.current.clear();
      cursorWidgets.current.forEach(({ widget }) => {
        editorRef.current?.removeContentWidget(widget);
      });
      cursorWidgets.current.clear();
    };
  }, [roomId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function addToast(message) {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }

  // Update or add the floating name label above a remote user's cursor
  function updateCursorWidget(socketId, userName, lineNumber) {
    const editor = editorRef.current;
    if (!editor) return;

    const color = getCursorColor(socketId);
    const existing = cursorWidgets.current.get(socketId);

    // Remove old widget so we can re-add at the new line
    if (existing) editor.removeContentWidget(existing.widget);

    const domNode = document.createElement("div");
    domNode.textContent = userName;
    domNode.style.cssText = `background:${color};color:white;font-size:11px;padding:1px 6px;border-radius:3px 3px 3px 0;white-space:nowrap;pointer-events:none;font-family:-apple-system,sans-serif;line-height:16px;`;

    const widget = {
      getId: () => `clabel-${socketId}`,
      getDomNode: () => domNode,
      getPosition: () => ({
        position: { lineNumber, column: 1 },
        preference: [1], // 1 = ContentWidgetPositionPreference.ABOVE
      }),
    };

    editor.addContentWidget(widget);
    cursorWidgets.current.set(socketId, { widget, domNode });
  }

  function updateRemoteCursor(socketId, userName, position, selection) {
    const editor = editorRef.current;
    if (!editor) return;

    const color = getCursorColor(socketId);
    injectCursorCSS(socketId, color);

    // 1. Line highlight decoration
    const lineDecoration = {
      range: { startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: 1 },
      options: { isWholeLine: true, className: `rcursor-${socketId}`, overviewRuler: { color } },
    };
    const existingLine = decorationCollections.current.get(socketId);
    if (existingLine) {
      existingLine.set([lineDecoration]);
    } else {
      decorationCollections.current.set(socketId, editor.createDecorationsCollection([lineDecoration]));
    }

    // 2. Floating name label (content widget)
    updateCursorWidget(socketId, userName, position.lineNumber);

    // 3. Selection highlight (only when text is actually selected)
    const existingSel = selectionCollections.current.get(socketId);
    const hasSelection = selection &&
      (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn);

    if (hasSelection) {
      const selDecoration = {
        range: selection,
        options: { className: `rselection-${socketId}` },
      };
      if (existingSel) {
        existingSel.set([selDecoration]);
      } else {
        selectionCollections.current.set(socketId, editor.createDecorationsCollection([selDecoration]));
      }
    } else if (existingSel) {
      existingSel.clear();
    }
  }

  function clearRemoteCursor(socketId) {
    decorationCollections.current.get(socketId)?.clear();
    decorationCollections.current.delete(socketId);
    selectionCollections.current.get(socketId)?.clear();
    selectionCollections.current.delete(socketId);
    const w = cursorWidgets.current.get(socketId);
    if (w) editorRef.current?.removeContentWidget(w.widget);
    cursorWidgets.current.delete(socketId);
    document.getElementById(`cstyle-${socketId}`)?.remove();
  }

  async function loadRoom(password = null) {
    try {
      const params = password ? { password } : {};
      const { data } = await api.get(`/api/v1/rooms/${roomId}`, { params });
      setRoom(data);
      setCode(data.content);
      setLanguage(data.language);
      setPasswordRequired(false);
      setPasswordError("");
      connectSocket();
    } catch (err) {
      if (err.response?.data?.requiresPassword) {
        setPasswordRequired(true);
      } else if (err.response?.status === 403) {
        setPasswordError("Wrong password, try again");
      } else {
        alert("Room not found");
        navigate("/dashboard");
      }
    }
  }

  function connectSocket() {
    if (socketSetup.current) return; // already connected
    socketSetup.current = true;

    // "connect" fires on initial connect AND every reconnect in Socket.io v4
    // (socket.on("reconnect") is a Manager event and won't fire on the socket instance)
    socket.on("connect", () => {
      socket.emit("join-room", { roomId, userName: user?.name || "Anonymous" });
    });

    socket.connect();

    socket.on("init-code", ({ code: initCode }) => {
      const current = editorRef.current?.getModel()?.getValue();
      if (current !== initCode) {
        isRemoteChange.current = true;
        setCode(initCode);
      }
    });

    socket.on("code-update", ({ code: remoteCode, language: lang }) => {
      const current = editorRef.current?.getModel()?.getValue();
      if (current !== remoteCode) {
        isRemoteChange.current = true;
        setCode(remoteCode);
      }
      if (lang) setLanguage(lang);
    });

    socket.on("language-update", ({ language: lang }) => setLanguage(lang));
    socket.on("participants-update", (list) => setParticipants(list));

    socket.on("user-joined", ({ userName }) => addToast(`${userName} joined`));
    socket.on("user-left", ({ userName, socketId }) => {
      addToast(`${userName} left`);
      clearRemoteCursor(socketId);
      setTypingUsers((prev) => prev.filter((u) => u !== userName));
    });

    socket.on("cursor-update", ({ socketId, userName, position, selection }) => {
      updateRemoteCursor(socketId, userName, position, selection);
    });

    // Shared code execution events
    socket.on("run-start", ({ runnerName }) => {
      setRunningBy(runnerName);
      setRunOutput(null);
    });
    socket.on("run-result", ({ output, runnerName }) => {
      setRunningBy(null);
      setRunOutput({ output, by: runnerName });
    });

    socket.on("message-history", (msgs) => setMessages(msgs));
    socket.on("new-message", (msg) => setMessages((prev) => [...prev, msg]));

    socket.on("user-typing", ({ userName }) => {
      setTypingUsers((prev) => (prev.includes(userName) ? prev : [...prev, userName]));
    });
    socket.on("user-stopped-typing", ({ userName }) => {
      setTypingUsers((prev) => prev.filter((u) => u !== userName));
    });
  }

  function handleCodeChange(value) {
    if (isRemoteChange.current) {
      isRemoteChange.current = false;
      return;
    }
    setCode(value);
    socket.emit("code-change", { roomId, code: value, language });
  }

  function handleEditorMount(editor) {
    editorRef.current = editor;
    isRemoteChange.current = false;

    // Track cursor AND selection changes, throttled to 20/s
    editor.onDidChangeCursorSelection((e) => {
      const now = Date.now();
      if (now - lastCursorEmit.current < 50) return;
      lastCursorEmit.current = now;

      const sel = e.selection;
      const hasSelection = !(
        sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn
      );

      socket.emit("cursor-move", {
        roomId,
        position: { lineNumber: sel.positionLineNumber, column: sel.positionColumn },
        selection: hasSelection
          ? { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn,
              endLineNumber: sel.endLineNumber, endColumn: sel.endColumn }
          : null,
      });
    });
  }

  function handleLanguageChange(e) {
    const lang = e.target.value;
    setLanguage(lang);
    socket.emit("language-change", { roomId, language: lang });
  }

  function copyShareLink() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadCode() {
    const extensions = { javascript: "js", typescript: "ts", python: "py", java: "java", cpp: "cpp" };
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code.${extensions[language] || "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleMessageChange(e) {
    setNewMessage(e.target.value);
    socket.emit("typing-start", { roomId });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => socket.emit("typing-stop", { roomId }), 1500);
  }

  function sendMessage(e) {
    e.preventDefault();
    if (!newMessage.trim()) return;
    socket.emit("send-message", { roomId, text: newMessage });
    socket.emit("typing-stop", { roomId });
    clearTimeout(typingTimerRef.current);
    setNewMessage("");
  }

  async function runCode() {
    if (runningBy) return; // block if someone is already running
    const name = user?.name || "Anonymous";

    // Show "running" immediately on the runner's tab; broadcast to others via socket
    setRunningBy(name);
    setRunOutput(null);
    socket.emit("run-start", { roomId, runnerName: name });

    // Calls the execute API and returns the output string
    async function attempt() {
      const { data } = await api.post("/api/v1/rooms/execute", { code, language });
      return data.output || "(no output)";
    }

    try {
      let output;
      try {
        output = await attempt();
      } catch (firstErr) {
        // 503 with JUDGE0_KEY message = config error, no point retrying
        const is503NoKey = firstErr.response?.status === 503 &&
          firstErr.response?.data?.error?.includes("JUDGE0_KEY");
        const isRetryable = !is503NoKey &&
          (!firstErr.response || firstErr.response.status >= 500);

        if (!isRetryable) throw firstErr;

        // Likely Render cold start — show hint as a subtitle under "running..."
        // then retry once after 3 s (by then Render should be awake)
        setRunOutput({ output: "Server is waking up — retrying in 3 seconds...", by: name });
        await new Promise((r) => setTimeout(r, 3000));
        setRunOutput(null);
        output = await attempt(); // throws if retry also fails → caught below
      }

      setRunningBy(null);
      setRunOutput({ output, by: name });
      socket.emit("run-result", { roomId, output, runnerName: name });
    } catch (err) {
      const status = err.response?.status;
      const serverMsg = err.response?.data?.error || "";

      let output;
      if (status === 503 && serverMsg.includes("JUDGE0_KEY")) {
        output = "Code execution not configured — add JUDGE0_KEY to backend/.env";
      } else if (!err.response) {
        output = "Server is not responding. Try again in a moment.";
      } else {
        output = serverMsg || err.message || "Execution failed";
      }

      setRunningBy(null);
      setRunOutput({ output, by: name });
      socket.emit("run-result", { roomId, output, runnerName: name });
    }
  }

  // ── Session replay ─────────────────────────────────────────────────────────

  async function openReplay() {
    setReplayLoading(true);
    console.log(`[Replay] fetching room=${roomId}`);
    try {
      const { data } = await api.get(`/api/v1/rooms/${roomId}/replay`);
      console.log(`[Replay] loaded ${data.length} snapshots`);
      if (!data.length) {
        addToast("No replay data yet — edit some code first");
        return;
      }
      setReplaySnapshots(data);
      setReplayIndex(0);
      setReplayMode(true);
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error || err.message;
      console.error(`[Replay] failed — status=${status} msg=${msg}`);
      addToast(status === 403 ? "Access denied for replay" : `Could not load replay (${status ?? "network error"})`);
    } finally {
      setReplayLoading(false);
    }
  }

  function closeReplay() {
    clearInterval(replayTimerRef.current);
    setReplayMode(false);
    setReplayPlaying(false);
    setReplaySnapshots([]);
  }

  function togglePlay(snapshots) {
    if (replayPlaying) {
      clearInterval(replayTimerRef.current);
      setReplayPlaying(false);
      return;
    }
    setReplayPlaying(true);
    replayTimerRef.current = setInterval(() => {
      setReplayIndex((prev) => {
        if (prev >= snapshots.length - 1) {
          clearInterval(replayTimerRef.current);
          setReplayPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 750);
  }

  // ── Password modal (full-screen block until correct password entered) ──────
  if (passwordRequired) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 w-80 shadow-2xl">
          <p className="text-2xl text-center mb-2">🔒</p>
          <h3 className="text-white font-semibold text-center mb-1">Password required</h3>
          <p className="text-gray-400 text-sm text-center mb-5">This room is password protected</p>
          {passwordError && (
            <p className="text-red-400 text-sm text-center mb-3">{passwordError}</p>
          )}
          <form onSubmit={(e) => { e.preventDefault(); loadRoom(roomPassword); }}>
            <input
              type="password"
              value={roomPassword}
              onChange={(e) => setRoomPassword(e.target.value)}
              placeholder="Enter room password"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white mb-3 focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-lg font-medium transition"
            >
              Join Room
            </button>
          </form>
          <button
            onClick={() => navigate("/dashboard")}
            className="mt-3 w-full text-gray-500 hover:text-gray-300 text-sm transition"
          >
            ← Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Main editor UI ──────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-gray-950">

      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="bg-gray-800 border border-gray-700 text-white text-sm px-4 py-2.5 rounded-lg shadow-xl">
            {t.message}
          </div>
        ))}
      </div>

      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/dashboard")} className="text-gray-400 hover:text-white text-sm transition">
            ← Back
          </button>
          <span className="text-white font-semibold">{room?.name || "Loading..."}</span>
          {room?.hasPassword && <span title="Password protected" className="text-gray-500 text-xs">🔒</span>}
          <span className="text-gray-500 text-xs font-mono bg-gray-800 px-2 py-0.5 rounded">#{roomId}</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Language selector */}
          <select
            value={language}
            onChange={handleLanguageChange}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>

          {/* Theme selector */}
          <select
            value={editorTheme}
            onChange={(e) => setEditorTheme(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          {/* Run — disabled while anyone in the room is running */}
          <button
            onClick={runCode}
            disabled={!!runningBy}
            className="bg-green-600 hover:bg-green-500 disabled:bg-green-900 disabled:text-green-700 text-white px-3 py-1 rounded-lg text-sm font-medium transition"
          >
            {runningBy ? `${runningBy.split(" ")[0]} running...` : "▶ Run"}
          </button>

          {/* Participant avatars with online dot */}
          <div className="flex -space-x-1">
            {participants.slice(0, 4).map((p) => (
              <div key={p.socketId} className="relative">
                <div
                  title={p.userName}
                  style={{ backgroundColor: getCursorColor(p.socketId) }}
                  className="w-7 h-7 rounded-full border-2 border-gray-900 flex items-center justify-center text-xs font-bold text-white"
                >
                  {p.userName[0]?.toUpperCase()}
                </div>
                <span className="absolute bottom-0 right-0 w-2 h-2 bg-green-400 rounded-full border border-gray-900" />
              </div>
            ))}
          </div>

          {/* Download */}
          <button onClick={downloadCode} className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition">
            ⬇ Download
          </button>

          {/* Share */}
          <button onClick={() => setShareOpen(true)} className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition">
            Share
          </button>

          {/* Replay */}
          {!replayMode && (
            <button
              onClick={openReplay}
              disabled={replayLoading}
              className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white px-3 py-1 rounded-lg text-sm font-medium transition"
            >
              {replayLoading ? "Loading..." : "⏪ Replay"}
            </button>
          )}

          {/* Chat toggle */}
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`px-3 py-1 rounded-lg text-sm transition ${chatOpen ? "bg-blue-600 text-white" : "bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white"}`}
          >
            💬
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">

        {/* Editor + output  OR  Replay panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {replayMode ? (
            /* ── Replay panel ─────────────────────────────────────────── */
            <>
              {/* Replay header */}
              <div className="bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <span className="text-purple-400 text-sm font-semibold">⏪ Replay</span>
                  <span className="text-white text-sm">{replaySnapshots[replayIndex]?.userName}</span>
                  <span className="text-gray-500 text-xs">
                    {new Date(replaySnapshots[replayIndex]?.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="text-gray-600 text-xs font-mono">
                    {replayIndex + 1} / {replaySnapshots.length}
                  </span>
                </div>
                <button
                  onClick={closeReplay}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition"
                >
                  ✕ Exit Replay
                </button>
              </div>

              {/* Read-only editor showing the snapshot at current index */}
              <div className="flex-1 overflow-hidden">
                <Editor
                  key="replay"
                  height="100%"
                  language={MONACO_LANG[language] || "javascript"}
                  value={replaySnapshots[replayIndex]?.content || ""}
                  theme={editorTheme}
                  options={{ fontSize: 14, minimap: { enabled: false }, readOnly: true, scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2 }}
                />
              </div>

              {/* Timeline controls */}
              <div className="bg-gray-900 border-t border-gray-800 px-4 pt-3 pb-2 flex-shrink-0">
                <input
                  type="range"
                  min={0}
                  max={Math.max(replaySnapshots.length - 1, 1)}
                  value={replayIndex}
                  onChange={(e) => {
                    clearInterval(replayTimerRef.current);
                    setReplayPlaying(false);
                    setReplayIndex(Number(e.target.value));
                  }}
                  className="w-full mb-2 accent-purple-500 cursor-pointer"
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {/* Jump to start */}
                    <button
                      onClick={() => { clearInterval(replayTimerRef.current); setReplayPlaying(false); setReplayIndex(0); }}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-sm transition"
                      title="Jump to start"
                    >⏮</button>

                    {/* Play / Pause */}
                    <button
                      onClick={() => togglePlay(replaySnapshots)}
                      className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-1 rounded-lg text-sm font-medium transition"
                    >
                      {replayPlaying ? "⏸ Pause" : "▶ Play"}
                    </button>

                    {/* Jump to end */}
                    <button
                      onClick={() => { clearInterval(replayTimerRef.current); setReplayPlaying(false); setReplayIndex(replaySnapshots.length - 1); }}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-sm transition"
                      title="Jump to end"
                    >⏭</button>
                  </div>
                  <span className="text-gray-600 text-xs">
                    {new Date(replaySnapshots[0]?.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                    {" · "}{replaySnapshots.length} snapshots
                  </span>
                </div>
              </div>
            </>
          ) : (
            /* ── Live editor ───────────────────────────────────────────── */
            <>
              <div className="flex-1 overflow-hidden">
                <Editor
                  key="live"
                  height="100%"
                  language={MONACO_LANG[language] || "javascript"}
                  value={code}
                  onChange={handleCodeChange}
                  onMount={handleEditorMount}
                  theme={editorTheme}
                  options={{ fontSize: 14, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2 }}
                />
              </div>

              {(runOutput !== null || runningBy !== null) && (
                <div className="h-40 border-t border-gray-800 bg-gray-950 flex flex-col flex-shrink-0">
                  <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-800">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs font-mono font-semibold tracking-widest">OUTPUT</span>
                      {runOutput?.by && (
                        <span className="text-gray-400 text-xs">· ran by {runOutput.by}</span>
                      )}
                    </div>
                    <button
                      onClick={() => { setRunOutput(null); setRunningBy(null); }}
                      className="text-gray-600 hover:text-gray-300 text-xs transition"
                    >
                      ✕ close
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto px-4 py-2">
                    {runningBy ? (
                      <div>
                        <p className="text-yellow-400 text-sm font-mono italic">
                          {runningBy} is running the code...
                        </p>
                        {runOutput?.output && (
                          <p className="text-gray-500 text-xs font-mono mt-1">{runOutput.output}</p>
                        )}
                      </div>
                    ) : (
                      <pre className="text-green-400 text-sm font-mono whitespace-pre-wrap">{runOutput?.output}</pre>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Chat panel */}
        {chatOpen && (
          <div className="w-72 border-l border-gray-800 flex flex-col bg-gray-900 flex-shrink-0">
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
              <span className="text-white text-sm font-semibold">Chat</span>
              <button onClick={() => setChatOpen(false)} className="text-gray-500 hover:text-gray-300 text-xs transition">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {messages.length === 0 && <p className="text-gray-600 text-xs text-center mt-4">No messages yet</p>}
              {messages.map((msg) => (
                <div key={msg._id}>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-blue-400 text-xs font-semibold">{msg.userName}</span>
                    <span className="text-gray-600 text-xs">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="text-gray-200 text-sm mt-0.5 break-words">{msg.text}</p>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="px-3 h-5 flex items-center">
              {typingUsers.length > 0 && (
                <p className="text-gray-500 text-xs italic">
                  {typingUsers.join(", ")} {typingUsers.length === 1 ? "is" : "are"} typing...
                </p>
              )}
            </div>
            <form onSubmit={sendMessage} className="p-3 border-t border-gray-800">
              <div className="flex gap-2">
                <input
                  value={newMessage}
                  onChange={handleMessageChange}
                  placeholder="Send a message..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <button type="submit" disabled={!newMessage.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-sm transition">
                  Send
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="bg-gray-900 border-t border-gray-800 px-4 py-1 flex items-center justify-between text-xs text-gray-500 flex-shrink-0">
        <span>{participants.length} user{participants.length !== 1 ? "s" : ""} online</span>
        <span>Auto-saves every 5 seconds</span>
      </div>

      {/* Share modal */}
      {shareOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShareOpen(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-semibold mb-1">Invite collaborators</h3>
            <p className="text-gray-400 text-sm mb-4">Share this link — anyone with it can join the room</p>
            <div className="flex gap-2">
              <input
                readOnly
                value={window.location.href}
                onFocus={(e) => e.target.select()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none"
              />
              <button onClick={copyShareLink} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
                {copied ? "✓" : "Copy"}
              </button>
            </div>
            <button onClick={() => setShareOpen(false)} className="mt-4 w-full text-gray-500 hover:text-gray-300 text-sm transition">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

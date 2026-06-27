// pages/RoomPage.jsx — the main collaborative editor page
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

// One color per remote user — assigned by hashing their socket ID
const CURSOR_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#ef4444"];

function getCursorColor(socketId) {
  const hash = [...socketId].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

// Injects a <style> tag so Monaco can color a remote user's cursor line
function injectCursorCSS(socketId, color) {
  if (document.getElementById(`cstyle-${socketId}`)) return;
  const [r, g, b] = [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
  const el = document.createElement("style");
  el.id = `cstyle-${socketId}`;
  el.textContent = `.rcursor-${socketId} { background: rgba(${r},${g},${b},0.18) !important; border-left: 2px solid ${color} !important; }`;
  document.head.appendChild(el);
}

export default function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [room, setRoom] = useState(null);
  const [code, setCode] = useState("// Loading...");
  const [language, setLanguage] = useState("javascript");
  const [participants, setParticipants] = useState([]);
  const [copied, setCopied] = useState(false);

  // Chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [typingUsers, setTypingUsers] = useState([]); // names of users currently typing

  // Code execution state
  const [runOutput, setRunOutput] = useState(null);
  const [isRunning, setIsRunning] = useState(false);

  // Toast notifications
  const [toasts, setToasts] = useState([]);

  const isRemoteChange = useRef(false);
  const editorRef = useRef(null);
  const chatEndRef = useRef(null);
  const typingTimerRef = useRef(null);       // debounce for typing-stop
  const lastCursorEmit = useRef(0);          // throttle cursor-move emissions
  const decorationCollections = useRef(new Map()); // socketId -> Monaco decoration collection

  useEffect(() => {
    loadRoom();
    connectSocket();

    return () => {
      socket.emit("leave-room", { roomId });
      socket.disconnect();
      clearTimeout(typingTimerRef.current);
      // Clean up all cursor decorations
      decorationCollections.current.forEach((col) => col.clear());
      decorationCollections.current.clear();
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

  // Highlight the line where a remote user's cursor sits
  function updateRemoteCursor(socketId, position) {
    const editor = editorRef.current;
    if (!editor) return;

    const color = getCursorColor(socketId);
    injectCursorCSS(socketId, color);

    const decoration = {
      range: {
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: `rcursor-${socketId}`,
        overviewRuler: { color },
      },
    };

    const existing = decorationCollections.current.get(socketId);
    if (existing) {
      existing.set([decoration]);
    } else {
      decorationCollections.current.set(
        socketId,
        editor.createDecorationsCollection([decoration])
      );
    }
  }

  function clearRemoteCursor(socketId) {
    const col = decorationCollections.current.get(socketId);
    if (col) {
      col.clear();
      decorationCollections.current.delete(socketId);
    }
    document.getElementById(`cstyle-${socketId}`)?.remove();
  }

  async function loadRoom() {
    try {
      const { data } = await api.get(`/api/v1/rooms/${roomId}`);
      setRoom(data);
      setCode(data.content);
      setLanguage(data.language);
    } catch {
      alert("Room not found");
      navigate("/dashboard");
    }
  }

  function connectSocket() {
    socket.connect();
    socket.emit("join-room", { roomId, userName: user?.name || "Anonymous" });

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

    socket.on("user-joined", ({ userName }) => {
      addToast(`${userName} joined`);
    });

    socket.on("user-left", ({ userName, socketId }) => {
      addToast(`${userName} left`);
      clearRemoteCursor(socketId);
      setTypingUsers((prev) => prev.filter((u) => u !== userName));
    });

    // Live cursors
    socket.on("cursor-update", ({ socketId, position }) => {
      updateRemoteCursor(socketId, position);
    });

    // Chat events
    socket.on("message-history", (msgs) => setMessages(msgs));
    socket.on("new-message", (msg) => setMessages((prev) => [...prev, msg]));

    // Typing indicator
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

    // Throttled cursor position broadcast (max 20/s)
    editor.onDidChangeCursorPosition((e) => {
      const now = Date.now();
      if (now - lastCursorEmit.current < 50) return;
      lastCursorEmit.current = now;
      socket.emit("cursor-move", {
        roomId,
        position: { lineNumber: e.position.lineNumber, column: e.position.column },
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

  function handleMessageChange(e) {
    setNewMessage(e.target.value);
    socket.emit("typing-start", { roomId });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit("typing-stop", { roomId });
    }, 1500);
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
    setIsRunning(true);
    setRunOutput("Running...");
    try {
      const { data } = await api.post("/api/v1/rooms/execute", { code, language });
      setRunOutput(data.output || "(no output)");
    } catch (err) {
      setRunOutput(`Error: ${err.response?.data?.error || err.message}`);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950">

      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-gray-800 border border-gray-700 text-white text-sm px-4 py-2.5 rounded-lg shadow-xl"
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/dashboard")}
            className="text-gray-400 hover:text-white text-sm transition"
          >
            ← Back
          </button>
          <span className="text-white font-semibold">{room?.name || "Loading..."}</span>
          <span className="text-gray-500 text-xs font-mono bg-gray-800 px-2 py-0.5 rounded">
            #{roomId}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={language}
            onChange={handleLanguageChange}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>

          <button
            onClick={runCode}
            disabled={isRunning}
            className="bg-green-600 hover:bg-green-500 disabled:bg-green-900 disabled:text-green-700 text-white px-3 py-1 rounded-lg text-sm font-medium transition"
          >
            {isRunning ? "Running..." : "▶ Run"}
          </button>

          {/* Participant avatars — each uses the same color as their cursor */}
          <div className="flex -space-x-1">
            {participants.slice(0, 4).map((p) => (
              <div
                key={p.socketId}
                title={p.userName}
                style={{ backgroundColor: getCursorColor(p.socketId) }}
                className="w-7 h-7 rounded-full border-2 border-gray-900 flex items-center justify-center text-xs font-bold text-white"
              >
                {p.userName[0]?.toUpperCase()}
              </div>
            ))}
          </div>

          <button
            onClick={copyShareLink}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition"
          >
            {copied ? "✓ Copied!" : "Share"}
          </button>

          <button
            onClick={() => setChatOpen((v) => !v)}
            title="Toggle chat"
            className={`px-3 py-1 rounded-lg text-sm transition ${
              chatOpen
                ? "bg-blue-600 text-white"
                : "bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white"
            }`}
          >
            💬
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">

        {/* Editor + output */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Editor
              height="100%"
              language={MONACO_LANG[language] || "javascript"}
              value={code}
              onChange={handleCodeChange}
              onMount={handleEditorMount}
              theme="vs-dark"
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: "on",
                tabSize: 2,
              }}
            />
          </div>

          {runOutput !== null && (
            <div className="h-40 border-t border-gray-800 bg-gray-950 flex flex-col flex-shrink-0">
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-800">
                <span className="text-gray-400 text-xs font-mono font-semibold tracking-widest">OUTPUT</span>
                <button
                  onClick={() => setRunOutput(null)}
                  className="text-gray-600 hover:text-gray-300 text-xs transition"
                >
                  ✕ close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-2">
                <pre className="text-green-400 text-sm font-mono whitespace-pre-wrap">{runOutput}</pre>
              </div>
            </div>
          )}
        </div>

        {/* Chat panel */}
        {chatOpen && (
          <div className="w-72 border-l border-gray-800 flex flex-col bg-gray-900 flex-shrink-0">
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
              <span className="text-white text-sm font-semibold">Chat</span>
              <button
                onClick={() => setChatOpen(false)}
                className="text-gray-500 hover:text-gray-300 text-xs transition"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {messages.length === 0 && (
                <p className="text-gray-600 text-xs text-center mt-4">No messages yet</p>
              )}
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

            {/* Typing indicator */}
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
                <button
                  type="submit"
                  disabled={!newMessage.trim()}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-sm transition"
                >
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
    </div>
  );
}

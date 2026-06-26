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

  // Code execution state
  const [runOutput, setRunOutput] = useState(null); // null = panel hidden
  const [isRunning, setIsRunning] = useState(false);

  const isRemoteChange = useRef(false);
  const editorRef = useRef(null);
  const chatEndRef = useRef(null); // for auto-scroll to latest message

  useEffect(() => {
    loadRoom();
    connectSocket();

    return () => {
      socket.emit("leave-room", { roomId });
      socket.disconnect();
    };
  }, [roomId]);

  // Auto-scroll chat to bottom whenever messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadRoom() {
    try {
      const { data } = await api.get(`/api/v1/rooms/${roomId}`);
      setRoom(data);
      setCode(data.content);
      setLanguage(data.language);
    } catch (err) {
      alert("Room not found");
      navigate("/dashboard");
    }
  }

  function connectSocket() {
    socket.connect();

    socket.emit("join-room", {
      roomId,
      userName: user?.name || "Anonymous",
    });

    // Server sends initial code when we join
    socket.on("init-code", ({ code: initCode }) => {
      const current = editorRef.current?.getModel()?.getValue();
      if (current !== initCode) {
        isRemoteChange.current = true;
        setCode(initCode);
      }
    });

    // Another user typed — update our editor
    socket.on("code-update", ({ code: remoteCode, language: lang }) => {
      const current = editorRef.current?.getModel()?.getValue();
      if (current !== remoteCode) {
        isRemoteChange.current = true;
        setCode(remoteCode);
      }
      if (lang) setLanguage(lang);
    });

    // Another user changed language
    socket.on("language-update", ({ language: lang }) => {
      setLanguage(lang);
    });

    // Participant list updated
    socket.on("participants-update", (list) => {
      setParticipants(list);
    });

    socket.on("user-joined", ({ userName }) => {
      console.log(`${userName} joined`);
    });

    socket.on("user-left", ({ userName }) => {
      console.log(`${userName} left`);
    });

    // Chat: full history sent on join
    socket.on("message-history", (msgs) => {
      setMessages(msgs);
    });

    // Chat: new message broadcast from server
    socket.on("new-message", (msg) => {
      setMessages((prev) => [...prev, msg]);
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

  function sendMessage(e) {
    e.preventDefault();
    if (!newMessage.trim()) return;
    socket.emit("send-message", { roomId, text: newMessage });
    setNewMessage("");
  }

  async function runCode() {
    setIsRunning(true);
    setRunOutput("Running...");
    try {
      const { data } = await api.post("/api/v1/rooms/execute", { code, language });
      setRunOutput(data.output || "(no output)");
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message;
      setRunOutput(`Error: ${errMsg}`);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950">
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
          {/* Language selector */}
          <select
            value={language}
            onChange={handleLanguageChange}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>

          {/* Run button */}
          <button
            onClick={runCode}
            disabled={isRunning}
            className="bg-green-600 hover:bg-green-500 disabled:bg-green-900 disabled:text-green-700 text-white px-3 py-1 rounded-lg text-sm font-medium transition"
          >
            {isRunning ? "Running..." : "▶ Run"}
          </button>

          {/* Participant avatars */}
          <div className="flex -space-x-1">
            {participants.slice(0, 4).map((p) => (
              <div
                key={p.socketId}
                title={p.userName}
                className="w-7 h-7 rounded-full bg-blue-600 border-2 border-gray-900 flex items-center justify-center text-xs font-bold text-white"
              >
                {p.userName[0]?.toUpperCase()}
              </div>
            ))}
          </div>

          {/* Share button */}
          <button
            onClick={copyShareLink}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition"
          >
            {copied ? "✓ Copied!" : "Share"}
          </button>

          {/* Chat toggle — highlights when open */}
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

      {/* Main content area: editor column + optional chat sidebar */}
      <div className="flex-1 flex overflow-hidden">

        {/* Left column: Monaco + output panel */}
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

          {/* Output panel — shown after clicking Run */}
          {runOutput !== null && (
            <div className="h-40 border-t border-gray-800 bg-gray-950 flex flex-col flex-shrink-0">
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-800">
                <span className="text-gray-400 text-xs font-mono font-semibold tracking-widest">
                  OUTPUT
                </span>
                <button
                  onClick={() => setRunOutput(null)}
                  className="text-gray-600 hover:text-gray-300 text-xs transition"
                >
                  ✕ close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-2">
                <pre className="text-green-400 text-sm font-mono whitespace-pre-wrap">
                  {runOutput}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Right column: Chat panel (toggled) */}
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

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {messages.length === 0 && (
                <p className="text-gray-600 text-xs text-center mt-4">No messages yet</p>
              )}
              {messages.map((msg) => (
                <div key={msg._id}>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-blue-400 text-xs font-semibold">{msg.userName}</span>
                    <span className="text-gray-600 text-xs">
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-gray-200 text-sm mt-0.5 break-words">{msg.text}</p>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Message input */}
            <form onSubmit={sendMessage} className="p-3 border-t border-gray-800">
              <div className="flex gap-2">
                <input
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
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

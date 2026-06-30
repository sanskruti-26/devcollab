// pages/RoomPage.jsx — collaborative editor with multi-file support
// Sync engine: Yjs CRDT over Socket.io (y-monaco binding per file)
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Editor from "@monaco-editor/react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
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

const FILE_ICONS = {
  javascript: "JS",
  typescript: "TS",
  python:     "PY",
  java:       "JV",
  cpp:        "C+",
};

const CURSOR_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#ef4444"];

const THEMES = [
  { value: "vs-dark",  label: "Dark" },
  { value: "vs",       label: "Light" },
  { value: "hc-black", label: "High Contrast" },
];

function getCursorColor(socketId) {
  const hash = [...socketId].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

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

  // ── Room & editor core ────────────────────────────────────────────────────
  const [room, setRoom]             = useState(null);
  const [language, setLanguage]     = useState("javascript");
  const [editorTheme, setEditorTheme] = useState("vs-dark");
  const [participants, setParticipants] = useState([]);
  const [copied, setCopied]         = useState(false);
  const [shareOpen, setShareOpen]   = useState(false);

  // ── Password protection ───────────────────────────────────────────────────
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [roomPassword, setRoomPassword]         = useState("");
  const [passwordError, setPasswordError]       = useState("");

  // ── Multi-file ────────────────────────────────────────────────────────────
  const [files, setFiles]               = useState([]);
  const [activeFile, setActiveFile]     = useState(null);
  const [filePresence, setFilePresence] = useState([]);
  const [addingFile, setAddingFile]   = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renaming, setRenaming]       = useState(null);

  // ── Chat ──────────────────────────────────────────────────────────────────
  const [chatOpen, setChatOpen]       = useState(false);
  const [messages, setMessages]       = useState([]);
  const [newMessage, setNewMessage]   = useState("");
  const [typingUsers, setTypingUsers] = useState([]);

  // ── AI pair programmer ────────────────────────────────────────────────────
  const [aiOpen, setAiOpen]               = useState(false);
  const [aiMessages, setAiMessages]       = useState([]);
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiInput, setAiInput]             = useState("");
  const [aiHasSelection, setAiHasSelection] = useState(false);

  // ── Code execution ────────────────────────────────────────────────────────
  const [runOutput, setRunOutput]   = useState(null);
  const [runningBy, setRunningBy]   = useState(null);

  // ── Session replay ────────────────────────────────────────────────────────
  const [replayMode, setReplayMode]           = useState(false);
  const [replaySnapshots, setReplaySnapshots] = useState([]);
  const [replayIndex, setReplayIndex]         = useState(0);
  const [replayPlaying, setReplayPlaying]     = useState(false);
  const [replayLoading, setReplayLoading]     = useState(false);

  // ── Toasts ────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState([]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const editorRef         = useRef(null);
  const chatEndRef        = useRef(null);
  const aiEndRef          = useRef(null);
  const typingTimerRef    = useRef(null);
  const lastCursorEmit    = useRef(0);
  const socketSetup       = useRef(false);
  const decorationCollections = useRef(new Map());
  const selectionCollections  = useRef(new Map());
  const cursorWidgets     = useRef(new Map());
  const replayTimerRef    = useRef(null);

  // Yjs: one Y.Doc + MonacoBinding per active file. Destroyed + recreated on file switch.
  const ydocRef    = useRef(null);
  const bindingRef = useRef(null);

  // Kept in sync with state so socket event handlers (set up once) never go stale
  const activeFileIdRef = useRef(null);
  const filesRef        = useRef([]);

  useEffect(() => { activeFileIdRef.current = activeFile?._id || null; }, [activeFile]);
  useEffect(() => { filesRef.current = files; },                        [files]);

  useEffect(() => {
    loadRoom();
    return () => {
      socket.emit("leave-room", { roomId });
      // Remove all listeners BEFORE disconnecting so that a remount (React
      // Strict Mode or navigation back) starts with a clean slate. Without
      // this, the singleton socket accumulates duplicate listeners on every
      // remount, and each incoming yjs-update would be applied N times.
      socket.removeAllListeners();
      socket.disconnect();
      socketSetup.current = false;
      clearTimeout(typingTimerRef.current);
      clearInterval(replayTimerRef.current);
      // Tear down Yjs
      if (bindingRef.current) { bindingRef.current.destroy(); bindingRef.current = null; }
      if (ydocRef.current)    { ydocRef.current.destroy();    ydocRef.current    = null; }
      // Tear down cursor decorations
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

  useEffect(() => {
    aiEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiMessages, aiLoading]);

  // ── Toast ─────────────────────────────────────────────────────────────────

  function addToast(message) {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }

  // ── Cursor decorations ────────────────────────────────────────────────────

  function updateCursorWidget(socketId, userName, lineNumber) {
    const editor = editorRef.current;
    if (!editor) return;
    const color = getCursorColor(socketId);
    const existing = cursorWidgets.current.get(socketId);
    if (existing) editor.removeContentWidget(existing.widget);

    const domNode = document.createElement("div");
    domNode.textContent = userName;
    domNode.style.cssText = `background:${color};color:white;font-size:11px;padding:1px 6px;border-radius:3px 3px 3px 0;white-space:nowrap;pointer-events:none;font-family:-apple-system,sans-serif;line-height:16px;`;

    const widget = {
      getId:       () => `clabel-${socketId}`,
      getDomNode:  () => domNode,
      getPosition: () => ({
        position:   { lineNumber, column: 1 },
        preference: [1],
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

    const lineDecoration = {
      range:   { startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: 1 },
      options: { isWholeLine: true, className: `rcursor-${socketId}`, overviewRuler: { color } },
    };
    const existingLine = decorationCollections.current.get(socketId);
    if (existingLine) {
      existingLine.set([lineDecoration]);
    } else {
      decorationCollections.current.set(socketId, editor.createDecorationsCollection([lineDecoration]));
    }

    updateCursorWidget(socketId, userName, position.lineNumber);

    const existingSel = selectionCollections.current.get(socketId);
    const hasSelection = selection &&
      (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn);

    if (hasSelection) {
      const selDecoration = { range: selection, options: { className: `rselection-${socketId}` } };
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

  function clearAllRemoteCursors() {
    decorationCollections.current.forEach((c) => c.clear());
    decorationCollections.current.clear();
    selectionCollections.current.forEach((c) => c.clear());
    selectionCollections.current.clear();
    cursorWidgets.current.forEach(({ widget }) => editorRef.current?.removeContentWidget(widget));
    cursorWidgets.current.clear();
  }

  // ── Room + file loading ───────────────────────────────────────────────────

  async function loadRoom(password = null) {
    try {
      const params = password ? { password } : {};
      const { data: roomData } = await api.get(`/api/v1/rooms/${roomId}`, { params });
      setRoom(roomData);
      setPasswordRequired(false);
      setPasswordError("");

      const { data: filesData } = await api.get(`/api/v1/rooms/${roomId}/files`);
      setFiles(filesData);
      if (filesData.length > 0) {
        const first = filesData[0];
        setActiveFile(first);
        activeFileIdRef.current = first._id;
        setLanguage(first.language);
        // Content will be set by yjs-sync-response after onMount fires
      }

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

  // ── Socket setup ──────────────────────────────────────────────────────────

  function connectSocket() {
    if (socketSetup.current) return;
    socketSetup.current = true;

    socket.on("connect", () => {
      socket.emit("join-room", { roomId, userName: user?.name || "Anonymous" });
      // Only re-request Yjs state on RECONNECTION — when ydocRef is already
      // set (editor was mounted before the drop). On initial connect ydocRef
      // is null; handleEditorMount fires shortly after and requests sync then.
      if (activeFileIdRef.current && ydocRef.current) {
        socket.emit("yjs-sync-request", { roomId, fileId: activeFileIdRef.current });
      }
    });

    socket.connect();

    // ── Yjs sync ──────────────────────────────────────────────────────────
    // Full Y.Doc state sent in response to yjs-sync-request.
    // Socket.io delivers binary attachments as ArrayBuffer in the browser;
    // new Uint8Array() wraps it without copying.
    socket.on("yjs-sync-response", ({ fileId, state }) => {
      if (!ydocRef.current || fileId !== activeFileIdRef.current) return;
      Y.applyUpdate(ydocRef.current, new Uint8Array(state), "socket");
    });

    // Incremental update from another client — apply to local Y.Doc
    socket.on("yjs-update", ({ fileId, update }) => {
      if (!ydocRef.current || fileId !== activeFileIdRef.current) return;
      Y.applyUpdate(ydocRef.current, new Uint8Array(update), "socket");
    });


    // ── Language ──────────────────────────────────────────────────────────
    socket.on("language-update", ({ language: lang, fileId }) => {
      if (fileId && fileId !== activeFileIdRef.current) {
        setFiles((prev) => prev.map((f) => (f._id === fileId ? { ...f, language: lang } : f)));
        return;
      }
      setLanguage(lang);
    });

    socket.on("participants-update", (list) => setParticipants(list));

    socket.on("user-joined", ({ userName }) => addToast(`${userName} joined`));
    socket.on("user-left", ({ userName, socketId }) => {
      addToast(`${userName} left`);
      clearRemoteCursor(socketId);
      setTypingUsers((prev) => prev.filter((u) => u !== userName));
    });

    // cursor-update: only render cursors for users on the same file
    socket.on("cursor-update", ({ socketId, userName, position, selection, fileId }) => {
      if (fileId && fileId !== activeFileIdRef.current) {
        clearRemoteCursor(socketId);
        return;
      }
      updateRemoteCursor(socketId, userName, position, selection);
    });

    // ── File presence ─────────────────────────────────────────────────────
    socket.on("file-presence-update", (presence) => setFilePresence(presence));

    // ── File CRUD broadcasts from other users ─────────────────────────────
    socket.on("file-created", ({ file }) => {
      setFiles((prev) => [...prev, file]);
      addToast(`New file: ${file.name}`);
    });

    socket.on("file-renamed", ({ fileId, name, language: lang }) => {
      setFiles((prev) =>
        prev.map((f) => (f._id === fileId ? { ...f, name, language: lang } : f))
      );
      if (activeFileIdRef.current === fileId) {
        setActiveFile((prev) => (prev ? { ...prev, name, language: lang } : prev));
        setLanguage(lang);
      }
    });

    socket.on("file-deleted", ({ fileId }) => {
      const remaining = filesRef.current.filter((f) => f._id !== fileId);
      setFiles(remaining);
      if (activeFileIdRef.current === fileId && remaining.length > 0) {
        const fallback = remaining[0];
        clearAllRemoteCursors();
        // Update state — the key change on activeFile triggers Editor remount,
        // which creates a fresh Y.Doc and requests Yjs sync for the fallback file.
        activeFileIdRef.current = fallback._id;
        setActiveFile(fallback);
        setLanguage(fallback.language);
      }
    });

    // ── Execution ─────────────────────────────────────────────────────────
    socket.on("run-start",  ({ runnerName }) => { setRunningBy(runnerName); setRunOutput(null); });
    socket.on("run-result", ({ output, runnerName }) => { setRunningBy(null); setRunOutput({ output, by: runnerName }); });

    // ── Chat ──────────────────────────────────────────────────────────────
    socket.on("message-history", (msgs) => setMessages(msgs));
    socket.on("new-message",     (msg)  => setMessages((prev) => [...prev, msg]));
    socket.on("user-typing",         ({ userName }) =>
      setTypingUsers((prev) => (prev.includes(userName) ? prev : [...prev, userName]))
    );
    socket.on("user-stopped-typing", ({ userName }) =>
      setTypingUsers((prev) => prev.filter((u) => u !== userName))
    );
  }

  // ── File operations ───────────────────────────────────────────────────────

  function switchFile(file) {
    if (!file || file._id === activeFileIdRef.current) return;

    // Destroy current binding + Y.Doc — onMount for the new file will create fresh ones
    if (bindingRef.current) { bindingRef.current.destroy(); bindingRef.current = null; }
    if (ydocRef.current)    { ydocRef.current.destroy();    ydocRef.current    = null; }

    clearAllRemoteCursors();
    setAiHasSelection(false);

    activeFileIdRef.current = file._id;
    setActiveFile(file);
    setLanguage(file.language);

    // Notify server of presence change (Yjs sync will happen in onMount via key remount)
    socket.emit("active-file-change", { roomId, fileId: file._id });
  }

  async function addFile() {
    const name = newFileName.trim();
    if (!name) return;
    try {
      const { data: file } = await api.post(`/api/v1/rooms/${roomId}/files`, { name });
      setFiles((prev) => [...prev, file]);
      setNewFileName("");
      setAddingFile(false);
      socket.emit("announce-file-created", { roomId, file });
      switchFile(file);
    } catch (err) {
      if (err.response?.status === 409) addToast("A file with that name already exists");
      else addToast("Could not create file");
    }
  }

  async function renameFile(fileId, newName) {
    const name = newName.trim();
    if (!name) { setRenaming(null); return; }
    try {
      const { data: updated } = await api.patch(`/api/v1/rooms/${roomId}/files/${fileId}`, { name });
      setFiles((prev) =>
        prev.map((f) => (f._id === fileId ? { ...f, name: updated.name, language: updated.language } : f))
      );
      if (activeFileIdRef.current === fileId) {
        setActiveFile((prev) => (prev ? { ...prev, name: updated.name, language: updated.language } : prev));
        setLanguage(updated.language);
      }
      setRenaming(null);
      socket.emit("announce-file-renamed", {
        roomId, fileId, name: updated.name, language: updated.language,
      });
    } catch (err) {
      if (err.response?.status === 409) addToast("A file with that name already exists");
      else addToast("Could not rename file");
      setRenaming(null);
    }
  }

  async function deleteFile(file) {
    if (filesRef.current.length <= 1) { addToast("Cannot delete the last file"); return; }
    try {
      await api.delete(`/api/v1/rooms/${roomId}/files/${file._id}`);
      const remaining = filesRef.current.filter((f) => f._id !== file._id);
      setFiles(remaining);
      socket.emit("announce-file-deleted", { roomId, fileId: file._id });
      if (activeFileIdRef.current === file._id && remaining.length > 0) {
        switchFile(remaining[0]);
      }
    } catch (err) {
      addToast("Could not delete file");
    }
  }

  // ── Editor mount — creates Y.Doc + y-monaco binding for the active file ──

  function handleEditorMount(editor) {
    editorRef.current = editor;

    // Tear down any stale binding/ydoc from a previous file
    if (bindingRef.current) { bindingRef.current.destroy(); bindingRef.current = null; }
    if (ydocRef.current)    { ydocRef.current.destroy();    ydocRef.current    = null; }

    const model = editor.getModel();
    if (!model) return;

    // Create a fresh Y.Doc for this file
    const ydoc  = new Y.Doc();
    const yText = ydoc.getText("content");

    // Bind Y.Text ↔ Monaco model. The binding drives all content updates;
    // we no longer set editor content via React state.
    const binding = new MonacoBinding(yText, model, new Set([editor]));

    ydocRef.current    = ydoc;
    bindingRef.current = binding;

    // Emit local Yjs updates to the server as raw binary.
    // Passing the Uint8Array directly lets Socket.io use its binary framing
    // instead of JSON-encoding each byte as a decimal number (~3× the size).
    // Origin 'socket' is skipped to avoid re-broadcasting received updates.
    ydoc.on("update", (update, origin) => {
      if (origin === "socket") return;
      socket.emit("yjs-update", {
        roomId,
        fileId: activeFileIdRef.current,
        update,
      });
    });

    // Request the full current state for this file from the server.
    // yjs-sync-response will apply it, populating the editor via the binding.
    socket.emit("yjs-sync-request", {
      roomId,
      fileId: activeFileIdRef.current,
    });

    // Cursor broadcasting — unchanged from original, plus a local flag the AI
    // panel reads to know whether to use the selection or the whole file as context.
    editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      const hasSelection = !(
        sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn
      );
      setAiHasSelection(hasSelection);

      const now = Date.now();
      if (now - lastCursorEmit.current < 50) return;
      lastCursorEmit.current = now;

      socket.emit("cursor-move", {
        roomId,
        position:  { lineNumber: sel.positionLineNumber, column: sel.positionColumn },
        selection: hasSelection
          ? { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn,
              endLineNumber: sel.endLineNumber, endColumn: sel.endColumn }
          : null,
        fileId: activeFileIdRef.current,
      });
    });
  }

  function handleLanguageChange(e) {
    const lang = e.target.value;
    setLanguage(lang);
    if (activeFile) {
      setActiveFile((prev) => (prev ? { ...prev, language: lang } : prev));
      setFiles((prev) =>
        prev.map((f) => (f._id === activeFile._id ? { ...f, language: lang } : f))
      );
    }
    socket.emit("language-change", { roomId, language: lang, fileId: activeFileIdRef.current });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function copyShareLink() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadCode() {
    const content = ydocRef.current?.getText("content").toString() ?? "";
    const blob = new Blob([content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = activeFile?.name || "code.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

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

  // ── AI pair programmer ────────────────────────────────────────────────────

  async function askAI(question) {
    const q = (question || aiInput).trim();
    if (!q || aiLoading) return;
    setAiInput("");

    const fileContent = ydocRef.current?.getText("content").toString() ?? "";

    // Prefer the editor selection as a focused context when the user has one active
    let selection = "";
    const editor = editorRef.current;
    if (editor) {
      const sel = editor.getSelection();
      if (sel && !sel.isEmpty()) {
        selection = editor.getModel()?.getValueInRange(sel) ?? "";
      }
    }

    // Send recent conversation turns so the AI can follow up ("now refactor that")
    const history = aiMessages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

    const msgId = Date.now();
    setAiMessages((prev) => [...prev, { id: msgId, role: "user", content: q }]);
    setAiLoading(true);

    try {
      const { data } = await api.post("/api/v1/ai/ask", {
        fileContent, selection, language, question: q, history,
      });
      setAiMessages((prev) => [...prev, { id: msgId + 1, role: "assistant", content: data.answer }]);
    } catch (err) {
      const serverMsg = err.response?.data?.error || "";
      if (serverMsg.includes("not configured")) {
        addToast("AI not configured — add GEMINI_API_KEY to backend/.env");
      } else if (err.response?.status === 429) {
        addToast("Too many AI requests — please slow down");
      } else {
        addToast(serverMsg || "AI request failed");
      }
    } finally {
      setAiLoading(false);
    }
  }

  // ── Code execution ────────────────────────────────────────────────────────

  async function runCode() {
    if (runningBy) return;
    const name = user?.name || "Anonymous";
    const code = ydocRef.current?.getText("content").toString() ?? "";
    setRunningBy(name);
    setRunOutput(null);
    socket.emit("run-start", { roomId, runnerName: name });

    async function attempt() {
      const { data } = await api.post("/api/v1/rooms/execute", { code, language });
      return data.output || "(no output)";
    }

    try {
      let output;
      try {
        output = await attempt();
      } catch (firstErr) {
        const is503NoKey =
          firstErr.response?.status === 503 &&
          firstErr.response?.data?.error?.includes("JUDGE0_KEY");
        const isRetryable = !is503NoKey && (!firstErr.response || firstErr.response.status >= 500);
        if (!isRetryable) throw firstErr;
        setRunOutput({ output: "Server is waking up — retrying in 3 seconds...", by: name });
        await new Promise((r) => setTimeout(r, 3000));
        setRunOutput(null);
        output = await attempt();
      }
      setRunningBy(null);
      setRunOutput({ output, by: name });
      socket.emit("run-result", { roomId, output, runnerName: name });
    } catch (err) {
      const status    = err.response?.status;
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

  // ── Session replay ────────────────────────────────────────────────────────

  async function openReplay() {
    setReplayLoading(true);
    try {
      const { data } = await api.get(`/api/v1/rooms/${roomId}/replay`);
      if (!data.length) { addToast("No replay data yet — edit some code first"); return; }
      setReplaySnapshots(data);
      setReplayIndex(0);
      setReplayMode(true);
    } catch (err) {
      const status = err.response?.status;
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

  // ── Password gate ─────────────────────────────────────────────────────────
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
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
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
            Back
          </button>
          <span className="text-white font-semibold">{room?.name || "Loading..."}</span>
          {room?.hasPassword && <span title="Password protected" className="text-gray-500 text-xs">🔒</span>}
          <span className="text-gray-500 text-xs font-mono bg-gray-800 px-2 py-0.5 rounded">
            #{roomId}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={language}
            onChange={handleLanguageChange}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>

          <select
            value={editorTheme}
            onChange={(e) => setEditorTheme(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          <button
            onClick={runCode}
            disabled={!!runningBy}
            className="bg-green-600 hover:bg-green-500 disabled:bg-green-900 disabled:text-green-700 text-white px-3 py-1 rounded-lg text-sm font-medium transition"
          >
            {runningBy ? `${runningBy.split(" ")[0]} running...` : "Run"}
          </button>

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

          <button
            onClick={downloadCode}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition"
          >
            Download
          </button>

          <button
            onClick={() => setShareOpen(true)}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition"
          >
            Share
          </button>

          {!replayMode && (
            <button
              onClick={openReplay}
              disabled={replayLoading}
              className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white px-3 py-1 rounded-lg text-sm font-medium transition"
            >
              {replayLoading ? "Loading..." : "Replay"}
            </button>
          )}

          <button
            onClick={() => setAiOpen((v) => !v)}
            className={`px-3 py-1 rounded-lg text-sm transition ${
              aiOpen ? "bg-yellow-600 text-white" : "bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white"
            }`}
          >
            Ask AI
          </button>

          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`px-3 py-1 rounded-lg text-sm transition ${
              chatOpen ? "bg-blue-600 text-white" : "bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white"
            }`}
          >
            Chat
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── File sidebar ─────────────────────────────────────────────── */}
        <div className="w-44 bg-gray-900 border-r border-gray-800 flex flex-col flex-shrink-0">
          <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
            <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Files</span>
            <button
              onClick={() => { setAddingFile(true); setNewFileName(""); }}
              title="New file"
              className="text-gray-500 hover:text-white transition text-lg leading-none w-5 h-5 flex items-center justify-center"
            >
              +
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {files.map((file) => (
              <div key={file._id}>
                {renaming?.fileId === file._id ? (
                  <form
                    onSubmit={(e) => { e.preventDefault(); renameFile(file._id, renaming.name); }}
                    className="px-1"
                  >
                    <input
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      onBlur={() => renameFile(file._id, renaming.name)}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                      className="w-full bg-gray-800 border border-blue-500 text-white text-xs px-2 py-1 outline-none rounded"
                    />
                  </form>
                ) : (
                  <div
                    onClick={() => switchFile(file)}
                    className={`group px-2 py-1.5 cursor-pointer flex items-center gap-1.5 ${
                      file._id === activeFile?._id
                        ? "bg-gray-800 text-white"
                        : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200"
                    }`}
                  >
                    <span className="text-xs font-mono text-gray-600 w-4 flex-shrink-0 leading-none select-none">
                      {FILE_ICONS[file.language] || "??"}
                    </span>
                    <span className="flex-1 text-xs truncate leading-none">{file.name}</span>

                    <div className="flex gap-0.5 flex-shrink-0">
                      {filePresence
                        .filter(
                          (p) => p.activeFileId === file._id && p.socketId !== socket.id
                        )
                        .map((p) => (
                          <div
                            key={p.socketId}
                            title={p.userName}
                            style={{ backgroundColor: getCursorColor(p.socketId) }}
                            className="w-1.5 h-1.5 rounded-full"
                          />
                        ))}
                    </div>

                    <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ fileId: file._id, name: file.name });
                        }}
                        title="Rename"
                        className="text-gray-500 hover:text-gray-200 text-xs px-0.5 leading-none"
                      >
                        ✎
                      </button>
                      {files.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteFile(file); }}
                          title="Delete"
                          className="text-gray-500 hover:text-red-400 text-xs px-0.5 leading-none"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {addingFile && (
              <form onSubmit={(e) => { e.preventDefault(); addFile(); }} className="mt-1 px-1">
                <input
                  autoFocus
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  onBlur={() => { if (!newFileName.trim()) setAddingFile(false); }}
                  onKeyDown={(e) => e.key === "Escape" && setAddingFile(false)}
                  placeholder="filename.js"
                  className="w-full bg-gray-800 border border-blue-500 text-white text-xs px-2 py-1.5 outline-none rounded placeholder-gray-600"
                />
              </form>
            )}
          </div>
        </div>

        {/* ── Editor + output  OR  Replay panel ──────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {replayMode ? (
            <>
              {/* Replay header */}
              <div className="bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <span className="text-purple-400 text-sm font-semibold">Replay</span>
                  <span className="text-white text-sm">
                    {replaySnapshots[replayIndex]?.userName}
                  </span>
                  <span className="text-gray-500 text-xs">
                    {new Date(replaySnapshots[replayIndex]?.createdAt).toLocaleTimeString([], {
                      hour: "2-digit", minute: "2-digit", second: "2-digit",
                    })}
                  </span>
                  <span className="text-gray-600 text-xs font-mono">
                    {replayIndex + 1} / {replaySnapshots.length}
                  </span>
                </div>
                <button
                  onClick={closeReplay}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1 rounded-lg text-sm transition"
                >
                  Exit Replay
                </button>
              </div>

              <div className="flex-1 overflow-hidden">
                <Editor
                  key="replay"
                  height="100%"
                  language={MONACO_LANG[language] || "javascript"}
                  value={replaySnapshots[replayIndex]?.content || ""}
                  theme={editorTheme}
                  options={{
                    fontSize: 14, minimap: { enabled: false }, readOnly: true,
                    scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2,
                  }}
                />
              </div>

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
                    <button
                      onClick={() => { clearInterval(replayTimerRef.current); setReplayPlaying(false); setReplayIndex(0); }}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-sm transition"
                    >
                      |&lt;
                    </button>
                    <button
                      onClick={() => togglePlay(replaySnapshots)}
                      className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-1 rounded-lg text-sm font-medium transition"
                    >
                      {replayPlaying ? "Pause" : "Play"}
                    </button>
                    <button
                      onClick={() => {
                        clearInterval(replayTimerRef.current);
                        setReplayPlaying(false);
                        setReplayIndex(replaySnapshots.length - 1);
                      }}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-sm transition"
                    >
                      &gt;|
                    </button>
                  </div>
                  <span className="text-gray-600 text-xs">
                    {new Date(replaySnapshots[0]?.createdAt).toLocaleDateString([], {
                      month: "short", day: "numeric",
                    })}
                    {" · "}{replaySnapshots.length} snapshots
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Live editor — uncontrolled; Yjs drives all content via y-monaco binding.
                  Key includes activeFile._id so React remounts the editor on file switch,
                  which triggers handleEditorMount to create a fresh Y.Doc for the new file. */}
              <div className="flex-1 overflow-hidden">
                <Editor
                  key={activeFile?._id || "live"}
                  height="100%"
                  language={MONACO_LANG[language] || "javascript"}
                  defaultValue=""
                  onMount={handleEditorMount}
                  theme={editorTheme}
                  options={{
                    fontSize: 14, minimap: { enabled: false },
                    scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2,
                  }}
                />
              </div>

              {/* Output panel */}
              {(runOutput !== null || runningBy !== null) && (
                <div className="h-40 border-t border-gray-800 bg-gray-950 flex flex-col flex-shrink-0">
                  <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-800">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs font-mono font-semibold tracking-widest">
                        OUTPUT
                      </span>
                      {runOutput?.by && (
                        <span className="text-gray-400 text-xs">· ran by {runOutput.by}</span>
                      )}
                    </div>
                    <button
                      onClick={() => { setRunOutput(null); setRunningBy(null); }}
                      className="text-gray-600 hover:text-gray-300 text-xs transition"
                    >
                      close
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
                      <pre className="text-green-400 text-sm font-mono whitespace-pre-wrap">
                        {runOutput?.output}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── AI pair programmer panel ────────────────────────────────── */}
        {aiOpen && (
          <div className="w-80 border-l border-gray-800 flex flex-col bg-gray-900 flex-shrink-0">
            {/* Header */}
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-white text-sm font-semibold">Ask AI</span>
                <span className="text-yellow-400 text-xs">✦</span>
              </div>
              <button
                onClick={() => setAiOpen(false)}
                className="text-gray-500 hover:text-gray-300 text-xs transition"
              >
                close
              </button>
            </div>

            {/* Context note */}
            <div className="px-3 py-1.5 bg-gray-800/40 border-b border-gray-800/60">
              <p className="text-gray-500 text-xs">
                {aiHasSelection
                  ? "AI can see your selected code"
                  : <>AI can see your current file{activeFile?.name ? ` · ${activeFile.name}` : ""}</>}
              </p>
            </div>

            {/* Quick-action preset buttons */}
            <div className="px-3 py-2 border-b border-gray-800/60 flex gap-1.5 flex-wrap">
              {[
                { label: "Explain",   prompt: "Explain what this code does, step by step." },
                { label: "Find bugs", prompt: "Review this code for bugs, edge cases, or potential issues." },
                { label: "Improve",   prompt: "Suggest concrete improvements to this code." },
              ].map(({ label, prompt }) => (
                <button
                  key={label}
                  onClick={() => askAI(prompt)}
                  disabled={aiLoading}
                  className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white border border-gray-700 transition disabled:opacity-40"
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Conversation */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {aiMessages.length === 0 && !aiLoading && (
                <p className="text-gray-600 text-xs text-center mt-4">
                  Ask anything about your code
                </p>
              )}
              {aiMessages.map((msg) => (
                <div key={msg.id}>
                  {msg.role === "user" ? (
                    <div className="flex justify-end">
                      <div className="inline-block bg-blue-600/30 border border-blue-500/30 rounded-lg px-3 py-2 text-sm text-gray-200 max-w-[90%]">
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    <div className="text-gray-200 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}
              {aiLoading && (
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              )}
              <div ref={aiEndRef} />
            </div>

            {/* Input */}
            <form
              onSubmit={(e) => { e.preventDefault(); askAI(aiInput); }}
              className="p-3 border-t border-gray-800"
            >
              <div className="flex gap-2">
                <input
                  value={aiInput}
                  onChange={(e) => setAiInput(e.target.value)}
                  placeholder="Ask about this code..."
                  disabled={aiLoading}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!aiInput.trim() || aiLoading}
                  className="bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition"
                >
                  Ask
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── Chat panel ──────────────────────────────────────────────── */}
        {chatOpen && (
          <div className="w-72 border-l border-gray-800 flex flex-col bg-gray-900 flex-shrink-0">
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
              <span className="text-white text-sm font-semibold">Chat</span>
              <button
                onClick={() => setChatOpen(false)}
                className="text-gray-500 hover:text-gray-300 text-xs transition"
              >
                close
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
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: "2-digit", minute: "2-digit",
                      })}
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
        <span>{activeFile?.name || ""}</span>
        <span>Auto-saves every 5 seconds</span>
      </div>

      {/* Share modal */}
      {shareOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={() => setShareOpen(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-white font-semibold mb-1">Invite collaborators</h3>
            <p className="text-gray-400 text-sm mb-4">
              Share this link — anyone with it can join the room
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={window.location.href}
                onFocus={(e) => e.target.select()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none"
              />
              <button
                onClick={copyShareLink}
                className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <button
              onClick={() => setShareOpen(false)}
              className="mt-4 w-full text-gray-500 hover:text-gray-300 text-sm transition"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

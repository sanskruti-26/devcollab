// pages/DashboardPage.jsx — lists user's rooms, lets them create new ones
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../lib/api";
import { useAuth } from "../hooks/useAuth";

const LANGUAGES = ["javascript", "typescript", "python", "java", "cpp"];

const LANG_BADGE = {
  javascript: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  typescript: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  python:     "bg-green-500/20 text-green-400 border border-green-500/30",
  java:       "bg-orange-500/20 text-orange-400 border border-orange-500/30",
  cpp:        "bg-purple-500/20 text-purple-400 border border-purple-500/30",
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newRoom, setNewRoom] = useState({ name: "", language: "javascript", password: "" });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchRooms();
  }, []);

  async function fetchRooms() {
    try {
      const { data } = await api.get("/api/v1/rooms");
      setRooms(data);
    } catch (err) {
      console.error("Failed to fetch rooms:", err.message);
    } finally {
      setLoading(false);
    }
  }

  async function createRoom(e) {
    e.preventDefault();
    if (!newRoom.name.trim()) return;
    setCreating(true);
    try {
      const { data } = await api.post("/api/v1/rooms", newRoom);
      navigate(`/room/${data.roomId}`);
    } catch (err) {
      alert(err.response?.data?.error || "Failed to create room");
    } finally {
      setCreating(false);
    }
  }

  async function deleteRoom(roomId) {
    if (!confirm("Delete this room?")) return;
    try {
      await api.delete(`/api/v1/rooms/${roomId}`);
      setRooms(rooms.filter((r) => r.roomId !== roomId));
    } catch (err) {
      alert(err.response?.data?.error || "Failed to delete room");
    }
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Navbar */}
      <nav className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <span className="text-white font-bold text-lg">⌨️ DevCollab</span>
        <div className="flex items-center gap-4">
          <span className="text-gray-400 text-sm">Hi, {user?.name}</span>
          <button
            onClick={() => { logout(); navigate("/login"); }}
            className="text-sm text-gray-400 hover:text-white transition"
          >
            Logout
          </button>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">Your Rooms</h1>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition"
          >
            + New Room
          </button>
        </div>

        {/* Create room form */}
        {showCreate && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
            <h2 className="text-white font-semibold mb-4">Create a new room</h2>
            <form onSubmit={createRoom} className="flex gap-3 items-end flex-wrap">
              <div className="flex-1 min-w-48">
                <label className="block text-sm text-gray-400 mb-1">Room name</label>
                <input
                  type="text"
                  value={newRoom.name}
                  onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })}
                  placeholder="e.g. My Python Project"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Language</label>
                <select
                  value={newRoom.language}
                  onChange={(e) => setNewRoom({ ...newRoom, language: e.target.value })}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Password <span className="text-gray-600">(optional)</span></label>
                <input
                  type="password"
                  value={newRoom.password}
                  onChange={(e) => setNewRoom({ ...newRoom, password: e.target.value })}
                  placeholder="Leave blank for public"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={creating}
                className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-semibold transition"
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </form>
          </div>
        )}

        {/* Room list */}
        {loading ? (
          <p className="text-gray-400">Loading rooms...</p>
        ) : rooms.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <p className="text-4xl mb-3">📂</p>
            <p>No rooms yet. Create one to start coding!</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {rooms.map((room) => (
              <div
                key={room.roomId}
                className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 flex items-center justify-between hover:border-gray-600 transition"
              >
                <div>
                  <div className="flex items-center gap-2">
                  <h3 className="text-white font-semibold">{room.name}</h3>
                  {room.hasPassword && <span title="Password protected" className="text-gray-500 text-xs">🔒</span>}
                </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LANG_BADGE[room.language] || "bg-gray-700 text-gray-400"}`}>
                      {room.language}
                    </span>
                    <span className="text-gray-500 text-xs">
                      Updated {new Date(room.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => navigate(`/room/${room.roomId}`)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-sm font-semibold transition"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => deleteRoom(room.roomId)}
                    className="text-gray-500 hover:text-red-400 px-2 py-1.5 rounded-lg text-sm transition"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

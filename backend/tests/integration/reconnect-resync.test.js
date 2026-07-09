// A client disconnects mid-session and reconnects — the backend instance
// itself is restarted in between (forcing a genuine cold start, not a warm
// in-memory hit), so the reconnect can only succeed by rehydrating from
// persisted state. Two variants isolate each layer of that persistence:
//   - Redis snapshot present  -> must resync from Redis
//   - Redis snapshot missing  -> must fall back to MongoDB
const mongoose = require("mongoose");
const {
  connect,
  joinRoom,
  syncRequest,
  sendUpdate,
  newDocFrom,
  textOf,
  uniqueId,
  wait,
  BACKEND1_URL,
} = require("./helpers/testClient");
const { redisDel } = require("./helpers/redis");
const { restartService, waitForHealth } = require("./helpers/docker");

// The docker-compose mongo container, reachable from the host via its
// published port — a throwaway local fixture, not the real dev/Atlas
// database (see docker-compose.yml).
const MONGODB_URI = process.env.MONGODB_URI_TEST || "mongodb://127.0.0.1:27017/devcollab";

describe("disconnect + reconnect resyncs from persisted state, no data loss", () => {
  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  test("resyncs via the Redis snapshot after the instance restarts", async () => {
    const roomId = uniqueId("room");
    // Not a real Mongo _id — File.findByIdAndUpdate silently no-ops for it,
    // which is what isolates this test to the Redis path specifically.
    const fileId = uniqueId("file");

    const socket = await connect(BACKEND1_URL, "redisResyncUser");
    await joinRoom(socket, roomId);
    const initialState = await syncRequest(socket, roomId, fileId);
    const doc = newDocFrom(initialState);
    let update;
    doc.on("update", (u) => { update = u; });
    doc.getText("content").insert(0, "REDIS-SNAPSHOT-CONTENT");
    sendUpdate(socket, roomId, fileId, update);

    // Wait past the 5s save/snapshot debounce, then simulate a dropped
    // connection mid-session.
    await wait(5500);
    socket.disconnect();

    // Force a real cold start: restart the container so its in-memory
    // ydocs Map is gone. The next sync-request can only be answered by
    // rehydrating from Redis or Mongo.
    restartService("backend1");
    await waitForHealth(`${BACKEND1_URL}/health`);

    const reconnected = await connect(BACKEND1_URL, "redisResyncUser");
    await joinRoom(reconnected, roomId);
    const resyncState = await syncRequest(reconnected, roomId, fileId);
    const text = textOf(newDocFrom(resyncState));

    expect(text).toBe("REDIS-SNAPSHOT-CONTENT");

    reconnected.close();
  }, 75000);

  test("falls back to MongoDB when the Redis snapshot is unavailable", async () => {
    if (mongoose.connection.readyState !== 1) await mongoose.connect(MONGODB_URI);
    const File = require("../../src/models/File");

    const roomId = uniqueId("room");
    const file = await File.create({ roomId, name: `${uniqueId("mongo-fallback")}.txt` });
    const fileId = file._id.toString();

    const socket = await connect(BACKEND1_URL, "mongoFallbackUser");
    await joinRoom(socket, roomId);
    const initialState = await syncRequest(socket, roomId, fileId);
    const doc = newDocFrom(initialState);
    let update;
    doc.on("update", (u) => { update = u; });
    doc.getText("content").insert(0, "MONGO-FALLBACK-CONTENT");
    sendUpdate(socket, roomId, fileId, update);

    await wait(5500); // let scheduleFileSave persist content + yjsState to Mongo
    socket.disconnect();

    // Simulate Redis losing this file's cache (eviction, flush, restart
    // without persistence, etc.) — Mongo must still be able to serve it.
    redisDel(`yjs:state:${fileId}`);

    restartService("backend1");
    await waitForHealth(`${BACKEND1_URL}/health`);

    const reconnected = await connect(BACKEND1_URL, "mongoFallbackUser");
    await joinRoom(reconnected, roomId);
    const resyncState = await syncRequest(reconnected, roomId, fileId);
    const text = textOf(newDocFrom(resyncState));

    expect(text).toBe("MONGO-FALLBACK-CONTENT");

    reconnected.close();
    await File.deleteOne({ _id: file._id });
  }, 75000);
});

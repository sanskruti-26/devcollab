// Two clients connected to the SAME backend instance, both editing the same
// file at (functionally) the same moment — a baseline regression test that
// the server-side Y.Doc merge itself is correct, independent of anything
// Redis-related (both edits land on the one in-process Y.Doc either way).
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

describe("concurrent conflicting edits — same instance", () => {
  test("both edits survive and merge deterministically via Yjs CRDT", async () => {
    const roomId = uniqueId("room");
    const fileId = uniqueId("file");

    const socketA = await connect(BACKEND1_URL, "sameInstanceA");
    const socketB = await connect(BACKEND1_URL, "sameInstanceB");
    await joinRoom(socketA, roomId);
    await joinRoom(socketB, roomId);

    const initialState = await syncRequest(socketA, roomId, fileId);
    const docA = newDocFrom(initialState);
    const docB = newDocFrom(initialState);

    let updateA;
    let updateB;
    docA.on("update", (u) => { updateA = u; });
    docB.on("update", (u) => { updateB = u; });

    // Both insert at index 0 of the SAME base state — a genuine conflict.
    // Yjs must resolve a deterministic order, but both insertions must
    // survive in the merged result.
    docA.getText("content").insert(0, "[[FROM-A]]");
    docB.getText("content").insert(0, "[[FROM-B]]");

    sendUpdate(socketA, roomId, fileId, updateA);
    sendUpdate(socketB, roomId, fileId, updateB);

    await wait(500);

    const finalState = await syncRequest(socketA, roomId, fileId);
    const text = textOf(newDocFrom(finalState));

    expect(text).toContain("[[FROM-A]]");
    expect(text).toContain("[[FROM-B]]");

    socketA.close();
    socketB.close();
  });
});

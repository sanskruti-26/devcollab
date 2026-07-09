// A cold-starting instance joining an existing room with in-flight edits
// must catch up correctly — and specifically via the Redis Stream backlog
// read (catchUpFromStream in services/roomService.js), not the periodic
// snapshot key, since the snapshot only refreshes on a 5s debounce and
// wouldn't have this edit yet.
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
  BACKEND2_URL,
} = require("./helpers/testClient");
const { redisGet } = require("./helpers/redis");

describe("cold-starting instance catches up via the XRANGE backlog, not the snapshot", () => {
  test("a late-joining instance receives an edit it never saw over pub/sub", async () => {
    const roomId = uniqueId("room");
    const fileId = uniqueId("file");

    // backend1 is warmed and subscribed to this file BEFORE any edit happens.
    const socket1 = await connect(BACKEND1_URL, "coldStartWarm");
    await joinRoom(socket1, roomId);
    const initialState = await syncRequest(socket1, roomId, fileId);
    const doc1 = newDocFrom(initialState);
    let update1;
    doc1.on("update", (u) => { update1 = u; });
    doc1.getText("content").insert(0, "IN-FLIGHT-EDIT");

    // backend2 has never touched this fileId, so it isn't subscribed — this
    // edit's live pub/sub delivery reaches nobody but backend1 itself.
    sendUpdate(socket1, roomId, fileId, update1);
    await wait(200); // let backend1 merge, publish, and XADD

    // Prove the snapshot key genuinely has nothing yet — well under the 5s
    // debounce — so if backend2 ends up with the edit below, it can only
    // have come from the stream catch-up read, not getRedisSnapshot.
    const snapshotBeforeColdStart = redisGet(`yjs:state:${fileId}`);
    expect(snapshotBeforeColdStart).toBeNull();

    // NOW backend2 opens the file for the first time — a genuine cold start
    // that must catch up via the stream backlog, since subscribing now is
    // too late to receive the edit above live.
    const socket2 = await connect(BACKEND2_URL, "coldStartLate");
    await joinRoom(socket2, roomId);
    const catchUpState = await syncRequest(socket2, roomId, fileId);
    const text = textOf(newDocFrom(catchUpState));

    expect(text).toContain("IN-FLIGHT-EDIT");

    socket1.close();
    socket2.close();
  });
});

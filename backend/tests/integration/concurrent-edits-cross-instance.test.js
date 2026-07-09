// Two clients connected to DIFFERENT backend instances, editing the same
// file within milliseconds of each other — the automated, repeatable version
// of scripts/verify-multi-instance-race.js. This is the scenario that
// originally exposed the Redis SET-overwrite race and, after that fix, the
// SUBSCRIBE-vs-PUBLISH race — see the state-ownership comment at the top of
// services/roomService.js.
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

describe("concurrent conflicting edits — different instances", () => {
  test("both edits survive and both instances converge to identical content", async () => {
    const roomId = uniqueId("room");
    const fileId = uniqueId("file");

    const socket1 = await connect(BACKEND1_URL, "crossInstanceA");
    const socket2 = await connect(BACKEND2_URL, "crossInstanceB");
    await joinRoom(socket1, roomId);
    await joinRoom(socket2, roomId);

    const initialState = await syncRequest(socket1, roomId, fileId);
    const doc1 = newDocFrom(initialState);
    const doc2 = newDocFrom(initialState);

    let update1;
    let update2;
    doc1.on("update", (u) => { update1 = u; });
    doc2.on("update", (u) => { update2 = u; });
    doc1.getText("content").insert(0, "HELLO-FROM-A");
    doc2.getText("content").insert(0, "HELLO-FROM-B");

    // Deliberately NOT awaited between each other — sequential edits with a
    // pause never exercise either race this test guards against.
    sendUpdate(socket1, roomId, fileId, update1);
    sendUpdate(socket2, roomId, fileId, update2);

    await wait(1500); // let Redis pub/sub + stream catch-up propagate

    const final1 = await syncRequest(socket1, roomId, fileId);
    const final2 = await syncRequest(socket2, roomId, fileId);
    const text1 = textOf(newDocFrom(final1));
    const text2 = textOf(newDocFrom(final2));

    expect(text1).toContain("HELLO-FROM-A");
    expect(text1).toContain("HELLO-FROM-B");
    expect(text2).toContain("HELLO-FROM-A");
    expect(text2).toContain("HELLO-FROM-B");
    expect(text1).toBe(text2);

    socket1.close();
    socket2.close();
  });
});

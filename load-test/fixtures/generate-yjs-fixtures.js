// generate-yjs-fixtures.js — one-time (re-run only if you need a bigger pool)
// offline generator for the k6 load test's Yjs update fixtures.
//
// Why fixtures at all, instead of building updates in k6 itself: k6 scripts
// run in goja (a pure-Go JS engine), not Node — there's no `require("yjs")`
// available there, and bundling the real yjs CRDT encoder into a k6 script
// is a lot of fragile machinery for something we can just precompute once.
//
// Why one template per (potential) virtual user, not one global template:
// every Yjs update is tagged with the origin Y.Doc's clientID. If every
// simulated "user" reused the exact same clientID, the server's CRDT would
// treat their edits as revisions of the SAME logical operation instead of
// distinct concurrent edits from different people — not how real usage
// looks, and not what we want to load-test. So each template here comes
// from its own Y.Doc with its own clientID; the k6 script gives VU N
// template N and reuses it for all of that VU's sends.
//
// Why a fixed marker offset shared across the whole pool: the k6 script
// needs to patch a fresh 32-byte marker (VU id + sequence + timestamp) into
// each outgoing update so a receiving VU can read the send time back out
// without decoding real Yjs structure. Yjs encodes clientID as a LEB128
// varint, whose BYTE LENGTH depends on the value's magnitude — so two
// templates with wildly different clientIDs can have their marker text sit
// at different byte offsets. Clamping every clientID into the same
// [BASE_CLIENT_ID, BASE_CLIENT_ID + POOL_SIZE) range keeps the varint width
// identical across the whole pool, so a single offset works for all of
// them. Generation asserts this rather than assuming it.

const fs = require("fs");
const path = require("path");
const Y = require("yjs");

const POOL_SIZE = 2000; // supports up to 2000 concurrent editor VUs; see README's scaling plan
const MARKER_LENGTH = 32;
const MARKER_PLACEHOLDER = "X".repeat(MARKER_LENGTH);
const BASE_CLIENT_ID = 1_000_000; // see file header — keeps LEB128 width uniform across the pool

const templates = [];
let markerOffset = null;

for (let i = 0; i < POOL_SIZE; i++) {
  const doc = new Y.Doc();
  doc.clientID = BASE_CLIENT_ID + i;

  let updateBytes = null;
  doc.on("update", (u) => {
    updateBytes = u;
  });
  doc.getText("content").insert(0, MARKER_PLACEHOLDER);

  if (!updateBytes) {
    throw new Error(`template ${i}: no update captured`);
  }

  const buf = Buffer.from(updateBytes);
  const offset = buf.indexOf(Buffer.from(MARKER_PLACEHOLDER, "utf8"));
  if (offset === -1) {
    throw new Error(`template ${i}: marker placeholder not found in encoded update`);
  }
  if (markerOffset === null) {
    markerOffset = offset;
  } else if (offset !== markerOffset) {
    throw new Error(
      `template ${i}: marker offset ${offset} != pool offset ${markerOffset} — ` +
        `clientID varint width isn't uniform across BASE_CLIENT_ID..BASE_CLIENT_ID+POOL_SIZE. ` +
        `Pick a BASE_CLIENT_ID further from a power-of-2^7k boundary.`
    );
  }

  templates.push(buf.toString("base64"));
}

const output = { markerOffset, markerLength: MARKER_LENGTH, templates };
const outPath = path.join(__dirname, "yjs-update-templates.json");
fs.writeFileSync(outPath, JSON.stringify(output));

console.log(
  `Wrote ${templates.length} templates to ${outPath} ` +
    `(markerOffset=${markerOffset}, avg template size=${Math.round(
      templates.reduce((s, t) => s + t.length, 0) / templates.length
    )} base64 chars).`
);

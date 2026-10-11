import { test } from "node:test";
import assert from "node:assert/strict";
import { newBoard, newCard, screenToWorld, worldToScreen, zoomAt, endpoint, connect, deleteCards, mapBounds, mapTransform, viewportBounds, parseBoard } from "../src/canvas/model.ts";
import { CanvasSession } from "../src/canvas/persistence.ts";

const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} ≠ ${b}`);
function memory() {
  const files = new Map();
  let fail = false;
  return { files, fail: value => { fail = value; },
    read: async path => { if (!files.has(path)) throw new Error("Missing"); return files.get(path); },
    write: async (path, contents) => { if (fail) throw new Error("Disk full"); files.set(path, contents); },
    listFiles: async dir => [...files.keys()].filter(p => p.slice(0, p.lastIndexOf("/")) === dir).map(p => p.slice(p.lastIndexOf("/") + 1)),
  };
}
const text = board => JSON.stringify(board, null, 2) + "\n";
const withCard = (board, body = "An idea") => ({ ...board, cards: [{ ...newCard({ x: -420, y: 700 }), body }] });

test("camera conversion and pointer-centered zoom work in every quadrant", () => {
  for (const zoom of [.02, .25, 1, 3]) {
    const camera = { x: -1400, y: 320, zoom }, p = { x: -6200, y: 9000 };
    const restored = screenToWorld(worldToScreen(p, camera), camera);
    approx(restored.x, p.x); approx(restored.y, p.y);
    const anchor = { x: 172, y: 330 }, before = screenToWorld(anchor, camera);
    const next = zoomAt(camera, anchor, zoom * 1.2), after = screenToWorld(anchor, next);
    approx(before.x, after.x); approx(before.y, after.y);
  }
});
test("connection endpoints track card movement and resizing", () => {
  const card = newCard({ x: -100, y: 50 });
  assert.deepEqual(endpoint(card, "right"), { x: 180, y: 130 });
  assert.deepEqual(endpoint({ ...card, x: 10, width: 400, height: 200 }, "bottom"), { x: 210, y: 250 });
});
test("connections reject self links and duplicates; card deletion removes incident edges", () => {
  const a = newCard({ x: 0, y: 0 }), b = newCard({ x: 400, y: 0 });
  const board = { ...newBoard(), cards: [a, b] };
  assert.equal(connect(board, a.id, a.id), board);
  const joined = connect(board, a.id, b.id);
  assert.equal(joined.connections.length, 1);
  assert.equal(connect(joined, b.id, a.id), joined);
  assert.deepEqual(deleteCards(joined, new Set([a.id])).connections, []);
});
test("minimap includes a viewport far away from cards and maps points reversibly", () => {
  const board = withCard(newBoard());
  const viewport = viewportBounds({ x: -50000, y: 30000, zoom: .5 }, { width: 1200, height: 800 });
  const bounds = mapBounds(board.cards, viewport);
  assert.ok(bounds.x <= board.cards[0].x && bounds.x <= viewport.x);
  assert.ok(bounds.y <= board.cards[0].y && bounds.y <= viewport.y);
  assert.ok(bounds.x + bounds.width >= viewport.x + viewport.width);
  const transform = mapTransform(bounds), point = { x: viewport.x, y: viewport.y };
  const restored = screenToWorld(worldToScreen(point, transform), transform);
  approx(restored.x, point.x); approx(restored.y, point.y);
});
test("future schemas, nonfinite geometry, dangling and repeated IDs fail validation", () => {
  const board = withCard(newBoard());
  assert.deepEqual(parseBoard(board), board);
  assert.throws(() => parseBoard({ ...board, version: 2 }));
  assert.throws(() => parseBoard({ ...board, cards: [{ ...board.cards[0], x: Infinity }] }));
  assert.throws(() => parseBoard({ ...board, cards: [board.cards[0], board.cards[0]] }));
  assert.throws(() => parseBoard({ ...board, connections: [{ id: "a", from: board.cards[0].id, to: "missing", fromSide: "right", toSide: "left", arrow: false }] }));
});
test("opening an empty canvas makes no files; editing round-trips", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs);
  await session.reload(); assert.equal(fs.files.size, 0);
  const board = withCard(session.get().board);
  session.change(board); await session.flush();
  const reopened = new CanvasSession("/Writing", fs); await reopened.reload();
  assert.deepEqual(reopened.get().board, board);
});
test("a move is one undo action; deleting and undoing restores connections", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs); await session.reload();
  const first = withCard(session.get().board);
  const second = { ...first, cards: [...first.cards, newCard({ x: 400, y: 0 })] };
  const joined = connect(second, second.cards[0].id, second.cards[1].id);
  session.change(joined);
  const moved = { ...joined, cards: joined.cards.map(c => ({ ...c, x: c.x + 600 })) };
  session.change(moved); session.undo(); assert.deepEqual(session.get().board, joined);
  session.redo(); assert.deepEqual(session.get().board, moved);
  session.change(deleteCards(moved, new Set([moved.cards[0].id])));
  session.undo(); assert.equal(session.get().board.connections.length, 1);
  await session.flush();
});
test("failed saves retain ideas and can be retried", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs); await session.reload();
  const board = withCard(session.get().board); session.change(board); fs.fail(true);
  await assert.rejects(session.flush(), /Disk full/);
  assert.deepEqual(session.get().board, board); assert.equal(session.get().status, "error");
  fs.fail(false); await session.flush(); assert.equal(session.get().status, "saved");
  assert.deepEqual(JSON.parse(fs.files.get(session.path)), board);
});
test("retrying a transient read failure works with an already-loaded board", async () => {
  const fs = memory(); let failRead = false;
  const session = new CanvasSession("/Writing", { ...fs, read: async path => {
    if (failRead) throw new Error("Temporarily unavailable"); return fs.read(path);
  } });
  await session.reload(); session.change(withCard(session.get().board)); await session.flush();
  failRead = true; await session.reload(); assert.equal(session.get().status, "error");
  failRead = false; await session.retry(); assert.equal(session.get().status, "saved");
});
test("saving over an externally damaged file is blocked without discarding local ideas", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs); await session.reload();
  const board = withCard(session.get().board); session.change(board); await session.flush();
  session.change({ ...board, cards: [{ ...board.cards[0], body: "Local edits" }] });
  fs.files.set(session.path, "{damaged externally");
  await assert.rejects(session.flush()); assert.equal(fs.files.get(session.path), "{damaged externally");
  assert.equal(session.get().board.cards[0].body, "Local edits");
  fs.files.set(session.path, text(board)); await session.retry();
  assert.equal(JSON.parse(fs.files.get(session.path)).cards[0].body, "Local edits");
});
test("folders have independent boards and save targets", async () => {
  const fs = memory(), a = new CanvasSession("/A", fs), b = new CanvasSession("/B", fs);
  await Promise.all([a.reload(), b.reload()]);
  a.change(withCard(a.get().board, "A")); b.change(withCard(b.get().board, "B"));
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(JSON.parse(fs.files.get(a.path)).cards[0].body, "A");
  assert.equal(JSON.parse(fs.files.get(b.path)).cards[0].body, "B");
});
test("damaged and future files remain unchanged when opening", async () => {
  for (const contents of ["{broken", text({ ...newBoard(), version: 9 })]) {
    const fs = memory(), session = new CanvasSession("/Writing", fs); fs.files.set(session.path, contents);
    await session.reload(); await session.flush();
    assert.equal(session.get().board, null); assert.equal(session.get().status, "error");
    assert.equal(fs.files.get(session.path), contents);
  }
});
test("remote edits arriving before save are preserved even before a sync UI event", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs); await session.reload();
  const original = withCard(session.get().board, "Original"); session.change(original); await session.flush();
  const local = { ...original, cards: [{ ...original.cards[0], body: "Local idea" }] };
  const remote = { ...original, cards: [{ ...original.cards[0], body: "Remote idea" }] };
  session.change(local); fs.files.set(session.path, text(remote)); await session.flush();
  assert.deepEqual(JSON.parse(fs.files.get(session.path)), local);
  assert.equal(session.get().recovered.length, 1);
  assert.deepEqual(await session.readRecovery(session.get().recovered[0]), remote);
});
test("remote reload during an edit is deferred; both versions survive", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs); await session.reload();
  const original = withCard(session.get().board); session.change(original); await session.flush();
  session.hold();
  const remote = { ...original, cards: [{ ...original.cards[0], body: "Theirs" }] };
  fs.files.set(session.path, text(remote)); await session.reload();
  assert.deepEqual(session.get().board, original);
  const local = { ...original, cards: [{ ...original.cards[0], body: "Ours" }] };
  session.change(local); session.release(); await session.reload(); await session.flush();
  assert.deepEqual(JSON.parse(fs.files.get(session.path)), local);
  assert.ok([...fs.files.values()].some(contents => contents === text(remote)));
});
test("restoring a recovered version backs up the current board and is undoable", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs); await session.reload();
  const current = withCard(session.get().board, "Current"), remote = withCard(newBoard(), "Recovered");
  session.change(current); await session.flush();
  fs.files.set(`${session.dir}/canvas (conflict from B).json`, text(remote));
  await session.reload(); await session.restore("canvas (conflict from B).json");
  assert.equal(session.get().board.cards[0].body, "Recovered");
  assert.ok([...fs.files.values()].includes(text(current)));
  session.undo(); assert.deepEqual(session.get().board, current); await session.flush();
  await assert.rejects(session.readRecovery("../../elsewhere.json"));
});
test("restoring over damaged data keeps the original bytes", async () => {
  const fs = memory(), session = new CanvasSession("/Writing", fs);
  fs.files.set(session.path, "{damaged");
  fs.files.set(`${session.dir}/canvas (conflict from B).json`, text(withCard(newBoard(), "Recovered")));
  await session.reload(); await session.restore("canvas (conflict from B).json");
  assert.equal(session.get().board.cards[0].body, "Recovered");
  assert.ok([...fs.files.values()].includes("{damaged"));
});
test("overlapping saves are serialized and never mark a newer edit saved early", async () => {
  const fs = memory();
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  let block = true;
  const session = new CanvasSession("/Writing", { ...fs, write: async (path, contents) => {
    if (block && path.endsWith("/canvas.json")) { entered(); await gate; block = false; }
    await fs.write(path, contents);
  } });
  await session.reload(); const first = withCard(session.get().board, "First"); session.change(first);
  const saving = session.flush(); await started;
  const latest = { ...first, cards: [{ ...first.cards[0], body: "Latest" }] }; session.change(latest);
  unblock(); await saving; assert.equal(session.get().status, "dirty");
  await session.flush(); assert.deepEqual(JSON.parse(fs.files.get(session.path)), latest);
});

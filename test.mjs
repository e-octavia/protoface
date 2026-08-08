// Round-trips every stock ProtoESP animation through the editor and checks the
// bytes come back identical.  Needs playwright; if it isn't installed here it
// falls back to the copy in the sibling choreograph checkout.
//
//   node test.mjs [path/to/ProtoESP-Controller/data/anims]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("playwright")); }
catch {
  const alt = path.join(HERE, "..", "choreograph", "node_modules", "playwright", "index.mjs");
  if (!fs.existsSync(alt)) { console.error("playwright not found — `npm i -D playwright`"); process.exit(2); }
  ({ chromium } = await import(alt));
}

const APP = "file://" + path.join(HERE, "protoface.html");
const ANIMS = process.argv[2] || path.join(HERE, "fixtures", "anims");
if (!fs.existsSync(ANIMS)) {
  console.error(`no animations at ${ANIMS}\npass the path to ProtoESP-Controller/data/anims as an argument.`);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log("  ok   " + m); };
const bad = (m) => { fail++; console.log("  FAIL " + m); };
const eq  = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(`${m}\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(APP);

console.log("\n— boot —");
eq(await page.locator(".px").count(), 11 * 64, "704 pixels rendered (11 panels)");
eq(await page.locator(".seg").count(), 11, "11 panel groups");
eq(await page.evaluate(() => S.frames.length), 1, "starts with one blank frame");
eq(errors, [], "no page errors on load");

console.log("\n— import round-trip (all 8 stock animations) —");
for (const fn of fs.readdirSync(ANIMS).filter(f => f.endsWith(".json"))) {
  const orig = JSON.parse(fs.readFileSync(path.join(ANIMS, fn), "utf8"));
  await page.setInputFiles("#fileIn", path.join(ANIMS, fn));
  await page.waitForFunction(n => S.frames.length === n, orig.visor.frames.length);
  const out = await page.evaluate(() => buildJSON());

  const gotLeds  = out.visor.frames.map(f => f.leds.map(h => BigInt("0x" + h).toString(16)));
  const wantLeds = orig.visor.frames.map(f => f.leds.map(h => BigInt("0x" + h).toString(16)));
  eq(gotLeds, wantLeds, `${fn}: every panel of every frame identical`);
  eq(out.visor.frames.map(f => f.timespan), orig.visor.frames.map(f => f.timespan), `${fn}: timespans preserved`);
  eq(out.visor.isMouth, orig.visor.isMouth, `${fn}: isMouth preserved`);
  eq(out.ears.type, orig.ears.type, `${fn}: ear type preserved`);
  if (orig.ears.frames) eq(out.ears.frames, orig.ears.frames, `${fn}: custom ear frames passed through verbatim`);
}

// imports deliberately change filename / layout / RGB mode, so start each
// independent block from a clean page
const reset = () => page.goto(APP);

console.log("\n— per-pixel colour survives an RGB round-trip —");
await reset();
await page.evaluate(() => {
  if (!S.rgb) document.getElementById("bRGB").click();
  document.getElementById("pxColor").value = "#00ff88";
  paint(3, 9, 1);                       // panel 3, row 1 col 1
});
{
  const out = await page.evaluate(() => buildJSON());
  const g3 = out.visor.frames[0].ppColor.find(g => g.mIndex === 3);
  const g7 = out.visor.frames[0].ppColor.find(g => g.mIndex === 7);   // mirror of 3 in an 11-panel face
  eq(g3 && g3.data, [[9, "00ff88"]], "ppColor written for the painted pixel");
  eq(g7 && g7.data, [[14, "00ff88"]], "mirrored pixel is row 1 col 6 (idx 14) on panel 7");
  const mono = await page.evaluate(() => { document.getElementById("bRGB").click(); return buildJSON(); });
  eq(mono.visor.frames[0].ppColor, [], "monochrome export emits no ppColor");
  eq(mono.visor.frames[0].fColor.every(c => c === "0"), true, "monochrome export zeroes fColor");
}

console.log("\n— mirror maps panel p ↔ N-1-p, col c ↔ 7-c —");
await reset();
{
  const r = await page.evaluate(() => { paint(0, 7, 1); return [...F().leds[10]].findIndex(v => v); });
  eq(r, 0, "painting t0 r0c7 lights t10 r0c0");
  await reset();
  const nose = await page.evaluate(() => {
    paint(5, 2, 1);        // nose panel is its own mirror
    return [...F().leds[5]].map((v, i) => v ? i : null).filter(v => v !== null);
  });
  eq(nose, [2, 5], "nose panel mirrors onto itself (col 2 ↔ col 5)");
}

console.log("\n— shift moves across panel seams within a band —");
await reset();
{
  const r = await page.evaluate(() => {
    document.getElementById("tMirror").click();          // mirror off
    F().leds[3][0] = 1;                                   // mouth band t2 t3 t4: leftmost col of t3
    document.querySelector('[data-shift="left"]').click();
    return { t3: [...F().leds[3]].filter(Boolean).length, t2_idx: [...F().leds[2]].findIndex(v => v) };
  });
  eq(r, { t3: 0, t2_idx: 7 }, "pixel crosses from t3 into t2 (mouth scrolls as one 24-wide strip)");

  await reset();
  const gap = await page.evaluate(() => {
    document.getElementById("tMirror").click();
    F().leds[4][7] = 1;                                   // right edge of the LEFT mouth half
    document.querySelector('[data-shift="right"]').click();
    return { t4: [...F().leds[4]].filter(Boolean).length, t6: [...F().leds[6]].filter(Boolean).length };
  });
  eq(gap, { t4: 0, t6: 0 }, "pixels fall off the end of a half — they don't jump the gap to the other half");

  await reset();
  eq(await page.evaluate(() => bands()), [[0, 1], [9, 10], [5], [2, 3, 4], [6, 7, 8]],
     "11-panel face groups into eye/eye/nose/mouth/mouth bands");
}

console.log("\n— layout validation rejects nonsense —");
await reset();
for (const [str, why] of [["t0;t2", "gap in panel numbering"], ["t0;t0", "duplicate panel"], ["-;-", "no panels"], ["q7", "unknown token"]]) {
  const msg = await page.evaluate(s => { try { parseLayout(s); return null; } catch (e) { return e.message; } }, str);
  msg ? ok(`rejected "${str}" — ${msg}`) : bad(`accepted "${str}" (${why})`);
}
{
  const n = await page.evaluate(() => { applyLayout(PRESETS["14"].visType, PRESETS["14"].isMouth); return S.nSeg; });
  eq(n, 14, "14-panel preset applies");
  eq(await page.locator(".px").count(), 14 * 64, "14-panel preset re-renders the stage");
  eq(await page.locator(".bl").count(), 8, "14-panel preset draws its 8 blush LEDs");
}

console.log("\n— editing stops playback (the frame-duration smear) —");
await reset();
{
  // build a 4-frame animation, start it playing, then type into the duration
  // field the way you would by hand.  Before the fix the playhead kept moving
  // and each keystroke landed on a different frame.
  await page.evaluate(() => { for (let i = 0; i < 3; i++) document.getElementById("fAdd").click(); S.cur = 0; render(); });
  await page.click("#bPlay");
  eq(await page.evaluate(() => S.playing), true, "playing");
  await page.click("#msIn");
  eq(await page.evaluate(() => S.playing), false, "clicking into the duration field pauses");

  const before = await page.evaluate(() => S.cur);
  await page.fill("#msIn", "");
  await page.type("#msIn", "120", { delay: 60 });
  await page.waitForTimeout(400);                        // longer than a frame
  const after = await page.evaluate(() => ({ cur: S.cur, spans: S.frames.map(f => f.timespan) }));
  eq(after.cur, before, "the playhead did not move while typing");
  eq(after.spans.filter(v => v !== 500), [120], "exactly one frame changed — no smear");

  await page.click("#bPlay");
  await page.evaluate(() => { paint(0, 0, 1); });
  eq(await page.evaluate(() => S.playing), true, "paint() alone doesn't pause (it's the low-level call)");
  await page.mouse.move(0, 0);
  await page.click(".px");
  eq(await page.evaluate(() => S.playing), false, "clicking a pixel pauses");
  for (const [sel, name] of [["#bFill","Fill"], ["#bInvert","Invert"], ['[data-shift="up"]',"shift"], ["#fDup","Duplicate"]]) {
    await page.click("#bPlay");
    await page.click(sel);
    eq(await page.evaluate(() => S.playing), false, `${name} pauses`);
  }
}

console.log("\n— undo / redo —");
await reset();
{
  await page.click(".px");                               // one stroke
  const lit = () => page.evaluate(() => S.frames.reduce((a,f) => a + f.leds.flatMap(x => [...x]).filter(Boolean).length, 0));
  eq(await lit(), 2, "painted pixel + its mirror");
  eq(await page.evaluate(() => document.getElementById("bUndo").disabled), false, "undo button enabled after an edit");
  await page.keyboard.press("Meta+z");
  eq(await lit(), 0, "⌘Z undoes the stroke");
  await page.keyboard.press("Meta+Shift+z");
  eq(await lit(), 2, "⇧⌘Z redoes it");

  // a drag is ONE undo step, not one per pixel
  await reset();
  const box = await page.locator(".px").first().boundingBox();
  await page.mouse.move(box.x + 3, box.y + 3);
  await page.mouse.down();
  for (let i = 1; i < 6; i++) await page.mouse.move(box.x + 3 + i * 18, box.y + 3);
  await page.mouse.up();
  eq(await lit(), 12, "drag painted 6 pixels + 6 mirrored");
  await page.keyboard.press("Meta+z");
  eq(await lit(), 0, "one ⌘Z undoes the whole drag");

  // typing several digits is ONE undo step
  await reset();
  await page.click("#msIn");
  await page.fill("#msIn", "");
  await page.type("#msIn", "250", { delay: 30 });
  await page.keyboard.press("Meta+z");
  eq(await page.evaluate(() => S.frames[0].timespan), 500, "one ⌘Z undoes the whole number");

  await reset();
  eq(await page.evaluate(() => {
    const d = document.getElementById("bUndo").disabled;
    document.getElementById("fAdd").click();
    applyLayout(PRESETS["14"].visType, PRESETS["14"].isMouth);
    return [d, S.undo.length];
  }), [true, 0], "undo starts empty and is cleared when the panel count changes");
}

console.log("\n— new animation —");
await reset();
{
  await page.setInputFiles("#fileIn", path.join(ANIMS, "happy.json"));
  await page.waitForFunction(() => S.frames.length === 2);
  page.once("dialog", d => d.accept());
  await page.click("#btnNew");
  eq(await page.evaluate(() => [S.frames.length, S.frames[0].leds[0].some(Boolean)]), [1, false],
     "New leaves one empty frame");
  await page.keyboard.press("Meta+z");
  eq(await page.evaluate(() => S.frames.length), 2, "⌘Z brings the animation back");
}

console.log("\n— drag to reorder the timeline —");
await reset();
{
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) document.getElementById("fAdd").click();
    S.frames.forEach((f, i) => f.timespan = (i + 1) * 100);   // tag them 100/200/300
    S.cur = 0; render();
  });
  const spans = () => page.evaluate(() => S.frames.map(f => f.timespan));
  eq(await spans(), [100, 200, 300], "starting order");

  const frames = page.locator(".fr");
  const a = await frames.nth(0).boundingBox(), c = await frames.nth(2).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width - 4, c.y + c.height / 2, { steps: 12 });
  await page.mouse.up();
  eq(await spans(), [200, 300, 100], "dragged frame 0 past the end");
  eq(await page.evaluate(() => S.cur), 2, "the dragged frame stays selected");
  await page.keyboard.press("Meta+z");
  eq(await spans(), [100, 200, 300], "⌘Z undoes a reorder");
}

console.log("\n— slide (motion tween) —");
await reset();
{
  // one pixel at the left of the left-mouth band, slid a full 24px lap
  await page.evaluate(() => { document.getElementById("tMirror").click(); F().leds[2][0] = 1; render(); });
  const made = await page.evaluate(() => slide(24, 0, 24, true));
  eq(made, 23, "a full-width wrapping lap makes 23 frames, not 24 — the 24th would repeat frame 0");
  eq(await page.evaluate(() => S.frames.length), 24, "24 frames total");
  eq(await page.evaluate(() => S.frames.map(f => [...f.leds[2], ...f.leds[3], ...f.leds[4]].findIndex(Boolean))
       .slice(0, 3).map(i => i % 64)), [0, 1, 2], "the pixel advances one column per frame");
  eq(await page.evaluate(() => {
      const last = S.frames[23], b = [2,3,4];
      return b.map(s => [...last.leds[s]].findIndex(Boolean));
     }), [-1, -1, 7], "after 23 frames it sits in the last column of t4, one step from home");
  eq(await page.evaluate(() => S.frames.every(f => f.leds[6].every(v => !v))),
     true, "the other mouth half was never touched");
  await page.keyboard.press("Meta+z");
  eq(await page.evaluate(() => S.frames.length), 1, "one ⌘Z undoes the whole slide");
}
await reset();
{
  await page.evaluate(() => { document.getElementById("tMirror").click(); F().leds[2][0] = 1; render(); });
  await page.evaluate(() => slide(-8, 0, 8, false));   // walk off the left edge
  eq(await page.evaluate(() => S.frames.length), 2,
     "without wrap it stops making frames once the drawing has left the face");
  eq(await page.evaluate(() => S.frames[1].leds.every(p => p.every(v => !v))), true, "the last frame is empty");
}
await reset();
{
  await page.evaluate(() => { F().leds[5][2] = 1; render(); });   // nose, mirror on
  await page.evaluate(() => { selectSeg(5); slide(0, 8, 8, true); });
  eq(await page.evaluate(() => S.frames.length), 8, "a vertical wrapping lap of the 8px-tall nose makes 7 new frames");
  eq(await page.evaluate(() => S.frames.map(f => [...f.leds[5]].findIndex(Boolean) >> 3)),
     [0, 1, 2, 3, 4, 5, 6, 7], "it moves down one row per frame");
}
await reset();
{
  // two laps must NOT drop the frame that passes through home mid-way
  await page.evaluate(() => { selectSeg(5); F().leds[5][0] = 1; render(); return slide(16, 0, 16, true); });
  eq(await page.evaluate(() => S.frames.length), 16, "a two-lap slide keeps its mid-point pass through home");
  eq(await page.evaluate(() => S.frames.map(f => [...f.leds[5]].findIndex(Boolean) % 8).slice(7, 10)),
     [7, 0, 1], "it passes through column 0 and carries on");
}

console.log("\n— selecting a panel —");
await reset();
{
  eq(await page.locator("#panelChips button").count(), 11, "one chip per panel");
  await page.locator('#panelChips button[data-chip="4"]').click();
  eq(await page.evaluate(() => S.selSeg), 4, "a sidebar chip selects");
  eq(await page.evaluate(() => document.getElementById("panelBox").style.display !== "none"), true,
     "the Panel tools appear");
  await page.locator('#panelChips button[data-chip="4"]').click();
  eq(await page.evaluate(() => S.selSeg), -1, "clicking the same chip deselects");

  await page.locator('.seg[data-seg="6"] .tag').click();
  eq(await page.evaluate(() => S.selSeg), 6, "the t-label on the face selects");

  const lit = () => page.evaluate(() => S.frames.reduce((a,f) => a + f.leds.flatMap(x => [...x]).filter(Boolean).length, 0));
  await page.locator('.px[data-seg="8"]').first().click({ modifiers: ["Shift"] });
  eq(await page.evaluate(() => S.selSeg), 8, "shift-clicking a pixel selects its panel");
  eq(await lit(), 0, "…and does not paint it");

  await page.evaluate(() => applyLayout(PRESETS["14"].visType, PRESETS["14"].isMouth));
  eq(await page.locator("#panelChips button").count(), 14, "chips rebuild when the layout changes");
  eq(await page.evaluate(() => S.selSeg), -1, "and the selection is cleared");
}

console.log("\n— rotate / flip a panel —");
await reset();
{
  // an L in the top-left corner of t5 (the nose, its own mirror) so orientation is unambiguous
  const setL = () => page.evaluate(() => {
    F().leds[5].fill(0);
    [[0,0],[1,0],[2,0],[2,1]].forEach(([r,c]) => F().leds[5][r*8+c] = 1);
    selectSeg(5); render();
  });
  const cells = s => page.evaluate(seg => [...F().leds[seg]].map((v,i) => v ? [i>>3, i&7] : null).filter(Boolean), s);

  await setL();
  eq(await cells(5), [[0,0],[1,0],[2,0],[2,1]], "starting L");
  await page.click("#pRotCW");
  // the bar lies along the top; the foot, which was right of the bar's bottom,
  // ends up below the bar's left end
  eq(await cells(5), [[0,5],[0,6],[0,7],[1,5]], "↻ takes the top-left corner to the top-right");
  await page.click("#pRotCCW");
  eq(await cells(5), [[0,0],[1,0],[2,0],[2,1]], "↺ puts it back");
  await page.click("#pFlipH");
  eq(await cells(5), [[0,7],[1,7],[2,6],[2,7]], "↔ mirrors left-to-right");
  await page.click("#pFlipH");
  await page.click("#pFlipV");
  eq(await cells(5), [[5,0],[5,1],[6,0],[7,0]], "↕ mirrors top-to-bottom");
  await page.keyboard.press("Meta+z");
  eq(await cells(5), [[0,0],[1,0],[2,0],[2,1]], "each op is one undo step");
}

console.log("\n— panel ops keep a mirrored face symmetric —");
await reset();
{
  const symmetric = () => page.evaluate(() =>
    S.frames[0].leds.every((p, s) =>
      [...p].every((v, i) => v === S.frames[0].leds[S.nSeg-1-s][(i>>3)*8 + (7-(i&7))])));
  await page.evaluate(() => {
    [[0,0],[1,0],[2,0],[2,1]].forEach(([r,c]) => paint(0, r*8+c, 1));   // mirror on
    selectSeg(0);
  });
  eq(await symmetric(), true, "the drawing starts symmetric");
  for (const op of ["#pRotCW", "#pFlipH", "#pFlipV", "#pRotCCW"]) {
    await page.click(op);
    eq(await symmetric(), true, `still symmetric after ${op.slice(2)}`);
  }
  eq(await page.evaluate(() => {
      selectSeg(0); const before = [...F().leds[10]];
      document.getElementById("tMirror").click();      // mirror off
      panelOp("rotCW");
      const after = [...F().leds[10]];
      return before.join("") === after.join("");
     }), true, "with Mirror off the far panel is left alone");
}

console.log("\n— copy / paste a panel —");
await reset();
{
  await page.evaluate(() => {
    document.getElementById("tMirror").click();                     // mirror off
    [[0,0],[1,0],[2,0],[2,1]].forEach(([r,c]) => F().leds[2][r*8+c] = 1);
    selectSeg(2); render();
  });
  eq(await page.evaluate(() => document.getElementById("pPaste").disabled), true, "Paste is disabled until something is copied");
  await page.click("#pCopy");
  eq(await page.evaluate(() => document.getElementById("pPaste").disabled), false, "Paste enables after Copy");
  await page.evaluate(() => selectSeg(4));
  await page.click("#pPaste");
  eq(await page.evaluate(() => [...F().leds[4]].join("") === [...F().leds[2]].join("")), true,
     "t4 now matches t2 exactly");
  eq(await page.evaluate(() => F().leds[3].every(v => !v)), true, "nothing else was touched");

  // with mirror on, paste also lands mirrored on the far side
  await reset();
  await page.evaluate(() => {
    [[0,0],[1,0],[2,0],[2,1]].forEach(([r,c]) => F().leds[2][r*8+c] = 1);
    selectSeg(2); copyPanel(); selectSeg(3); pastePanel();
  });
  eq(await page.evaluate(() => [...F().leds[7]].map((v,i) => v ? [i>>3,i&7] : null).filter(Boolean)),
     [[0,7],[1,7],[2,6],[2,7]], "the mirror panel t7 got a left-right flipped copy");
  eq(await page.evaluate(() => S.undo.length), 1, "a paste is one undo step; the copy is not an edit");
}

console.log("\n— toggle a row or column —");
await reset();
{
  const hover = (seg, idx) => page.evaluate(([s,i]) => {
    document.querySelector(`.px[data-seg="${s}"][data-idx="${i}"]`)
      .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  }, [seg, idx]);

  await hover(3, 2*8 + 4);                       // mouth band t2/t3/t4, row 2
  await page.keyboard.press("r");
  eq(await page.evaluate(() => [2,3,4].map(s => [...F().leds[s]].filter(Boolean).length)), [8,8,8],
     "R lights the whole row across all three panels of the mouth band");
  eq(await page.evaluate(() => [6,7,8].map(s => [...F().leds[s]].filter(Boolean).length)), [8,8,8],
     "and the mirrored band too, since Mirror is on");
  eq(await page.evaluate(() => F().leds[0].every(v => !v)), true, "the eye band is untouched");
  await page.keyboard.press("r");
  eq(await page.evaluate(() => S.frames[0].leds.every(p => p.every(v => !v))), true,
     "R again clears it — a full line toggles off");

  await hover(0, 5*8 + 3);
  await page.keyboard.press("c");
  eq(await page.evaluate(() => [...F().leds[0]].map((v,i) => v ? i&7 : null).filter(v => v !== null)),
     [3,3,3,3,3,3,3,3], "C lights the full 8-pixel column of that panel only");
  eq(await page.evaluate(() => [...F().leds[10]].map((v,i) => v ? i&7 : null).filter(v => v !== null)),
     [4,4,4,4,4,4,4,4], "mirrored to column 4 of t10");
  await page.keyboard.press("Meta+z");
  eq(await page.evaluate(() => S.frames[0].leds.every(p => p.every(v => !v))), true, "one ⌘Z undoes a line toggle");
}

console.log("\n— a face wider than the window stays reachable —");
await reset();
{
  await page.setViewportSize({ width: 700, height: 800 });
  await page.evaluate(() => applyLayout(PRESETS["14"].visType, PRESETS["14"].isMouth));
  const left = await page.locator(".px").first().boundingBox();
  const wrap = await page.locator("#stageWrap").boundingBox();
  ok(`14-panel face on a 700px window: first pixel at x=${left.x.toFixed(0)}`);
  left.x >= wrap.x - 1
    ? ok("left edge is not clipped outside the scroll container")
    : bad(`left edge sits at ${left.x.toFixed(0)}, outside the container at ${wrap.x} — unscrollable`);
  await page.setViewportSize({ width: 1500, height: 900 });
}

console.log("\n— export actually downloads —");
await reset();
{
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnExport")]);
  const tmp = "/tmp/protoface-export-test.json";
  await dl.saveAs(tmp);
  const j = JSON.parse(fs.readFileSync(tmp, "utf8"));
  eq(dl.suggestedFilename(), "myface.json", "download named from the field");
  eq([j.visor.type, j.visor.leds === undefined, j.visor.frames[0].leds.length], ["custom", true, 11], "exported file has the firmware's shape");
  eq(j.visor.frames[0].leds[0], "0000000000000000", "blank frame exports all-zero panels");
  fs.unlinkSync(tmp);
}

eq(errors, [], "no page errors across the whole run");
await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

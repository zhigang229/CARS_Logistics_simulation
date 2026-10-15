// 仿真内核回归测试：node tests/sim-core.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const C = require(path.join(__dirname, "..", "src", "wwwroot", "assets", "js", "sim-core.js"));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}
const run = (sc, seed, duration) => {
  const sim = C.createSim(JSON.parse(JSON.stringify(sc)), { seed, duration });
  while (!sim.done) sim.step(C.SIM_DT);
  return sim;
};

console.log("sim-core");

test("示例方案通过校验", () => {
  assert.deepStrictEqual(C.validateScenario(C.sampleScenario()), []);
});

test("示例方案 8 小时班次：指标合理、无死锁", () => {
  const sc = C.sampleScenario();
  const t0 = Date.now();
  const sim = run(sc, 7, 28800);
  const k = C.computeKPI(sim, sc);
  assert.ok(Date.now() - t0 < 10000, "8 小时仿真应在 10 秒内完成");
  assert.strictEqual(sim.problems.length, 0);
  assert.strictEqual(k.overrides, 0, "不应出现死锁放行");
  assert.ok(k.util > 0.6 && k.util < 0.95, "平均利用率 " + k.util);
  assert.ok(k.deliveries > 600, "送料次数 " + k.deliveries);
  assert.strictEqual(k.ontime, 1, "Milk Run 应全部按节拍发车");
  const agvCharges = k.vehicles.filter(v => v.id.startsWith("R2")).map(v => v.charges);
  assert.ok(agvCharges.every(n => n >= 1), "AGV 应回充");
});

test("同一随机种子结果完全可复现", () => {
  const sc = C.sampleScenario();
  const a = C.computeKPI(run(sc, 3, 7200), sc), b = C.computeKPI(run(sc, 3, 7200), sc);
  assert.strictEqual(a.deliveries, b.deliveries);
  assert.strictEqual(a.util, b.util);
});

test("车辆之间不重叠", () => {
  const sc = C.sampleScenario();
  const sim = C.createSim(JSON.parse(JSON.stringify(sc)), { seed: 3, duration: 7200 });
  let overlaps = 0;
  while (!sim.done) {
    sim.step(C.SIM_DT);
    if (Math.round(sim.t * 10) % 50 !== 0) continue;
    const act = sim.vehicles.filter(v => v.active);
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const p = C.posAlong(act[i], act[i].vt.length / 2), q = C.posAlong(act[j], act[j].vt.length / 2);
      if (Math.hypot(p.x - q.x, p.z - q.z) < 0.5) overlaps++;
    }
  }
  assert.strictEqual(overlaps, 0);
});

test("路段方向错误时给出提示并跳过路线", () => {
  const sc = C.sampleScenario();
  const e = sc.edges.find(x => x.a === "n6" && x.b === "n9");
  [e.a, e.b] = [e.b, e.a];
  assert.ok(C.validateScenario(sc).some(v => v.level === "error"));
  const sim = C.createSim(JSON.parse(JSON.stringify(sc)), { seed: 1, duration: 60 });
  assert.ok(sim.problems.some(p => p.includes("没有可达路径")));
});

test("空白方案可以运行（无车辆）", () => {
  const sc = C.blankScenario("空白");
  const sim = C.createSim(sc, { seed: 1, duration: 60 });
  assert.strictEqual(sim.vehicles.length, 0);
});

// ---------------------------------------------------------------- 路网整理
const net = (nodes, edges, extra = {}) => Object.assign({ nodes: nodes.map(([id, x, z]) => ({ id, x, z })), edges: edges.map(([a, b, dir = "fwd"], i) => ({ id: "e" + i, a, b, dir, limit: null })), stations: [], routes: [] }, extra);
const sig = r => r.edges.map(e => { const N = new Map(r.nodes.map(n => [n.id, n])); const a = N.get(e.a), b = N.get(e.b); return `${a.x},${a.z}>${b.x},${b.z}:${e.dir}`; }).sort();

test("交叉路段自动生成路口并连通", () => {
  const r = C.normalizeNetwork(net([["a", 0, 5], ["b", 10, 5], ["c", 5, 0], ["d", 5, 10]], [["a", "b"], ["c", "d"]]));
  assert.strictEqual(r.stats.crossings, 1);
  assert.strictEqual(r.nodes.length, 5);
  assert.strictEqual(r.edges.length, 4);
  const g = C.buildGraph(r);
  assert.ok(C.shortestPath(g, "a", "d", 1), "交叉后应能从横向路段转到纵向路段");
});

test("部分重叠的路段合并为一条", () => {
  const r = C.normalizeNetwork(net([["a", 0, 0], ["b", 10, 0], ["c", 4, 0], ["d", 14, 0]], [["a", "b"], ["c", "d"]]));
  assert.deepStrictEqual(sig(r), ["0,0>4,0:fwd", "10,0>14,0:fwd", "4,0>10,0:fwd"]);
  assert.strictEqual(r.stats.edges, 1);
});

test("方向相反的重叠单向路段合并为双向", () => {
  const r = C.normalizeNetwork(net([["a", 0, 0], ["b", 10, 0]], [["a", "b"], ["b", "a"]]));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.edges[0].dir, "both");
});

test("相近节点合并，站点与途经点跟随", () => {
  const sc = net([["a", 0, 0], ["b", 10, 0], ["b2", 10.1, 0], ["c", 20, 0]], [["a", "b"], ["b2", "c"]],
    { stations: [{ id: "s1", node: "b2", name: "S", type: "drop" }], routes: [{ id: "r", stops: ["s1"], via: { "x>y": ["b", "c"] } }] });
  const r = C.normalizeNetwork(sc);
  assert.strictEqual(r.nodes.length, 3);
  assert.strictEqual(r.stations[0].node, "b2", "应保留带站点的节点");
  assert.deepStrictEqual(r.routes[0].via["x>y"], ["b2", "c"]);
  assert.ok(C.shortestPath(C.buildGraph(r), "a", "c", 1));
});

test("整理结果再次整理不再变化", () => {
  const r1 = C.normalizeNetwork(net([["a", 0, 5], ["b", 10, 5], ["c", 5, 0], ["d", 5, 10], ["e", 2, 5], ["f", 12, 5]], [["a", "b"], ["c", "d"], ["e", "f", "both"]]));
  const r2 = C.normalizeNetwork({ nodes: r1.nodes, edges: r1.edges, stations: [], routes: [] });
  assert.strictEqual(r2.changed, false);
});

test("示例方案无需整理", () => {
  assert.strictEqual(C.normalizeNetwork(C.sampleScenario()).changed, false);
});

// ---------------------------------------------------------------- 指定往返路线
function viaScenario(via) {
  const sc = C.blankScenario("往返");
  sc.nodes = [{ id: "A", x: 2, z: 10 }, { id: "B", x: 22, z: 10 }, { id: "T", x: 12, z: 2 }, { id: "U", x: 12, z: 12 }];
  sc.edges = [["A", "T"], ["T", "B"], ["A", "U"], ["U", "B"]].map(([a, b], i) => ({ id: "e" + i, a, b, dir: "both", limit: null }));
  sc.stations = [{ id: "sA", name: "仓库", node: "A", type: "pick", dwellMode: "fixed", d1: 10, d2: 0 }, { id: "sB", name: "线边", node: "B", type: "drop", dwellMode: "fixed", d1: 10, d2: 0 }];
  sc.routes = [{ id: "r", name: "往返", color: "#000", vtype: "vt-agv", count: 1, period: 0, gap: 0, stops: ["sA", "sB"], via }];
  sc.vtypes[0].runtimeH = 0;
  return sc;
}
test("未指定途经点时往返都走最短路", () => {
  const sc = viaScenario(undefined), g = C.buildGraph(sc);
  const st = new Map(sc.stations.map(x => [x.id, x]));
  assert.deepStrictEqual(C.routeLegPath(g, sc.routes[0], st.get("sA"), st.get("sB"), 1).map(a => a.to), ["U", "B"]);
  assert.deepStrictEqual(C.routeLegPath(g, sc.routes[0], st.get("sB"), st.get("sA"), 1).map(a => a.to), ["U", "A"]);
});
test("去程按指定途经点行驶，回程自动", () => {
  const sc = viaScenario({ "sA>sB": ["T"] });
  const sim = C.createSim(JSON.parse(JSON.stringify(sc)), { seed: 1, duration: 600 });
  const seen = new Set();
  while (!sim.done) { sim.step(C.SIM_DT); const v = sim.vehicles[0]; if (v.active) seen.add(v.legs[v.li].key); }
  assert.strictEqual(sim.problems.length, 0);
  for (const k of ["A>T", "T>B", "B>U", "U>A"]) assert.ok(seen.has(k), "应经过 " + k + "，实际 " + [...seen].join(" "));
  assert.ok(!seen.has("A>U"), "去程不应走最短路 A>U");
  assert.ok(sim.vehicles[0].lapNo >= 3);
});
test("途经点不可达时提示并跳过路线", () => {
  const sc = viaScenario({ "sA>sB": ["T"] });
  sc.edges.find(e => e.a === "T" && e.b === "B").dir = "fwd"; [sc.edges[0].a, sc.edges[0].b] = ["T", "A"]; sc.edges[0].dir = "fwd";
  assert.ok(C.validateScenario(sc).some(v => v.level === "error" && v.msg.includes("指定途经点")));
  assert.ok(C.createSim(sc, { seed: 1, duration: 60 }).problems.length === 1);
});

console.log(passed + " passed");

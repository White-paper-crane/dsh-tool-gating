// 纯逻辑自测：组清单校验 + load_tools 状态机。不需要宿主，不需要 fake ctx。
// 运行：node tests/test-state.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGroupsFile, parseGroups } from "../lib/groups.js";
import { createGateState, normalizeGroupsArg } from "../lib/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_FILE = path.join(HERE, "..", "groups.json");

let passed = 0;
const failures = [];

function test(title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${title}`);
  } catch (error) {
    failures.push({ title, error });
    console.log(`  FAIL ${title}\n       ${error?.message ?? error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const model = loadGroupsFile(GROUPS_FILE);
const allKnown = new Set(model.allTools.map((t) => t.name).concat(model.coreNames));

section("normalizeGroupsArg");
test("字符串转数组", () => {
  assert.deepEqual(normalizeGroupsArg({ groups: "coding" }), { ok: true, groups: ["coding"] });
});
test("数组去重并 trim", () => {
  assert.deepEqual(normalizeGroupsArg({ groups: [" a ", "a", "b"] }), { ok: true, groups: ["a", "b"] });
});
test("缺 groups 报错", () => {
  const r = normalizeGroupsArg({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /缺少 groups/);
});
test("空数组报错", () => {
  assert.equal(normalizeGroupsArg({ groups: [] }).ok, false);
});
test("非字符串项报错", () => {
  assert.equal(normalizeGroupsArg({ groups: ["a", 1] }).ok, false);
});
test("参数不是对象报错", () => {
  assert.equal(normalizeGroupsArg(null).ok, false);
});
test("超过 32 个组报错", () => {
  const many = Array.from({ length: 33 }, (_, i) => `g${i}`);
  assert.equal(normalizeGroupsArg({ groups: many }).ok, false);
});

section("groups.json 校验");
test("真实清单可解析，工具数 125", () => {
  assert.equal(model.allTools.length + model.core.length, 125);
});
test("version 必须为 1", () => {
  assert.throws(() => parseGroups({ version: 2, core: [{ name: "load_tools", purpose: "x" }], groups: {} }), /version/);
});
test("core 必须含 load_tools", () => {
  assert.throws(() => parseGroups({ version: 1, core: [{ name: "read", purpose: "x" }], groups: { g: [{ name: "grep", purpose: "y" }] } }), /load_tools/);
});
test("工具名重复报错", () => {
  assert.throws(
    () =>
      parseGroups({
        version: 1,
        core: [{ name: "load_tools", purpose: "x" }, { name: "read", purpose: "x" }],
        groups: { g: [{ name: "read", purpose: "y" }] },
      }),
    /重复/,
  );
});
test("组名不能叫 core", () => {
  assert.throws(
    () => parseGroups({ version: 1, core: [{ name: "load_tools", purpose: "x" }], groups: { core: [{ name: "read", purpose: "y" }] } }),
    /保留字/,
  );
});
test("purpose 超 40 字报错", () => {
  assert.throws(
    () =>
      parseGroups({
        version: 1,
        core: [{ name: "load_tools", purpose: "x" }],
        groups: { g: [{ name: "read", purpose: "x".repeat(41) }] },
      }),
    /purpose/,
  );
});

section("createGateState：初始 L0");
function freshState(options = {}) {
  return createGateState(model, options);
}
test("初始 deny = 全部非 core", () => {
  const deny = freshState().desiredDeny(allKnown);
  assert.equal(deny.length, model.allTools.length);
  assert.equal(deny.includes("load_tools"), false);
  assert.equal(deny.includes("read"), false);
});
test("known 里没有的名字不 deny（restrict 会抛 unknown）", () => {
  const known = new Set(["read", "load_tools", "diagram_apply"]);
  assert.deepEqual(freshState().desiredDeny(known), ["diagram_apply"]);
});
test("groupOfTool：core→null / 已配置→组名 / 未知→null", () => {
  const gate = freshState();
  assert.equal(gate.groupOfTool("read"), null);
  assert.equal(gate.groupOfTool("diagram_apply"), "coding");
  assert.equal(gate.groupOfTool("nope_not_here"), null);
});

section("createGateState：plan / commit");
test("未知组拒绝并给出可加载组", () => {
  const gate = freshState();
  const p = gate.plan(["browserr"], { turnKey: "t1" });
  assert.equal(p.kind, "reject");
  assert.equal(p.code, "unknown-group");
  assert.deepEqual(p.detail, ["browserr"]);
  assert.ok(p.available.includes("browser"));
});
test("加载一组后 deny 少掉该组", () => {
  const gate = freshState();
  const p = gate.plan(["coding"], { turnKey: "t1" });
  assert.equal(p.kind, "apply");
  assert.deepEqual(p.added, ["coding"]);
  assert.equal(gate.commit(p), true);
  const deny = gate.desiredDeny(allKnown);
  for (const name of model.groups.get("coding").names) assert.equal(deny.includes(name), false, `${name} 不该被 deny`);
  assert.ok(deny.includes("memory_save"));
});
test("重复加载同组是 noop", () => {
  const gate = freshState();
  gate.commit(gate.plan(["coding"], { turnKey: "t1" }));
  const p = gate.plan(["coding"], { turnKey: "t1" });
  assert.equal(p.kind, "noop");
  assert.equal(p.code, "already-active");
});
test("增量加载：再点一组只加不减", () => {
  const gate = freshState();
  gate.commit(gate.plan(["coding"], { turnKey: "t1" }));
  const p = gate.plan(["teams"], { turnKey: "t1" });
  assert.equal(p.kind, "apply");
  assert.deepEqual(p.added, ["teams"]);
  gate.commit(p);
  assert.deepEqual(gate.activeGroups.sort(), ["coding", "teams"]);
});
test("core 回到 L0（reset）", () => {
  const gate = freshState();
  gate.commit(gate.plan(["coding", "teams"], { turnKey: "t1" }));
  const p = gate.plan(["core"], { turnKey: "t1" });
  assert.equal(p.kind, "apply");
  assert.equal(p.reset, true);
  assert.deepEqual(p.groups, []);
  gate.commit(p);
  assert.deepEqual(gate.activeGroups, []);
  assert.equal(gate.desiredDeny(allKnown).length, model.allTools.length);
});
test("已经在 L0 时点 core 是 noop", () => {
  assert.equal(freshState().plan(["core"], { turnKey: "t1" }).kind, "noop");
});
test("reset + 新组：core,coding 等价于只留 coding", () => {
  const gate = freshState();
  gate.commit(gate.plan(["teams"], { turnKey: "t1" }));
  const p = gate.plan(["core", "coding"], { turnKey: "t1" });
  assert.equal(p.kind, "apply");
  assert.deepEqual(p.groups, ["coding"]);
});

section("预算");
test("每 turn 2 次：第 3 次被拒，下一 turn 恢复", () => {
  const gate = freshState({ maxSwitchesPerTurn: 2 });
  assert.equal(gate.plan(["coding"], { turnKey: "t1" }).kind, "apply");
  gate.commit(gate.plan(["coding"], { turnKey: "t1" }));
  assert.equal(gate.plan(["teams"], { turnKey: "t1" }).kind, "apply");
  gate.commit(gate.plan(["teams"], { turnKey: "t1" }));
  const third = gate.plan(["browser"], { turnKey: "t1" });
  assert.equal(third.kind, "reject");
  assert.equal(third.code, "turn-budget");
  assert.equal(gate.plan(["browser"], { turnKey: "t2" }).kind, "apply");
});
test("预算用完后 noop 仍然 noop（不误报预算）", () => {
  const gate = freshState({ maxSwitchesPerTurn: 1 });
  gate.commit(gate.plan(["coding"], { turnKey: "t1" }));
  assert.equal(gate.plan(["coding"], { turnKey: "t1" }).kind, "noop");
});
test("会话上限：超了之后换 turn 也不行", () => {
  const gate = freshState({ maxSwitchesPerTurn: 9, maxSwitchesPerSession: 2 });
  gate.commit(gate.plan(["coding"], { turnKey: "t1" }));
  gate.commit(gate.plan(["teams"], { turnKey: "t1" }));
  const p = gate.plan(["browser"], { turnKey: "t9" });
  assert.equal(p.kind, "reject");
  assert.equal(p.code, "session-budget");
});
test("turnKey 取不到时只做会话上限（不误报 turn 预算）", () => {
  const gate = freshState({ maxSwitchesPerTurn: 1, maxSwitchesPerSession: 3 });
  gate.commit(gate.plan(["coding"], {}));
  const p = gate.plan(["teams"], {});
  assert.equal(p.kind, "apply");
});
test("被拒的 plan 不消耗预算", () => {
  const gate = freshState({ maxSwitchesPerTurn: 1, maxSwitchesPerSession: 2 });
  const rejected = gate.plan(["nope"], { turnKey: "t1" });
  assert.equal(rejected.kind, "reject");
  assert.equal(gate.snapshot().sessionSwitches, 0);
  gate.commit(gate.plan(["coding"], { turnKey: "t1" }));
  assert.equal(gate.snapshot().sessionSwitches, 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const { title, error } of failures) console.error(`\nFAIL: ${title}\n${error?.stack ?? error}`);
process.exit(failures.length === 0 ? 0 : 1);
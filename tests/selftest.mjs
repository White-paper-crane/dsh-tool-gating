// 离线自检：用假 ctx 跑真插件代码。不需要启动 DSH，也不需要安装插件。
// 运行：node tests/selftest.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as plugin from "../index.js";
import { loadGroupsFile, renderCatalog } from "../lib/groups.js";
import { createHost, GATE } from "./fake-ctx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const model = loadGroupsFile(path.join(HERE, "..", "groups.json"));

let passed = 0;
const failures = [];
function check(title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${title}`);
  } catch (error) {
    failures.push({ title, error });
    console.log(`  FAIL ${title}\n       ${error?.message ?? error}`);
  }
}
async function checkAsync(title, fn) {
  try {
    await fn();
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const coreNames = model.core.map((t) => t.name).sort();

/** 假宿主里把真实 profile 上存在的工具都先注册好（load_tools 留给插件注册）。 */
function seedRegistry(host) {
  for (const tool of [...model.core, ...model.allTools]) {
    if (tool.name === "load_tools") continue;
    host.registry.set(tool.name, {
      name: tool.name,
      description: tool.purpose,
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: String(v) }] },
      execute: async () => `${tool.name} ok`,
    });
  }
}

function boot(config = {}) {
  const host = createHost();
  seedRegistry(host);
  const api = plugin.apply(host.ctx, config);
  return { host, api };
}

/** section.text 允许是函数（自动发现后要能换目录），测试里统一取当前值。 */
function textOf(entry) {
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return entry;
  return typeof entry.text === "function" ? entry.text() : entry.text;
}

/** 把一次 load_tools 调用当成模型调用：走 registry 里的定义直接执行。 */
async function callLoad(host, agent, args) {
  const definition = host.registry.get("load_tools");
  assert.ok(definition, "load_tools 没注册");
  return definition.execute(args, { name: "load_tools", arguments: args, agent });
}

section("插件导出契约");
check("导出 name / inject / apply", () => {
  assert.equal(plugin.name, "tool-gating");
  assert.deepEqual(plugin.inject, ["tools", "systemPrompt"]);
  assert.equal(typeof plugin.apply, "function");
});

section("系统提示目录");
{
  const { host, api } = boot();
  const catalog = host.sections.get("tool-gating-catalog");
  check("注册了目录 section", () => {
    assert.ok(catalog, "缺 section");
    assert.equal(catalog.order, 3990);
    assert.equal(catalog.interpolate, false);
  });
  check("目录含全部组的标题与工具行", () => {
    for (const groupName of model.groups.keys()) assert.match(textOf(catalog), new RegExp(`### ${groupName}`));
    assert.match(textOf(catalog), /- diagram_apply — 结构化改画布/);
    assert.match(textOf(catalog), /- load_tools|常驻（core）：.*load_tools/);
    assert.match(textOf(catalog), /每 turn 最多切 2 次/);
  });
  check("目录是静态的：不含运行时状态字样", () => {
    assert.equal(textOf(api.catalog), renderCatalog(model));
    assert.doesNotMatch(textOf(catalog), /已加载组|deny|L0 当前/);
  });
  check("目录三个快照逐字节一致", () => {
    assert.equal(textOf(host.sections.get("tool-gating-catalog")), renderCatalog(model));
    assert.equal(renderCatalog(model), renderCatalog(loadGroupsFile(path.join(HERE, "..", "groups.json"))));
  });
}

section("工具注册");
{
  const { host } = boot();
  const definition = host.registry.get("load_tools");
  check("load_tools 已注册且带 output.render", () => {
    assert.ok(definition);
    assert.equal(typeof definition.output.render, "function");
    assert.deepEqual(definition.output.schema, { type: "string" });
  });
  check("parameters 是合法 JSON Schema 且必填 groups", () => {
    assert.equal(definition.parameters.type, "object");
    assert.deepEqual(definition.parameters.required, ["groups"]);
    assert.equal(definition.parameters.properties.groups.type, "array");
  });
  check("output.render 产出 text content", () => {
    assert.deepEqual(definition.output.render({}, "hi"), [{ type: "text", text: "hi" }]);
  });
}

section("L0：agent 创建后只剩 core");
{
  const { host, api } = boot();
  const agent = host.createAgent("a1");
  host.emit("agent/created", { agent, source: "session" });
  check("agent 创建即套上限制层", () => {
    assert.equal(api.records.size, 1);
    assert.equal(agent[GATE].layers.length, 1);
  });
  check("可见工具 = core", () => {
    assert.deepEqual(host.visibleNames(agent), coreNames);
  });
  check("deny 覆盖全部非 core 且不含未知名", () => {
    const deny = agent[GATE].layers.flatMap((l) => [...l.deny]);
    assert.equal(deny.length, model.allTools.length);
    for (const name of deny) assert.ok(model.toolToGroup.has(name));
  });
}

section("load_tools 正常路径");
await checkAsync("加载 memory 后下一步可见 memory 组", async () => {
  const { host } = boot();
  const agent = host.createAgent("a3");
  host.emit("agent/created", { agent });
  const text = await callLoad(host, agent, { groups: ["memory"] });
  assert.match(text, /已加载：memory/);
  assert.match(text, /下一步的工具列表里会出现/);
  const visible = host.visibleNames(agent);
  for (const name of model.groups.get("memory").names) assert.ok(visible.includes(name), `${name} 应可见`);
  assert.ok(visible.includes("memory_save"));
  assert.ok(!visible.includes("diagram_apply"));
});
await checkAsync("重复加载是 noop", async () => {
  const { host } = boot();
  const agent = host.createAgent("a4");
  host.emit("agent/created", { agent });
  await callLoad(host, agent, { groups: ["memory"] });
  const text = await callLoad(host, agent, { groups: ["memory"] });
  assert.match(text, /已经加载过/);
});
await checkAsync("未知组给出可加载组清单", async () => {
  const { host } = boot();
  const agent = host.createAgent("a5");
  host.emit("agent/created", { agent });
  const text = await callLoad(host, agent, { groups: ["nope"] });
  assert.match(text, /没有这些组：nope/);
  assert.match(text, /coding/);
});
await checkAsync("参数缺 groups 只报错不改状态", async () => {
  const { host } = boot();
  const agent = host.createAgent("a6");
  host.emit("agent/created", { agent });
  const text = await callLoad(host, agent, {});
  assert.match(text, /缺少 groups/);
  assert.equal(agent[GATE].layers.length, 1, "不该新增限制层");
});

section("pre-execute 兜底（未加载就调用）");
await checkAsync("调用未加载工具 → 自动加载该组 + deny 提示下一步重试", async () => {
  const { host } = boot();
  const agent = host.createAgent("b1");
  host.emit("agent/created", { agent });
  assert.ok(!host.visibleNames(agent).includes("motion_render"));
  const decision = await host.callTool(agent, "motion_render");
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /已自动加载该组/);
  assert.match(decision.reason, /下一步重试/);
  // 下一步：media 组已进可见集
  assert.ok(host.visibleNames(agent).includes("motion_render"));
});
await checkAsync("core 工具与未知工具不拦截", async () => {
  const { host } = boot();
  const agent = host.createAgent("b2");
  host.emit("agent/created", { agent });
  const coreCall = await host.callTool(agent, "read");
  assert.equal(coreCall.kind, "allow", "core 工具应原样放行");
  host.registry.set("third_party_tool", { execute: async () => "ok" });
  await tick();
  const third = await host.callTool(agent, "third_party_tool");
  assert.equal(third.kind, "allow", "第三方未配置工具应始终放行");
  assert.ok(host.visibleNames(agent).includes("third_party_tool"));
});
await checkAsync("预算用尽时兜底只提示，不加载", async () => {
  const { host } = boot();
  const agent = host.createAgent("b3");
  host.emit("agent/created", { agent });
  await callLoad(host, agent, { groups: ["coding"] });
  await callLoad(host, agent, { groups: ["teams"] });
  const decision = await host.callTool(agent, "motion_render");
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /尚未加载/);
  assert.match(decision.reason, /load_tools/);
  assert.ok(!host.visibleNames(agent).includes("motion_render"));
});

section("预算与 turn 边界");
await checkAsync("每 turn 2 次，第 3 次拒绝；下一 turn 放行", async () => {
  const { host } = boot();
  const agent = host.createAgent("c1");
  host.emit("agent/created", { agent });
  await callLoad(host, agent, { groups: ["coding"] });
  await callLoad(host, agent, { groups: ["teams"] });
  const blocked = await callLoad(host, agent, { groups: ["ops"] });
  assert.match(blocked, /本 turn 已切满 2 次/);
  assert.ok(!host.visibleNames(agent).includes("schedule_create"));
  agent.phase.turn = 2;
  const ok = await callLoad(host, agent, { groups: ["ops"] });
  assert.match(ok, /已加载：ops/);
});
await checkAsync("会话上限 6 次：跨 turn 也拦，新 agent 不受影响", async () => {
  // 把每 turn 上限调高，单独验证会话上限（默认 2 会先被 turn 预算拦住）。
  const { host } = boot({ maxSwitchesPerTurn: 99 });
  const agent = host.createAgent("c2");
  host.emit("agent/created", { agent });
  const order = ["coding", "teams", "ops", "context", "misc", "memory"];
  for (const groupName of order) await callLoad(host, agent, { groups: [groupName] });
  agent.phase.turn += 1;
  const blocked = await callLoad(host, agent, { groups: ["media"] });
  assert.match(blocked, /本会话切换次数已用完/);
  const other = host.createAgent("c3");
  host.emit("agent/created", { agent: other });
  const ok = await callLoad(host, other, { groups: ["media"] });
  assert.match(ok, /已加载：media/);
});
await checkAsync("两个 agent 的工具面互不影响", async () => {
  const { host } = boot();
  const a = host.createAgent("d1");
  const b = host.createAgent("d2");
  host.emit("agent/created", { agent: a });
  host.emit("agent/created", { agent: b });
  await callLoad(host, a, { groups: ["memory"] });
  assert.ok(host.visibleNames(a).includes("memory_save"));
  assert.ok(!host.visibleNames(b).includes("memory_save"));
  assert.deepEqual(host.visibleNames(b), coreNames);
});

section("回到 L0");
await checkAsync("load_tools(['core']) 收回全部组", async () => {
  const { host } = boot();
  const agent = host.createAgent("e1");
  host.emit("agent/created", { agent });
  await callLoad(host, agent, { groups: ["memory", "media"] });
  assert.ok(host.visibleNames(agent).includes("motion_render"));
  const text = await callLoad(host, agent, { groups: ["core"] });
  assert.match(text, /已回到 L0/);
  assert.deepEqual(host.visibleNames(agent), coreNames);
});

section("lazy 注入 / 后注册工具");
await checkAsync("后注册的已配置工具会被补 deny（不可绕过）", async () => {
  const { host } = boot();
  const agent = host.createAgent("f1");
  host.emit("agent/created", { agent });
  // 模拟 dsh-browser-cdp 的 lazy：此刻还没注册 bcdp_navigate
  host.registry.delete("bcdp_navigate");
  await tick();
  assert.ok(!host.visibleNames(agent).includes("bcdp_navigate"));
  host.registry.set("bcdp_navigate", { execute: async () => "ok" });
  host.emit("tools/change");
  await tick();
  await tick();
  assert.ok(!host.visibleNames(agent).includes("bcdp_navigate"), "lazy 注入后必须仍被门控");
});
await checkAsync("加载组后后注册的同组工具直接可见", async () => {
  const { host } = boot();
  const agent = host.createAgent("f2");
  host.emit("agent/created", { agent });
  await callLoad(host, agent, { groups: ["browser"] });
  host.registry.set("bcdp_navigate", { execute: async () => "ok" });
  host.emit("tools/change");
  await tick();
  await tick();
  assert.ok(host.visibleNames(agent).includes("bcdp_navigate"));
});

section("生命周期与清理");
await checkAsync("agent/disposed 释放限制层", async () => {
  const { host, api } = boot();
  const agent = host.createAgent("g1");
  host.emit("agent/created", { agent });
  assert.equal(agent[GATE].layers.length, 1);
  host.emit("agent/disposed", { agent });
  assert.equal(agent[GATE].layers.length, 0);
  assert.equal(api.records.size, 0);
});
await checkAsync("ctx dispose：撤工具、撤 section、撤限制层", async () => {
  const { host } = boot();
  const agent = host.createAgent("g2");
  host.emit("agent/created", { agent });
  host.ctx.dispose();
  assert.equal(host.registry.has("load_tools"), false);
  assert.equal(host.sections.size, 0);
  assert.equal(agent[GATE].layers.length, 0);
});
await checkAsync("拿不到 agent 时返回文本而不是抛错", async () => {
  const { host } = boot();
  const definition = host.registry.get("load_tools");
  const text = await definition.execute({ groups: ["memory"] }, { name: "load_tools", arguments: {}, agent: undefined });
  assert.match(text, /拿不到 agent 上下文/);
});
await checkAsync("插件热加载时给已有 agent 补 L0", async () => {
  const host = createHost();
  seedRegistry(host);
  const existing = host.createAgent("h1");
  plugin.apply(host.ctx, {});
  assert.equal(existing[GATE].layers.length, 1);
  assert.deepEqual(host.visibleNames(existing), coreNames);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const { title, error } of failures) console.error(`\nFAIL: ${title}\n${error?.stack ?? error}`);
process.exit(failures.length === 0 ? 0 : 1);
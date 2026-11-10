// 组清单的解析、校验与目录文本渲染。
// 纯函数：不碰 ctx，方便离线自测。
import fs from "node:fs";

export const CORE_GROUP = "core";
const RESET_NAMES = new Set(["core", "none"]);
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const GROUP_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_PURPOSE_CHARS = 40;

function fail(message) {
  throw new Error(`[tool-gating] groups.json 校验失败：${message}`);
}

function assertToolEntry(entry, where) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`${where} 必须是 { name, purpose } 对象`);
  }
  const name = entry.name;
  const purpose = entry.purpose;
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
    fail(`${where} 的工具名非法："${String(name)}"（要求 ^[a-z][a-z0-9_]{1,63}$）`);
  }
  if (typeof purpose !== "string" || purpose.trim() === "") {
    fail(`${where}（${name}）缺少 purpose`);
  }
  if (purpose.length > MAX_PURPOSE_CHARS) {
    fail(`${where}（${name}）purpose 超过 ${MAX_PURPOSE_CHARS} 字`);
  }
  return { name, purpose: purpose.trim() };
}

/**
 * 解析并校验一份组清单。
 * @param {unknown} raw JSON 解析结果
 * @param {{source?: string}} [meta]
 * @returns {{source:string, version:number, core:Array<{name:string,purpose:string}>, coreNames:Set<string>, groups:Map<string,{name:string,tools:Array<{name:string,purpose:string}>,names:Set<string>}>, toolToGroup:Map<string,string>, allTools:Array<{name:string,purpose:string,group:string}>, limits:{maxSwitchesPerTurn:number,maxSwitchesPerSession:number}}}
 */
export function parseGroups(raw, meta = {}) {
  const source = meta.source ?? "(memory)";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("根节点必须是对象");
  if (raw.version !== 1) fail(`version 必须是 1，实际是 ${JSON.stringify(raw.version)}`);

  const limitsIn = raw.limits ?? {};
  if (limitsIn === null || typeof limitsIn !== "object" || Array.isArray(limitsIn)) fail("limits 必须是对象");
  const limits = {
    maxSwitchesPerTurn: positiveInt(limitsIn.maxSwitchesPerTurn, 2, "limits.maxSwitchesPerTurn"),
    maxSwitchesPerSession: positiveInt(limitsIn.maxSwitchesPerSession, 6, "limits.maxSwitchesPerSession"),
  };

  const auto = parseAuto(raw.auto);

  if (!Array.isArray(raw.core) || raw.core.length === 0) fail("core 必须是非空数组");
  const seen = new Map();
  const core = raw.core.map((entry, i) => {
    const tool = assertToolEntry(entry, `core[${i}]`);
    if (seen.has(tool.name)) fail(`工具名重复：${tool.name}（core[${i}] 与 ${seen.get(tool.name)}）`);
    seen.set(tool.name, `core[${i}]`);
    return tool;
  });
  const coreNames = new Set(core.map((t) => t.name));
  if (!coreNames.has("load_tools")) {
    fail("core 必须包含 load_tools，否则加载入口会被自己关掉");
  }

  const groupsIn = raw.groups;
  if (groupsIn === null || typeof groupsIn !== "object" || Array.isArray(groupsIn)) fail("groups 必须是对象");
  const groupNames = Object.keys(groupsIn);
  if (groupNames.length === 0) fail("groups 不能为空");

  const groups = new Map();
  const toolToGroup = new Map();
  const allTools = [];
  const order = [];
  for (const groupName of groupNames) {
    if (!GROUP_NAME_RE.test(groupName)) fail(`组名非法："${groupName}"（要求 ^[a-z][a-z0-9-]{0,31}$）`);
    if (RESET_NAMES.has(groupName)) fail(`组名 "${groupName}" 被用作「回到 L0」的保留字`);
    const list = groupsIn[groupName];
    if (!Array.isArray(list) || list.length === 0) fail(`组 ${groupName} 必须是非空数组`);
    const tools = [];
    const names = new Set();
    list.forEach((entry, i) => {
      const tool = assertToolEntry(entry, `groups.${groupName}[${i}]`);
      if (seen.has(tool.name)) fail(`工具名重复：${tool.name}（groups.${groupName}[${i}] 与 ${seen.get(tool.name)}）`);
      if (names.has(tool.name)) fail(`组 ${groupName} 内工具重复：${tool.name}`);
      seen.set(tool.name, `groups.${groupName}[${i}]`);
      names.add(tool.name);
      tools.push(tool);
      toolToGroup.set(tool.name, groupName);
      allTools.push({ ...tool, group: groupName });
    });
    groups.set(groupName, { name: groupName, tools, names });
    order.push(groupName);
  }

  return { source, version: 1, core, coreNames, groups, toolToGroup, allTools, order, limits, auto };
}

/** 自动分组配置：{ enabled, exclude }。exclude 支持精确名与「前缀*」。 */
function parseAuto(raw) {
  if (raw === undefined) return { enabled: false, exclude: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("auto 必须是对象");
  const enabled = raw.enabled !== false;
  const exclude = raw.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((x) => typeof x !== "string" || x.trim() === "")) {
    fail("auto.exclude 必须是字符串数组");
  }
  return { enabled, exclude: exclude.map((x) => x.trim()) };
}

function isExcluded(name, patterns) {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** 工具名 → 组名：取第一个下划线之前的部分；没有下划线就自成一组。 */
function groupKey(name) {
  const i = name.indexOf("_");
  const key = i >= 2 ? name.slice(0, i) : name;
  return GROUP_NAME_RE.test(key) ? key : null;
}

function purposeOf(description) {
  const line = String(description ?? "").split(/[\r\n]/)[0].trim();
  if (line === "") return "（自动发现）";
  return line.length > MAX_PURPOSE_CHARS ? `${line.slice(0, MAX_PURPOSE_CHARS - 1)}…` : line;
}

/**
 * 把「组清单里没登记、但宿主里真实存在」的工具按名字前缀自动归组。
 * 好处：新装的插件不用改 groups.json 就能受门控，也不会白占 schema。
 * 只在会话开始时算一次——目录文本一变，整段前缀就作废。
 * @param {ReturnType<typeof parseGroups>} model
 * @param {Array<{name:string, description?:string}>} catalog 当前宿主里可见的工具
 * @param {{enabled:boolean, exclude:string[]}} [auto]
 */
export function deriveAutoGroups(model, catalog, auto = model.auto) {
  if (!auto?.enabled || !Array.isArray(catalog)) return { model, added: 0, groups: [] };
  const groups = new Map();
  for (const [key, group] of model.groups) {
    groups.set(key, { name: key, tools: [...group.tools], names: new Set(group.names) });
  }
  const toolToGroup = new Map(model.toolToGroup);
  const allTools = [...model.allTools];
  const order = [...model.order];
  const touched = [];
  let added = 0;
  for (const entry of catalog) {
    const toolName = entry?.name;
    if (typeof toolName !== "string") continue;
    if (model.coreNames.has(toolName) || toolToGroup.has(toolName)) continue;
    if (isExcluded(toolName, auto.exclude)) continue;
    const key = groupKey(toolName);
    if (key === null) continue;
    let group = groups.get(key);
    if (group === undefined) {
      group = { name: key, tools: [], names: new Set() };
      groups.set(key, group);
      order.push(key);
      touched.push(key);
    }
    if (group.names.has(toolName)) continue;
    const tool = { name: toolName, purpose: purposeOf(entry.description) };
    group.tools.push(tool);
    group.names.add(toolName);
    toolToGroup.set(toolName, key);
    allTools.push({ ...tool, group: key });
    added += 1;
  }
  if (added === 0) return { model, added: 0, groups: [] };
  return { model: { ...model, groups, toolToGroup, allTools, order }, added, groups: touched };
}

function positiveInt(value, fallback, where) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) fail(`${where} 必须是正整数`);
  return value;
}

/** 读取并解析组清单文件。 */
export function loadGroupsFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`[tool-gating] 读不到组清单 ${filePath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`[tool-gating] 组清单不是合法 JSON（${filePath}）：${error.message}`);
  }
  return parseGroups(parsed, { source: filePath });
}

/** 目录里出现的组名（`core` 是保留字，不出现在这里）。 */
export function groupNames(model) {
  return [...model.groups.keys()];
}

/** 判断请求里的名字是不是「回到 L0」的保留字。 */
export function isResetName(name) {
  return RESET_NAMES.has(name);
}

/**
 * 渲染系统提示里的静态目录。
 * 只依赖组清单，不随加载状态变化——目录一变，整段前缀就作废。
 * @param {ReturnType<typeof parseGroups>} model
 */
export function renderCatalog(model) {
  const lines = [];
  lines.push("[tool-gating] 工具按组加载。先用 load_tools(groups=[\"组名\"]) 加载，下一步的工具列表里才会出现；已在 tool list 里的工具直接用，不必加载。");
  lines.push(`常驻（core）：${model.core.map((t) => t.name).join("、")}`);
  lines.push(`可加载组：${groupNames(model).join("、")}`);
  lines.push(
    `限制：每 turn 最多切 ${model.limits.maxSwitchesPerTurn} 次，每会话最多切 ${model.limits.maxSwitchesPerSession} 次；` +
      "load_tools(groups=[\"core\"]) 回到 L0。未加载就调用会先失败一次并提示已自动加载。",
  );
  lines.push("");
  for (const groupName of model.groups.keys()) {
    const group = model.groups.get(groupName);
    lines.push(`### ${groupName}`);
    for (const tool of group.tools) lines.push(`- ${tool.name} — ${tool.purpose}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
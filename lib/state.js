// 门控状态机：纯逻辑，不碰 ctx，可离线自测。
// 只记两件事：哪些组已加载；本 turn / 本会话切了几次。
import { isResetName } from "./groups.js";

const MAX_NAMES_PER_CALL = 32;

/**
 * 解析 load_tools 的入参。
 * @returns {{ok:true, groups:string[]} | {ok:false, reason:string}}
 */
export function normalizeGroupsArg(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "参数必须是对象，例如 { groups: [\"coding\"] }" };
  }
  const raw = args.groups ?? args.group;
  if (raw === undefined) {
    return { ok: false, reason: "缺少 groups（字符串或字符串数组，例如 [\"coding\"]）" };
  }
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) return { ok: false, reason: "groups 必须是字符串或字符串数组" };
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") return { ok: false, reason: "groups 里每一项都必须是字符串" };
    const name = item.trim();
    if (name === "") continue;
    if (name.length > 32) return { ok: false, reason: `组名过长：${name.slice(0, 16)}…` };
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) return { ok: false, reason: "groups 是空的" };
  if (out.length > MAX_NAMES_PER_CALL) return { ok: false, reason: `一次最多点名 ${MAX_NAMES_PER_CALL} 个组` };
  return { ok: true, groups: out };
}

/**
 * 建一个门控状态。
 * @param {import("./groups.js").parseGroups extends (r:any,m:any)=>infer M ? M : never} model
 * @param {{maxSwitchesPerTurn?:number, maxSwitchesPerSession?:number, extraCore?:string[]}} [options]
 */
export function createGateState(model, options = {}) {
  const maxTurn = options.maxSwitchesPerTurn ?? model.limits.maxSwitchesPerTurn;
  const maxSession = options.maxSwitchesPerSession ?? model.limits.maxSwitchesPerSession;
  const coreNames = new Set(model.coreNames);
  for (const name of options.extraCore ?? []) {
    if (typeof name === "string" && name !== "") coreNames.add(name);
  }

  let active = new Set();
  let turnKey;
  let turnSwitches = 0;
  let sessionSwitches = 0;

  function syncTurn(nextKey) {
    if (nextKey === undefined) return;
    if (nextKey !== turnKey) {
      turnKey = nextKey;
      turnSwitches = 0;
    }
  }

  /**
   * 只算不提交。返回 kind = reject | noop | apply。
   * ctx.turnKey 取不到时只做会话级上限（见 README「已知限制」）。
   */
  function plan(request, ctx = {}) {
    syncTurn(ctx.turnKey);
    const names = request;
    const reset = names.some((n) => isResetName(n));
    const wanted = names.filter((n) => !isResetName(n));

    const unknown = wanted.filter((n) => !model.groups.has(n));
    if (unknown.length > 0) {
      return { kind: "reject", code: "unknown-group", detail: unknown, available: [...model.groups.keys()] };
    }

    const next = reset ? new Set(wanted) : new Set([...active, ...wanted]);
    const same = next.size === active.size && [...next].every((n) => active.has(n));
    if (same) return { kind: "noop", code: "already-active", groups: [...active] };

    if (turnKey !== undefined && turnSwitches >= maxTurn) {
      return { kind: "reject", code: "turn-budget", detail: String(maxTurn), groups: [...active] };
    }
    if (sessionSwitches >= maxSession) {
      return { kind: "reject", code: "session-budget", detail: String(maxSession), groups: [...active] };
    }

    if (reset) {
      return { kind: "apply", reset: true, added: wanted, groups: [...next] };
    }
    const added = wanted.filter((n) => !active.has(n));
    return { kind: "apply", reset: false, added, groups: [...next] };
  }

  /** 提交一次 plan；只有 kind=apply 的 plan 才该调用。 */
  function commit(p) {
    if (p?.kind !== "apply") return false;
    active = new Set(p.groups);
    if (turnKey !== undefined) turnSwitches += 1;
    sessionSwitches += 1;
    return true;
  }

  /** 请求里的组是否存在（pre-execute 兜底用）。 */
  function hasGroup(name) {
    return model.groups.has(name);
  }

  /** 某组此刻是否已加载。 */
  function isActive(name) {
    return active.has(name);
  }

  /**
   * 应该 deny 的工具名：组清单里、非 core、组未加载。
   * known 给了就只保留真实存在的名字（restrict 对未知名字会抛错）。
   */
  function desiredDeny(knownNames) {
    const deny = [];
    for (const tool of model.allTools) {
      if (coreNames.has(tool.name)) continue;
      if (active.has(tool.group)) continue;
      if (knownNames && !knownNames.has(tool.name)) continue;
      deny.push(tool.name);
    }
    deny.sort();
    return deny;
  }

  /** 该工具所在组（core 返回 null）。 */
  function groupOfTool(name) {
    if (coreNames.has(name)) return null;
    return model.toolToGroup.get(name) ?? null;
  }

  function snapshot() {
    return {
      active: [...active],
      turnKey,
      turnSwitches,
      sessionSwitches,
      maxTurn,
      maxSession,
      core: [...coreNames],
    };
  }

  return {
    plan,
    commit,
    hasGroup,
    isActive,
    desiredDeny,
    groupOfTool,
    snapshot,
    syncTurn,
    get activeGroups() {
      return [...active];
    },
    setActiveForTest(names) {
      active = new Set(names);
    },
  };
}
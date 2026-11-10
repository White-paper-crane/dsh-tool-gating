// dsh-tool-gating：常驻 core 组，其余工具按组加载。
//
// 分工：本文件只做「接宿主」；组清单解析在 lib/groups.js，状态机在 lib/state.js。
// 生效点：exec 里立刻 restrict，但一步的 toolSet 是 preStep 快照，所以下一次模型步才看得见。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAutoGroups, loadGroupsFile, renderCatalog } from "./lib/groups.js";
import { createGateState, normalizeGroupsArg } from "./lib/state.js";

export const name = "tool-gating";
export const inject = ["tools", "systemPrompt"];

const SECTION_NAME = "tool-gating-catalog";
const SECTION_ORDER = 3990;
const TOOL_NAME = "load_tools";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: { type: "string" },
      description: "要加载的组名（可多个）；[\"core\"] 回到只留常驻工具",
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

export function apply(ctx, config = {}) {
  const groupsFile = config.groupsFile ? path.resolve(config.groupsFile) : path.join(HERE, "groups.json");
  const model = loadGroupsFile(groupsFile);

  // 自动发现：第一次建 agent 时把「清单里没登记」的工具按名字前缀并进组，之后不再变。
  let effectiveModel = model;
  let catalogText = renderCatalog(effectiveModel);
  let expanded = false;

  const stateOptions = {
    maxSwitchesPerTurn: config.maxSwitchesPerTurn,
    maxSwitchesPerSession: config.maxSwitchesPerSession,
    extraCore: Array.isArray(config.extraCore) ? config.extraCore : [],
  };

  const records = new Set();
  const byAgent = new WeakMap();
  const disposers = [];
  let reapplyQueued = false;

  function log(level, ...args) {
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === "function") logger[level]("[tool-gating]", ...args);
    } catch {
      // 日志失败不影响门控
    }
  }

  function readTurnKey(agent) {
    try {
      const turn = agent?.phase?.turn;
      if (Number.isFinite(turn)) return `t${turn}`;
    } catch {
      // phase 可能还没建好
    }
    return undefined;
  }

  /** 把当前状态算成一次 restrict。无变化就不动图层；失败保留旧层（fail closed）。 */
  function applyRestriction(rec) {
    const agent = rec.agent;
    if (rec.reapplying) return;
    rec.reapplying = true;
    try {
      const tools = agent?.ctx?.tools;
      if (!tools || typeof tools.restrict !== "function") return;
      const view = tools.view(agent);
      const known = view?.restrictableNames;
      if (!(known instanceof Set)) return;
      const deny = rec.state.desiredDeny(known);
      const key = deny.join(",");
      if (key === rec.lastDenyKey) return;
      let next;
      if (deny.length > 0) {
        next = tools.restrict({ deny });
        if (typeof next !== "function") next = undefined;
      }
      const previous = rec.disposer;
      rec.disposer = next;
      rec.lastDenyKey = key;
      if (typeof previous === "function") previous();
      if (deny.length > 0) log("debug", `deny ${deny.length} 个工具（agent=${agent.session?.header?.id ?? "?"}）`);
    } catch (error) {
      log("warn", `restrict 失败：${error?.message ?? error}`);
    } finally {
      rec.reapplying = false;
    }
  }

  function queueReapply() {
    if (reapplyQueued) return;
    reapplyQueued = true;
    queueMicrotask(() => {
      reapplyQueued = false;
      for (const rec of records) applyRestriction(rec);
    });
  }

  /**
   * 自动发现一次：把宿主里真实存在、但 groups.json 没登记的工具按前缀并进组。
   * 只在第一个 agent 上做——此后目录文本冻结，避免中途改系统提示把前缀打碎。
   */
  function expandOnce(agent) {
    if (expanded) return;
    expanded = true;
    if (model.auto?.enabled !== true) return;
    try {
      const view = agent?.ctx?.tools?.view?.(agent);
      if (!view || !(view.visible instanceof Map)) return;
      const catalog = [];
      for (const [toolName, definition] of view.visible) {
        catalog.push({ name: toolName, description: definition?.description ?? "" });
      }
      const out = deriveAutoGroups(effectiveModel, catalog, model.auto);
      if (out.added === 0) return;
      effectiveModel = out.model;
      catalogText = renderCatalog(effectiveModel);
      log("info", `自动发现 ${out.added} 个未登记工具；并进组：${out.groups.join("、") || "（无新组）"}`);
    } catch (error) {
      log("warn", `自动分组失败：${error?.message ?? error}`);
    }
  }

  function install(agent) {
    if (!agent || byAgent.has(agent)) return byAgent.get(agent);
    expandOnce(agent);
    const rec = {
      agent,
      state: createGateState(effectiveModel, stateOptions),
      disposer: undefined,
      lastDenyKey: "\u0000init",
      reapplying: false,
    };
    records.add(rec);
    byAgent.set(agent, rec);
    applyRestriction(rec);
    return rec;
  }

  function remove(agent) {
    const rec = byAgent.get(agent);
    if (!rec) return;
    records.delete(rec);
    const disposer = rec.disposer;
    rec.disposer = undefined;
    if (typeof disposer === "function") {
      try {
        disposer();
      } catch (error) {
        log("warn", `释放限制层失败：${error?.message ?? error}`);
      }
    }
  }

  function activeText(gate) {
    const snapshot = gate.snapshot();
    const parts = [];
    parts.push(`常驻：${snapshot.core.join("、")}`);
    if (snapshot.active.length === 0) parts.push("已加载组：无（L0）");
    else parts.push(`已加载组：${snapshot.active.join("、")}`);
    const turnLeft = snapshot.turnKey === undefined ? null : Math.max(0, snapshot.maxTurn - snapshot.turnSwitches);
    const sessionLeft = Math.max(0, snapshot.maxSession - snapshot.sessionSwitches);
    parts.push(turnLeft === null ? `本会话还可切 ${sessionLeft} 次` : `本 turn 还可切 ${turnLeft} 次，本会话还可切 ${sessionLeft} 次`);
    return parts.join("；");
  }

  function rejectText(p, gate) {
    if (p.code === "unknown-group") {
      return `[tool-gating] 没有这些组：${p.detail.join("、")}。可加载组：${p.available.join("、")}。（${activeText(gate)}）`;
    }
    if (p.code === "turn-budget") {
      return `[tool-gating] 本 turn 已切满 ${p.detail} 次，不能再切；下个 turn 再加载。（${activeText(gate)}）`;
    }
    if (p.code === "session-budget") {
      return `[tool-gating] 本会话切换次数已用完（上限 ${p.detail}），要换工具面请新开会话。（${activeText(gate)}）`;
    }
    return `[tool-gating] 不能加载：${p.code}。（${activeText(gate)}）`;
  }

  function loadTool(agent, args) {
    const norm = normalizeGroupsArg(args);
    if (!norm.ok) return `[tool-gating] ${norm.reason}`;
    const rec = install(agent);
    const gate = rec.state;
    const turnKey = readTurnKey(agent);
    const p = gate.plan(norm.groups, { turnKey });
    if (p.kind === "reject") return rejectText(p, gate);
    if (p.kind === "noop") return `[tool-gating] 「${norm.groups.join("、")}」已经加载过，不用重复加载。（${activeText(gate)}）`;
    gate.commit(p);
    applyRestriction(rec);
    const added = p.added ?? [];
    const head = p.reset
      ? "已回到 L0（只保留常驻工具）"
      : `已加载：${added.join("、") || norm.groups.join("、")}`;
    const names = p.groups.flatMap((groupName) => effectiveModel.groups.get(groupName)?.tools.map((t) => t.name) ?? []);
    return `[tool-gating] ${head}。下一步的工具列表里会出现：${names.join("、")}。下一步即可调用。（${activeText(gate)}）`;
  }

  // ── 工具注册 ──────────────────────────────────────────────
  const registration = ctx.tools.register(
    {
      name: TOOL_NAME,
      description:
        "按组加载工具。加载后该组工具会在下一步的工具列表里出现。groups 传组名数组（见系统提示里的工具目录）；[\"core\"] 回到只留常驻工具。",
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        if (!agent?.ctx) return "[tool-gating] 拿不到 agent 上下文，无法加载工具。";
        try {
          return loadTool(agent, args);
        } catch (error) {
          return `[tool-gating] 加载失败：${error?.message ?? error}`;
        }
      },
    },
    {},
  );
  disposers.push(registration);

  // ── 系统提示目录（静态，只依赖 groups.json）────────────────
  const section = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => catalogText,
    interpolate: false,
  });
  disposers.push(section);

  // ── 宿主事件 ──────────────────────────────────────────────
  disposers.push(
    ctx.on("agent/created", (payload) => {
      try {
        install(payload?.agent);
      } catch (error) {
        log("warn", `agent/created 安装失败：${error?.message ?? error}`);
      }
    }),
  );
  disposers.push(
    ctx.on("agent/disposed", (payload) => {
      try {
        remove(payload?.agent);
      } catch (error) {
        log("warn", `agent/disposed 清理失败：${error?.message ?? error}`);
      }
    }),
  );
  // 别处注册/撤掉工具（lazy 注入、别的插件）后要重算 deny，否则后注册的工具不受门控。
  disposers.push(ctx.on("tools/change", () => queueReapply()));

  // 未加载就调用：先一次性自动加载该组，再用 error 结果让模型下一步重试。
  // 不静默补执行——参数 schema 尚未进模型视野，硬跑成功率低。
  disposers.push(
    ctx.on(
      "tools/pre-execute",
      async (exec, next) => {
        const agent = exec?.agent;
        if (!agent?.ctx) return next();
        let rec;
        try {
          rec = install(agent);
        } catch {
          return next();
        }
        // 兜底自愈：哪怕 tools/change 没送到，也在调用点把 deny 台账对齐一次（内部按 key 去重）。
        applyRestriction(rec);
        const group = rec.state.groupOfTool(exec.name);
        if (group === null || rec.state.isActive(group)) return next();
        const p = rec.state.plan([group], { turnKey: readTurnKey(agent) });
        if (p.kind === "apply") {
          rec.state.commit(p);
          applyRestriction(rec);
          return {
            kind: "deny",
            reason: `[tool-gating] ${exec.name} 属于「${group}」组，原本未加载；已自动加载该组。请在下一步重试这个调用。`,
          };
        }
        return {
          kind: "deny",
          reason: `[tool-gating] ${exec.name} 属于「${group}」组，尚未加载。先用 load_tools(groups=["${group}"]) 加载，下一步再调用。（${activeText(rec.state)}）`,
        };
      },
      { prepend: true },
    ),
  );

  // 已经在跑的 agent（插件热加载时）也要立刻套上 L0。
  try {
    const list = ctx.agents?.list;
    if (typeof list === "function") {
      for (const agent of list.call(ctx.agents) ?? []) {
        try {
          install(agent);
        } catch (error) {
          log("warn", `已有 agent 安装失败：${error?.message ?? error}`);
        }
      }
    }
  } catch (error) {
    log("debug", `ctx.agents 不可用：${error?.message ?? error}`);
  }

  ctx.on("dispose", () => {
    for (const rec of [...records]) remove(rec.agent);
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch (error) {
        log("warn", `释放句柄失败：${error?.message ?? error}`);
      }
    }
  });

  // 仅供离线自检读取，不参与运行时逻辑。
  return {
    model,
    records,
    catalog: renderCatalog(model),
    groupsFile,
  };
}
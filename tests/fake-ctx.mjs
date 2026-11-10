// 假宿主：只实现插件用到的那一小片 Cordis/ToolsService/SystemPrompt 语义。
// 目的：不启用插件也能对着「假 ctx」跑一遍真代码。
//
// 与真宿主的对应关系见 reports/gating-plugin.md「离线自检覆盖了什么」。
export const GATE = Symbol("tool-gating.layers");

export function createHost() {
  const listeners = new Map();
  const registry = new Map();
  const sections = new Map();
  const agents = new Set();
  const logs = [];

  function emit(event, ...args) {
    const out = [];
    for (const fn of [...(listeners.get(event) ?? [])]) out.push(fn(...args));
    return out;
  }

  async function emitAsync(event, ...args) {
    return Promise.all(emit(event, ...args));
  }

  const ctx = {
    logger: {
      debug: (...args) => logs.push(["debug", ...args]),
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    tools: {
      register(definition) {
        if (registry.has(definition.name)) throw new Error(`tool "${definition.name}" 已注册`);
        registry.set(definition.name, definition);
        emit("tools/change");
        return () => {
          registry.delete(definition.name);
          emit("tools/change");
        };
      },
      view() {
        return { restrictableNames: new Set(registry.keys()) };
      },
    },
    systemPrompt: {
      section(section) {
        sections.set(section.name, section);
        return () => sections.delete(section.name);
      },
    },
    agents: { list: () => [...agents] },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {
        const list = listeners.get(event) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit,
    emitAsync,
    dispose: () => emit("dispose"),
  };

  return {
    ctx,
    registry,
    sections,
    agents,
    logs,
    emit,
    emitAsync,
    /** 新建一个 agent；phase.turn 由测试直接改。 */
    createAgent(id) {
      const rec = { id, layers: [], phase: { turn: 1 } };
      const agent = {
        session: { header: { id } },
        phase: rec.phase,
        ctx: null,
      };
      agent.ctx = {
        tools: {
          restrict(filter = {}) {
            const layer = { deny: new Set(filter.deny ?? []) };
            rec.layers.push(layer);
            emit("tools/change");
            let live = true;
            return () => {
              if (!live) return;
              live = false;
              const index = rec.layers.indexOf(layer);
              if (index >= 0) rec.layers.splice(index, 1);
              emit("tools/change");
            };
          },
          view(scope) {
            return ctx.tools.view(scope);
          },
        },
      };
      Object.defineProperty(agent, GATE, { value: rec, enumerable: false });
      agents.add(agent);
      return agent;
    },
    /** 此刻该 agent 实际能看到的工具名（= registry 减去限制层）。 */
    visibleNames(agent) {
      const rec = agent[GATE];
      const denied = new Set();
      for (const layer of rec.layers) for (const name of layer.deny) denied.add(name);
      return [...registry.keys()].filter((name) => !denied.has(name)).sort();
    },
    /** 假装模型调了一次工具，走 pre-execute。返回决定（allow / deny）。 */
    async callTool(agent, toolName, args = {}) {
      const exec = { name: toolName, arguments: args, agent };
      const next = () => ({ kind: "allow" });
      const results = await emitAsync("tools/pre-execute", exec, next);
      // 真实宿主按顺序取第一个非 undefined 的决定。
      for (const result of results) if (result !== undefined) return result;
      const definition = registry.get(toolName);
      if (!definition) return { kind: "unknown-tool" };
      const output = await definition.execute(args, exec);
      return { kind: "ok", output };
    },
  };
}
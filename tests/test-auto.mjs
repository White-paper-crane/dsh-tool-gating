// 自动分组的离线测试：不启宿主，只喂 parseGroups + deriveAutoGroups + renderCatalog。
import assert from "node:assert/strict";
import { parseGroups, deriveAutoGroups, renderCatalog } from "../lib/groups.js";

const base = {
  version: 1,
  limits: { maxSwitchesPerTurn: 2, maxSwitchesPerSession: 6 },
  auto: { enabled: true, exclude: ["bcdp_*"] },
  core: [
    { name: "read", purpose: "读文件" },
    { name: "write", purpose: "写文件" },
    { name: "load_tools", purpose: "加载工具组" },
  ],
  groups: {
    media: [{ name: "video_probe", purpose: "读视频元信息" }],
  },
};

const catalog = [
  { name: "read", description: "读文件" },
  { name: "video_probe", description: "读视频元信息" },
  { name: "bcdp_click", description: "点击元素（浏览器插件自注册，不该被收编）" },
  { name: "qq_send_image", description: "发图片到 QQ\n第二行不该进目录" },
  { name: "media_extra", description: "并进已有 media 组" },
  { name: "compress", description: "压缩上下文" },
];

// 1) 关闭时不动
{
  const model = parseGroups({ ...base, auto: { enabled: false } });
  const out = deriveAutoGroups(model, catalog);
  assert.equal(out.added, 0);
  assert.equal(out.model, model);
}

// 2) 开时：新前缀自成组、已有组追加、exclude 生效、core 跳过
{
  const model = parseGroups(base);
  const out = deriveAutoGroups(model, catalog);
  assert.equal(out.added, 3, "应只收 qq_send_image / media_extra / compress");
  assert.deepEqual(out.groups.sort(), ["compress", "qq"]);
  const g = out.model.groups;
  assert.equal(g.has("qq"), true);
  assert.deepEqual([...g.get("qq").names], ["qq_send_image"]);
  assert.deepEqual([...g.get("media").names].sort(), ["media_extra", "video_probe"]);
  assert.equal(out.model.toolToGroup.get("bcdp_click"), undefined, "bcdp 被 exclude");
  assert.equal(out.model.toolToGroup.get("read"), undefined, "core 不收编");
  assert.equal(out.model.toolToGroup.get("qq_send_image"), "qq");
  assert.equal(out.model.allTools.length, model.allTools.length + 3);
}

// 3) 目录文本里要出现自动组，且只取描述首行、超长截断
{
  const model = parseGroups(base);
  const out = deriveAutoGroups(model, catalog);
  const text = renderCatalog(out.model);
  assert.match(text, /### qq/);
  assert.match(text, /qq_send_image — 发图片到 QQ/);
  assert.equal(text.includes("第二行不该进目录"), false);
  const long = "很".repeat(80);
  const out2 = deriveAutoGroups(parseGroups(base), [{ name: "zz_long", description: long }]);
  const line = renderCatalog(out2.model).split("\n").find((l) => l.startsWith("- zz_long"));
  assert.ok(line.length <= 60, `目录行过长：${line.length}`);
}

// 4) 重复调用幂等：第二次不再新增
{
  const model = parseGroups(base);
  const once = deriveAutoGroups(model, catalog);
  const twice = deriveAutoGroups(once.model, catalog);
  assert.equal(twice.added, 0);
}

console.log("test-auto: all passed");

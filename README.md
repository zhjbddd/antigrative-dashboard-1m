# Antigrative Dashboard (1M Context Edition)

基于开源项目 [`wycocoyu/agy-context-dashboard`](https://github.com/wycocoyu/agy-context-dashboard) (`v0.9.5`, MIT License) 增强的 **1M 上下文真实容量增强版**，适配 **Google Antigravity `2.33.0+`**（Windows / macOS / Linux），可与 [`zhjbddd/codex-1m-compact`](https://github.com/zhjbddd/codex-1m-compact) 配合使用。

---

## 核心增强特性（相比原版 v0.9.5）

1. **修复 `512K` 软上限分母问题，支持真实 `1M`（`1,048,576`）容量显示**：
   - Antigravity 宿主轨迹接口 `GetCascadeTrajectoryGeneratorMetadata` 默认返回软上限 `maxContextTokens: 512000`，导致原版面板将原生支持 `1M` 的 Gemini / Orchestrator 模型按 `512K` 计算百分比。
   - 本增强版在模型具备经校验的 `1,048,576`（1M）或更高目录容量时，自动将上下文分母升级为模型真实物理容量（`1M`），同时保留原始 `hostMaxTokens` 字段供参考，并对缺失/非法宿主计数保持安全 `null` 处理。
2. **新增 `GetAvailableModels` 动态模型目录同步**：
   - 在配额刷新时自动从本地 Language Server 同步 `GetAvailableModels`，未来 Antigravity 新增模型及上下文容量无需手动改代码即可自动识别。
3. **补齐最新模型与占位符映射**：
   - 完整支持 `Orchestrator (Carbon)` / `Orchestrator (Argon)`、`Gemini 4 Hydrogen (Orchestrator)`、`Gemini 4 Carbon / Argon / Hydrogen`（含 `tiered-*`）、`Gemini 3 Flash`、`Gemini 3.5 Flash Lite`、`Gemini 3.1 Flash Lite/Image`、`Gemini 2.5 Pro/Flash` 等最新目录模型及配额分组识别。
4. **完整保留上游 `v0.9.5` 全部能力**：
   - Antigravity Desktop `2.33.0+` 快捷方式调试端口自愈（`--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`）与自动重连恢复
   - 聊天输入框内嵌状态条（TPS 速度、Prompt 缓存命中率、1M 上下文环、5h / 周额度预测）与右侧辅助栏仪表盘
   - 简体中文 / 繁体中文 / English 实时切换

---

## 一键安装

```bash
git clone https://github.com/zhjbddd/antigrative-dashboard-1m.git
cd antigrative-dashboard-1m
node install.mjs
```

安装脚本会将插件部署到 `~/.gemini/config/plugins/antigravity-pulse/`。若首次安装或客户端升级后未开启远程调试端口，可在右侧辅助栏打开 **Antigrative Dashboard** 点击重连（或重启一次 Antigravity）即可挂载内嵌状态条。

---

## 运行单元测试

```bash
cd sidecars/panel
node --test tests/context.test.mjs tests/metrics.test.mjs tests/i18n.test.mjs tests/panel-source.test.mjs tests/store-selection.test.mjs
```

---

## 致谢与许可

- 上游项目：[`wycocoyu/agy-context-dashboard`](https://github.com/wycocoyu/agy-context-dashboard) (`v0.9.5`)
- 开源协议：[MIT License](./LICENSE)

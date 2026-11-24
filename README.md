# Antigrative Dashboard (1M Context Edition)

基于开源项目 [`ATtacK030130/antigrative-dashboard`](https://github.com/ATtacK030130/antigrative-dashboard) (`v0.9.16`, MIT License) 增强的 **1M 上下文真实容量与 Antigravity `2.35.0` 适配版**，支持 Windows / macOS / Linux 桌面端与独立 **Antigravity IDE**，可与 [`zhjbddd/codex-1m-compact`](https://github.com/zhjbddd/codex-1m-compact) 配合使用。

---

## 核心增强与 `v0.9.16` 同步特性

1. **全面适配 Antigravity `2.35.0` 最新模型与真实 `1M` 上下文分母**：
   - 修复宿主轨迹接口默认返回 `512K` / `200K` 软上限导致百分比失真的问题：对具备经校验 `1M`（`1,048,576` / `1,000,000`）容量的模型自动升级分母，同时保留原始 `hostMaxTokens` 字段供参考。
   - 补全 `2.35.0` 全量模型与占位符映射：`Gemini 4 Neon`（`M532`–`M535`）、`Orchestrator (Neon)`（`M537` / `gemini-pro-orchestrator-neon`）、`Claude Opus/Sonnet 5.5`（`M400`–`M405`，1M）、`Gemini 3.8 Flash (Tiered)`（`M322`）、`Gemini 4 Hydrogen (Sonar)`（`M578`），以及 `Carbon / Argon / Hydrogen`、`Gemini 3.x / 2.5` 等系列模型。
   - 在配额刷新时同步调用 `GetAvailableModels` 动态注册未来新增模型，并在 `metrics.mjs` / `history.mjs` 统一规范化模型显示名称。
2. **彻底消除 512MB OOM 堆内存崩溃（同步上游 `v0.9.16`）**：
   - 使用常驻增量 SQLite 索引（`.usage-index-v1.sqlite`）替代全量 JS 内存聚合（堆内存稳定在 ~10MB），移除旧 `--max-old-space-size` 硬限制。
3. **体验与稳定性同步升级（`v0.9.14`–`v0.9.16`）**：
   - 支持手动折叠迷你状态条（`< ○ 47%`）、USD 成本空间周额度满载容量估算、Antigravity `2.34.0+` daemon 凭据双校验与远程 SSH/WSL Hub 发现。
   - 消除高负载或慢轮询时的内联状态条闪烁消失问题，包含 `compat/host-theme.mjs` 与 `compat/pricing.cjs` 对独立 Antigravity IDE 的完整支持。
   - 支持简体中文 / 繁体中文 / English 实时切换。

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
node --test --test-timeout=60000 sidecars/panel/tests/*.test.mjs
```

---

## 致谢与许可

- 上游项目：[`ATtacK030130/antigrative-dashboard`](https://github.com/ATtacK030130/antigrative-dashboard) (`v0.9.16`)
- 开源协议：[MIT License](./LICENSE)

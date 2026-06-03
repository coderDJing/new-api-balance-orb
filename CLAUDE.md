# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AI Balance Orb 是一个基于 **Tauri v2** 的 Windows 桌面悬浮球小部件，用于轮询 New API 兼容的余额接口并实时显示账户余额。关闭窗口时最小化到系统托盘而非退出。

## 常用命令

```bash
pnpm install              # 安装依赖
pnpm tauri:dev            # 启动完整开发模式（前端 + Rust 后端）
pnpm build                # TypeScript 检查 + Vite 生产构建（仅前端）
pnpm check:desktop        # Rust 类型检查（cargo check）
pnpm tauri:build          # 完整桌面打包
```

没有测试套件。

## 架构

### 技术栈

- **前端：** React 19 + TypeScript 5.8 + Vite 7 + lucide-react
- **后端：** Rust (Tauri v2 + reqwest + serde)
- **包管理器：** pnpm（非 npm/yarn）
- **Tauri API：** `@tauri-apps/api` v2（注意不是 v1）

### 代码结构

前端和后端各只有一个核心文件：

- `src/App.tsx` — 整个前端（约 453 行），包含 `BalanceWindow`（主悬浮球）和 `SettingsWindow`（设置表单）两个组件。无路由、无状态管理库。
- `src-tauri/src/lib.rs` — 整个后端逻辑（约 347 行），5 个 Tauri command（`load_config`、`save_config`、`query_balance`、`hide_window`、`show_settings_window`）和系统托盘初始化。

### Tauri 配置

`src-tauri/tauri.conf.json` 定义了两个窗口：
1. **main** (348×238) — 无边框、透明背景、置顶、不在任务栏显示
2. **settings** (440×430) — 无边框、透明、初始隐藏

### 关键业务逻辑

- 余额查询：`GET <endpoint_url>/api/user/self` 带 `Authorization: Bearer <token>` 和 `New-Api-User: <userId>` 请求头
- 余额计算：`quota / 500_000`（常量 `QUOTA_SCALE`）
- 配置文件：存储在 Tauri app config 目录的 `config.json`（含 `endpoint_url`、`access_token`、`user_id`）
- 端点校验：必须是 HTTPS 或 localhost
- 前端在非 Tauri 环境（`pnpm dev`）下有 mock 数据，可独立开发 UI

### UI 语言

界面文字为中文（如"刷新中"、"异常"、"待配置"、"在线"）。

## CI

`.github/workflows/build.yml` 仅在 Windows 运行：`pnpm build` → `pnpm check:desktop` → `pnpm tauri:build`，产物上传为 GitHub Actions artifact。

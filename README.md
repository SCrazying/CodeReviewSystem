# CodeReviewSystem

AI 代码审查工作台 —— **Electron 客户端 + Node/Express 单机服务端 + PostgreSQL**。对 GitLab/Gitea 仓库的 MR / 提交自动做 AI 审查，结论(问题 + 修复建议)回填 GitLab 评论区；支持基于源分支的**自动修复(每问题一个增量 commit)并推送远端**，研发可直接 cherry-pick。

## 功能特性

- 🚀 **多仓库**: 待合入 MR / 历史 MR / 提交树 / 历史 Review 四页签, 多仓库切换
- 🤖 **AI 审查**: native ocr 直调, 输出 严重级别 + 问题代码 + 修复建议; 支持中文输出、并发、超时(默认60min)可调, 可随时停止
- 💬 **回填评论**: 选择性回填(勾选/按严重等级)、历史结果二次回填、自动切换所属仓库、评论含问题代码+修复建议, 服务器自动去重
- 🔧 **自动修复**: 基于 MR **源分支**建 `fix/ai/...`, 每问题一个 `【fix】` 增量 commit(`【问题单号】【影响性】` 描述), **默认推送远端**, 研发 git fetch/cherry-pick 即用
- ⏰ **客户端定时任务**: 按仓库创建多个扫描任务, 支持频率(30min~每天)与每日开始时间, 列表启停; 不依赖服务器定时
- 🧳 **零配置分发**: ocr 配置随程序目录走(便携), 模型 Key 保存即校验(不读系统环境变量), 内网拷贝目录即用
- 🎨 **Cursor 风格 UI**: 左导航 + 内容区, 深浅主题, Ctrl+=/- 缩放, 日志选中复制, 内置使用手册

## 架构

```
Electron 客户端 ──(卡控/记录队列)──▶ Express + PostgreSQL(服务端 :3001)
   └─▶ ocr(native) ──▶ 模型API ──▶ GitLab/Gitea(评论/修复分支)
```

## 快速开始

### 客户端
1. `cd client && npm install`(需要 `@alibaba-group/open-code-review` 以自带 ocr native)
2. `npm start`(本机开发)或使用 `dist/CodeReviewTool-win-x64.zip`(win-unpacked, 已含 ocr)
3. 打开后: 设置 → 常规 → 填 **API 地址 / Key / 审查模型** → 保存(自动校验)
4. 设置 → Git 仓库 → 添加仓库(Git 地址 / Token / 本地目录)后即可审查

### 服务端(可选, 用于卡控与记录)
```
cd server
createdb codereview && node src/init-db.js && node src/init-admin.js
npm start                 # :3001, 管理后台 http://127.0.0.1:3001/
```
客户端在 设置 → 服务端 填服务地址 + Token。

### 打包与发版
```
cd client
export ELECTRON_BUILDER_BINARIES_MIRROR="https://gh-proxy.com/..."
node_modules/.bin/electron-builder --win dir -c.win.signAndEditExecutable=false
powershell Compress-Archive dist\win-unpacked\* ...  # 打 zip 前先 taskkill 残留实例
```

## 文档
- [PRD](docs/PRD.md) · [方案设计](docs/方案设计.md) · [系统设计](docs/系统设计.md)
- 应用内: 设置 → 使用手册(完整操作说明)

## 版本
- 见 Git tag(`v1.1.x`); 最新 master 为准。

# CodeReviewSystem

AI 代码审查工作台 + 审查数据管理平台

- **client/**:Electron 桌面客户端(免安装绿色版)
  - 交付: `client/dist/CodeReviewTool-win-x64.zip` → 解压运行 `CodeReviewTool.exe`
  - **ocr 已内置**: 软件目录自带 open-code-review(47M, asar.unpacked), 内网/离线无需再 npm install
  - 功能:
    - 每日进入卡控(服务端授权门禁) + 本地缓存推送(离线不丢)
    - MR 全自动审查 + 评论自动回填 Git(Gitea/GitLab 双后端)
    - **提交树**(分支切换 / 全部分支 / 🔀MR 标记) + **单提交审查**
    - **自动修复**: 基于 MR 原始分支创建 `fix/ai/<branch>-<mrId>`, 每个问题一个 commit(仅本地, 研发决定是否推远端)
      - 小文件(≤200 行)整文件重写模式(行号无关, 高可靠); 大文件 unified diff + git apply 校验
      - 修复内容校验(相似度/行数/无变化检测) + 失败自动重试, 坏补丁安全跳过不破坏代码
    - **设置中心(Cursor 风格)**: 左侧分组导航 + 右侧内容区 + 搜索设置
      - **主页↔设置切换**: 设置导航首项"🏠 主页"与顶部"← 返回应用", 与主页 ⚙设置 互为切换
      - **多仓库管理**: 设置页维护仓库列表(名称/Git地址/Token/项目/本地目录), 支持增删改 + "设为当前"; 主页顶部下拉一键切换仓库(后端即时切换, MR/提交树联动刷新)
      - **模型服务配置**: 常规面板填写 协议(http/https)+ API 地址 + API Key → 一键获取模型列表(OpenAI 兼容 /v1/models)→ 下拉选择审查模型; **审查 / 自动修复 / 中文翻译共用同一模型**
      - **超级管理员授权**: 高级面板输入密码 → 永久免服务端验证(离线可用, 重启免认证, 可注销恢复); 密码 sha256 本地校验
      - **审查结果中文**: 审查完成后自动用审查模型翻译评论为中文(界面显示 + Git 回填均中文, 失败保留原文)
      - 开关项: 自动回填评论、自动修复分支(审查完成自动执行)
      - 外观: 深色 / 浅色 / 跟随系统 主题(全组件适配, 无深色残留) + 字号(小/中/大), 即时生效持久化
    - Token / 请求次数记录, 自动上报服务端
- **server/**:Node.js 服务端(REST API + 管理 Web + PostgreSQL)
  - 一键启动: `server/start-server.bat`
  - 管理后台: `http://127.0.0.1:3001/`(admin / admin123)
  - **定时任务**: 选仓库 + cron 周期审查 open MRs, 执行历史可查, 支持手动触发
  - 统计量化: 审查次数 / 问题严重分布 / 类别 TOP / Token 用量趋势 / 修复记录
- **docs/**: PRD、方案设计、系统设计

## 快速启动

```bash
# 1. 服务端(PG 运行于 5432, 库名 codereview)
cd server && start-server.bat
# → 管理后台创建"客户端 Token"(设置页生成)

# 2. 客户端
解压 client/dist/CodeReviewTool-win-x64.zip → 运行 CodeReviewTool.exe
# → 设置: Git 服务地址/Token + 仓库; 服务端地址 + 客户端 Token
# → 🛡 卡控校验通过后: 刷新 MR / 提交树 → 审查 → 回填/自动修复

# 3. 定时任务(可选)
管理后台 → ⏰ 定时任务 → 创建(选仓库 + cron)→ 启用
```

## 里程碑

- [x] M1 服务端基础(建表/API/授权/上报/统计)
- [x] M5 管理 Web(总览/记录/分类/用量)
- [x] M2 客户端接入服务端(每日卡控/本地缓存推送/审查门禁)
- [x] M3 提交树 + MR/单提交审查 + 回填
- [x] M4 自动修复分支(unified diff + git apply 校验, 每问题一 commit)
- [x] M6 服务端定时任务(API + node-cron 调度 + Web 管理)

详见 docs/
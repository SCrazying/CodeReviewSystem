// CodeReviewTool 主进程 (M2: 服务端接入 + 每日卡控 + 本地缓存推送)
const { app, BrowserWindow, ipcMain, Notification, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { ReviewBackend } = require('./backend/review-backend');
const { AuthGate } = require('./backend/auth-gate');
const { ReportQueue } = require('./backend/report-queue');
const { FixEngine } = require('./backend/fix-engine');

let win = null;
let backend = null;
let lastReview = null;     // 缓存最近一次审查结果, 回填时复用
let fixEngine = null;
let lastFix = null;        // 最近一次自动修复分支记录
let serverConfig = { serverUrl: '', clientToken: '' };
let gate = null;
let queue = null;
let pushTimer = null;

function getUserConfigPath() { return path.join(app.getPath('userData'), 'config.json'); }
function getGatePath() { return path.join(app.getPath('userData'), 'gate.json'); }
function getQueuePath() { return path.join(app.getPath('userData'), 'report_queue.jsonl'); }

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getUserConfigPath(), 'utf-8'));
  } catch {
    return { url: '', token: '', project: '', repoDir: '', model: 'deepseek-v4-flash', serverUrl: '', clientToken: '' };
  }
}

/** 将多仓库配置展开为"当前激活仓库"的单仓库视图(兼容旧字段) */
function activeRepoConfig(cfg) {
  const repos = Array.isArray(cfg.repos) ? cfg.repos : [];
  const active = repos[cfg.activeRepo || 0] || {};
  return {
    ...cfg,
    url: active.url || cfg.url || '',
    token: active.token || cfg.token || '',
    project: active.project || cfg.project || '',
    repoDir: active.repoDir || cfg.repoDir || '',
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1100, minHeight: 700,
    title: 'CodeReviewTool - AI 代码审查',
    autoHideMenuBar: true, backgroundColor: '#0d1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 启动恢复上次界面缩放级别(Ctrl+Plus/Minus 调整, 存 uiZoom)
  try { const z = loadConfig().uiZoom; if (typeof z === 'number' && !isNaN(z)) win.webContents.setZoomLevel(Math.max(-2, Math.min(3, z))); } catch { }
}

function pushLog(text) {
  if (win && !win.isDestroyed()) win.webContents.send('log', String(text));
}

// ---- 每日卡控流程(应用启动时) ----
async function runDailyGate() {
  const cfg = loadConfig();
  serverConfig.serverUrl = (cfg.serverUrl || '').trim();
  serverConfig.clientToken = (cfg.clientToken || '').trim();
  if (!gate) gate = new AuthGate(getGatePath(), pushLog);
  pushLog('🛡 每日进入卡控 ...');
  const r = await gate.checkDaily(serverConfig.serverUrl, serverConfig.clientToken);
  pushLog(r.ok ? '🛡 卡控通过, 今日可使用审查功能' : `🛡 卡控未通过: ${r.error}`);
  // 卡控通过后立即尝试补推本地缓存
  if (r.ok) flushQueue();
  return r;
}

// ---- 本地审查历史(用户可在客户端查看历史 Review 记录) ----
const HISTORY_MAX = 500;
function historyFile() { return path.join(app.getPath('userData'), 'reviews-history.json'); }
function loadHistory() {
  try { const arr = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); return Array.isArray(arr) ? arr : []; } catch { return []; }
}
function saveReviewHistory(review, meta) {
  try {
    const arr = loadHistory();
    arr.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ts: Date.now(), ...meta, comments: (review && review.comments) || [], commentsCount: ((review && review.comments) || []).length });
    if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    fs.writeFileSync(historyFile(), JSON.stringify(arr, null, 1), 'utf-8');
  } catch { }
}
/** 历史列表(新→旧) */
ipcMain.handle('reviews:list', () => {
  return loadHistory().slice().reverse();
});

/** 界面缩放: Ctrl+Plus / Ctrl+Minus(与系统无关, 主进程 setZoomLevel) */
ipcMain.handle('ui:zoom', (e, dir) => {
  try {
    const web = win && win.webContents;
    if (!web) return { ok: false, error: '窗口未就绪' };
    const cur = web.getZoomLevel();
    const next = dir === 0 ? 0 : Math.max(-2, Math.min(3, Math.round((cur + dir) * 2) / 2));
    web.setZoomLevel(next);
    // 持久化缩放级别(下次启动恢复)
    const c = loadConfig();
    c.uiZoom = next;
    try { fs.writeFileSync(getUserConfigPath(), JSON.stringify(c, null, 2)); } catch { }
    return { ok: true, zoom: next };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 当前激活仓库的唯一标识(防跨仓库误用审查结果, 不同仓库同名 MR iid 相同)
function currentRepoKey() {
  const c = activeRepoConfig(loadConfig());
  return `${c.url || ''}|${c.project || ''}|${c.repoDir || ''}`;
}

// ---- 本地缓存推送 ----
async function flushQueue(force = false) {
  if (!queue) queue = new ReportQueue(getQueuePath(), pushLog, (loadConfig() || {}).pushMaxTries || 3);
  const cfg = loadConfig();
  const url = (cfg.serverUrl || '').trim(), token = (cfg.clientToken || '').trim();
  if (!url || !token) {
    // 手动推送时给出明确提示
    if (force) pushLog('⛔ 未配置服务端地址/Token, 无法推送');
    return { posted: 0, remaining: 0, paused: queue.paused, error: '未配置服务端地址/Token' };
  }
  const r = await queue.flush(url, token, { force });
  return r;
}

// 周期性重连推送: 每 30s 试一次(有积压才真正请求, 连续失败达上限后自动暂停)
setInterval(() => {
  if (!gate || !gate.authorized) return;
  if (queue && queue.paused) return;   // 已暂停自动推送
  const cfg = loadConfig();
  const url = (cfg.serverUrl || '').trim(), token = (cfg.clientToken || '').trim();
  if (url && token && queue && queue.pendingCount() > 0) {
    queue.flush(url, token).catch(() => {});
  }
}, 30000).unref();

/** 将"含项目路径的完整地址"拆分为 {url(服务器基址), project(项目路径)}
 *  例: http://gitlab.xxx.com/admin/xxx/dada → { url:'http://gitlab.xxx.com', project:'admin/xxx/dada' }
 *  仅服务器地址则原样返回 */
function splitRepoUrl(full) {
  const s = String(full || '').trim().replace(/\/+$/, '');
  if (!s) return { url: '', project: '' };
  const m = s.match(/^(https?:\/\/[^/]+)\/(.+)$/);
  if (m) return { url: m[1], project: m[2].replace(/\/+$/, '') };
  return { url: s, project: '' };
}

// ---- IPC ----
ipcMain.handle('config:get', () => {
  const cfg = activeRepoConfig(loadConfig());
  cfg.ocrAvailable = backend ? backend.ocrJsAvailable() : false;
  return cfg;
});

ipcMain.handle('config:save', async (e, cfg) => {
  const prev = loadConfig();
  const repos = Array.isArray(cfg.repos) ? cfg.repos.map((r) => {
    // 支持"地址含项目"合一填法: gitlab.xxx.com/admin/xxx → url + project 自动拆分
    const sp = splitRepoUrl(r.url);
    const project = String(r.project || '').trim() || sp.project;
    return {
      name: String(r.name || '').trim() || (project.split('/').pop() || 'repo'),
      url: sp.url,
      token: String(r.token || '').trim(),
      project,
      repoDir: String(r.repoDir || '').trim(),
    };
  }) : (prev.repos || []);
  const safe = {
    url: String(cfg.url || '').trim(),
    token: String(cfg.token || '').trim(),
    project: String(cfg.project || '').trim(),
    repoDir: String(cfg.repoDir || '').trim(),
    model: String(cfg.model || 'deepseek-v4-flash').trim(),
    serverUrl: String(cfg.serverUrl || '').trim(),
    clientToken: String(cfg.clientToken || '').trim(),
    // 审查偏好(开关)
    autoPost: !!cfg.autoPost,
    autoFix: !!cfg.autoFix,
    autoPushFix: cfg.autoPushFix === undefined ? true : !!cfg.autoPushFix,   // 修复分支默认推送远端, 便于研发参考修改
    reviewDepth: String(cfg.reviewDepth || 'standard').trim(),
    // 审查输出语言: auto 自动(英文→客户端智能翻译) / zh 中文(ocr 直接中文) / en 英文
    ocrLang: String(cfg.ocrLang || 'auto').trim(),
    // 推送重试上限(连续失败达上限自动停止自动推送)
    pushMaxTries: Number(cfg.pushMaxTries) > 0 ? Number(cfg.pushMaxTries) : 3,
    // 审查并发(ocr 最大并发文件数, 默认 8)
    concurrency: Number(cfg.concurrency) > 0 ? Math.min(Number(cfg.concurrency), 32) : 8,
    // 审查超时(分钟, 默认 60)
    reviewTimeout: Number(cfg.reviewTimeout) > 0 ? Math.min(Number(cfg.reviewTimeout), 480) : 60,
    // LLM(自动修复引擎)
    llmBaseUrl: String(cfg.llmBaseUrl || '').trim(),
    llmApiKey: String(cfg.llmApiKey || '').trim(),
    fixModel: String(cfg.fixModel || '').trim(),
    // 外观
    theme: String(cfg.theme || 'dark').trim(),
    fontSize: String(cfg.fontSize || 'medium').trim(),
    // 多仓库
    repos,
    activeRepo: typeof cfg.activeRepo === 'number' ? cfg.activeRepo : (prev.activeRepo || 0),
  };
  // 同步激活仓库到顶层字段(兼容单仓库路径)
  const active = repos[safe.activeRepo] || {};
  if (active.project) safe.project = active.project;
  if (active.repoDir) safe.repoDir = active.repoDir;
  if (active.url) safe.url = active.url;
  if (active.token) safe.token = active.token;
  fs.writeFileSync(getUserConfigPath(), JSON.stringify(safe, null, 2), 'utf-8');
  backend = new ReviewBackend(safe, pushLog);
  serverConfig.serverUrl = safe.serverUrl;
  serverConfig.clientToken = safe.clientToken;
  if (fixEngine) fixEngine = new FixEngine(safe, pushLog);   // 刷新 LLM 配置
  if (queue) queue.setMaxRetries(safe.pushMaxTries);         // 同步推送重试上限
  const r = await runDailyGate();
  if (r.ok) flushQueue();
  return { ok: true, gate: r, activeRepo: safe.activeRepo };
});

// 手动停止当前审查(终止 ocr 子进程)
ipcMain.handle('review:stop', () => {
  const stopped = backend ? backend.stopReview((l) => pushLog(l)) : false;
  return { ok: true, stopped };
});

// 卡控状态查询(渲染进程用)
ipcMain.handle('gate:status', () => {
  return {
    ok: gate ? gate.authorized : false,
    grantedToday: gate ? gate.isGrantedToday() : false,
    admin: gate ? gate.adminAuthorized : false,
    pending: queue ? queue.pendingCount() : 0,
    serverUrl: serverConfig.serverUrl,
  };
});

// 超级管理员授权(密码验证, 通过后永久免服务端验证)
ipcMain.handle('admin:auth', async (e, password) => {
  if (!gate) gate = new AuthGate(getGatePath(), pushLog);
  pushLog('🔐 验证超级管理员密码...');
  const r = gate.verifyAdmin(password);
  pushLog(r.ok ? '🔐 超级管理员授权成功' : '🔐 ' + r.error);
  return r;
});

// 注销超级管理员(恢复服务端验证)
ipcMain.handle('admin:revoke', async () => {
  if (!gate) gate = new AuthGate(getGatePath(), pushLog);
  const r = gate.revokeAdmin();
  return r;
});

// 拉取模型列表(OpenAI 兼容 /v1/models)
ipcMain.handle('llm:models', async (e, baseUrl, apiKey) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '请先填写 API 地址' };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `模型列表请求失败: HTTP ${res.status}` };
    const data = await res.json();
    const models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    if (!models.length) return { ok: false, error: '未解析到模型列表' };
    pushLog(`📋 获取到 ${models.length} 个模型: ${models.slice(0, 5).join(', ')}${models.length > 5 ? '...' : ''}`);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: '连接失败: ' + e.message };
  }
});

/** 保存前校验 LLM 配置(不依赖系统环境): 地址可达 + Key 有效 + 模型存在 */
ipcMain.handle('llm:validate', async (e, baseUrl, apiKey, model) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '「API 地址」不能为空' };
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: '「API 地址」必须以 http:// 或 https:// 开头' };
  if (!/\/v1(?:\/|$)/i.test(base + '/')) return { ok: false, error: '「API 地址」建议包含 /v1(OpenAI 兼容) 或已由网关统一' };
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: '「API Key」不能为空(已不再使用系统环境变量)' };
  if (!String(model || '').trim()) return { ok: false, error: '「审查模型」不能为空' };
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
    const res = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: `API Key 无效(HTTP ${res.status})` };
      return { ok: false, error: `模型列表请求失败: HTTP ${res.status}` };
    }
    const data = await res.json();
    const models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    if (!models.length) return { ok: false, error: '地址可达但未返回模型列表, 请确认是 OpenAI 兼容网关' };
    const target = String(model || '').trim();
    const found = models.some((m) => m === target || m.includes(target) || target.includes(m));
    // 真实请求一次(极小): 部分网关 /models 不鉴权, 用 /chat/completions 确认 Key 真有效 + 模型可用
    try {
      const r2 = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: target, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(20000),
      });
      if (r2.status === 401 || r2.status === 403) return { ok: false, error: `API Key 无效(HTTP ${r2.status}), 请核对「模型服务 → API Key」` };
      if (r2.status === 404) return { ok: false, error: `模型「${target}」在该网关不存在(HTTP 404), 请从「获取模型列表」中选择` };
      if (!r2.ok) return { ok: false, error: `模型请求失败: HTTP ${r2.status}` };
    } catch (e2) {
      return { ok: false, error: '模型调用超时/失败: ' + e2.message };
    }
    pushLog(`✅ LLM 配置校验通过: ${base} · 模型 ${target}(${found ? '在列表' : '列表未找到同名, 但调用成功'})`);
    return { ok: true, modelFound: found, models, message: found ? '校验通过' : '⚠ 网关可达且调用成功, 但所选模型不在 /models 列表' };
  } catch (e) {
    return { ok: false, error: '连接失败(检查地址/网络/代理): ' + e.message };
  }
});

// 重新卡控(设置页手动触发)
ipcMain.handle('gate:recheck', async () => {
  return runDailyGate();
});

ipcMain.handle('connect:test', async () => {
  if (!backend) return { ok: false, error: '请先保存配置' };
  pushLog('正在测试 Git 服务连接...');
  const r = await backend.testConnection();
  pushLog(r.ok ? `连接成功: ${r.info}` : `连接失败: ${r.error}`);
  return r;
});

ipcMain.handle('mrs:list', async () => {
  if (!backend) return { ok: false, error: '请先保存配置' };
  const r = await backend.listMRs();
  if (r.ok) pushLog(`获取到 ${r.mrs.length} 个待合入 MR`);
  else pushLog(`获取 MR 失败: ${r.error}`);
  return r;
});

/** 历史 MR(已合入/已关闭) */
ipcMain.handle('mrs:history', async () => {
  if (!backend) return { ok: false, error: '请先保存配置' };
  const r = await backend.listHistoryMRs();
  return r;
});

ipcMain.handle('review:run', async (e, iid) => {
  // 审查门禁: 每日卡控未通过则禁用
  if (!gate || !gate.authorized) {
    const msg = '今日未通过服务端授权, 审查功能已禁用\n请在设置中配置并连接服务端(或确认客户端 Token 有效)';
    pushLog('🛑 ' + msg);
    return { ok: false, error: msg };
  }
  if (!backend) return { ok: false, error: '请先保存配置' };
  pushLog(`开始审查 MR !${iid} ...`);
  const cfg = loadConfig();
  const r = await backend.runReview(iid, (line) => pushLog('  ' + line), cfg.model);
  if (r.ok) {
    r.repoKey = currentRepoKey();   // 标记审查所属仓库, 防跨仓库误用
    lastReview = r;
    saveReviewHistory(r, { repoKey: r.repoKey, repoProject: activeRepoConfig(loadConfig()).project || '', object: `MR !${iid}`, iid });
    pushLog(`审查完成: ${r.comments.length} 条评论`);
    try {
      await translateComments(r.comments, cfg);
      notify(`✅ 审查完成 · MR !${iid}`, `发现 ${r.comments.length} 条问题${r.comments.length ? '（' + r.comments[0].path + ' 等）' : ''}`);
    } catch (e) { pushLog('⚠️ 翻译/通知异常: ' + e.message); }
    // 后处理(上报/自动流程)独立容错, 任何异常都不影响结果返回
    try { reportReview(r); } catch (e) { pushLog('⚠️ 审查记录上报失败: ' + e.message); }
    if (cfg.autoPost && r.comments.length > 0) {
      pushLog('⚙ 自动回填已开启, 自动回填评论...');
      try {
        const pr = await backend.postComments(iid, (line) => pushLog('  ' + line), r);
        pushLog(pr.ok ? `⚙ 自动回填完成: ${pr.posted} 条` : `⚙ 自动回填失败: ${pr.error}`);
      } catch (e) { pushLog('⚠️ 自动回填异常: ' + e.message); }
    }
    if (cfg.autoFix && r.comments.length > 0) {
      pushLog('⚙ 自动修复已开启, 创建修复分支...');
      try {
        const fr = await autoFix(iid, r);
        pushLog(fr.message || fr.error || '⚙ 自动修复无结果');
      } catch (e) { pushLog('⚠️ 自动修复异常: ' + e.message); }
    }
  } else {
    // 手动停止不算失败, 分开提示
    if (r.stopped) pushLog('⏹ 审查已手动停止');
    else pushLog(`审查失败: ${r.error || '未知错误'}`);
  }
  return r;
});

/** 自动修复(供自动流程和按钮共用) */
async function autoFix(iid, review) {
  if (!fixEngine) fixEngine = new FixEngine(loadConfig(), pushLog);
  let r = review;
  if (!r) {
    const rr = await backend.runReview(iid, (line) => pushLog('  ' + line));
    if (!rr.ok) return rr;
    lastReview = r = rr;
  }
  const base = r.srcBranch || r.dstBranch || 'main';
  pushLog(`启动自动修复: 基准分支 ${base}, 问题 ${(r.comments || []).length} 个 ...`);
  const fr = await fixEngine.runFix(r, base);
  if (fr.ok) {
    lastFix = fr;
    reportFix(r, fr);
  }
  return fr;
}

ipcMain.handle('review:post', async (e, iid, comments, expectRepoKey) => {
  if (!gate || !gate.authorized) return { ok: false, error: '今日未通过服务端授权' };
  if (!backend) return { ok: false, error: '请先保存配置' };
  // 历史记录回填: 若记录了所属仓库, 与当前激活仓库不一致则拒绝(防止把评论发错仓库)
  if (expectRepoKey && expectRepoKey !== currentRepoKey()) {
    const cur = activeRepoConfig(loadConfig());
    return { ok: false, error: `该记录属于其他仓库, 请先在顶部切换到对应仓库后再回填(当前: ${(cur && cur.project) || '?'})` };
  }
  // 优先复用最近一次审查结果: 必须同仓库 + 同 MR
  const reuse = lastReview && lastReview.mrId === Number(iid) && lastReview.ok && (!lastReview.repoKey || lastReview.repoKey === currentRepoKey());
  if (reuse) {
    pushLog(`回填评论到 MR !${iid}(复用最近审查结果 ${lastReview.comments.length} 条, 已选 ${(comments || []).length} 条)...`);
  } else {
    pushLog(`未找到 MR !${iid} 的审查结果, 先审查本 MR(可能要几分钟)...`);
  }
  const r = await backend.postComments(iid, (line) => pushLog('  ' + line), reuse ? lastReview : null, comments || null);
  pushLog(r.ok ? `✅ 回填完成: ${r.posted} 条评论` : `❌ 回填失败: ${r.error || '未知原因'}`);
  return r;
});

ipcMain.handle('server:test', async (e, baseUrl, token) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '请先填写服务端地址' };
  try {
    const headers = {};
    if (token) headers['X-Client-Token'] = token;
    const res = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: '服务端异常: HTTP ' + res.status };
    const data = await res.json().catch(() => ({}));
    return { ok: true, info: '服务端连接正常' + (data.db ? ' · 数据库正常' : '') };
  } catch (e) {
    return { ok: false, error: '连接失败: ' + e.message };
  }
});

// ---- M3: 提交树 IPC ----
ipcMain.handle('commits:branches', async () => {
  if (!backend) return { ok: false, error: '请先保存配置' };
  const r = await backend.listBranches();
  if (r.ok) pushLog(`获取到 ${r.branches.length} 个分支`);
  return r;
});

ipcMain.handle('commits:list', async (e, branch, all) => {
  if (!backend) return { ok: false, error: '请先保存配置' };
  const r = await backend.commitLog(branch || null, !!all);
  return r;
});

ipcMain.handle('commit:review', async (e, sha) => {
  if (!gate || !gate.authorized) return { ok: false, error: '今日未通过服务端授权' };
  if (!backend) return { ok: false, error: '请先保存配置' };
  pushLog(`审查提交 ${String(sha).slice(0, 8)} ...`);
  const r = await backend.runCommitReview(sha, (line) => pushLog('  ' + line));
  if (r.ok) {
    r.repoKey = currentRepoKey();   // 标记审查所属仓库, 防跨仓库误用
    lastReview = r;
    saveReviewHistory(r, { repoKey: r.repoKey, repoProject: activeRepoConfig(loadConfig()).project || '', object: `提交 ${String(sha).slice(0, 8)}`, sha: String(sha) });
    pushLog(`提交审查完成: ${r.comments.length} 条评论`);
    try {
      await translateComments(r.comments, loadConfig());
      notify(`✅ 提交审查完成 · ${String(sha).slice(0, 8)}`, `发现 ${r.comments.length} 条问题`);
    } catch (e) { pushLog('⚠️ 翻译/通知异常: ' + e.message); }
    try { reportReview(r); } catch (e) { pushLog('⚠️ 记录上报失败: ' + e.message); }
  } else {
    // 手动停止不算失败, 分开提示
    if (r.stopped) pushLog('⏹ 审查已手动停止');
    else pushLog(`审查失败: ${r.error || '未知错误'}`);
  }
  return r;
});

ipcMain.handle('commit:post', async (e, sha, comments, historyReview) => {
  if (!gate || !gate.authorized) return { ok: false, error: '今日未通过服务端授权' };
  if (!backend) return { ok: false, error: '请先保存配置' };
  const sh = String(sha || '');
  // 历史提交记录回填: 携带原仓库, 与当前不一致则拒绝
  if (historyReview && historyReview.repoKey && historyReview.repoKey !== currentRepoKey()) {
    const cur = activeRepoConfig(loadConfig());
    return { ok: false, error: `该记录属于其他仓库, 请先在顶部切换到对应仓库后再回填(当前: ${(cur && cur.project) || '?'})` };
  }
  let review;
  if (historyReview && historyReview.ok) {
    // 历史记录: 直接用其评论(子集)
    review = { ok: true, commitSha: sh, comments: Array.isArray(comments) ? comments : (historyReview.comments || []), repoKey: historyReview.repoKey };
  } else {
    // 常规: 复用最近一次该提交的审查结果
    const reuse = lastReview && lastReview.commitSha === sh && lastReview.ok && (!lastReview.repoKey || lastReview.repoKey === currentRepoKey());
    if (!reuse) return { ok: false, error: '请先审查该提交, 再回填评论' };
    review = lastReview;
    if (Array.isArray(comments)) review.comments = comments;
  }
  if (!Array.isArray(review.comments) || review.comments.length === 0) return { ok: true, posted: 0, message: '未选择要回填的评论' };
  pushLog(`回填提交评论(${sh.slice(0, 8)}, ${review.comments.length} 条)...`);
  const r = await backend.postCommitComments(sh, review, (line) => pushLog('  ' + line));
  pushLog(r.ok
    ? `✅ 提交回填完成: ${r.posted} 条${r.viaMr ? '(回填到 MR !' + r.viaMr + ')' : ''}`
    : `❌ 回填失败: ${r.error || '未知原因'}`);
  return r;
});

// ---- M4: 自动修复 IPC ----
ipcMain.handle('fix:run', async (e, iid) => {
  if (!gate || !gate.authorized) return { ok: false, error: '今日未通过服务端授权' };
  if (!backend) return { ok: false, error: '请先保存配置' };
  // 优先用最近一次审查结果(同仓库+同 MR); 无则现审 MR
  const r = await autoFix(iid, lastReview && lastReview.mrId === Number(iid) && lastReview.ok && (!lastReview.repoKey || lastReview.repoKey === currentRepoKey()) ? lastReview : null);
  pushLog(r.message || r.error || '');
  return r;
});

// 提交审查的自动修复: 从该提交创建修复分支 fix/ai/commit-<sha>, 逐问题 commit
ipcMain.handle('fix:commit', async (e, sha) => {
  if (!gate || !gate.authorized) return { ok: false, error: '今日未通过服务端授权' };
  if (!backend) return { ok: false, error: '请先保存配置' };
  const review = lastReview && lastReview.commitSha === String(sha) && lastReview.ok ? lastReview : null;
  if (!review) return { ok: false, error: '请先审查该提交, 再自动修复' };
  if (!fixEngine) fixEngine = new FixEngine(loadConfig(), pushLog);
  pushLog(`🚀 提交自动修复: ${String(sha).slice(0, 8)} ...`);
  const fr = await fixEngine.runFix(review, 'commit:' + String(sha));
  if (fr.ok) { lastFix = fr; try { reportFix(review, fr); } catch (e) { pushLog('⚠️ 修复记录上报失败: ' + e.message); } }
  pushLog(fr.ok ? `✅ ${fr.message || `${fr.applied} 个修复已提交到 ${fr.fixBranch} (仅本地)`}` : `❌ ${fr.error || fr.message || '自动修复失败'}`);
  return fr;
});

ipcMain.handle('fix:status', () => {
  return { lastFix };
});

// 立即推送本地缓存(渲染进程按钮 - 手动强制, 即使已暂停也重试并重置失败计数)
ipcMain.handle('queue:flush', async () => {
  if (!queue) queue = new ReportQueue(getQueuePath(), pushLog, (loadConfig() || {}).pushMaxTries || 3);
  queue.resetFailure();
  const r = await flushQueue(true);
  return { ok: true, posted: r.posted || 0, pending: queue.pendingCount(), paused: queue.paused };
});

// 审查结果中文翻译(LLM 批量翻译问题描述, 失败保留原文)
async function translateComments(comments, cfg) {
  if (!comments || !comments.length) return comments;
  const base = String(cfg.llmBaseUrl || '').replace(/\/+$/, '') || 'https://opencode.ai/zen/go/v1';
  const key = cfg.llmApiKey || process.env.HERMES_CUSTOM_OPENCODE_API_KEY || '';
  const model = cfg.model || 'deepseek-v4-flash';   // 修复/翻译共用审查模型
  // 评论已含中文(ocr 已按语言要求输出)则跳过翻译, 避免多余 LLM 流程
  const CJK = /[\u4e00-\u9fff]/;
  const hasAnyZh = comments.some((c) => CJK.test(c.content || c.message || c.body || ''));
  if (hasAnyZh) {
    comments.forEach((c) => {
      const raw = c.content || c.message || c.body || '';
      if (!c.contentZh && CJK.test(raw)) c.contentZh = raw;   // 已是中文: 直接作为中文内容
    });
    pushLog(`🀄 评论已含中文(${comments.filter((c) => c.contentZh).length}/${comments.length} 条), 跳过翻译`);
    return comments;
  }
  if (!key) return comments;
  const items = comments.map((c, i) => `${i}. [${c.path || ''}${c.start_line || c.line ? ':' + (c.start_line || c.line) : ''}] ${(c.content || c.message || c.body || '').slice(0, 400)}`);
  const prompt = `你是代码审查助手。以下是 AI 代码审查发现的问题(英文), 请逐条翻译成简洁通顺的中文, 保留技术术语(如 API 名、函数名、类型名不翻译)。只输出 JSON 数组(元素按序号与输入一一对应), 不要输出其他内容:\n\n${items.join('\n')}\n\n输出格式: ["翻译1", "翻译2", ...]`;
  try {
    pushLog('🀄 翻译审查结果为中文...');
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 2500 }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) { pushLog(`⚠ 翻译失败: HTTP ${res.status}, 保留原文`); return comments; }
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr) || !arr.length) { pushLog('⚠ 翻译解析失败, 保留原文'); return comments; }
    comments.forEach((c, i) => { if (arr[i] && typeof arr[i] === 'string') c.contentZh = arr[i]; });
    pushLog(`🀄 中文翻译完成(${comments.filter((c) => c.contentZh).length}/${comments.length} 条)`);
  } catch (e) {
    pushLog('⚠ 翻译失败: ' + e.message.slice(0, 60) + ', 保留原文');
  }
  return comments;
}

/** 系统通知(审查完成等事件提醒) */
function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    }
  } catch { }
}

// 打开外部链接(默认浏览器): MR 页面 / 任意 URL
ipcMain.handle('open:url', (e, url) => {
  try { if (url) shell.openExternal(String(url)); } catch { }
  return { ok: true };
});

// 构造并打开提交的网页 URL(按 Gitea / GitLab 协议)
ipcMain.handle('open:commit', (e, sha) => {
  const cfg = activeRepoConfig(loadConfig());
  const base = String(cfg.url || '').replace(/\/+$/, '');
  const project = String(cfg.project || '').replace(/\/+$/, '');
  if (!base || !project || !sha) return { ok: false, error: '缺少仓库配置或提交号' };
  const isGitLab = /gitlab/i.test(base);
  // GitLab: {base}/{project}/-/commit/{sha};  Gitea: {base}/{project}/commit/{sha}
  const url = isGitLab ? `${base}/${project}/-/commit/${sha}` : `${base}/${project}/commit/${sha}`;
  try { shell.openExternal(url); } catch { }
  pushLog(`🌐 打开提交页面: ${url}`);
  return { ok: true, url };
});

// 复制文本到剪贴板(修复建议一键复制)
ipcMain.handle('clip:write', (e, text) => {
  try { clipboard.writeText(String(text || '')); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---- 审查记录上报(本地缓存 + 推送) ----
function reportReview(review) {
  const cfg = loadConfig();
  const usage = extractUsage(review);
  const isCommit = !!review.commitSha && !review.mrId;
  queue.enqueue({ type: 'review', payload: {
    repoName: cfg.project || '',
    source: 'client',
    targetType: isCommit ? 'commit' : 'mr',
    targetId: isCommit ? String(review.commitSha) : String(review.mrId || ''),
    targetTitle: '',
    srcBranch: review.srcBranch || '',
    dstBranch: review.dstBranch || '',
    status: 'done',
    model: cfg.model || '',
    durationMs: review.summary ? parseInt(review.summary.elapsed_millis || 0) : 0,
    inputTokens: usage.input || 0,
    outputTokens: usage.output || 0,
    requestCount: Math.max(1, Math.ceil(usage.total / 20000)),
    issues: (review.comments || []).map((c) => ({
      path: c.path, startLine: c.start_line, endLine: c.end_line || null,
      severity: c.severity || 'low', category: c.category || '', content: c.content || '', suggestion: c.suggestion || null,
    })),
  }});
  queue.enqueue({ type: 'usage', payload: {
    source: 'client', model: cfg.model || '',
    inputTokens: usage.input || 0, outputTokens: usage.output || 0, requestCount: Math.max(1, usage.total ? Math.ceil(usage.total / 20000) : 1),
  }});
  flushQueue();
}

// ---- 修复记录上报 ----
function reportFix(review, fixRun) {
  if (!queue) queue = new ReportQueue(getQueuePath(), pushLog);
  queue.enqueue({ type: 'fix', payload: {
    repoName: loadConfig().project || '',
    reviewId: review.mrId || null,
    baseBranch: review.srcBranch || review.dstBranch || '',
    fixBranch: fixRun.fixBranch,
    issueCount: fixRun.applied || 0,
    commitCount: (fixRun.commits || []).length,
    status: fixRun.ok ? 'created' : 'failed',
    commits: (fixRun.commits || []).map((c) => ({ sha: c.sha, message: c.message, issueId: c.issueId })),
  }});
  flushQueue();
}

function extractUsage(review) {
  // ocr JSON manifest 可能含 token 统计; 无则从 summary 兜底
  try {
    const s = review.summary || {};
    return { input: s.input_tokens || 0, output: s.output_tokens || 0, total: s.total_tokens || 0 };
  } catch { return { input: 0, output: 0, total: 0 }; }
}

app.whenReady().then(() => {
  const cfg = activeRepoConfig(loadConfig());
  backend = new ReviewBackend(cfg, pushLog);
  serverConfig.serverUrl = (cfg.serverUrl || '').trim();
  serverConfig.clientToken = (cfg.clientToken || '').trim();
  createWindow();
  // 每日进入卡控
  runDailyGate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// CodeReviewSystem 服务端入口
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { pool, config } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---- 鉴权中间件 ----
// 管理端: Authorization: Bearer <jwt>
const requireAdmin = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const jwt = require('jsonwebtoken');
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch { return res.status(401).json({ error: '登录已过期' }); }
};

// 客户端: X-Client-Token
const requireClient = async (req, res, next) => {
  const token = req.headers['x-client-token'];
  if (!token) return res.status(401).json({ error: '缺少客户端 token' });
  try {
    const r = await pool.query('SELECT id FROM client_tokens WHERE token=$1 AND enabled=true', [token]);
    if (r.rowCount === 0) return res.status(401).json({ error: '客户端未授权' });
    await pool.query('UPDATE client_tokens SET last_seen=now() WHERE id=$1', [r.rows[0].id]);
    next();
  } catch (e) {
    res.status(500).json({ error: 'DB 错误: ' + e.message });
  }
};

// ---- 健康检查 ----
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true, time: new Date().toISOString() });
  } catch (e) {
    res.json({ ok: false, db: false, error: e.message });
  }
});

// ---- 客户端心跳/授权 ----
app.post('/api/auth/heartbeat', requireClient, (_req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

// ---- 管理端登录 ----
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const r = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
    if (r.rowCount === 0) return res.status(401).json({ error: '用户名或密码错误' });
    const bcrypt = require('bcryptjs');
    const ok = await bcrypt.compare(String(password), r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: r.rows[0].id, username: r.rows[0].username }, config.jwtSecret, { expiresIn: '12h' });
    res.json({ token, username: r.rows[0].username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 客户端 token 管理(管理端) ----
app.get('/api/admin/tokens', requireAdmin, async (_req, res) => {
  const r = await pool.query('SELECT id, token, machine, enabled, created_at, last_seen FROM client_tokens ORDER BY id');
  res.json(r.rows);
});
app.post('/api/admin/tokens', requireAdmin, async (req, res) => {
  const machine = (req.body || {}).machine || '';
  const token = require('crypto').randomBytes(24).toString('hex');
  const r = await pool.query('INSERT INTO client_tokens (token, machine) VALUES ($1,$2) RETURNING *', [token, machine]);
  res.json(r.rows[0]);
});
app.delete('/api/admin/tokens/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM client_tokens WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- 审查记录上报(客户端) ----
app.post('/api/reviews', requireClient, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rv = await client.query(
      `INSERT INTO reviews (repo_name, source, target_type, target_id, target_title, src_branch, dst_branch,
        status, model, duration_ms, input_tokens, output_tokens, request_count, error_msg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [b.repoName, b.source || 'client', b.targetType, String(b.targetId), b.targetTitle || '',
       b.srcBranch || '', b.dstBranch || '', b.status || 'done', b.model || '',
       b.durationMs || 0, b.inputTokens || 0, b.outputTokens || 0, b.requestCount || 0, b.errorMsg || '']
    );
    const reviewId = rv.rows[0].id;
    for (const i of b.issues || []) {
      await client.query(
        `INSERT INTO review_issues (review_id, path, start_line, end_line, severity, category, content, suggestion, fix_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [reviewId, i.path || '', i.startLine || null, i.endLine || null, i.severity || 'low', i.category || '',
         i.content || '', i.suggestion || null, i.fixStatus || 'none']
      );
    }
    await client.query(
      `INSERT INTO usage_logs (review_id, source, model, input_tokens, output_tokens, request_count, cost_estimate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [reviewId, b.source || 'client', b.model || '', b.inputTokens || 0, b.outputTokens || 0, b.requestCount || 0, b.cost || 0]
    );
    await client.query('COMMIT');
    res.json({ ok: true, reviewId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ---- 修复记录上报(客户端) ----
app.post('/api/fixes', requireClient, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO fix_runs (review_id, repo_name, base_branch, fix_branch, issue_count, commit_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.reviewId || null, b.repoName || '', b.baseBranch || '', b.fixBranch || '', b.issueCount || 0, b.commitCount || 0, b.status || 'created']
    );
    const runId = r.rows[0].id;
    for (const c of b.commits || []) {
      await client.query(
        'INSERT INTO fix_commits (fix_run_id, sha, message, issue_id) VALUES ($1,$2,$3,$4)',
        [runId, c.sha || '', c.message || '', c.issueId || null]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, fixRunId: runId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ---- 用量明细上报(独立) ----
app.post('/api/usage', requireClient, async (req, res) => {
  const b = req.body || {};
  await pool.query(
    `INSERT INTO usage_logs (review_id, source, model, input_tokens, output_tokens, request_count, cost_estimate)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [b.reviewId || null, b.source || 'client', b.model || '', b.inputTokens || 0, b.outputTokens || 0, b.requestCount || 0, b.cost || 0]
  );
  res.json({ ok: true });
});

// ---- 审查记录查询(管理端) ----
app.get('/api/reviews', requireAdmin, async (req, res) => {
  const { repo, source, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
  const cond = [];
  const params = [];
  if (repo) { params.push(repo); cond.push(`repo_name=$${params.length}`); }
  if (source) { params.push(source); cond.push(`source=$${params.length}`); }
  if (from) { params.push(from); cond.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); cond.push(`created_at <= $${params.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  params.push(pageSize); const limIdx = params.length;
  params.push((page - 1) * pageSize); const offIdx = params.length;
  const r = await pool.query(
    `SELECT id, repo_name, source, target_type, target_id, target_title, status, model, input_tokens, output_tokens, request_count, duration_ms, created_at
     FROM reviews ${where} ORDER BY id DESC LIMIT $${limIdx} OFFSET $${offIdx}`, params
  );
  const total = await pool.query(`SELECT count(*)::int AS c FROM reviews ${where}`, params.slice(0, params.length - 2));
  res.json({ rows: r.rows, total: total.rows[0].c, page, pageSize });
});

// ---- 审查详情 ----
app.get('/api/reviews/:id', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM reviews WHERE id=$1', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '不存在' });
  const issues = await pool.query('SELECT * FROM review_issues WHERE review_id=$1 ORDER BY severity DESC, id', [req.params.id]);
  res.json({ review: r.rows[0], issues: issues.rows });
});

// ---- 统计聚合 ----
app.get('/api/stats/overview', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  let cond = ''; const params = [];
  if (from) { params.push(from); cond += ` AND created_at >= $${params.length}`; }
  if (to) { params.push(to); cond += ` AND created_at <= $${params.length}`; }
  const r1 = await pool.query(`SELECT count(*)::int AS reviews, coalesce(sum(input_tokens),0)::bigint AS t_in, coalesce(sum(output_tokens),0)::bigint AS t_out, coalesce(sum(request_count),0)::int AS reqs FROM reviews WHERE true${cond}`, params);
  const r2 = await pool.query(`SELECT count(*)::int AS issues FROM review_issues WHERE review_id IN (SELECT id FROM reviews WHERE created_at=${from ? '$1' : 'now() - interval \'365 days\''})`, from ? [from] : []);
  // 严重分布
  const sev = await pool.query(
    `SELECT severity, count(*)::int AS c FROM review_issues WHERE review_id IN (SELECT id FROM reviews WHERE created_at${from ? ' >= $1' : ' >= now() - interval \'365 days\''}) GROUP BY severity`, from ? [from] : []
  );
  res.json({ reviews: r1.rows[0], issues: r2.rows[0].issues, bySeverity: sev.rows });
});

// ---- 问题分类统计 ----
app.get('/api/stats/by-category', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  let cond = ` WHERE 1=1`; const params = [];
  // 简化实现: 前端传 from/to, 拼到 reviews.created_at
  const r = await pool.query(
    `SELECT i.category, count(*)::int AS c, sum(CASE WHEN i.severity='high' OR i.severity='security' THEN 1 ELSE 0 END)::int AS critical
     FROM review_issues i JOIN reviews v ON v.id=i.review_id ${cond} GROUP BY i.category ORDER BY c DESC LIMIT 20`, params
  );
  res.json(r.rows);
});

// ---- 用量趋势 ----
app.get('/api/stats/usage', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const cond = []; const params = [];
  if (from) { params.push(from); cond.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); cond.push(`created_at <= $${params.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(
    `SELECT to_char(created_at,'YYYY-MM-DD') AS day, coalesce(sum(input_tokens),0)::bigint AS t_in,
            coalesce(sum(output_tokens),0)::bigint AS t_out, coalesce(sum(request_count),0)::int AS reqs,
            coalesce(sum(cost_estimate),0)::numeric AS cost
     FROM usage_logs ${where} GROUP BY day ORDER BY day`
  , params);
  res.json(r.rows);
});

// ---- 看板聚合(管理端): 工具价值量化 ----
// 问题分级: 低级问题(可忽略/批量处理) vs 值得讨论(有技术含量, 需人工评审)
app.get('/api/stats/dashboard', requireAdmin, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  try {
    // 总览
    const ov = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM reviews WHERE created_at >= now() - ($1 || ' days')::interval) AS reviews,
         (SELECT count(*)::int FROM review_issues i JOIN reviews v ON v.id=i.review_id WHERE v.created_at >= now() - ($1 || ' days')::interval) AS issues,
         (SELECT count(DISTINCT repo_name)::int FROM reviews WHERE created_at >= now() - ($1 || ' days')::interval) AS repos_covered,
         (SELECT coalesce(sum(duration_ms),0)::bigint FROM reviews WHERE created_at >= now() - ($1 || ' days')::interval) AS total_ms,
         (SELECT count(*)::int FROM review_issues i JOIN reviews v ON v.id=i.review_id WHERE v.created_at >= now() - ($1 || ' days')::interval AND i.fix_status='fixed') AS fixed`,
      [days]);
    const o = ov.rows[0];

    // 分级: 低级 vs 值得讨论(按严重度+类别双维判定)
    const grade = await pool.query(
      `SELECT
         CASE WHEN i.severity IN ('low','info','note','nit','style')
                    OR lower(coalesce(i.category,'')) IN ('style','format','naming','comment','documentation','other','chore')
              THEN 'trivial' ELSE 'discussion' END AS grade,
         count(*)::int AS c
       FROM review_issues i JOIN reviews v ON v.id=i.review_id
       WHERE v.created_at >= now() - ($1 || ' days')::interval
       GROUP BY 1`, [days]);
    const g = { trivial: 0, discussion: 0 };
    for (const row of grade.rows) g[row.grade] = row.c;

    // 客户端/来源维度排行(reviews.source 目前都是 client; machine 维度后续加)
    const byRepo = await pool.query(
      `SELECT v.repo_name AS name,
              count(DISTINCT v.id)::int AS reviews,
              count(i.id)::int AS issues,
              sum(CASE WHEN i.severity IN ('high','critical','security') THEN 1 ELSE 0 END)::int AS high,
              sum(CASE WHEN i.severity IN ('low','info','note','nit','style') THEN 1 ELSE 0 END)::int AS low,
              coalesce(sum(v.duration_ms),0)::bigint AS ms
       FROM reviews v LEFT JOIN review_issues i ON i.review_id=v.id
       WHERE v.created_at >= now() - ($1 || ' days')::interval
       GROUP BY v.repo_name ORDER BY issues DESC LIMIT 15`, [days]);

    // 分类×严重度矩阵(量化"哪类问题最多")
    const byCat = await pool.query(
      `SELECT coalesce(nullif(i.category,''),'(未分类)') AS category,
              count(*)::int AS c,
              sum(CASE WHEN i.severity IN ('high','critical','security') THEN 1 ELSE 0 END)::int AS high,
              sum(CASE WHEN i.severity = 'medium' THEN 1 ELSE 0 END)::int AS medium,
              sum(CASE WHEN i.severity IN ('low','info','note','nit','style') THEN 1 ELSE 0 END)::int AS low
       FROM review_issues i JOIN reviews v ON v.id=i.review_id
       WHERE v.created_at >= now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY c DESC LIMIT 20`, [days]);

    // 日趋势(审查次数+问题数)
    const trend = await pool.query(
      `SELECT to_char(d.day,'MM-DD') AS day,
              coalesce((SELECT count(*)::int FROM reviews v WHERE date_trunc('day',v.created_at)=d.day),0) AS reviews,
              coalesce((SELECT count(*)::int FROM review_issues i JOIN reviews v ON v.id=i.review_id WHERE date_trunc('day',v.created_at)=d.day),0) AS issues
       FROM generate_series(date_trunc('day', now()) - (($1::int-1) || ' days')::interval, date_trunc('day', now()), '1 day') d(day)
       ORDER BY d.day`, [days]);

    // 高频问题 Top 文件(问题集中地)
    const topFiles = await pool.query(
      `SELECT i.path, count(*)::int AS c,
              sum(CASE WHEN i.severity IN ('high','critical','security') THEN 1 ELSE 0 END)::int AS high
       FROM review_issues i JOIN reviews v ON v.id=i.review_id
       WHERE v.created_at >= now() - ($1 || ' days')::interval
       GROUP BY i.path ORDER BY c DESC LIMIT 10`, [days]);

    res.json({
      overview: { reviews: o.reviews, issues: o.issues, reposCovered: o.repos_covered,
                  avgMinutes: o.reviews ? Math.round(o.total_ms / o.reviews / 60000 * 10) / 10 : 0, fixed: o.fixed },
      grade: { trivial: g.trivial, discussion: g.discussion,
               trivialPct: o.issues ? Math.round(g.trivial / o.issues * 100) : 0 },
      byRepo: byRepo.rows, byCategory: byCat.rows, trend: trend.rows, topFiles: topFiles.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 定时任务(管理端) ----
app.get('/api/tasks', requireAdmin, async (_req, res) => {
  const r = await pool.query(
    `SELECT t.*, r.name AS repo_name FROM scheduled_tasks t LEFT JOIN repos r ON r.id = t.repo_id ORDER BY t.id`
  );
  // 附最近一次运行
  const runs = await pool.query(
    `SELECT DISTINCT ON (task_id) task_id, status, reviews_created, error_msg, started_at, finished_at
     FROM task_runs ORDER BY task_id, id DESC`
  );
  const runMap = {};
  for (const rn of runs.rows) runMap[rn.task_id] = rn;
  res.json(r.rows.map((t) => ({ ...t, lastRun: runMap[t.id] || null })));
});

app.post('/api/tasks', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.cron || !b.repoId) return res.status(400).json({ error: '缺少 name/cron/repoId' });
  if (!require('node-cron').validate(b.cron)) return res.status(400).json({ error: 'cron 表达式无效' });
  const r = await pool.query(
    `INSERT INTO scheduled_tasks (name, repo_id, mode, branch, cron, enabled, post_to_git, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.name, b.repoId, b.mode || 'open_mrs', b.branch || '', b.cron, b.enabled !== false, !!b.postToGit, b.model || '']
  );
  res.json(r.rows[0]);
});

app.put('/api/tasks/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const r = await pool.query(
    `UPDATE scheduled_tasks SET name=$1, cron=$2, enabled=$3, mode=$4, branch=$5, model=$6
     WHERE id=$7 RETURNING *`,
    [b.name || '', b.cron || '', b.enabled !== false, b.mode || 'open_mrs', b.branch || '', b.model || '', req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: '任务不存在' });
  const { schedulerNotify } = require('./scheduler');
  schedulerNotify && schedulerNotify();
  res.json(r.rows[0]);
});

app.delete('/api/tasks/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM scheduled_tasks WHERE id=$1', [req.params.id]);
  const { schedulerNotify } = require('./scheduler');
  schedulerNotify && schedulerNotify();
  res.json({ ok: true });
});

// 立即执行一次(不阻塞, 异步)
app.post('/api/tasks/:id/run', requireAdmin, async (req, res) => {
  const t = await pool.query('SELECT * FROM scheduled_tasks WHERE id=$1', [req.params.id]);
  if (t.rowCount === 0) return res.status(404).json({ error: '任务不存在' });
  const task = t.rows[0];
  const repo = await pool.query('SELECT * FROM repos WHERE id=$1', [task.repo_id]);
  const full = { ...task, ...(repo.rows[0] || {}) };
  const { runTaskOnce } = require('./scheduler');
  runTaskOnce(full).then(() => {});
  res.json({ ok: true, message: '任务已触发, 后台执行中' });
});

app.get('/api/tasks/:id/runs', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM task_runs WHERE task_id=$1 ORDER BY id DESC LIMIT 30', [req.params.id]);
  res.json(r.rows);
});

// ---- 仓库注册(定时任务用) ----
app.get('/api/repos', requireAdmin, async (_req, res) => {
  const r = await pool.query('SELECT * FROM repos ORDER BY id');
  res.json(r.rows);
});
app.post('/api/repos', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.gitUrl || !b.project) return res.status(400).json({ error: '缺少 name/gitUrl/project' });
  const r = await pool.query(
    `INSERT INTO repos (name, git_url, project, token, git_type, local_path) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.name, b.gitUrl, b.project, b.token || '', b.gitType || 'gitea', b.localPath || '']
  );
  res.json(r.rows[0]);
});
app.delete('/api/repos/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM repos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- 管理静态页(简单)
const webDir = path.join(__dirname, '..', 'web');
app.get('/', (_req, res) => {
  const idx = path.join(webDir, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.redirect('/api/health');
});
app.use('/web', express.static(webDir));

// ---- 启动 ----
// 监听地址与端口: config.json { host, port } → 环境变量 CRS_HOST/CRS_PORT 可覆盖(优先级更高)
// host 默认 0.0.0.0(所有网卡, 局域网可访问); 仅本机用改为 127.0.0.1
const HOST = String(process.env.CRS_HOST || config.host || '0.0.0.0').trim() || '0.0.0.0';
const PORT = Number(process.env.CRS_PORT || config.port || 3001);
const server = app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? '所有网卡(局域网可访问)' : HOST;
  console.log(`[CodeReviewSystem] 服务端运行于 ${shown}:${PORT}`);
  console.log(`[CodeReviewSystem] 健康检查: http://127.0.0.1:${PORT}/api/health`);
  console.log(`[CodeReviewSystem] 客户端服务端地址填: http://<本机IP>:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[CodeReviewSystem] ❌ 端口 ${PORT} 已被占用! 解决: 改 config.json 的 port, 或启动时 CRS_PORT=3002 node src/index.js`);
  } else if (err.code === 'EACCES') {
    console.error(`[CodeReviewSystem] ❌ 无权限绑定 ${HOST}:${PORT}(端口<1024 需管理员; 或 host 不在本机)`);
  } else {
    console.error('[CodeReviewSystem] ❌ 监听失败:', err.message);
  }
  process.exit(1);
  // 启动定时任务调度器
  try {
    const { startScheduler } = require('./scheduler');
    startScheduler();
  } catch (e) {
    console.error('[CodeReviewSystem] 调度器启动失败:', e.message);
  }
});
// 定时任务调度器(M6)
// 从 scheduled_tasks 读取启用任务, 按 cron 触发:
//   拉取/克隆仓库 → 获取 open MRs → 逐个 ocr 审查 → 记录 reviews/issues/usage → 写 task_runs
const cron = require('node-cron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { runOcrReview } = require('./ocr-runner');

const WORK_DIR = path.join(__dirname, '..', 'data', 'repos');
fs.mkdirSync(WORK_DIR, { recursive: true });

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || err || '').toString() }));
  });
}

async function apiFetch(task, subPath, method = 'GET', body) {
  const isGitea = !/gitlab/i.test(task.gitUrl || task.git_url || '');
  const base = (task.gitUrl || task.git_url).replace(/\/+$/, '');
  const project = task.project || task.name;
  const url = isGitea
    ? `${base}/api/v1/repos/${project}${subPath}`
    : `${base}/api/v4/projects/${encodeURIComponent(project)}${subPath}`;
  const headers = { 'Content-Type': 'application/json' };
  if (task.token) headers[isGitea ? 'Authorization' : 'PRIVATE-TOKEN'] = isGitea ? 'token ' + task.token : task.token;
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.status === 204 ? null : resp.json();
}

/** 确保本地仓库就绪, 返回目录 */
async function ensureRepo(task) {
  const safeName = String(task.name || 'repo').replace(/[^w一-鿿.-]+/g, '_');   // 防路径穿越(task.name 来自管理端输入)
  const dir = path.join(WORK_DIR, safeName);
  let repoUrl = task.gitUrl;
  // 解析 clone 地址: 若 gitUrl 是 API 地址则组装
  const isGitea = !/gitlab/i.test(task.gitUrl || task.git_url || '');
  if (task.token && !/@/.test(task.gitUrl || task.git_url)) {
    const host = (task.gitUrl || task.git_url).replace(/\/+$/, '').replace(/^https?:\/\//, '');
    repoUrl = `${isGitea ? 'http' : 'https'}://oauth2:${encodeURIComponent(task.token)}@${host}/${task.project || task.name}.git`;
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    const c = await git(WORK_DIR, ['clone', repoUrl, dir]);
    if (!c.ok) throw new Error('clone 失败: ' + c.stderr.slice(0, 150));
  }
  const f = await git(dir, ['fetch', 'origin', '--prune']);
  if (!f.ok) throw new Error('fetch 失败: ' + f.stderr.slice(0, 150));
  return dir;
}

/** 执行一次任务 */
async function runTaskOnce(task) {
  const started = await pool.query("INSERT INTO task_runs (task_id) VALUES ($1) RETURNING id", [task.id]);
  const runId = started.rows[0].id;
  let reviewsCreated = 0;
  try {
    const dir = await ensureRepo(task);

    // 获取 open MRs
    const suffix = /gitlab/i.test(task.gitUrl || task.git_url || '') ? '/merge_requests?state=opened&per_page=50' : '/pulls?state=open&limit=50';
    const mrs = await apiFetch(task, suffix);
    const list = Array.isArray(mrs) ? mrs : [];
    const useModel = task.model || 'deepseek-v4-flash';

    for (const raw of list) {
      let iid, title, srcBranch, dstBranch, headSha;
      if (/gitlab/i.test(task.gitUrl || task.git_url || '')) {
        iid = raw.iid; title = raw.title; srcBranch = raw.source_branch; dstBranch = raw.target_branch; headSha = raw.sha;
      } else {
        iid = raw.number; title = raw.title; srcBranch = (raw.head || {}).ref; dstBranch = (raw.base || {}).ref; headSha = (raw.head || {}).sha;
      }
      // 拉取 MR 分支
      if (/gitlab/i.test(task.gitUrl || task.git_url || '')) await git(dir, ['fetch', 'origin', `refs/merge-requests/${iid}/head`]);
      else await git(dir, ['fetch', 'origin', `refs/pull/${iid}/head:refs/remotes/origin/pr/${iid}`]);
      const ref = /gitlab/i.test(task.gitUrl || task.git_url || '') ? `refs/merge-requests/${iid}/head` : `origin/pr/${iid}`;

      const llmConfig = await pool.query('SELECT * FROM llm_config WHERE id=1');
      const llm = llmConfig.rows[0] || {};
      // 保证 apiKey 从环境变量可取
      const apiKey = llm.api_key || process.env.HERMES_CUSTOM_OPENCODE_API_KEY || '';

      const t0 = Date.now();
      const r = await runOcrReview(dir, `origin/${dstBranch}`, ref, useModel, apiKey, console.log);
      const durationMs = Date.now() - t0;

      // 落库 reviews + issues
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rv = await client.query(
          `INSERT INTO reviews (repo_name, source, target_type, target_id, target_title, src_branch, dst_branch,
             status, model, duration_ms, error_msg)
           VALUES ($1,'scheduler','mr',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [task.name, String(iid), title || '', srcBranch || '', dstBranch || '',
           r.ok ? 'done' : 'error', useModel, durationMs, r.ok ? '' : (r.error || '')]
        );
        const reviewId = rv.rows[0].id;
        if (r.ok) {
          for (const c of r.comments) {
            await client.query(
              `INSERT INTO review_issues (review_id, path, start_line, end_line, severity, category, content, suggestion)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [reviewId, c.path || '', c.start_line || null, c.end_line || null, c.severity || 'low', c.category || '', c.content || '', c.suggestion || null]
            );
          }
          await client.query(
            `INSERT INTO usage_logs (review_id, source, model, request_count) VALUES ($1,'scheduler',$2,$3)`,
            [reviewId, useModel, Math.max(1, (r.comments.length || 1))]
          );
        }
        await client.query('COMMIT');
        reviewsCreated++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('[scheduler] 落库失败:', e.message);
      } finally {
        client.release();
      }
    }

    await pool.query("UPDATE task_runs SET finished_at=now(), status='done', reviews_created=$1 WHERE id=$2", [reviewsCreated, runId]);
    console.log(`[scheduler] 任务#${task.id}「${task.name}」完成: ${list.length} 个 MR, 创建 ${reviewsCreated} 条审查记录`);
    return { ok: true, reviewsCreated };
  } catch (e) {
    await pool.query("UPDATE task_runs SET finished_at=now(), status='error', error_msg=$1 WHERE id=$2", [String(e.message || e).slice(0, 500), runId]);
    console.error(`[scheduler] 任务#${task.id}「${task.name}」失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 启动调度器: 加载所有启用任务 */
let reloadFn = null;
function startScheduler() {
  const jobs = new Map();
  const load = async () => {
    try {
      const r = await pool.query(`SELECT t.*, r.git_url, r.project, r.token, r.local_path FROM scheduled_tasks t LEFT JOIN repos r ON r.id = t.repo_id WHERE t.enabled = true`);
      for (const task of r.rows) {
        if (jobs.has(task.id)) continue;   // 已调度
        if (!task.cron) continue;
        const valid = cron.validate(task.cron);
        if (!valid) { console.error(`[scheduler] 任务#${task.id} cron 无效: ${task.cron}`); continue; }
        const job = cron.schedule(task.cron, async () => {
          console.log(`[scheduler] 触发任务#${task.id}「${task.name}」`);
          await runTaskOnce(task);
        });
        job.start();
        jobs.set(task.id, job);
        console.log(`[scheduler] 已注册任务#${task.id}「${task.name}」 cron=${task.cron}`);
      }
      // 清理已禁用的任务
      for (const key of jobs.keys()) {
        if (!r.rows.some((t) => t.id === key)) {
          jobs.get(key).stop();
          jobs.delete(key);
          console.log(`[scheduler] 已注销任务#${key}`);
        }
      }
    } catch (e) {
      console.error('[scheduler] 加载任务失败:', e.message);
    }
  };
  load();
  reloadFn = load;
  setInterval(load, 60000).unref();    // 每分钟同步一次任务变更
  console.log('[scheduler] 调度器已启动(每 60s 同步任务)');
}

/** 任务变更后立即同步(由 API 层调用) */
function schedulerNotify() {
  if (reloadFn) reloadFn();
}

module.exports = { startScheduler, runTaskOnce, schedulerNotify };
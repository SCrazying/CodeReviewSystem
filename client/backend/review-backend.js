// CodeReviewTool 后端: Gitea/GitLab API + ocr 审查调度
// 移植自 mr_scan.py 的双后端逻辑, Node 原生实现(无需 Python)
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OCR_JS_NAME = 'ocr.js';
const AI_MARK = '🤖 AI 审查';

class ReviewBackend {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.baseUrl = (config.url || '').replace(/\/+$/, '');
    this.isGitea = this.baseUrl.length > 0 && !/gitlab/i.test(this.baseUrl) && /localhost|127\.0\.0\.1|gitea/i.test(this.baseUrl);
    // 简化判断: 兼容模式。默认按 Gitea v1 API; 若 URL 含 gitlab 字样则走 v4
    this.isGitea = !/gitlab/i.test(this.baseUrl || '');
  }

  get token() { return this.config.token || ''; }

  ocrJsAvailable() {
    return findOcrJs() !== null;
  }

  _headers() {
    return this.isGitea
      ? { Authorization: 'token ' + this.token, 'Content-Type': 'application/json' }
      : { 'PRIVATE-TOKEN': this.token, 'Content-Type': 'application/json' };
  }

  _projectPath() {
    return encodeURIComponent(this.config.project || '');
  }

  _apiBase() {
    return this.isGitea
      ? `${this.baseUrl}/api/v1/repos/${this.config.project}`
      : `${this.baseUrl}/api/v4/projects/${this._projectPath()}`;
  }

  async _api(method, subPath, body) {
    const url = this._apiBase() + subPath;
    const opts = {
      method,
      headers: this._headers(),
      body: body ? JSON.stringify(body) : undefined,
    };
    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`API ${resp.status} ${method} ${url}: ${text.slice(0, 300)}`);
    }
    if (resp.status === 204 || resp.headers.get('content-length') === '0') return null;
    return resp.json();
  }

  /** 规范化 MR/PR 字段 */
  _normalizeMr(mr) {
    if (!this.isGitea) return {
      iid: mr.iid, title: mr.title,
      source_branch: mr.source_branch, target_branch: mr.target_branch,
      sha: mr.sha, web_url: mr.web_url,
      state: String(mr.state || '').toLowerCase(), updated_at: mr.updated_at || mr.merged_at || null,
    };
    return {
      iid: mr.number, title: mr.title,
      source_branch: (mr.head || {}).ref, target_branch: (mr.base || {}).ref,
      sha: (mr.head || {}).sha, web_url: mr.html_url,
      state: String(mr.state || '').toLowerCase(), updated_at: mr.updated_at || mr.merged_at || null,
    };
  }

  async testConnection() {
    try {
      if (this.isGitea) {
        await this._api('GET', '');
      } else {
        await this._api('GET', '');
      }
      return { ok: true, info: `${this.config.project} (${this.isGitea ? 'Gitea v1' : 'GitLab v4'})` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async listMRs() {
    try {
      const suffix = this.isGitea
        ? `/pulls?state=open&limit=50`
        : `/merge_requests?state=opened&per_page=50`;
      const list = await this._api('GET', suffix);
      if (!Array.isArray(list)) return { ok: false, error: '返回格式异常' };
      return { ok: true, mrs: list.map((m) => this._normalizeMr(m)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 历史 MR: 已合并/已关闭的 MR 列表 */
  async listHistoryMRs() {
    try {
      const suffix = this.isGitea
        ? `/pulls?state=all&limit=100`
        : `/merge_requests?state=all&per_page=100`;
      const list = await this._api('GET', suffix);
      if (!Array.isArray(list)) return { ok: false, error: '返回格式异常' };
      const hist = list.map((m) => this._normalizeMr(m))
        .filter((m) => String(m.state).toLowerCase() === 'merged' || String(m.state).toLowerCase() === 'closed');
      return { ok: true, mrs: hist };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getMr(iid) {
    const suffix = this.isGitea ? `/pulls/${iid}` : `/merge_requests/${iid}`;
    const mr = await this._api('GET', suffix);
    return this._normalizeMr(mr);
  }

  /** git 工具函数 */
  _git(repoDir, args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, stdout, stderr: stderr || err.message });
        else resolve({ ok: true, stdout });
      });
    });
  }

  async _fetchMrRef(repoDir, iid, srcBranch) {
    if (this.isGitea) {
      const r = await this._git(repoDir, ['fetch', 'origin', `refs/pull/${iid}/head:refs/remotes/origin/pr/${iid}`]);
      return r.ok ? `origin/pr/${iid}` : `origin/${srcBranch}`;
    }
    const r = await this._git(repoDir, ['fetch', 'origin', `refs/merge-requests/${iid}/head`]);
    return r.ok ? `refs/merge-requests/${iid}/head` : `origin/${srcBranch}`;
  }

  /** 手动停止当前进行中的审查(终止 ocr 子进程) */
  stopReview(log = () => {}) { return stopActiveRun(log); }

  /** 执行 ocr review, 返回评论数组 */
  async runReview(iid, log = () => {}) {
    try {
      const mr = await this.getMr(iid);
      const repoDir = this.config.repoDir;
      if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
        return { ok: false, error: `仓库目录无效: ${repoDir}` };
      }

      log('拉取 origin ...');
      const f1 = await this._git(repoDir, ['fetch', 'origin']);
      if (!f1.ok) return { ok: false, error: 'fetch origin 失败: ' + f1.stderr.slice(0, 200) };

      // MR ref 优先用 head sha(绝对有效, 避开 --to "refs/..." 解析问题)
      let ref = mr.sha || '';
      if (!ref) {
        const fetched = await this._fetchMrRef(repoDir, iid, mr.source_branch);
        ref = fetched;
      }
      log(`审查范围: origin/${mr.target_branch} → ${ref.slice(0, 40)}`);

      // 优先 native exe(直接执行, 配置随程序走); 回退 js 启动器
      const ocrBin = findOcrExe();
      const ocrJs = ocrBin ? null : findOcrJs();
      if (!ocrBin && !ocrJs) return { ok: false, error: '找不到 open-code-review(ocr)。请先 npm install -g @alibaba-group/open-code-review' };
      // 审查超时(设置可调, 默认 60 分钟)
      const tmoMs = (Number(this.config.reviewTimeout) > 0 ? Number(this.config.reviewTimeout) : 60) * 60000;

      const args = [
        'review',
        '--from', `origin/${mr.target_branch}`,
        '--to', ref,
        '--format', 'json',
        '--model', this.config.model || 'deepseek-v4-flash',
      ];
      // ocr 并行审查: 最大并发文件数(设置可调, 默认 8)
      const cc = Number(this.config.concurrency) > 0 ? Number(this.config.concurrency) : 8;
      args.push('--concurrency', String(cc));
      // ocr 内部并发超时: 略小于客户端审查超时(默认 60min - 5min 余量), 避免 ocr 默认 10min 先杀
      args.push('--timeout', String(Math.max(1, Math.round(tmoMs / 60000) - 5)));
      // 审查输出语言: 中文时通过 --background 注入指令, 让 ocr 的 LLM 直接输出中文(实测有效)
      if (String(this.config.ocrLang || 'auto').trim() === 'zh') {
        args.push('--background', ZH_BG_PROMPT);
      }
      // 打印具体调用命令, 便于排查内网问题
      log(`$ ${(ocrBin || ocrJs).replace(/\\/g, '/')} ${args.join(' ')}`);
      log(`调用 ocr(模型 ${this.config.model || 'deepseek-v4-flash'}, 并发 ${cc}, ${ocrBin ? 'native' : 'js'}${String(this.config.ocrLang || 'auto').trim() === 'zh' ? ', 中文输出' : ''})...`);
      const out = ocrBin ? await runNative(ocrBin, args, repoDir, this.config, (l) => log(l), tmoMs)
                         : await runNode(ocrJs, args, repoDir, this.config.model, tmoMs);
      if (out.stoppedByUser) return { ok: false, error: '审查已手动停止', stopped: true };
      if (!out.ok) {
        log('❌ ocr 审查失败, 详细日志:');
        if (out.stderr) log('  ── stderr ──\n' + out.stderr.slice(0, 2000));
        if (out.stdout) log('  ── stdout(前 800) ──\n' + out.stdout.slice(0, 800));
        if (out.error && !out.stderr) log('  ── 进程错误 ──\n' + String(out.error).slice(0, 800));
        return { ok: false, error: 'ocr review 失败: ' + (out.stderr || out.error || '未知').slice(0, 300) };
      }

      let data;
      try { data = JSON.parse(out.stdout); }
      catch (e) {
        log('❌ ocr 输出解析失败(不是合法 JSON), 原始输出:');
        log('  ── stdout(前 2000) ──\n' + out.stdout.slice(0, 2000));
        if (out.stderr) log('  ── stderr(前 1000) ──\n' + out.stderr.slice(0, 1000));
        return { ok: false, error: 'ocr 输出解析失败: ' + e.message };
      }
      // JSON 合法但缺少审查结果字段
      if (!Array.isArray(data.comments)) {
        log(`⚠️ ocr 返回 JSON 但缺少 comments 数组, 实际 keys: ${Object.keys(data).join(', ') || '(空对象)'}`);
        log('  ── stdout(前 1200) ──\n' + out.stdout.slice(0, 1200));
      }

      const comments = (data.comments || []).filter((c) => c.path && c.start_line);
      const manifest = (data.manifest || {}).input || {};
      return {
        ok: true,
        comments,
        base_sha: manifest.resolved_base || manifest.base_sha || '',
        head_sha: manifest.resolved_head || manifest.head_sha || '',
        summary: data.summary || {},
        // 供数据上报
        mrId: mr.iid,
        srcBranch: mr.source_branch,
        dstBranch: mr.target_branch,
      };
    } catch (e) {
      return { ok: false, error: '审查异常: ' + (e.message || e) };
    }
  }

  /** 审查单次提交(ocr --commit) */
  async runCommitReview(sha, log = () => {}) {
    try {
      const repoDir = this.config.repoDir;
      if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
        return { ok: false, error: `仓库目录无效: ${repoDir}` };
      }
      // 优先 native exe; 回退 js 启动器
      const ocrBin = findOcrExe();
      const ocrJs = ocrBin ? null : findOcrJs();
      if (!ocrBin && !ocrJs) return { ok: false, error: '找不到 open-code-review(ocr)' };
      // 审查超时(设置可调, 默认 60 分钟)
      const tmoMs = (Number(this.config.reviewTimeout) > 0 ? Number(this.config.reviewTimeout) : 60) * 60000;
      log(`审查提交 ${sha.slice(0, 8)} ...`);
      const cc = Number(this.config.concurrency) > 0 ? Number(this.config.concurrency) : 8;
      const args = ['review', '--commit', sha, '--format', 'json', '--model', this.config.model || 'deepseek-v4-flash', '--concurrency', String(cc)];
      args.push('--timeout', String(Math.max(1, Math.round(tmoMs / 60000) - 5)));   // ocr 内部超时与客户端对齐
      if (String(this.config.ocrLang || 'auto').trim() === 'zh') {
        args.push('--background', ZH_BG_PROMPT);
      }
      log(`$ ${(ocrBin || ocrJs).replace(/\\/g, '/')} ${args.join(' ')}`);
      log(`调用 ocr(模型 ${this.config.model || 'deepseek-v4-flash'}, 并发 ${cc}, ${ocrBin ? 'native' : 'js'}${String(this.config.ocrLang || 'auto').trim() === 'zh' ? ', 中文输出' : ''})...`);
      const out = ocrBin ? await runNative(ocrBin, args, repoDir, this.config, (l) => log(l), tmoMs)
                         : await runNode(ocrJs, args, repoDir, this.config.model, tmoMs);
      if (out.stoppedByUser) return { ok: false, error: '审查已手动停止', stopped: true };
      if (!out.ok) {
        log('❌ ocr 提交审查失败, 详细日志:');
        if (out.stderr) log('  ── stderr ──\n' + out.stderr.slice(0, 2000));
        if (out.stdout) log('  ── stdout(前 800) ──\n' + out.stdout.slice(0, 800));
        if (out.error && !out.stderr) log('  ── 进程错误 ──\n' + String(out.error).slice(0, 800));
        return { ok: false, error: 'ocr review 失败: ' + (out.stderr || out.error || '未知').slice(0, 300) };
      }
      let data;
      try { data = JSON.parse(out.stdout); }
      catch (e) {
        log('❌ ocr 提交审查输出解析失败, 原始输出:');
        log('  ── stdout(前 2000) ──\n' + out.stdout.slice(0, 2000));
        if (out.stderr) log('  ── stderr(前 1000) ──\n' + out.stderr.slice(0, 1000));
        return { ok: false, error: 'ocr 输出解析失败: ' + e.message };
      }
      if (!Array.isArray(data.comments)) {
        log(`⚠️ ocr 返回 JSON 但缺少 comments 数组, 实际 keys: ${Object.keys(data).join(', ') || '(空对象)'}`);
        log('  ── stdout(前 1200) ──\n' + out.stdout.slice(0, 1200));
      }
      const comments = (data.comments || []).filter((c) => c.path && c.start_line);
      // 反查该提交关联的 MR(便于按 commit 分片审查大 MR)
      let relatedMr = null;
      try { relatedMr = await this.getCommitRelatedMr(repoDir, sha); } catch { }
      log(relatedMr ? `🔗 该提交属于 MR !${relatedMr.iid}${relatedMr.title ? ' · ' + relatedMr.title : ''}` : '📄 该提交未关联到已开放的 MR');
      return {
        ok: true, comments, summary: data.summary || {},
        commitSha: sha, mrId: null, srcBranch: '', dstBranch: '', relatedMr,
      };
    } catch (e) {
      return { ok: false, error: '审查异常: ' + (e.message || e) };
    }
  }

  /**
   * 反查某个 commit 所属的开放 MR
   * GitLab: API  GET /repository/commits/:sha/merge_requests (v4 标准)
   * Gitea:  本地已 fetch 的 pr refs(origin/pr/N) 用 git branch -r --contains 反查
   * @returns {null|{iid:number,title:string,web_url:string,source_branch:string}}
   */
  async getCommitRelatedMr(repoDir, sha) {
    try {
      if (!this.isGitea) {
        // GitLab 官方反查端点
        const list = await this._api('GET', `/repository/commits/${sha}/merge_requests?state=opened`);
        if (Array.isArray(list) && list.length) {
          const mr = list[0];
          return { iid: mr.iid, title: mr.title, web_url: mr.web_url, source_branch: mr.source_branch };
        }
        return null;
      }
      // Gitea: 本地 pr refs 反查(要求仓库已 fetch refs/pull/*/head)
      const r = await this._git(repoDir, ['branch', '-r', '--contains', sha]);
      for (const line of (r.stdout || '').split('\n')) {
        const ref = line.trim();
        const m = ref.match(/pr\/(\d+)(?:$|\s)/);
        if (m) {
          const iid = Number(m[1]);
          let mr = {};
          try { mr = await this.getMr(iid); } catch { }
          return { iid, title: mr.title || '', web_url: mr.web_url || '', source_branch: mr.source_branch || '' };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 列出本地/远程分支 */
  async listBranches() {
    const repoDir = this.config.repoDir;
    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) return { ok: false, error: '仓库目录无效' };
    const r = await this._git(repoDir, ['branch', '-a', '--no-color']);
    if (!r.ok) return { ok: false, error: r.stderr.slice(0, 200) };
    const branches = r.stdout.split('\n')
      .map((s) => s.trim().replace(/^\*+\s*/, ''))
      .filter((s) => s && s !== 'HEAD ->' && !s.includes('->') && s !== 'HEAD');
    return { ok: true, branches };
  }

  /** 带 open MR 标记的分支集合(用于提交树标注) */
  async getMrBranches() {
    try {
      const mrs = await this.listMRs();
      if (!mrs.ok) return new Set();
      const set = new Set();
      for (const mr of mrs.mrs || []) {
        set.add(mr.source_branch); set.add('origin/' + mr.source_branch);
        if (mr.iid) set.add('mr#' + mr.iid);
      }
      return set;
    } catch { return new Set(); }
  }

  /** 提交日志(支持分支 + 全部/单分支). 返回 commits + 带 MR 标记 */
  async commitLog(branch, allBranches, maxCount = 60) {
    const repoDir = this.config.repoDir;
    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) return { ok: false, error: '仓库目录无效' };
    let args;
    if (branch && !allBranches) {
      args = ['log', branch, '--first-parent', `--max-count=${maxCount}`,
        '--pretty=%H\t%ad\t%an\t%s', '--date=format:%m-%d %H:%M'];
    } else {
      // 全部分支(去重): 用 --branches 遍历 + 简化图
      args = ['log', '--all', '--simplify-by-decoration', `--max-count=${maxCount}`,
        '--pretty=%H\t%ad\t%an\t%s\t%D', '--date=format:%m-%d %H:%M'];
    }
    const r = await this._git(repoDir, args);
    if (!r.ok) return { ok: false, error: r.stderr.slice(0, 200) };

    // 收集 MR 源分支哈希(远端)用于标记提交
    let mrHeads = new Set();
    let mrBranches = new Set();
    try {
      const mrs = await this.listMRs();
      if (mrs.ok) {
        for (const m of mrs.mrs || []) {
          if (m.sha) mrHeads.add(m.sha);
          mrBranches.add(m.source_branch);
        }
      }
    } catch { }

    const commits = [], seen = new Set();
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const hash = parts[0];
      if (seen.has(hash)) continue;
      seen.add(hash);
      const decorations = parts[4] || '';
      const hasMr = mrHeads.has(hash)
        || decorations.split(',').some((d) => {
          const t = d.trim().replace(/^origin\//, '');
          return mrBranches.has(t.replace(/^origin\//, '')) || /^pr\//.test(t);
        });
      commits.push({
        hash, date: parts[1] || '', author: parts[2] || '',
        subject: parts[3] || '', refs: decorations.trim(), hasMr,
      });
    }
    return { ok: true, commits };
  }

  /** 获取已有 AI 评论 → {(path,line)} 集合 */
  async _existingAiComments(iid) {
    const existing = new Set();
    try {
      if (this.isGitea) {
        const reviews = await this._api('GET', `/pulls/${iid}/reviews`);
        for (const rv of reviews || []) {
          const cmts = await this._api('GET', `/pulls/${iid}/reviews/${rv.id}/comments`);
          for (const c of cmts || []) {
            if (!(c.body || '').includes(AI_MARK)) continue;
            const line = c.line || c.line_new || c.new_position || c.position;
            if (c.path && line) existing.add(`${c.path}:${line}`);
          }
        }
      } else {
        const d = await this._api('GET', `/merge_requests/${iid}/discussions?per_page=100`);
        for (const disc of d || []) {
          for (const note of disc.notes || []) {
            if (!(note.body || '').includes(AI_MARK)) continue;
            const pos = note.position || {};
            const line = pos.new_line || pos.new_start_line;
            if (pos.new_path && line) existing.add(`${pos.new_path}:${line}`);
          }
        }
      }
    } catch { /* 忽略, 视为无历史评论 */ }
    return existing;
  }

  /** 补全 GitLab 行级评论所需 sha(本地 git 计算) */
  async _resolveReviewShas(repoDir, review, mr) {
    const out = { head: review.head_sha || '', base: review.base_sha || '' };
    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) return out;
    const iid = review.mrId || mr.iid;
    try {
      if (!out.head) {
        // 优先 MR 远端 ref; 退化到源分支 HEAD
        if (!this.isGitea) {
          const r = await this._git(repoDir, ['rev-parse', '--verify', `refs/merge-requests/${iid}/head`]);
          out.head = r.ok ? r.stdout.trim() : '';
        } else {
          const r = await this._git(repoDir, ['rev-parse', '--verify', `refs/remotes/origin/pr/${iid}`]);
          out.head = r.ok ? r.stdout.trim() : '';
        }
        if (!out.head) {
          const src = mr.source_branch || review.srcBranch;
          if (src) {
            const r = await this._git(repoDir, ['log', '-1', '--format=%H', `origin/${src}`]);
            out.head = r.ok ? r.stdout.trim() : '';
          }
        }
      }
      if (!out.base && out.head) {
        const dst = mr.target_branch || review.dstBranch || 'main';
        const r = await this._git(repoDir, ['merge-base', `origin/${dst}`, out.head]);
        out.base = r.ok ? r.stdout.trim() : '';
      }
    } catch { }
    return out;
  }

  /** 提交审查结果回填:
   *  1) 有关联 MR → 回填到该 MR(行级评论, 作者在 MR 上可见)
   *  2) 无关联 MR → 回填到提交评论(GitLab commit comments / Gitea commit comments)
   */
  async postCommitComments(sha, review, log = () => {}) {
    try {
      if (!review || !(review.comments || []).length) return { ok: false, error: '没有可回填的评论' };
      // 1) 关联 MR 优先
      const rel = review.relatedMr;
      if (rel && rel.iid) {
        log(`提交属于 MR !${rel.iid}, 回填到该 MR ...`);
        const r = await this.postComments(rel.iid, log, { ...review, mrId: rel.iid });
        return { ok: r.ok, posted: r.posted || 0, viaMr: rel.iid, error: r.error };
      }
      // 2) 无关联 MR → 提交评论
      if (this.isGitea) {
        log('⚠️ Gitea 不支持提交级评论, 且该提交未关联开放 MR, 无法回填');
        return { ok: false, error: '该提交未关联开放 MR(Gitea 不支持提交评论回填), 请先审查关联 MR' };
      }
      log('该提交未关联 MR, 回填到提交评论 ...');
      const existing = await this._existingCommitAiComments(sha);
      const fresh = (review.comments || []).filter((c) => {
        const key = `${c.path}:${c.start_line}`;
        return !existing.has(key) && c.path && c.start_line;
      });
      log(`共 ${review.comments.length} 条, 去重跳过 ${review.comments.length - fresh.length} 条`);
      let posted = 0;
      for (const c of fresh) {
        const body = `🤖 AI 审查(${c.severity || ''} · ${c.category || ''})\n\n${c.contentZh || c.content || ''}${c.suggestion_code ? '\n\n建议修复:\n```\n' + c.suggestion_code + '\n```' : ''}`;
        try {
          if (!this.isGitea) {
            // GitLab: POST /repository/commits/:sha/comments (行级: note + path + line + line_type)
            await this._api('POST', `/repository/commits/${sha}/comments`, {
              note: body, path: c.path, line: c.start_line, line_type: 'new',
            });
          } else {
            // Gitea: POST /repos/{owner}/{repo}/git/commits/{sha}/comments? 走普通 commit 评论端点
            await this._api('POST', `/git/commits/${sha}/comments`, { body, path: c.path, line: c.start_line });
          }
          posted++;
        } catch (e) {
          log(`  回填失败(${c.path}:${c.start_line}): ${(e.message || '').slice(0, 100)}, 跳过`);
        }
      }
      log(`✅ 提交评论回填完成: ${posted} 条`);
      return { ok: true, posted, viaCommit: sha.slice(0, 8) };
    } catch (e) {
      return { ok: false, error: '提交评论回填异常: ' + (e.message || e) };
    }
  }

  /** 收集已回填的提交评论 key(path:line), 用于去重 */
  async _existingCommitAiComments(sha) {
    const set = new Set();
    try {
      let list = [];
      if (!this.isGitea) {
        list = await this._api('GET', `/repository/commits/${sha}/comments?per_page=100`);
      } else {
        list = await this._api('GET', `/git/commits/${sha}/comments?limit=100`);
      }
      for (const cm of Array.isArray(list) ? list : []) {
        if ((cm.body || cm.note || '').includes('🤖 AI 审查')) set.add(`${cm.path}:${cm.line ?? cm.start_line}`);
      }
    } catch { /* 忽略, 视为无历史评论 */ }
    return set;
  }

  /** 回填评论到 MR(带去重). 可传入 runReview 已得到的 comments 避免重复审查 */
  /** 清理脏审查记录(Gitea): 旧 bug 可能遗留引用本仓库不存在对象的 PENDING review, 会导致后续回填一致 LineBlame 500 */
  async _cleanDirtyReviews(iid) {
    if (!this.isGitea) return 0;
    let cleaned = 0;
    try {
      const reviews = await this._api('GET', `/pulls/${iid}/reviews`);
      for (const rv of reviews || []) {
        const cid = String(rv.commit_id || '');
        if (!cid || (rv.state || '').toUpperCase() !== 'PENDING') continue;
        const g = await this._git(this.config.repoDir, ['rev-parse', '--verify', cid]);
        if (g.ok) continue;   // 对象在本仓库 → 正常保留
        try {
          await this._api('DELETE', `/pulls/${iid}/reviews/${rv.id}`);
          this.log(`🧹 已清理脏审查记录 review#${rv.id}(提交 ${cid.slice(0, 8)} 不在本仓库)`);
          cleaned++;
        } catch { }
      }
    } catch { }
    return cleaned;
  }

  async postComments(iid, log = () => {}, existingReview = null) {
    try {
      const mr = await this.getMr(iid);
      // 回填前清理脏数据(避免 Gitea LineBlame 引用坏对象返回 500)
      if (this.isGitea) await this._cleanDirtyReviews(iid);
      const review = existingReview || await this.runReview(iid, log);
      if (!review.ok) return review;

      // 补全 GitLab 行级评论需要的真实 sha(base/head)
      const shas = await this._resolveReviewShas(this.config.repoDir, review, mr);
      if (shas.head) review.head_sha = review.head_sha || shas.head;
      if (shas.base) review.base_sha = review.base_sha || shas.base;
      if (review.head_sha && !review.base_sha) review.base_sha = review.head_sha;
      if (!review.base_sha) review.base_sha = review.head_sha;

      const comments = review.comments;
      const existing = await this._existingAiComments(iid);
      const fresh = comments.filter((c) => !existing.has(`${c.path}:${c.start_line}`));
      log(`共 ${comments.length} 条, 去重跳过 ${comments.length - fresh.length} 条`);

      if (fresh.length === 0) return { ok: true, posted: 0, message: '无新评论可回填(均已存在)' };

      if (this.isGitea) {
        // commit_id 用服务器最新 MR head(getMr), 避免用旧审查结果为别仓库/旧对象导致 LineBlame bad object
        const headSha = mr.sha || review.head_sha || '';
        if (!headSha) return { ok: false, error: '无法确定 MR 当前 head commit, 取消回填' };
        const payload = {
          body: `${AI_MARK}: 共 ${fresh.length} 条评论(自动生成)`,
          commit_id: headSha,
          event: 'COMMENT',
          comments: fresh.map((c) => ({
            body: `${AI_MARK} [${c.severity || 'info'} · ${c.category || ''}]\n\n${c.contentZh || c.content || ''}`,
            path: c.path,
            new_position: c.start_line,
          })),
        };
        await this._api('POST', `/pulls/${iid}/reviews`, payload);
      } else {
        for (const c of fresh) {
          const body = `${AI_MARK} [${c.severity || 'info'} · ${c.category || ''}]\n\n${c.contentZh || c.content || ''}`;
          try {
            await this._api('POST', `/merge_requests/${iid}/discussions`, {
              body,
              position: {
                base_sha: review.base_sha, start_sha: review.base_sha, head_sha: review.head_sha,
                position_type: 'text', new_path: c.path, new_line: c.start_line,
              },
            });
          } catch (e) {
            log(`  行内评论失败, 回退普通评论: ${e.message.slice(0, 80)}`);
            await this._api('POST', `/merge_requests/${iid}/notes`, { body });
          }
        }
      }
      return { ok: true, posted: fresh.length };
    } catch (e) {
      return { ok: false, error: '回填异常: ' + (e.message || e) };
    }
  }
}

// ---- 工具 ----
const OCR_BIN_NAME = 'opencodereview.exe';
/** 中文输出注入指令(实测有效: 让 ocr 的 LLM 直接输出简体中文评论) */
const ZH_BG_PROMPT = '你在对代码进行代码审查。所有审查评论必须使用简体中文撰写(变量名/函数名/API名/类型名等标识符保留英文), 每一条描述要清晰完整, 说明问题原因与影响。';

/** 便携配置目录: 客户端根目录下的 .opencodereview(内网随程序走, 无需每机手工配置) */
let _portableHome = null;
function ocrPortableHome() {
  if (!_portableHome) {
    _portableHome = path.join(__dirname, '..');   // backend/.. = 客户端根(dev: client/; 打包: resources/app.asar.unpacked/)
    try { fs.mkdirSync(path.join(_portableHome, '.opencodereview'), { recursive: true }); } catch { }
  }
  return _portableHome;
}

/** 首次使用便携配置时, 若有旧的主目录配置则复制过来(平滑迁移) */
function ensurePortableConfig() {
  try {
    const pc = path.join(ocrPortableHome(), '.opencodereview', 'config.json');
    if (fs.existsSync(pc)) return;
    const hc = path.join(process.env.USERPROFILE || require('os').homedir(), '.opencodereview', 'config.json');
    if (fs.existsSync(hc)) {
      fs.mkdirSync(path.dirname(pc), { recursive: true });
      fs.copyFileSync(hc, pc);
    }
  } catch { }
}

/** 优先定位 native exe(直接执行, 跳过 js 启动器); 找不到时回退 js wrapper */
function findOcrExe() {
  const exe = OCR_BIN_NAME;
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@alibaba-group', 'open-code-review', 'node_modules', '@alibaba-group', 'ocr-win32-x64', 'bin', exe),
    path.join(__dirname, '..', 'node_modules', '@alibaba-group', 'ocr-win32-x64', 'bin', exe),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'node_modules', '@alibaba-group', 'ocr-win32-x64', 'bin', exe),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'node_modules', '@alibaba-group', 'ocr-win32-x64', 'bin', exe),
  ];
  for (const c of candidates) {
    try {
      // 打包版: asarUnpack 解包路径转换
      const real = c.includes('app.asar' + path.sep) ? c.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : c;
      if (fs.existsSync(real)) return real;
      if (fs.existsSync(c)) return c;
    } catch { }
  }
  return null;
}

function findOcrJs() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', OCR_JS_NAME),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', OCR_JS_NAME),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', OCR_JS_NAME),
  ];
  for (const c of candidates) {
    try {
      // 打包版: ocr 被 asarUnpack 解包到 app.asar.unpacked, node 只能执行 unpacked 的真实路径
      const real = c.includes('app.asar' + path.sep) ? c.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : c;
      if (fs.existsSync(real)) return real;
      if (fs.existsSync(c)) return c;
    } catch { }
  }
  // 尝试 which ocr 解析
  return null;
}

let _activeChild = null;          // 当前正在运行的 ocr 子进程(供手动停止)
function stopActiveRun(log = () => {}) {
  if (!_activeChild || !_activeChild.pid) return false;
  try {
    _activeChild._stopReq = true;   // 标记: 本次退出为手动停止(供 runNode 回调识别)
    if (process.platform === 'win32') {
      // Windows: 必须杀整棵进程树(ocr.js → native opencodereview.exe 是子子进程), 否则管道不关, 审查 hang 住
      execFileSync('taskkill', ['/F', '/T', '/PID', String(_activeChild.pid)], { stdio: 'ignore' });
    } else {
      try { _activeChild.kill('SIGKILL'); } catch { }
    }
    log('⏹ 已发送停止信号(正在终止 ocr...)');
    return true;
  } catch (e) { return false; }
}

function runNode(ocrJs, args, cwd, model, timeoutMs) {
  return runChild(process.execPath !== 'electron' ? 'node' : findNodeExe(), [ocrJs, ...args], cwd, model, null, timeoutMs);
}

/** 把客户端的 LLM 配置(设置页)同步到 ocr 便携配置, 用户无需全局配置 ocr:
 *  provider 指向 app, custom_providers.app = {url=llmBaseUrl, api_key=llmApiKey, model=审查模型}
 *  仅同步到便携目录(客户端根/.opencodereview), 不改用户主目录全局配置
 */
function syncOcrConfig(cfg, log = () => {}) {
  try {
    const url = String((cfg && cfg.llmBaseUrl) || '').trim();
    if (!url) return false;                 // 客户端没配 API 地址 → 不动 ocr 配置
    const home = ocrPortableHome();
    const pc = path.join(home, '.opencodereview', 'config.json');
    let oc = {};
    try { oc = JSON.parse(fs.readFileSync(pc, 'utf8')); } catch { }
    const key = String((cfg && cfg.llmApiKey) || '').trim()
      || ((oc.custom_providers || {}).app || {}).api_key          // 保留已有 key
      || process.env.HERMES_CUSTOM_OPENCODE_API_KEY || '';        // 兜底环境变量
    const model = String((cfg && cfg.model) || '').trim() || 'deepseek-v4-flash';
    oc.provider = 'app';
    const app = { protocol: 'openai', url, model };
    if (key) app.api_key = key;
    oc.custom_providers = oc.custom_providers || {};
    oc.custom_providers.app = app;
    oc.llm = oc.llm || {};
    oc.llm.model = model;
    // 审查输出语言: 同步到 ocr 配置(中文时写 language, 不靠它但保持一致)
    const ocrLang = String((cfg && cfg.ocrLang) || 'auto').trim();
    if (ocrLang === 'zh') oc.language = 'zh-CN';
    else if ('language' in oc) delete oc.language;
    fs.mkdirSync(path.dirname(pc), { recursive: true });
    fs.writeFileSync(pc, JSON.stringify(oc, null, 2), 'utf-8');
    log(`🔄 ocr 配置已按客户端设置同步(provider=app, url 末尾 ${url.slice(-24)}, model=${model})`);
    return true;
  } catch (e) { return false; }
}

/** 从客户端配置解析 LLM 三元组(url/key/model), 供 exe 直接使用 */
function _llmVals(cfg) {
  const url = String((cfg && cfg.llmBaseUrl) || '').trim();
  const model = String((cfg && cfg.model) || '').trim() || 'deepseek-v4-flash';
  let key = String((cfg && cfg.llmApiKey) || '').trim();
  if (!key) {
    try {
      const pc = path.join(ocrPortableHome(), '.opencodereview', 'config.json');
      const oc = JSON.parse(fs.readFileSync(pc, 'utf8'));
      key = ((oc.custom_providers || {}).app || {}).api_key || '';
    } catch { }
  }
  if (!key) key = process.env.HERMES_CUSTOM_OPENCODE_API_KEY || '';
  return { url, model, key };
}

/** 直接执行 native opencodereview.exe(跳过 js 启动器). 配置目录 = 客户端根(exe 相对, 内网便携) */
function runNative(exePath, args, cwd, cfg, log = () => {}, timeoutMs = 60 * 60 * 1000) {
  ensurePortableConfig();
  syncOcrConfig(cfg, log);   // 审查前: 客户端 LLM 设置 → ocr 便携配置(双保险)
  const { url, model, key } = _llmVals(cfg);
  if (!url) log('⚠️ 未配置模型 API 地址(设置 → 模型服务 → API 地址), 请先填写并「保存全部设置」');
  const env = {
    ...process.env,
    // 关键: 覆盖主目录, 使 ocr 把配置写到便携目录(客户端根/.opencodereview), 随程序走
    USERPROFILE: ocrPortableHome(),
    HOME: ocrPortableHome().replace(/\\/g, '/'),
    // exe 官方认可的 LLM endpoint 三件套(报错信息亲述), 直接给, 不依赖 config 是否被读到
    OCR_LLM_URL: url,
    OCR_LLM_TOKEN: key,
    OCR_LLM_MODEL: model,
    OCR_MODEL: model,
    OCR_NO_UPDATE: '1',
  };
  return runChild(exePath, args, cwd, model, env, timeoutMs);
}

function runChild(binPath, args, cwd, model, _env, timeoutMs) {
  const tmo = timeoutMs || 30 * 60 * 1000;
  const tmin = Math.round(tmo / 60000);
  const tmoErr = `审查超时(超过 ${tmin} 分钟)已自动终止; 可在设置中调整「审查超时」、增大并发或拆小审查范围后重试`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const child = execFile(binPath, args, {
      cwd,
      maxBuffer: 128 * 1024 * 1024,
      timeout: tmo,                      // 审查上限(设置可调, 默认 60 分钟)
      env: _env || {
        ...process.env,
        OCR_MODEL: model || 'deepseek-v4-flash',
        OCR_NO_UPDATE: '1',          // 内网/离线环境跳过 ocr 更新检查, 避免启动卡网络
      },
    }, (err, stdout, stderr) => {
      if (err) {
        if (child._stopReq) {
          finish({ ok: false, stdout, stderr: stderr || '', error: '审查已手动停止', killed: true, stoppedByUser: true });
        } else if (err.killed || err.signal || /timeout|ETIMEDOUT/i.test(String(err.message || ''))) {
          // 系统/超时终止(不是手动停止)
          finish({ ok: false, stdout, stderr: stderr || '', error: tmoErr, killed: true, timedOut: true });
        } else {
          finish({ ok: false, stdout, stderr: stderr || '', error: String(err.message || '').slice(0, 500), killed: false });
        }
      } else finish({ ok: true, stdout, stderr });
    });
    _activeChild = child;
    child.on('exit', (code, signal) => {
      if (_activeChild === child) _activeChild = null;
      // 正常退出(code 0, 无 signal): 交给 execFile 回调收尾(会得到 ok:true)
      if (code === 0 && !signal) return;
      // 手动停止: 立即结束(回调可能因管道不关而不来)
      if (child._stopReq) {
        if (!done) finish({ ok: false, stderr: '', error: '审查已手动停止', killed: true, stoppedByUser: true });
        return;
      }
      // 超时终止: execFile timeout 杀进程(SIGTERM, 无退出码) → 明确提示超时
      if (signal === 'SIGTERM' && code === null) {
        if (!done) finish({ ok: false, stderr: '', error: tmoErr, killed: true, timedOut: true });
        return;
      }
      // 其它非正常退出(ocr 失败 code!=0 / 崩溃): 等回调带出 stderr 真实原因; 超时兜底
      setTimeout(() => {
        if (!done) finish({ ok: false, stderr: '', error: `进程非正常退出(signal: ${signal || '-'}, code: ${code})`, killed: !!signal, stoppedByUser: false });
      }, 8000);
    });
  });
}

function findNodeExe() {
  // Electron 打包环境: 优先用系统 node
  return process.env.ELECTRON_RUN_AS_NODE ? process.execPath : 'node';
}

module.exports = { ReviewBackend, findOcrJs };
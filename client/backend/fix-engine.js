// 自动修复引擎(M4 v3)
// 策略: 小文件(≤200行) → LLM 输出修复后完整文件, 程序直接写入(行号无关, 可靠)
//       大文件 → LLM 生成 unified diff + git apply --check 校验(失败自动重试一次)
// 输出: 本地 fix/ai/<base>-<tag> 分支, 每个问题一个 commit(不推送远端)
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const WHOLE_FILE_LIMIT = 200;

class FixEngine {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.llmBase = (config.llmBaseUrl || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
    this.llmKey = config.llmApiKey || process.env.HERMES_CUSTOM_OPENCODE_API_KEY || '';
    this.llmModel = config.fixModel || config.model || 'deepseek-v4-flash';
  }

  get repoDir() { return this.config.repoDir || ''; }

  _git(args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: this.repoDir, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || err || '').toString() }));
    });
  }

  /** 调用 LLM(OpenAI 兼容) */
  async _callLLM(system, user) {
    if (!this.llmKey) throw new Error('未配置 LLM API Key(环境变量 HERMES_CUSTOM_OPENCODE_API_KEY 或设置中 llmApiKey)');
    const resp = await fetch(this.llmBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.llmKey },
      body: JSON.stringify({ model: this.llmModel, temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error('LLM HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
    const data = await resp.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return text;
  }

  /** 从 LLM 输出提取代码块 */
  _extractCode(text) {
    const fence = text.match(/```(?:[\w+-]*)\n([\s\S]*?)```/);
    if (fence) return fence[1].replace(/\n+$/, '');
    return text.replace(/\n+$/, '');
  }

  /** 从 LLM 输出提取 unified diff 块 */
  _extractDiff(text) {
    const fence = text.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const m = raw.match(/(^|\n)(diff --git|---\s+\S+)/);
    if (m) return raw.slice(m.index + m[1].length);
    return null;
  }

  /** 内容相似度(旧文件关键行在新内容中的保留比例) */
  _similarity(oldContent, newContent) {
    const oldLines = oldContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (oldLines.length === 0) return 1;
    const newSet = new Set(newContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const kept = oldLines.filter((l) => newSet.has(l)).length;
    return kept / oldLines.length;
  }

  /** 校验新文件内容合理性 */
  _validateNewContent(oldContent, newContent) {
    if (!newContent.trim()) return { ok: false, reason: '输出为空' };
    const oldLines = oldContent.split(/\r?\n/);
    const newLines = newContent.split(/\r?\n/);
    if (newLines.length < oldLines.length * 0.5 || newLines.length > oldLines.length * 2.5) {
      return { ok: false, reason: `行数异常 ${oldLines.length} → ${newLines.length}` };
    }
    const sim = this._similarity(oldContent, newContent);
    if (sim < 0.75) return { ok: false, reason: `内容偏离过大(相似度 ${(sim * 100).toFixed(0)}%)` };
    if (sim >= 0.999) return { ok: false, reason: '内容无变化' };
    return { ok: true, sim };
  }

  /**
   * 执行自动修复
   * @param {object} review     runReview/runCommitReview 的结果
   * @param {string} baseBranch 基准: 普通分支名 或 "commit:<sha>"(从该提交建修复分支)
   */
  async runFix(review, baseBranch = 'main') {
    const issues = (review.comments || []).filter((c) => c.path && c.start_line);
    if (issues.length === 0) return { ok: false, error: '没有可修复的问题' };
    const repoDir = this.repoDir;
    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) return { ok: false, error: '仓库目录无效' };
    if (!this.llmKey) return { ok: false, error: '未配置 LLM API Key(需 HERMES_CUSTOM_OPENCODE_API_KEY)' };

    const fromCommit = String(baseBranch || '').startsWith('commit:');
    const commitSha = fromCommit ? baseBranch.slice(7) : '';
    const tag = review.mrId ? `mr-${review.mrId}` : (review.commitSha ? review.commitSha.slice(0, 8) : 'local');
    const fixBranch = fromCommit
      ? `fix/ai/commit-${commitSha.slice(0, 8)}`
      : `fix/ai/${baseBranch.replace(/^origin\//, '')}-${tag}`;
    this.log(`🛠 修复分支: ${fixBranch} (基于 ${fromCommit ? '提交 ' + commitSha.slice(0, 8) : baseBranch})`);

    // 1. 基础: commit 模式直接从该提交建分支; 分支模式切换到基准分支
    if (fromCommit) {
      const cr = await this._git(['checkout', '-b', fixBranch, commitSha]);
      if (!cr.ok) return { ok: false, error: `创建修复分支(基于提交)失败: ${cr.stderr.slice(0, 150)}` };
    } else {
      const baseLocal = baseBranch.replace(/^origin\//, '');
      const hasLocal = (await this._git(['rev-parse', '--verify', '--quiet', baseLocal])).ok;
      if (hasLocal) {
        const r1 = await this._git(['checkout', baseLocal]);
        if (!r1.ok) return { ok: false, error: `切换 ${baseLocal} 失败: ${r1.stderr.slice(0, 150)}` };
      } else {
        const remoteRef = baseLocal === baseBranch ? 'origin/' + baseBranch : baseBranch;
        this.log(`  本地无 ${baseLocal}, 从 ${remoteRef} 创建跟踪分支`);
        const cr = await this._git(['checkout', '-b', baseLocal, remoteRef]);
        if (!cr.ok) return { ok: false, error: `创建本地分支 ${baseLocal} 失败: ${cr.stderr.slice(0, 150)}` };
      }
    }
    const status = await this._git(['status', '--porcelain']);
    const dirty = status.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
    if (dirty.length) return { ok: false, error: '工作区有未提交改动, 请先提交或 stash' };

    // 2. 建/重置修复分支(commit 模式已建, 跳过)
    if (!fromCommit) await this._git(['checkout', '-B', fixBranch]);

    // 3. 逐问题修复并 commit
    const system = '你是资深工程师, 根据代码审查意见修复问题。只输出代码本身, 不要解释。保持原有缩进风格和语言。';
    const commits = [];
    let applied = 0, failed = 0;

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const fileRel = issue.path;
      const fileAbs = path.join(repoDir, fileRel);
      if (!fs.existsSync(fileAbs)) { this.log(`  ⏭ 文件不存在, 跳过: ${fileRel}`); failed++; continue; }
      try {
        const oldContent = fs.readFileSync(fileAbs, 'utf-8');
        const lineCount = oldContent.split(/\r?\n/).length;
        const start = issue.start_line, end = issue.end_line || issue.start_line;
        const detail =
          `文件: ${fileRel}\n问题(严重度 ${issue.severity || '?'}, 类别 ${issue.category || '?'}):\n${issue.content || ''}\n` +
          (issue.suggestion ? `\n修复建议:\n${issue.suggestion}\n` : '');

        let newContent = null, ok = false;
        this.log(`  🔧 修复 [${i + 1}/${issues.length}] ${fileRel}:${start}(${lineCount} 行, ${lineCount <= WHOLE_FILE_LIMIT ? '整文件模式' : 'diff 模式'})`);

        if (lineCount <= WHOLE_FILE_LIMIT) {
          // ---- 模式 A: 整文件重写(可靠) ----
          const lines = oldContent.split(/\r?\n/);
          const ctxStart = Math.max(0, start - 3), ctxEnd = Math.min(lines.length, end + 3);
          const ctx = lines.slice(ctxStart, ctxEnd).map((l, idx) => `${String(ctxStart + idx + 1).padStart(4)}| ${l}`).join('\n');
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            const userPrompt =
              `${detail}\n当前文件(共 ${lineCount} 行, 问题位于第 ${start}~${end} 行附近):\n'''\n${oldContent}\n'''\n` +
              `请输出修复后完整的 ${fileRel} 文件内容, 只修改与问题相关的部分, 其余部分逐字保留。不要解释, 不要用围栏之外的内容。`;
            const out = await this._callLLM(system, userPrompt);
            const candidate = this._extractCode(out);
            const v = this._validateNewContent(oldContent, candidate);
            if (v.ok) { newContent = candidate; ok = true; }
            else if (attempt === 0) this.log(`  ⚠ 校验不通过(${v.reason}), 重试一次...`);
          }
        } else {
          // ---- 模式 B: unified diff + git apply(大文件) ----
          const lines = oldContent.split(/\r?\n/);
          const ctxStart = Math.max(0, start - 5), ctxEnd = Math.min(lines.length, end + 5);
          const ctx = lines.slice(ctxStart, ctxEnd).map((l, idx) => `${String(ctxStart + idx + 1).padStart(4)}| ${l}`).join('\n');
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            const userPrompt =
              `${detail}\n当前文件该段代码(带行号, 第 ${ctxStart + 1}~${ctxEnd} 行):\n'''\n${ctx}\n'''\n` +
              `请生成修复此问题的 unified diff(含 --- 与 +++ 文件头), 目标行号围绕第 ${start}~${end} 行。只输出 diff。`;
            const out = await this._callLLM(system, userPrompt);
            let diff = this._extractDiff(out);
            if (!diff || !diff.trim()) { this.log('  ⏭ LLM 未输出 diff, 跳过'); break; }
            diff = diff.replace(/^\s+/, '');
            if (!/^---/.test(diff)) diff = `--- a/${fileRel}\n+++ b/${fileRel}\n` + diff;
            const patchFile = path.join(repoDir, '.ai-fix.patch');
            fs.writeFileSync(patchFile, diff, 'utf-8');
            const c = await this._git(['apply', '--check', patchFile]);
            if (c.ok) {
              const ap = await this._git(['apply', patchFile]);
              fs.unlinkSync(patchFile);
              if (ap.ok) { ok = true; newContent = fs.readFileSync(fileAbs, 'utf-8'); }
              else this.log(`  ⚠ 应用失败(${ap.stderr.slice(0, 60)})`);
            } else {
              fs.unlinkSync(patchFile);
              if (attempt === 0) this.log(`  ⚠ 补丁校验失败(${c.stderr.slice(0, 60)}), 重试一次...`);
            }
          }
        }

        if (!ok || newContent === null) { this.log('  ⏭ 修复未通过校验, 跳过该问题'); failed++; continue; }

        // 写入 + commit
        fs.writeFileSync(fileAbs, newContent, 'utf-8');
        const gadd = await this._git(['add', '-A']);
        if (!gadd.ok) { this.log('  ⚠ git add 失败'); failed++; continue; }
        const subject = `fix(ai): ${(issue.category || 'issue')} ${fileRel}:${start} ${(issue.content || '').replace(/\n/g, ' ').slice(0, 60)}`;
        const gcm = await this._git(['commit', '-m', subject]);
        if (!gcm.ok) { this.log('  ⚠ commit 失败: ' + gcm.stderr.slice(0, 100)); failed++; continue; }
        const sha = await this._git(['rev-parse', 'HEAD']);
        commits.push({ sha: sha.stdout.trim(), message: subject, issueId: i + 1 });
        applied++;
      } catch (e) {
        this.log(`  ⚠ 修复异常: ${e.message.slice(0, 150)}`);
        failed++;
      }
    }

    // 4. 推送修复分支到远端(设置「修复后推送远端」开启时)
    let pushed = false;
    if (this.config.autoPushFix && applied > 0) {
      this.log(`🚀 推送修复分支 ${fixBranch} 到远端...`);
      try {
        const pr = await this._git(['push', '-u', 'origin', fixBranch]);
        if (pr.ok) { pushed = true; this.log(`✅ 已推送: origin/${fixBranch}`); }
        else this.log(`⚠️ 推送失败: ${(pr.stderr || '').slice(0, 200)}`);
      } catch (e) { this.log(`⚠️ 推送异常: ${String(e.message || e).slice(0, 150)}`); }
    }

    return {
      ok: applied > 0,
      fixBranch, commits, applied, pushed,
      message: applied > 0
        ? (pushed
          ? `✅ 自动修复完成并已推送: origin/${fixBranch}, 应用 ${applied}/${issues.length} 个修复, ${commits.length} 个 commit(研发可 git fetch 后切分支修改)`
          : `✅ 自动修复完成: 分支 ${fixBranch}, 应用 ${applied}/${issues.length} 个修复, ${commits.length} 个 commit(仅本地, 未推送)`)
        : `❌ 未能应用任何修复(${failed} 个失败)`,
    };
  }
}

module.exports = { FixEngine };
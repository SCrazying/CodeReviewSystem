// 服务端 ocr 运行器(定时任务用)
// 复用 client 的 findOcrJs/runNode 逻辑, 服务端进程内直接调 ocr CLI
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function findOcrJs() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { }
  }
  return null;
}

/** 执行 ocr review, 返回 {ok, comments, summary} */
function runOcrReview(repoDir, from, to, model, apiKey, log = () => {}) {
  const ocrJs = findOcrJs();
  if (!ocrJs) return Promise.resolve({ ok: false, error: '服务端未安装 open-code-review' });
  return new Promise((resolve) => {
    log(`[scheduler] ocr review ${from} → ${to} ...`);
    const args = ['review', '--from', from, '--to', to, '--format', 'json'];
    const env = { ...process.env, OCR_MODEL: model || 'deepseek-v4-flash' };
    if (apiKey) env.HERMES_CUSTOM_OPENCODE_API_KEY = apiKey;
    execFile('node', [ocrJs, ...args], {
      cwd: repoDir, maxBuffer: 128 * 1024 * 1024, timeout: 15 * 60 * 1000, env,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 300) });
      try {
        const data = JSON.parse(stdout);
        const comments = (data.comments || []).filter((c) => c.path && c.start_line);
        resolve({ ok: true, comments, summary: data.summary || {} });
      } catch {
        resolve({ ok: false, error: 'ocr 输出解析失败' });
      }
    });
  });
}

module.exports = { runOcrReview, findOcrJs };
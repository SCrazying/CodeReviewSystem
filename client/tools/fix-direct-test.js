// v2 修复引擎直测(绕过 UI, 直接验证 diff 补头 + git apply 全流程)
const { FixEngine } = require('../backend/fix-engine');
const { execFile } = require('child_process');

const g = (args) => new Promise((res) => execFile('git', args, { cwd: 'D:/AI/github/dsh-desktop' }, (e, so) => res((so || '').toString())));

async function main() {
  // 用 PR#2 审查得到的评论(模拟 runReview 返回)
  const review = {
    ok: true,
    mrId: 2,
    srcBranch: 'feature/verify-fix',
    dstBranch: 'master',
    comments: [
      { path: 'verify_bug.js', start_line: 5, end_line: 7, severity: 'high', category: 'bug',
        content: '`name` will be `undefined` when `id` is not present in `users` — calling `.toUpperCase()` on `undefined` throws.' },
      { path: 'verify_bug.js', start_line: 14, end_line: 14, severity: 'low', category: 'maintainability',
        content: '`unused` is declared but never read or referenced anywhere in the file' },
    ],
  };

  const eng = new FixEngine({ repoDir: 'D:/AI/github/dsh-desktop' }, (m) => console.log('  ' + m));
  console.log('1. 执行 runFix ...');
  const r = await eng.runFix(review, 'feature/verify-fix');
  console.log('2. 结果:', JSON.stringify({ ok: r.ok, fixBranch: r.fixBranch, applied: r.applied, commits: (r.commits || []).length, msg: (r.message || '').slice(0, 90) }));

  if (r.ok) {
    console.log('3. commit 链:');
    const log = await g(['log', '--oneline', r.fixBranch, '-4']);
    console.log(log.trim().split('\n').map((l) => '   ' + l).join('\n'));
    console.log('4. 修复后 verify_bug.js:');
    const content = await g(['show', r.fixBranch + ':verify_bug.js']);
    console.log(content);
  } else {
    console.log('3. 失败, 检查 git status 残留:');
    const st = await g(['status', '--porcelain']);
    console.log('   ' + (st.trim() || '(干净)'));
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
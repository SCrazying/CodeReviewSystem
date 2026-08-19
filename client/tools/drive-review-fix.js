// 驱动: 选待合入 MR → 审查 → 完成后自动修复(含推送) — 全程读 UI
async function main() {
  const port = 9282;
  let ws = null;
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = l.find((t) => t.type === 'page');
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); break; }
    } catch { }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!ws) { console.log('CDP 不可达'); process.exit(1); }
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr, w = 0) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); const v = r.result ? r.result.result.value : null; if (w) await new Promise((rr) => setTimeout(rr, w)); return v; };

  // 等 MR 列表就绪 → 选中第一个待合入 MR
  let mrTitle = null;
  for (let i = 0; i < 40; i++) {
    mrTitle = await evalJs(`(() => { const items = document.querySelectorAll('#mr-list .mr-item'); if (!items.length) return null; const t = items[0].querySelector('.t').textContent.trim(); items[0].click(); return t; })()`);
    if (mrTitle) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('选中 MR:', mrTitle || '(无待合入 MR)');
  if (!mrTitle) process.exit(1);

  // 触发审查
  await evalJs("document.getElementById('btn-review').onclick(); 'ok'", 500);
  console.log('审查已触发, 等待完成(日志轮询)...');
  // 轮询等待"审查完成" 或 失败
  let status = '';
  for (let i = 0; i < 240; i++) {
    status = await evalJs(`(() => { const t = document.getElementById('st-time') ? (document.getElementById('status') ? '' : '') : ''; const st = document.getElementById('conn-text') ? document.getElementById('conn-text').textContent : ''; const logs = document.querySelectorAll('#log-area div'); const last = Array.from(logs).slice(-3).map(d => d.textContent).join(' | '); return st + ' :: ' + last; })()`);
    if (/审查完成/.test(status) || /审查失败/.test(status) || /停止/.test(status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const lastLog = await evalJs(`Array.from(document.querySelectorAll('#log-area div')).slice(-6).map(d => d.textContent).join('\\n')`);
  console.log('--- 审查日志尾 ---');
  console.log(lastLog);

  // 若有评论 → 自动修复
  const stats = await evalJs(`JSON.stringify({ all: document.getElementById('st-all') ? document.getElementById('st-all').textContent : '?' , fix: document.getElementById('btn-fix').disabled })`);
  console.log('审查统计:', stats);
  const fixDisabled = await evalJs("document.getElementById('btn-fix').disabled");
  if (fixDisabled) { console.log('无评论可修复(btn-fix disabled)'); process.exit(0); }

  console.log('触发自动修复...');
  await evalJs("document.getElementById('btn-fix').onclick(); 'ok'", 500);
  let fixDone = '';
  for (let i = 0; i < 240; i++) {
    const logs = await evalJs(`Array.from(document.querySelectorAll('#log-area div')).slice(-3).map(d => d.textContent).join(' | ')`);
    if (/修复完成|修复失败|已推送|fix branch|fix\/ai/i.test(logs)) { fixDone = logs; break; }
    await new Promise((r) => setTimeout(r, 2500));
  }
  const fixTail = await evalJs(`Array.from(document.querySelectorAll('#log-area div')).slice(-8).map(d => d.textContent).join('\\n')`);
  console.log('--- 修复日志尾 ---'); console.log(fixTail || '(无日志)');
  process.exit(0);
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
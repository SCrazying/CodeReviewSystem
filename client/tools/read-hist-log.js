async function main() {
  const l = await (await fetch('http://127.0.0.1:9283/json/list')).json();
  const p = l.find((t) => t.type === 'page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  const s = (e) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); });
  await new Promise((r) => setTimeout(r, 25000));
  const logs = await s(`Array.from(document.querySelectorAll('#log-area div')).slice(-12).map(d => d.textContent).join('\n')`);
  console.log(logs);
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
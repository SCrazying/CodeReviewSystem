// CDP 截图: 设置页(浅色主题)
const fs = require('fs');
async function main() {
  const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const p = l.find((t) => t.type === 'page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1 && m.result && m.result.result) {
      const b64 = m.result.result.data;
      fs.writeFileSync('C:/Users/nil/AppData/Local/hermes/scripts/crt_shot.png', Buffer.from(b64, 'base64'));
      console.log('截图已保存, 大小:', Math.round(b64.length * 0.75 / 1024) + 'KB');
      process.exit(0);
    }
  };
  // 确保设置页打开
  ws.send(JSON.stringify({ id: 0, method: 'Runtime.evaluate', params: { expression: "document.getElementById('btn-settings').click()" } }));
  setTimeout(() => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })), 600);
  setTimeout(() => { console.log('超时'); process.exit(1); }, 8000);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
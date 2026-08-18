// 每日进入卡控 + 服务端心跳
// 规则: 每次应用启动时执行一次服务端心跳校验; 成功 → 记录"今天已授权"(gate.json 存日期),
//       当天内存即可用; 失败/离线 → 当日审查功能禁用。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 超级管理员密码哈希(sha256, 不存明文)
const ADMIN_PWD_HASH = '0a0102264839607b664d4e61bafc654ed22f1c2b74092d0da6f1eec5e7751ea7';

class AuthGate {
  constructor(gateFile, log = () => {}) {
    this.gateFile = gateFile;
    this.log = log;
    this.authorized = false;      // 当前进程内是否已授权
    this.adminAuthorized = false; // 超级管理员授权
    this.lastError = '';
  }

  _read() {
    try { return JSON.parse(fs.readFileSync(this.gateFile, 'utf-8')); }
    catch { return { date: '' }; }
  }

  _today() {
    const d = new Date();
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 验证超级管理员密码(通过后永久免服务端验证, 除非手动注销) */
  verifyAdmin(password) {
    const hash = crypto.createHash('sha256').update(String(password || '')).digest('hex');
    if (hash !== ADMIN_PWD_HASH) {
      this.lastError = '超级管理员密码错误';
      return { ok: false, error: this.lastError };
    }
    this.authorized = true;
    this.adminAuthorized = true;
    try { fs.writeFileSync(this.gateFile, JSON.stringify({ date: this._today(), admin: true }), 'utf-8'); } catch { }
    this.log('🔐 超级管理员授权通过, 永久免服务端验证');
    return { ok: true, admin: true };
  }

  /** 注销超级管理员(回到服务端验证模式) */
  revokeAdmin() {
    this.adminAuthorized = false;
    this.authorized = false;
    try { fs.writeFileSync(this.gateFile, JSON.stringify({ date: '' }), 'utf-8'); } catch { }
    this.log('🔐 超级管理员已注销, 恢复服务端验证');
    return { ok: true };
  }

  /** 本地是否已记录今日授权(避免同一天重复请求服务端) */
  isGrantedToday() {
    return this._read().date === this._today();
  }

  _grant() {
    this.authorized = true;
    try { fs.writeFileSync(this.gateFile, JSON.stringify({ date: this._today() }), 'utf-8'); } catch { }
    this.log('✅ 今日授权已记录');
  }

  _revoke() {
    this.authorized = false;
    this.log('🛑 今日未授权: ' + this.lastError);
  }

  /** 服务端心跳 */
  async _heartbeat(baseUrl, token) {
    if (!baseUrl || !token) throw new Error('未配置服务端地址/Token');
    const url = baseUrl.replace(/\/+$/, '') + '/api/auth/heartbeat';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-Client-Token': token },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 401) throw new Error('客户端 Token 未授权, 请先到服务端管理后台创建');
    if (!resp.ok) throw new Error('心跳失败 HTTP ' + resp.status);
    return resp.json();
  }

  /** 每日进入卡控: 应用启动时调用一次 */
  async checkDaily(baseUrl, token) {
    const rec = this._read();
    // 超级管理员授权(永久): 不受日期限制, 除非手动注销
    if (rec.admin) {
      this.authorized = true;
      this.adminAuthorized = true;
      this.log('🔐 超级管理员已授权(本地记录), 免服务端验证');
      return { ok: true, cached: true, admin: true };
    }
    if (rec.date === this._today()) {
      // 今天已经授权过(包体重启/多次启动), 直接用; 不再请求服务端
      this.authorized = true;
      this.log('✅ 今日已授权(本地记录), 进入软件');
      return { ok: true, cached: true };
    }
    try {
      await this._heartbeat(baseUrl, token);
      this._grant();
      return { ok: true, cached: false };
    } catch (e) {
      this.lastError = e.message;
      this._revoke();
      return { ok: false, error: e.message };
    }
  }

  /** 审查前调用: 未授权则拒绝 */
  requireAuthorized() {
    if (!this.authorized) {
      return { ok: false, error: '今日未通过服务端授权, 审查功能已禁用。请连接服务端并在设置中配置正确的 Token。' };
    }
    return { ok: true };
  }
}

module.exports = { AuthGate };
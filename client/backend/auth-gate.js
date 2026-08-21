// 每日进入卡控 + 服务端心跳
// 规则: 每次应用启动时执行一次服务端心跳校验; 成功 → 记录"今天已授权"(gate.json 存日期),
//       当天内存即可用; 失败/离线 → 当日审查功能禁用。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 超级管理员凭据: 旧版为无盐 sha256 常量(源码公开即等于泄露)。
// 现改为 PBKDF2 加盐, 凭据存本地 gate.json; 首次用旧口令登录成功后自动升级,
// 升级后源码常量通道关闭(legacy:false), 源码泄露不再等于口令泄露。
const ADMIN_PWD_LEGACY_SHA256 = '0a0102264839607b664d4e61bafc654ed22f1c2b74092d0da6f1eec5e7751ea7';
const PBKDF2_ITERS = 120000;

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
    const rec = this._read();
    const pwd = String(password || '');
    let ok = false;
    if (rec.adminHash && rec.adminSalt) {
      // 新格式: PBKDF2 加盐 + 恒定时间比较
      const h = crypto.pbkdf2Sync(pwd, rec.adminSalt, PBKDF2_ITERS, 32, 'sha256').toString('hex');
      try { ok = crypto.timingSafeEqual(Buffer.from(h), Buffer.from(rec.adminHash)); } catch { ok = false; }
    } else if (rec.legacy !== false) {
      // 旧格式: 仅在未迁移前接受一次内置哈希(成功后立即升级并关闭该通道)
      ok = crypto.createHash('sha256').update(pwd).digest('hex') === ADMIN_PWD_LEGACY_SHA256;
    }
    if (!ok) {
      this.lastError = '超级管理员密码错误';
      return { ok: false, error: this.lastError };
    }
    this.authorized = true;
    this.adminAuthorized = true;
    // 写入加盐凭据并关闭旧哈希通道
    try {
      const salt = crypto.randomBytes(16).toString('hex');
      const h2 = crypto.pbkdf2Sync(pwd, salt, PBKDF2_ITERS, 32, 'sha256').toString('hex');
      fs.writeFileSync(this.gateFile, JSON.stringify({ date: this._today(), admin: true, adminSalt: salt, adminHash: h2, legacy: false }), 'utf-8');
    } catch { }
    this.log('🔐 超级管理员授权通过(已升级为加盐凭据), 永久免服务端验证');
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
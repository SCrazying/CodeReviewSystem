// 本地缓存 + 上报队列
// 审查/修复/用量记录先写本地 JSONL, 连上服务端后批量推送; 推送失败保留待重传
const fs = require('fs');
const path = require('path');

const MAX_QUEUE = 5000;

class ReportQueue {
  constructor(queueFile, log = () => {}, maxRetries = 3) {
    this.queueFile = queueFile;
    this.log = log;
    this.maxRetries = maxRetries;
    this.failedConsecutive = 0;   // 连续失败次数
    this.paused = false;          // 达到上限后暂停自动推送
    this.lastError = '';
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  }

  /** 更新重试上限(设置变更时) */
  setMaxRetries(n) {
    this.maxRetries = Number(n) > 0 ? Number(n) : 3;
    if (this.failedConsecutive < this.maxRetries) this.paused = false;
  }

  /** 手动重置(用户点推送/卡控通过) */
  resetFailure() {
    this.failedConsecutive = 0;
    this.paused = false;
  }

  /**
   * 推送全部待传记录到服务端
   * 连续失败达到 maxRetries 后暂停自动推送(手动 forceFlush 可强制重试)
   * @returns {{posted:number, remaining:number, paused:boolean, error?:string}}
   */
  async flush(baseUrl, token, { force = false } = {}) {
    if (this.paused && !force) {
      this.log(`⏸️ 已暂停自动推送(连续失败 ${this.failedConsecutive} 次, 达到上限 ${this.maxRetries}), 请手动点「📤 推送」重试`);
      return { posted: 0, remaining: this.pendingCount(), paused: true };
    }
    if (!baseUrl || !token) {
      this.failedConsecutive++;
      this.lastError = '未配置服务端地址/Token';
      if (this.failedConsecutive >= this.maxRetries) this.paused = true;
      return { posted: 0, remaining: this.pendingCount(), paused: this.paused, error: this.lastError };
    }
    if (!fs.existsSync(this.queueFile)) return { posted: 0, remaining: 0, paused: this.paused };
    const lines = fs.readFileSync(this.queueFile, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 0) return { posted: 0, remaining: 0, paused: this.paused };
    const base = baseUrl.replace(/\/+$/, '');
    let posted = 0;
    const remaining = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const ok = await this._pushOne(base, token, rec);
        if (ok) posted++;
        else remaining.push(line);
      } catch (e) {
        this.lastError = e.message;
        remaining.push(line);
      }
    }
    fs.writeFileSync(this.queueFile, remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf-8');
    if (remaining.length === 0) {
      // 全部推成功: 重置失败计数
      this.failedConsecutive = 0;
      this.paused = false;
      this.log(`📤 已推送全部 ${posted} 条到服务端`);
      return { posted, remaining: 0, paused: false };
    }
    // 有失败: 连续失败计数(仅自动重试累计; 手动 force 不累计, 也不触发暂停)
    if (!force) {
      this.failedConsecutive++;
      this.lastError = '服务端不可达或未授权';
      if (this.failedConsecutive >= this.maxRetries) {
        this.paused = true;
        this.log(`⏸️ 连续推送失败 ${this.failedConsecutive}/${this.maxRetries} 次, 已暂停自动推送(点「📤 推送」可手动重试)`);
      } else {
        this.log(posted > 0
          ? `📤 已推送 ${posted} 条, 剩余 ${remaining.length} 条(连续失败 ${this.failedConsecutive}/${this.maxRetries})`
          : `⏳ 暂时无法推送(剩余 ${remaining.length} 条, 连续失败 ${this.failedConsecutive}/${this.maxRetries})`);
      }
    } else {
      this.log(`📤 手动推送: 成功 ${posted} 条, 剩余 ${remaining.length} 条`);
    }
    return { posted, remaining: remaining.length, paused: this.paused, error: this.lastError };
  }

  /** 入队一条记录 {type, payload} */
  enqueue(record) {
    try {
      let lines = [];
      if (fs.existsSync(this.queueFile)) {
        lines = fs.readFileSync(this.queueFile, 'utf-8').split('\n').filter(Boolean);
      }
      lines.push(JSON.stringify(record));
      if (lines.length > MAX_QUEUE) lines = lines.slice(lines.length - MAX_QUEUE);
      fs.writeFileSync(this.queueFile, lines.join('\n') + '\n', 'utf-8');
      this.log(`📥 记录已本地缓存(${lines.length}/${MAX_QUEUE}): ${record.type}/${record.payload.targetId || record.payload.reviewId || ''}`);
    } catch (e) {
      this.log('⚠️ 本地缓存写入失败: ' + e.message);
    }
  }

  pendingCount() {
    try {
      if (!fs.existsSync(this.queueFile)) return 0;
      return fs.readFileSync(this.queueFile, 'utf-8').split('\n').filter(Boolean).length;
    } catch { return 0; }
  }


  async _pushOne(base, token, rec) {
    const pathMap = { review: '/api/reviews', fix: '/api/fixes', usage: '/api/usage' };
    const p = pathMap[rec.type];
    if (!p) return true;
    const resp = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Token': token },
      body: JSON.stringify(rec.payload),
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok;
  }
}

module.exports = { ReportQueue };
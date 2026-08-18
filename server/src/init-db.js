// 初始化数据库: 执行 db/schema.sql
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
  console.log('执行 schema.sql ...');
  await pool.query(sql);
  console.log('✅ 表结构就绪');

  // 初始化 LLM 配置行(如不存在)
  const r = await pool.query('SELECT 1 FROM llm_config WHERE id=1');
  if (r.rowCount === 0) {
    const { config } = require('./db');
    await pool.query(
      'INSERT INTO llm_config (id, provider, base_url, api_key, model, price_in, price_out) VALUES (1,$1,$2,$3,$4,$5,$6)',
      [config.llm.provider, config.llm.baseUrl, config.llm.apiKey, config.llm.model, config.llm.priceIn, config.llm.priceOut]
    );
    console.log('✅ LLM 配置行已初始化');
  }
  process.exit(0);
}

main().catch((e) => { console.error('初始化失败:', e.message); process.exit(1); });
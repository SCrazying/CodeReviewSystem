// 初始化管理员账号: npm run init-admin [username] [password]
const bcrypt = require('bcryptjs');
const { pool, config } = require('./db');

async function main() {
  const username = process.argv[2] || config.adminInitial.username || 'admin';
  const password = process.argv[3] || config.adminInitial.password || 'admin123';
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
    [username, hash]
  );
  console.log(`✅ 管理员 ${username} 已就绪 (id=${r.rows[0].id}), 密码: ${password}`);
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
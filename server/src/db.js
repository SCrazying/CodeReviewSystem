// 数据库连接池
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const config = loadConfig();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
  } catch (e) {
    return { port: 3001, pg: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'codereview' } };
  }
}

const pool = new Pool(config.pg);

module.exports = { pool, config };
@echo off
REM CodeReviewSystem 服务端一键启动 (参考 PM 单机部署)
chcp 65001 >nul
cd /d %~dp0

echo ==========================================
echo   CodeReviewSystem 服务端一键启动
echo ==========================================

echo [1/4] 检查依赖...
if not exist node_modules (
  echo   安装依赖当中, 请稍候...
  call npm install --omit=dev
)

echo [2/4] 检查数据库并建表...
where node.exe >nul 2>&1 || (echo   [错误] 找不到 node.exe, 请先安装 Node.js 18+ & pause & exit /b 1)
node src\init-db.js

echo [3/4] 初始化管理员(admin / admin123, 可后改)...
node src\init-admin.js

echo [4/4] 启动服务端...
echo   管理后台: http://127.0.0.1:3001/
echo   健康检查: http://127.0.0.1:3001/api/health
echo   按 Ctrl+C 停止
echo ------------------------------------------
node src\index.js

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动像素词汇农场...
echo 教师端: http://127.0.0.1:8000
echo 学生端: http://本机局域网IP:8000
python server.py --host 0.0.0.0 --port 8000
pause

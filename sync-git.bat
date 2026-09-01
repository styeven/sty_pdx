@echo off
chcp 65001 >nul
rem ============================================================
rem  智能配电箱看板：一键同步脚本（SVN 提交 + git 推送）
rem  【2026-09-01 新增】SVN 是公司版本库主源；git 推送到远程仓库
rem   用于触发 Coolify 自动部署。两者互为镜像，每次改动后运行本脚本即可。
rem  用法：
rem     sync-git.bat            （默认提交信息：当前日期时间）
rem     sync-git.bat "提交说明" （自定义提交信息）
rem ============================================================
setlocal
set "PROJ=E:\0、企业项目\5、塘下-数智新能\0、项目\3、智能配电箱\系统平台AI"
set "MSG=%~1"
if "%MSG%"=="" set "MSG=%date:~0,4%-%date:~5,2%-%date:~8,2% %time:~0,8% 更新"

cd /d "%PROJ%" || (echo [错误] 项目目录不存在 & pause & exit /b 1)

echo [1/4] SVN 添加新文件...
svn add --force . >nul 2>&1

echo [2/4] SVN 提交...
svn commit -m "%MSG%"
if errorlevel 1 (
  echo [提示] SVN 无改动或提交失败，继续执行 git 同步...
)

echo [3/4] git 提交...
git add -A
git commit -m "%MSG%"
if errorlevel 1 echo [提示] git 无改动，继续推送...

echo [4/4] git 推送（触发 Coolify 自动部署）...
git push origin main

echo.
echo ===== 同步完成 =====
pause

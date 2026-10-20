#!/usr/bin/env bash
# 统一入口：固定 8083，test-web 底座（菜单/高亮/LSP 正常）+ 中文注入 + 空工作区
exec "$(dirname "$0")/run-web-zh.sh"

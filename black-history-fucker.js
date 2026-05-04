// ==UserScript==
// @name         B站评论批量删除工具（aicu数据 · 手动输入凭证）
// @namespace    https://space.bilibili.com/
// @version      1.1
// @description  在个人主页手动输入 bili_jct 和 SESSDATA，粘贴aicu导出的评论JSON，筛选并批量删除自己的评论
// @author       You
// @match        https://space.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // 封装删除请求（使用手动输入的SESSDATA）
    function deleteReply(reply, csrf, sessdata) {
        return new Promise((resolve, reject) => {
            const type = reply.dyn.type;
            const oid = reply.dyn.oid;
            const rpid = reply.rpid;
            const data = `type=${type}&oid=${oid}&rpid=${rpid}&csrf=${csrf}`;

            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.bilibili.com/x/v2/reply/del',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': `SESSDATA=${sessdata}`
                    // 只带 SESSDATA
                },
                data: data,
                responseType: 'json',
                onload: function(res) {
                    const json = res.response;
                    if (json && json.code === 0) {
                        resolve({ rpid, success: true });
                    } else {
                        reject({ rpid, code: json?.code, message: json?.message || '未知错误' });
                    }
                },
                onerror: function(err) {
                    reject({ rpid, error: err });
                },
                ontimeout: function() {
                    reject({ rpid, error: '请求超时' });
                }
            });
        });
    }

    // 延迟函数
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 添加样式
    GM_addStyle(`
        #bili-batch-del-panel {
            position: fixed;
            top: 60px;
            right: 20px;
            width: 420px;
            max-height: 85vh;
            background: #fff;
            box-shadow: 0 0 15px rgba(0,0,0,0.3);
            border-radius: 8px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            font-family: 'Microsoft YaHei', sans-serif;
        }
        #bili-batch-del-header {
            padding: 10px 15px;
            background: #00a1d6;
            color: #fff;
            border-radius: 8px 8px 0 0;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        #bili-batch-del-header h4 {
            margin: 0;
            font-size: 16px;
            font-weight: normal;
        }
        #bili-batch-del-close {
            background: none;
            border: none;
            color: #fff;
            font-size: 20px;
            cursor: pointer;
            line-height: 1;
        }
        #bili-batch-del-body {
            padding: 10px;
            overflow-y: auto;
            flex: 1;
        }
        #bili-batch-del-credential {
            margin-bottom: 8px;
        }
        #bili-batch-del-credential input {
            width: 100%;
            box-sizing: border-box;
            padding: 4px 6px;
            margin-bottom: 4px;
            font-size: 13px;
            border: 1px solid #ccc;
            border-radius: 4px;
        }
        #bili-batch-del-input {
            width: 100%;
            height: 80px;
            box-sizing: border-box;
            margin-bottom: 8px;
            resize: vertical;
        }
        #bili-batch-del-actions {
            margin-bottom: 10px;
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        #bili-batch-del-actions button {
            padding: 4px 10px;
            font-size: 13px;
            cursor: pointer;
            border: 1px solid #ccc;
            background: #f4f4f4;
            border-radius: 4px;
        }
        #bili-batch-del-actions button:hover {
            background: #e0e0e0;
        }
        #bili-batch-del-actions button.danger {
            background: #ff6d6d;
            color: #fff;
            border-color: #ff6d6d;
        }
        #bili-batch-del-list {
            max-height: 300px;
            overflow-y: auto;
            border: 1px solid #eee;
            padding: 5px;
            border-radius: 4px;
        }
        .reply-item {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            padding: 4px 0;
            border-bottom: 1px solid #f5f5f5;
            font-size: 13px;
        }
        .reply-item input[type="checkbox"] {
            margin-top: 2px;
        }
        .reply-content {
            flex: 1;
            word-break: break-all;
        }
        .reply-info {
            color: #999;
            font-size: 11px;
            margin-top: 2px;
        }
        #bili-batch-del-status {
            margin-top: 8px;
            color: #666;
            font-size: 13px;
            min-height: 20px;
        }
        .note {
            font-size: 11px;
            color: #999;
            margin: 2px 0 6px 0;
        }
    `);

    // 主脚本
    window.addEventListener('load', function() {
        if (!window.location.pathname.startsWith('/')) return;
        if (!document.querySelector('#bili-batch-del-panel')) {
            createPanel();
        }
    });

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'bili-batch-del-panel';
        panel.innerHTML = `
            <div id="bili-batch-del-header">
                <h4>批量删除评论工具</h4>
                <button id="bili-batch-del-close">&times;</button>
            </div>
            <div id="bili-batch-del-body">
                <div id="bili-batch-del-credential">
                    <input type="text" id="cred-jct" placeholder="输入 bili_jct (CSRF Token)">
                    <input type="text" id="cred-sessdata" placeholder="输入 SESSDATA">
                    <div class="note">凭证可在浏览器 Cookie 中查看（登录后按 F12 → 应用程序 → Cookie）</div>
                </div>
                <textarea id="bili-batch-del-input" placeholder="在此粘贴从aicu导出的JSON数据..."></textarea>
                <div id="bili-batch-del-actions">
                    <button id="btn-load">加载评论</button>
                    <button id="btn-select-all">全选</button>
                    <button id="btn-invert">反选</button>
                    <button id="btn-delete" class="danger">删除选中</button>
                </div>
                <div id="bili-batch-del-list"></div>
                <div id="bili-batch-del-status"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // 拖拽功能
        const header = document.getElementById('bili-batch-del-header');
        let isDragging = false, startX, startY, offsetX, offsetY;
        header.addEventListener('mousedown', function(e) {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            offsetX = startX - rect.left;
            offsetY = startY - rect.top;
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onDragEnd);
        });
        function onDrag(e) {
            if (!isDragging) return;
            panel.style.left = (e.clientX - offsetX) + 'px';
            panel.style.top = (e.clientY - offsetY) + 'px';
            panel.style.right = 'auto';
        }
        function onDragEnd() {
            isDragging = false;
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', onDragEnd);
        }

        // 关闭按钮
        document.getElementById('bili-batch-del-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        // 逻辑
        let replies = [];
        const listDiv = document.getElementById('bili-batch-del-list');
        const statusDiv = document.getElementById('bili-batch-del-status');
        const inputJct = document.getElementById('cred-jct');
        const inputSessdata = document.getElementById('cred-sessdata');

        function renderList() {
            listDiv.innerHTML = '';
            if (!replies.length) {
                listDiv.innerHTML = '<div style="text-align:center;color:#999;">暂无评论数据</div>';
                return;
            }
            replies.forEach((reply, index) => {
                const timeStr = new Date(reply.time * 1000).toLocaleString();
                const msg = reply.message.length > 50 ? reply.message.substring(0, 50) + '...' : reply.message;
                const item = document.createElement('div');
                item.className = 'reply-item';
                item.innerHTML = `
                    <input type="checkbox" data-index="${index}">
                    <div class="reply-content">
                        <div>${msg}</div>
                        <div class="reply-info">
                            rpid:${reply.rpid} | ${timeStr} | 类型:${reply.dyn.type} oid:${reply.dyn.oid}
                        </div>
                    </div>
                `;
                listDiv.appendChild(item);
            });
        }

        function getSelectedReplies() {
            const checks = listDiv.querySelectorAll('input[type="checkbox"]:checked');
            return Array.from(checks).map(cb => replies[parseInt(cb.dataset.index)]);
        }

        document.getElementById('btn-load').addEventListener('click', () => {
            const raw = document.getElementById('bili-batch-del-input').value.trim();
            if (!raw) {
                statusDiv.textContent = '请粘贴JSON数据';
                return;
            }
            let data;
            try {
                data = JSON.parse(raw);
            } catch (e) {
                statusDiv.textContent = 'JSON解析失败：' + e.message;
                return;
            }
            if (data.code !== 0 || !data.data || !Array.isArray(data.data.replies)) {
                statusDiv.textContent = '数据格式不正确，请确认是aicu导出的完整JSON';
                return;
            }
            replies = data.data.replies;
            renderList();
            statusDiv.textContent = `已加载 ${replies.length} 条评论`;
        });

        document.getElementById('btn-select-all').addEventListener('click', () => {
            const checks = listDiv.querySelectorAll('input[type="checkbox"]');
            checks.forEach(cb => cb.checked = true);
        });

        document.getElementById('btn-invert').addEventListener('click', () => {
            const checks = listDiv.querySelectorAll('input[type="checkbox"]');
            checks.forEach(cb => cb.checked = !cb.checked);
        });

        document.getElementById('btn-delete').addEventListener('click', async () => {
            const selected = getSelectedReplies();
            if (selected.length === 0) {
                statusDiv.textContent = '请先选择要删除的评论';
                return;
            }
            const csrf = inputJct.value.trim();
            const sessdata = inputSessdata.value.trim();
            if (!csrf || !sessdata) {
                statusDiv.textContent = '请填写 bili_jct 和 SESSDATA 后再删除';
                return;
            }

            // 确认删除
            if (!confirm(`确定要删除选中的 ${selected.length} 条评论吗？此操作不可恢复。`)) {
                return;
            }

            const deleteBtn = document.getElementById('btn-delete');
            deleteBtn.disabled = true;
            deleteBtn.textContent = '删除中...';
            statusDiv.textContent = `正在删除 0 / ${selected.length} ...`;

            let successCount = 0;
            let failCount = 0;
            const failMessages = [];

            for (let i = 0; i < selected.length; i++) {
                const reply = selected[i];
                try {
                    await deleteReply(reply, csrf, sessdata);
                    successCount++;
                } catch (err) {
                    failCount++;
                    failMessages.push(`rpid:${err.rpid} - 错误码:${err.code || '网络错误'} ${err.message || err.error || ''}`);
                }
                statusDiv.textContent = `正在删除 ${i+1} / ${selected.length} ... 成功:${successCount} 失败:${failCount}`;
                await delay(300); // 温和延迟
            }

            deleteBtn.disabled = false;
            deleteBtn.textContent = '删除选中';

            let resultMsg = `删除完成。成功: ${successCount}, 失败: ${failCount}`;
            if (failMessages.length > 0) {
                resultMsg += '\n失败原因（部分）：\n' + failMessages.slice(0, 5).join('\n');
                if (failMessages.length > 5) resultMsg += '\n...（仅显示前5条）';
            }
            alert(resultMsg);
            statusDiv.innerHTML = resultMsg.replace(/\n/g, '<br>');
        });
    }
})();

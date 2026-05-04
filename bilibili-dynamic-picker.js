// ==UserScript==
// @name         B站动态 API 跳转助手 (进度增强)
// @name:en      Bilibili Dynamic Picker By API
// @namespace    https://github.com/2540709491/bilibili-dynamic-picker
// @version      2.1.0
// @description  通过 Bilibili 官方 API 快速定位指定日期的动态，显示详细搜索进度
// @author       Sakurakid (重构版)
// @match        https://space.bilibili.com/*/dynamic
// @match        https://t.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const API_BASE = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';
    const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,onlyfansAssetsV2,forwardListHidden,ugcDelete';

    let isSearching = false;
    let abortController = null;

    function debugLog(...args) {
        console.log('[API跳转]', ...args);
    }

    function formatDate(date) {
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }

    // 获取 UP 主 mid
    function getHostMid() {
        const url = location.href;
        let match = url.match(/space\.bilibili\.com\/(\d+)/);
        if (match) return match[1];
        match = url.match(/t\.bilibili\.com\/(\d+)/);
        if (match) return match[1];
        const midMeta = document.querySelector('meta[name="bili-shortVer"]');
        if (midMeta) return midMeta.getAttribute('content');
        return null;
    }

    // 创建界面
    function createPanel() {
        const panel = document.createElement('div');
        panel.innerHTML = `
        <div id="api-jumper-panel" style="position:fixed;top:80px;right:20px;z-index:10000;
            background:white;padding:20px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.2);
            width:340px;font-family:sans-serif;">
            <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #00a1d6;padding-bottom:10px;">
                <h3 style="margin:0;font-size:16px;color:#333;">📅 API 跳转 v2.1</h3>
                <button id="api-close-btn" style="background:none;border:none;font-size:18px;color:#999;cursor:pointer;">✕</button>
            </div>
            <div style="margin-top:12px;">
                <label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">目标年份</label>
                <select id="api-year" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;">
                </select>
            </div>
            <div style="margin-top:10px;">
                <label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">目标月份</label>
                <select id="api-month" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;">
                    <option value="1">1月</option><option value="2">2月</option><option value="3">3月</option>
                    <option value="4">4月</option><option value="5">5月</option><option value="6">6月</option>
                    <option value="7">7月</option><option value="8">8月</option><option value="9">9月</option>
                    <option value="10">10月</option><option value="11">11月</option><option value="12">12月</option>
                </select>
            </div>
            <div style="margin-top:10px;">
                <label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">目标日(可选)</label>
                <select id="api-day" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;">
                    <option value="">不指定</option>
                </select>
            </div>
            <div style="margin-top:16px;">
                <button id="api-start-btn" style="width:100%;padding:10px;background:linear-gradient(135deg,#667eea,#764ba2);
                    color:white;border:none;border-radius:8px;font-weight:bold;cursor:pointer;">
                    🚀 通过 API 搜索
                </button>
                <button id="api-stop-btn" style="width:100%;padding:10px;background:#ff6b6b;color:white;
                    border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:8px;display:none;">
                    ⏹️ 停止搜索
                </button>
            </div>
            <!-- 增强的进度显示 -->
            <div id="api-progress" style="margin-top:14px;display:none;background:#f0f4ff;padding:12px;border-radius:8px;font-size:13px;color:#333;">
                <div style="font-weight:bold;margin-bottom:6px;">⏳ 搜索进度</div>
                <div style="font-size:12px;">
                    <div>已翻页：<span id="api-page-count">0</span> 页</div>
                    <div>已找到：<span id="api-found-count">0</span> 条目标动态</div>
                    <div>当前翻至：<span id="api-current-date" style="color:#764ba2;">等待中...</span></div>
                    <div style="margin-top:4px;color:#666;">目标：<span id="api-target-show"></span></div>
                </div>
            </div>
        </div>`;
        document.body.appendChild(panel);

        // 填充年份
        const yearSelect = document.getElementById('api-year');
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= 2009; y--) {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y + '年';
            yearSelect.appendChild(opt);
        }
        // 填充日期
        function updateDays() {
            const year = parseInt(yearSelect.value);
            const month = parseInt(document.getElementById('api-month').value);
            const daysInMonth = new Date(year, month, 0).getDate();
            const daySelect = document.getElementById('api-day');
            daySelect.innerHTML = '<option value="">不指定</option>';
            for (let d = 1; d <= daysInMonth; d++) {
                const opt = document.createElement('option');
                opt.value = d;
                opt.textContent = d + '日';
                daySelect.appendChild(opt);
            }
        }
        yearSelect.addEventListener('change', updateDays);
        document.getElementById('api-month').addEventListener('change', updateDays);
        updateDays();

        // 事件绑定
        document.getElementById('api-close-btn').addEventListener('click', () => {
            document.getElementById('api-jumper-panel').remove();
        });
        document.getElementById('api-start-btn').addEventListener('click', startApiSearch);
        document.getElementById('api-stop-btn').addEventListener('click', stopSearch);
    }

    async function startApiSearch() {
        const mid = getHostMid();
        if (!mid) {
            alert('未识别到 UP 主 ID，请在个人空间页面使用。');
            return;
        }

        const targetYear = parseInt(document.getElementById('api-year').value);
        const targetMonth = parseInt(document.getElementById('api-month').value);
        const targetDayVal = document.getElementById('api-day').value;
        const targetDay = targetDayVal ? parseInt(targetDayVal) : null;

        const targetStart = new Date(targetYear, targetMonth - 1, targetDay || 1);
        const targetEnd = targetDay
            ? new Date(targetYear, targetMonth - 1, targetDay + 1)
            : new Date(targetYear, targetMonth, 1);

        // 显示目标时间
        document.getElementById('api-target-show').textContent =
            formatDate(targetStart) + (targetDay ? '' : ' 整月');

        abortController = new AbortController();
        isSearching = true;

        document.getElementById('api-start-btn').style.display = 'none';
        document.getElementById('api-stop-btn').style.display = 'block';
        document.getElementById('api-progress').style.display = 'block';
        document.getElementById('api-found-count').textContent = '0';
        document.getElementById('api-page-count').textContent = '0';
        document.getElementById('api-current-date').textContent = '请求中...';

        let offset = null;
        let pageCount = 0;
        let foundItems = [];

        try {
            while (isSearching) {
                pageCount++;
                const params = new URLSearchParams({
                    host_mid: mid,
                    platform: 'web',
                    features: FEATURES,
                    web_location: '333.1365'
                });
                if (offset) params.set('offset', offset);

                const response = await fetch(`${API_BASE}?${params}`, {
                    credentials: 'include',
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const json = await response.json();
                if (json.code !== 0) {
                    throw new Error(json.message || 'API 错误');
                }

                const items = json.data?.items || [];
                if (!items.length) {
                    alert('没有更多动态了。');
                    break;
                }

                // 提取本页最旧动态的时间（列表最后一个元素）
                const lastItem = items[items.length - 1];
                let oldestDate = null;
                if (lastItem?.modules?.module_author?.pub_ts) {
                    oldestDate = new Date(lastItem.modules.module_author.pub_ts * 1000);
                    document.getElementById('api-current-date').textContent = formatDate(oldestDate);
                } else {
                    document.getElementById('api-current-date').textContent = '未知';
                }

                // 检查当前页匹配项
                for (const item of items) {
                    const pubTs = item.modules?.module_author?.pub_ts;
                    if (!pubTs) continue;
                    const date = new Date(pubTs * 1000);
                    if (date >= targetStart && date < targetEnd) {
                        foundItems.push(item);
                    }
                }

                // 更新进度数字
                document.getElementById('api-page-count').textContent = pageCount;
                document.getElementById('api-found-count').textContent = foundItems.length;

                // 停止条件：最旧动态已早于目标时间
                if (oldestDate && oldestDate < targetStart) {
                    isSearching = false;
                    break;
                }

                // 翻页条件
                if (!json.data.has_more || !json.data.offset) {
                    break;
                }
                offset = json.data.offset;
            }

            stopSearch();
            displayResult(foundItems, mid, targetYear, targetMonth, targetDay);
        } catch (err) {
            if (err.name !== 'AbortError') {
                alert('搜索失败: ' + err.message);
                console.error(err);
            }
            stopSearch();
        }
    }

    function stopSearch() {
        isSearching = false;
        if (abortController) abortController.abort();
        document.getElementById('api-start-btn').style.display = 'block';
        document.getElementById('api-stop-btn').style.display = 'none';
        // 进度面板保留
    }

    function displayResult(items, mid, year, month, day) {
        // 移除旧的结果面板（如果有）
        const oldResult = document.getElementById('api-result-panel');
        if (oldResult) oldResult.remove();

        const resultDiv = document.createElement('div');
        resultDiv.id = 'api-result-panel';
        resultDiv.style.cssText =
            'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;' +
            'background:white;padding:20px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.3);' +
            'max-width:500px;max-height:70vh;overflow-y:auto;';
        const desc = day ? `${year}年${month}月${day}日` : `${year}年${month}月`;
        let html = `<h3>📋 在 ${desc} 找到 ${items.length} 条动态</h3>`;
        if (items.length === 0) {
            html += '<p>未找到目标日期的动态。</p>';
        } else {
            html += '<ul>';
            items.forEach(item => {
                const idStr = item.id_str;
                const text = item.modules?.module_dynamic?.desc?.text || '(无文字)';
                const author = item.modules?.module_author?.name || '未知';
                const jumpUrl = `https://t.bilibili.com/${idStr}`;
                html += `<li style="margin-bottom:8px;">
                    <a href="${jumpUrl}" target="_blank" style="color:#00a1d6;">${author}: ${text.substring(0,50)}...</a>
                </li>`;
            });
            html += '</ul>';
        }
        html += `<button id="api-close-result" style="margin-top:10px;padding:6px 16px;background:#ccc;border:none;border-radius:6px;cursor:pointer;">关闭</button>`;
        resultDiv.innerHTML = html;
        document.body.appendChild(resultDiv);
        document.getElementById('api-close-result').addEventListener('click', () => {
            resultDiv.remove();
        });
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(createPanel, 1000));
    } else {
        setTimeout(createPanel, 1000);
    }

    console.log('%c[API跳转] v2.1 已加载！实时显示搜索进度','color:#667eea;font-weight:bold;background:#f0f4ff;padding:4px 8px;border-radius:4px;');
})();

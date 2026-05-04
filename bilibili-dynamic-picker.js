// ==UserScript==
// @name         B站动态 API 跳转助手 (时间段版)
// @name:en      Bilibili Dynamic API Jumper
// @namespace    https://github.com/2540709491/bilibili-dynamic-picker
// @version      2.4.0
// @description  通过 Bilibili 官方 API 快速定位指定时间段内的动态，卡片式展示
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
    const PROGRESS_PREFIX = 'bili_jumper_progress_';

    let isSearching = false;
    let abortController = null;

    function debugLog(...args) { console.log('[API跳转]', ...args); }

    function formatDate(date) { return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`; }

    function timeAgo(ts) {
        const now = Date.now() / 1000;
        const diff = now - ts;
        if (diff < 60) return '刚刚';
        if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
        if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
        const d = new Date(ts * 1000);
        return formatDate(d);
    }

    function extractSummary(item) {
        const major = item.modules?.module_dynamic?.major;
        const descText = item.modules?.module_dynamic?.desc?.text || '';
        const type = major?.type;
        let summary = '';
        if (descText) {
            summary = descText.replace(/\n/g, ' ').substring(0, 100);
        } else if (type === 'MAJOR_TYPE_OPUS' && major.opus?.summary?.text) {
            summary = major.opus.summary.text.replace(/\n/g, ' ').substring(0, 100);
        } else if (type === 'MAJOR_TYPE_ARCHIVE' && major.archive?.title) {
            summary = '视频：' + major.archive.title;
        } else if (type === 'MAJOR_TYPE_DRAW') {
            const count = major.draw?.items?.length || 0;
            summary = `带图动态 (${count}张图片)`;
        } else if (type === 'MAJOR_TYPE_ARTICLE' && major.article?.title) {
            summary = '专栏：' + major.article.title;
        }
        if (!summary) summary = '(无文字内容)';
        else if (summary.length > 100) summary = summary.substring(0, 97) + '...';
        return summary;
    }

    function extractCover(item) {
        const major = item.modules?.module_dynamic?.major;
        const type = major?.type;
        if (type === 'MAJOR_TYPE_OPUS' && major.opus?.pics?.length) return major.opus.pics[0].url;
        if (type === 'MAJOR_TYPE_DRAW' && major.draw?.items?.length) return major.draw.items[0].src;
        if (type === 'MAJOR_TYPE_ARCHIVE' && major.archive?.cover) return major.archive.cover;
        if (type === 'MAJOR_TYPE_ARTICLE' && major.article?.covers?.length) return major.article.covers[0];
        return null;
    }

    function simplifyItem(item) {
        return {
            id_str: item.id_str,
            pub_ts: item.modules?.module_author?.pub_ts,
            pub_time: item.modules?.module_author?.pub_time || timeAgo(item.modules?.module_author?.pub_ts),
            author_name: item.modules?.module_author?.name || '未知',
            author_face: item.modules?.module_author?.face || '',
            jump_url: item.basic?.jump_url || `https://t.bilibili.com/${item.id_str}`,
            summary: extractSummary(item),
            cover: extractCover(item),
        };
    }

    async function randomDelay() {
        const ms = 50;
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    function getProgressKey(mid) { return PROGRESS_PREFIX + mid; }

    function saveProgress(mid, startStr, endStr, offset, foundItems, pageCount) {
        const key = getProgressKey(mid);
        const data = { startStr, endStr, offset, foundItems, pageCount, updatedAt: Date.now() };
        localStorage.setItem(key, JSON.stringify(data));
    }

    function loadProgress(mid) {
        const key = getProgressKey(mid);
        const saved = localStorage.getItem(key);
        if (saved) {
            try { return JSON.parse(saved); } catch (e) { return null; }
        }
        return null;
    }

    function clearProgress(mid) { localStorage.removeItem(getProgressKey(mid)); }

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

    // 生成日期选择器 HTML
    function createDatePickerHTML(prefix, label) {
        return `
        <div style="margin-bottom:12px;">
            <label style="font-size:13px;color:#666;display:block;margin-bottom:4px;">${label}</label>
            <div style="display:flex;gap:6px;">
                <select id="${prefix}-year" style="flex:1;padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;"></select>
                <select id="${prefix}-month" style="width:70px;padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;">
                    ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}月</option>`).join('')}
                </select>
                <select id="${prefix}-day" style="width:70px;padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;">
                    <option value="">不指定</option>
                </select>
            </div>
        </div>`;
    }

    function createPanel() {
        const panel = document.createElement('div');
        panel.innerHTML = `
        <div id="api-jumper-panel" style="position:fixed;top:80px;right:20px;z-index:10000;
            background:white;padding:20px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.2);
            width:370px;font-family:sans-serif;">
            <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #00a1d6;padding-bottom:10px;">
                <h3 style="margin:0;font-size:16px;color:#333;">📅 API 跳转 v2.4</h3>
                <button id="api-close-btn" style="background:none;border:none;font-size:18px;color:#999;cursor:pointer;">✕</button>
            </div>
            ${createDatePickerHTML('start', '起始时间')}
            ${createDatePickerHTML('end', '结束时间')}
            <div style="margin-top:16px;">
                <button id="api-start-btn" style="width:100%;padding:10px;background:linear-gradient(135deg,#667eea,#764ba2);
                    color:white;border:none;border-radius:8px;font-weight:bold;cursor:pointer;">
                    🚀 搜索该时间段
                </button>
                <button id="api-stop-btn" style="width:100%;padding:10px;background:#ff6b6b;color:white;
                    border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:8px;display:none;">
                    ⏹️ 停止搜索
                </button>
                <button id="api-reset-btn" style="width:100%;padding:8px;background:#f0f0f0;color:#666;
                    border:1px solid #ddd;border-radius:8px;cursor:pointer;margin-top:6px;font-size:13px;">
                    🔄 重置进度
                </button>
            </div>
            <div id="api-progress" style="margin-top:14px;display:none;background:#f0f4ff;padding:12px;border-radius:8px;font-size:13px;color:#333;">
                <div style="font-weight:bold;margin-bottom:6px;">⏳ 搜索进度</div>
                <div style="font-size:12px;">
                    <div>已翻页：<span id="api-page-count">0</span> 页</div>
                    <div>已找到：<span id="api-found-count">0</span> 条</div>
                    <div>当前翻至：<span id="api-current-date" style="color:#764ba2;">等待中...</span></div>
                    <div style="margin-top:4px;color:#666;">区间：<span id="api-target-show"></span></div>
                </div>
            </div>
        </div>`;
        document.body.appendChild(panel);

        // 填充年份选项
        const currentYear = new Date().getFullYear();
        ['start', 'end'].forEach(prefix => {
            const yearSelect = document.getElementById(`${prefix}-year`);
            for (let y = currentYear; y >= 2009; y--) {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = y + '年';
                yearSelect.appendChild(opt);
            }
            // 默认结束年份为今年
            if (prefix === 'end') yearSelect.value = currentYear;
        });

        // 动态更新每月天数
        function updateDayOptions(prefix) {
            const year = parseInt(document.getElementById(`${prefix}-year`).value);
            const month = parseInt(document.getElementById(`${prefix}-month`).value);
            const daysInMonth = new Date(year, month, 0).getDate();
            const daySelect = document.getElementById(`${prefix}-day`);
            const currentVal = daySelect.value;
            daySelect.innerHTML = '<option value="">不指定</option>';
            for (let d = 1; d <= daysInMonth; d++) {
                const opt = document.createElement('option');
                opt.value = d;
                opt.textContent = d + '日';
                daySelect.appendChild(opt);
            }
            if (currentVal && parseInt(currentVal) <= daysInMonth) daySelect.value = currentVal;
            else daySelect.value = '';
        }
        ['start', 'end'].forEach(prefix => {
            document.getElementById(`${prefix}-year`).addEventListener('change', () => updateDayOptions(prefix));
            document.getElementById(`${prefix}-month`).addEventListener('change', () => updateDayOptions(prefix));
            updateDayOptions(prefix);
        });

        // 按钮事件
        document.getElementById('api-close-btn').addEventListener('click', () => document.getElementById('api-jumper-panel').remove());
        document.getElementById('api-start-btn').addEventListener('click', startApiSearch);
        document.getElementById('api-stop-btn').addEventListener('click', stopSearch);
        document.getElementById('api-reset-btn').addEventListener('click', () => {
            const mid = getHostMid();
            if (mid) {
                clearProgress(mid);
                alert('进度已重置。');
            }
        });
    }

    // 从面板读取日期并构建时间对象
    function getDateFromPanel(prefix) {
        const year = parseInt(document.getElementById(`${prefix}-year`).value);
        const month = parseInt(document.getElementById(`${prefix}-month`).value);
        const dayVal = document.getElementById(`${prefix}-day`).value;
        const day = dayVal ? parseInt(dayVal) : null;
        if (isNaN(year) || isNaN(month)) return null;
        return { year, month, day };
    }

    function buildDateRange() {
        const start = getDateFromPanel('start');
        const end = getDateFromPanel('end');
        if (!start || !end) return null;

        let startDate, endDate;
        if (start.day) startDate = new Date(start.year, start.month - 1, start.day);
        else startDate = new Date(start.year, start.month - 1, 1);

        if (end.day) endDate = new Date(end.year, end.month - 1, end.day);
        else endDate = new Date(end.year, end.month, 0); // 月末

        if (startDate > endDate) {
            alert('起始时间不能晚于结束时间');
            return null;
        }

        // 返回 [start, end) 用于比较
        return {
            startDate,
            endDate: new Date(endDate.getTime() + 86400000), // 次日0点
        };
    }

    async function startApiSearch() {
        const mid = getHostMid();
        if (!mid) {
            alert('未识别到 UP 主 ID，请在个人空间页面使用。');
            return;
        }
        const range = buildDateRange();
        if (!range) return;
        const { startDate, endDate } = range;

        const startStr = formatDate(startDate);
        const endStr = formatDate(new Date(endDate.getTime() - 86400000)); // 显示用的结束日
        document.getElementById('api-target-show').textContent = `${startStr} 至 ${endStr}`;

        // 检查续传进度
        const savedProgress = loadProgress(mid);
        let offset = null, pageCount = 0, foundItems = [];
        if (savedProgress && savedProgress.startStr === startStr && savedProgress.endStr === endStr) {
            const ok = confirm(`发现上次搜索进度：已翻页 ${savedProgress.pageCount} 页，找到 ${savedProgress.foundItems.length} 条。\n是否从上次位置继续？`);
            if (ok) {
                offset = savedProgress.offset;
                foundItems = savedProgress.foundItems;
                pageCount = savedProgress.pageCount;
                document.getElementById('api-page-count').textContent = pageCount;
                document.getElementById('api-found-count').textContent = foundItems.length;
                document.getElementById('api-current-date').textContent = '(继续中…)';
            } else {
                clearProgress(mid);
            }
        }

        abortController = new AbortController();
        isSearching = true;
        document.getElementById('api-start-btn').style.display = 'none';
        document.getElementById('api-stop-btn').style.display = 'block';
        document.getElementById('api-progress').style.display = 'block';

        try {
            while (isSearching) {
                await randomDelay();
                pageCount++;
                const params = new URLSearchParams({
                    host_mid: mid,
                    platform: 'web',
                    features: FEATURES,
                    web_location: '333.1365'
                });
                if (offset) params.set('offset', offset);

                const resp = await fetch(`${API_BASE}?${params}`, {
                    credentials: 'include',
                    signal: abortController.signal
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                if (json.code !== 0) throw new Error(json.message || 'API错误');

                const items = json.data?.items || [];
                if (!items.length) break;

                // 最旧动态日期
                const lastTs = items[items.length-1]?.modules?.module_author?.pub_ts;
                let oldestDate = null;
                if (lastTs) {
                    oldestDate = new Date(lastTs * 1000);
                    document.getElementById('api-current-date').textContent = formatDate(oldestDate);
                } else {
                    document.getElementById('api-current-date').textContent = '未知';
                }

                // 筛选在时间范围内的动态
                for (const item of items) {
                    const ts = item.modules?.module_author?.pub_ts;
                    if (!ts) continue;
                    const d = new Date(ts * 1000);
                    if (d >= startDate && d < endDate) {
                        foundItems.push(simplifyItem(item));
                    }
                }

                document.getElementById('api-page-count').textContent = pageCount;
                document.getElementById('api-found-count').textContent = foundItems.length;

                // 保存进度
                saveProgress(mid, startStr, endStr, offset, foundItems, pageCount);

                // 停止条件：最旧动态已早于起始时间
                if (oldestDate && oldestDate < startDate) {
                    isSearching = false;
                    break;
                }
                if (!json.data.has_more || !json.data.offset) break;
                offset = json.data.offset;
            }
            stopSearch();
            displayResult(foundItems, startStr, endStr);
        } catch (err) {
            if (err.name !== 'AbortError') {
                alert('搜索失败: ' + err.message);
                console.error(err);
            }
            stopSearch();
            try { saveProgress(mid, startStr, endStr, offset, foundItems, pageCount); } catch (e) {}
        }
    }

    function stopSearch() {
        isSearching = false;
        if (abortController) abortController.abort();
        document.getElementById('api-start-btn').style.display = 'block';
        document.getElementById('api-stop-btn').style.display = 'none';
    }

    function displayResult(items, startStr, endStr) {
        const old = document.getElementById('api-result-panel');
        if (old) old.remove();

        const resultDiv = document.createElement('div');
        resultDiv.id = 'api-result-panel';
        resultDiv.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;' +
            'background:rgba(255,255,255,0.98);padding:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.25);' +
            'width:540px;max-height:75vh;display:flex;flex-direction:column;overflow:hidden;';

        const header = document.createElement('div');
        header.style.cssText = 'padding:16px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;';
        header.innerHTML = `<h3 style="margin:0;font-size:18px;color:#333;">📋 ${startStr} 至 ${endStr} · 共 ${items.length} 条</h3>
            <button id="api-close-result" style="background:#f5f5f5;border:none;border-radius:20px;padding:4px 16px;cursor:pointer;font-size:14px;color:#666;">关闭</button>`;
        resultDiv.appendChild(header);

        const list = document.createElement('div');
        list.style.cssText = 'overflow-y:auto;padding:12px 20px 20px;flex:1;';
        if (!items.length) {
            list.innerHTML = '<div style="text-align:center;color:#999;padding:40px 0;">该时间段内没有动态</div>';
        } else {
            items.forEach(item => {
                const card = document.createElement('div');
                card.style.cssText = 'display:flex;align-items:flex-start;padding:14px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;transition:background 0.15s;';
                card.addEventListener('click', () => window.open(item.jump_url, '_blank'));
                card.addEventListener('mouseenter', () => card.style.background = '#fafafa');
                card.addEventListener('mouseleave', () => card.style.background = 'transparent');

                const ava = document.createElement('img');
                ava.src = item.author_face;
                ava.style.cssText = 'width:44px;height:44px;border-radius:50%;margin-right:12px;flex-shrink:0;object-fit:cover;';
                card.appendChild(ava);

                const right = document.createElement('div');
                right.style.cssText = 'flex:1;min-width:0;';
                const topLine = document.createElement('div');
                topLine.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
                topLine.innerHTML = `<span style="font-size:14px;font-weight:600;color:#222;">${escapeHtml(item.author_name)}</span>
                    <span style="font-size:12px;color:#999;">${escapeHtml(item.pub_time)}</span>`;
                right.appendChild(topLine);

                const summary = document.createElement('div');
                summary.textContent = item.summary;
                summary.style.cssText = 'font-size:13px;color:#555;line-height:1.5;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
                right.appendChild(summary);

                if (item.cover) {
                    const imgWrap = document.createElement('div');
                    const img = document.createElement('img');
                    img.src = item.cover;
                    img.style.cssText = 'max-height:80px;max-width:120px;border-radius:6px;object-fit:cover;border:1px solid #eee;';
                    imgWrap.appendChild(img);
                    right.appendChild(imgWrap);
                }
                card.appendChild(right);
                list.appendChild(card);
            });
        }
        resultDiv.appendChild(list);
        document.body.appendChild(resultDiv);
        document.getElementById('api-close-result').addEventListener('click', () => resultDiv.remove());
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(createPanel, 1000));
    } else {
        setTimeout(createPanel, 1000);
    }

    console.log('%c[API跳转] v2.4 已加载！支持自定义时间段搜索','color:#667eea;font-weight:bold;background:#f0f4ff;padding:4px 8px;border-radius:4px;');
})();

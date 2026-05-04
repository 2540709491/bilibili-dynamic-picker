// ==UserScript==
// @name         B站动态助手
// @namespace    https://github.com/2540709491/bilibili-dynamic-picker
// @version      2.5.1
// @description  通过 Bilibili 官方 API 快速定位指定时间段的动态，支持批量删除与自定义延迟
// @author       SXM
// @match        https://space.bilibili.com/*/dynamic
// @match        https://t.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const API_BASE = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';
    const DELETE_API = 'https://api.bilibili.com/x/dynamic/feed/operate/remove';
    const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,onlyfansAssetsV2,forwardListHidden,ugcDelete';
    const PROGRESS_PREFIX = 'bili_jumper_progress_';

    let isSearching = false;
    let abortController = null;
    let currentDelay = 50; // 默认50ms

    function debugLog(...args) { console.log('[API跳转]', ...args); }

    function formatDate(date) { return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`; }

    // 获取 bili_jct (CSRF Token)
    function getCsrfToken() {
        const cookies = document.cookie.split(';');
        for (let c of cookies) {
            c = c.trim();
            if (c.startsWith('bili_jct=')) {
                return c.substring('bili_jct='.length);
            }
        }
        return null;
    }

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
            if (descText.length > 100) summary += '...';
        } else if (type === 'MAJOR_TYPE_OPUS' && major.opus?.summary?.text) {
            summary = major.opus.summary.text.replace(/\n/g, ' ').substring(0, 100);
            if (major.opus.summary.text.length > 100) summary += '...';
        } else if (type === 'MAJOR_TYPE_ARCHIVE' && major.archive?.title) {
            summary = '视频：' + major.archive.title;
        } else if (type === 'MAJOR_TYPE_DRAW') {
            const count = major.draw?.items?.length || 0;
            summary = `带图动态 (${count}张图片)`;
        } else if (type === 'MAJOR_TYPE_ARTICLE' && major.article?.title) {
            summary = '专栏：' + major.article.title;
        }
        if (!summary) summary = '(无文字内容)';
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

    async function customDelay() {
        const input = document.getElementById('api-delay-input');
        if (input) currentDelay = parseInt(input.value) || 50;
        await new Promise(resolve => setTimeout(resolve, currentDelay));
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
            width:400px;font-family:sans-serif;">
            <div id="api-panel-header" style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #00a1d6;padding-bottom:10px;cursor:move;">
                <h3 style="margin:0;font-size:16px;color:#333;">📅 API 跳转 v2.5.1</h3>
                <button id="api-close-btn" style="background:none;border:none;font-size:18px;color:#999;cursor:pointer;">✕</button>
            </div>
            ${createDatePickerHTML('start', '起始时间')}
            ${createDatePickerHTML('end', '结束时间')}
            <div style="margin-top:12px;">
                <label style="font-size:13px;color:#666;display:block;margin-bottom:4px;">请求延迟 (毫秒)</label>
                <input type="number" id="api-delay-input" value="50" min="0" max="5000" step="10"
                    style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
                <div style="font-size:11px;color:#999;margin-top:2px;">每次API请求前的等待时间，建议50-200ms</div>
            </div>
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

        // 拖拽功能
        const panelEl = document.getElementById('api-jumper-panel');
        const headerEl = document.getElementById('api-panel-header');
        let isDragging = false, startX, startY, initialLeft, initialTop;

        headerEl.addEventListener('mousedown', function(e) {
            // 避免拖拽时误触关闭按钮
            if (e.target.id === 'api-close-btn') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panelEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            panelEl.style.right = 'auto'; // 取消右侧定位，改用left/top
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onDragEnd);
        });

        function onDrag(e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panelEl.style.left = (initialLeft + dx) + 'px';
            panelEl.style.top = (initialTop + dy) + 'px';
        }

        function onDragEnd() {
            isDragging = false;
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', onDragEnd);
        }

        const currentYear = new Date().getFullYear();
        ['start', 'end'].forEach(prefix => {
            const yearSelect = document.getElementById(`${prefix}-year`);
            for (let y = currentYear; y >= 2009; y--) {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = y + '年';
                yearSelect.appendChild(opt);
            }
            if (prefix === 'end') yearSelect.value = currentYear;
        });

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

        document.getElementById('api-close-btn').addEventListener('click', () => document.getElementById('api-jumper-panel').remove());
        document.getElementById('api-start-btn').addEventListener('click', startApiSearch);
        document.getElementById('api-stop-btn').addEventListener('click', stopSearch);
        document.getElementById('api-reset-btn').addEventListener('click', () => {
            const mid = getHostMid();
            if (mid) { clearProgress(mid); alert('进度已重置。'); }
        });
    }

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
        else endDate = new Date(end.year, end.month, 0);
        if (startDate > endDate) {
            alert('起始时间不能晚于结束时间');
            return null;
        }
        return {
            startDate,
            endDate: new Date(endDate.getTime() + 86400000),
        };
    }

    async function startApiSearch() {
        const mid = getHostMid();
        if (!mid) {
            alert('未识别到 UP 主 ID');
            return;
        }
        const range = buildDateRange();
        if (!range) return;
        const { startDate, endDate } = range;
        const startStr = formatDate(startDate);
        const endStr = formatDate(new Date(endDate.getTime() - 86400000));
        document.getElementById('api-target-show').textContent = `${startStr} 至 ${endStr}`;

        const savedProgress = loadProgress(mid);
        let offset = null, pageCount = 0, foundItems = [];
        if (savedProgress && savedProgress.startStr === startStr && savedProgress.endStr === endStr) {
            const ok = confirm(`发现上次进度：已翻 ${savedProgress.pageCount} 页，找到 ${savedProgress.foundItems.length} 条。\n是否继续？`);
            if (ok) {
                offset = savedProgress.offset;
                foundItems = savedProgress.foundItems;
                pageCount = savedProgress.pageCount;
            } else {
                clearProgress(mid);
            }
        }

        abortController = new AbortController();
        isSearching = true;
        document.getElementById('api-start-btn').style.display = 'none';
        document.getElementById('api-stop-btn').style.display = 'block';
        document.getElementById('api-progress').style.display = 'block';
        document.getElementById('api-page-count').textContent = pageCount;
        document.getElementById('api-found-count').textContent = foundItems.length;
        document.getElementById('api-current-date').textContent = '(搜索中…)';

        try {
            while (isSearching) {
                await customDelay();
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

                const lastTs = items[items.length-1]?.modules?.module_author?.pub_ts;
                let oldestDate = null;
                if (lastTs) {
                    oldestDate = new Date(lastTs * 1000);
                    document.getElementById('api-current-date').textContent = formatDate(oldestDate);
                } else {
                    document.getElementById('api-current-date').textContent = '未知';
                }

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
                saveProgress(mid, startStr, endStr, offset, foundItems, pageCount);

                if (oldestDate && oldestDate < startDate) { isSearching = false; break; }
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
            'width:600px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;';

        const header = document.createElement('div');
        header.style.cssText = 'padding:16px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;';
        header.innerHTML = `
            <h3 style="margin:0;font-size:16px;color:#333;">📋 ${startStr} 至 ${endStr} · 共 ${items.length} 条</h3>
            <div style="display:flex;gap:8px;align-items:center;">
                <button id="api-select-all" style="background:#e8f0fe;border:1px solid #667eea;color:#667eea;border-radius:20px;padding:4px 12px;cursor:pointer;font-size:12px;">全选</button>
                <button id="api-delete-selected" style="background:#ff4444;border:none;color:white;border-radius:20px;padding:4px 12px;cursor:pointer;font-size:12px;">🗑 删除选中</button>
                <button id="api-close-result" style="background:#f5f5f5;border:none;border-radius:20px;padding:4px 16px;cursor:pointer;font-size:13px;color:#666;">关闭</button>
            </div>`;
        resultDiv.appendChild(header);

        const list = document.createElement('div');
        list.style.cssText = 'overflow-y:auto;padding:12px 20px 20px;flex:1;';
        if (!items.length) {
            list.innerHTML = '<div style="text-align:center;color:#999;padding:40px 0;">没有动态</div>';
        } else {
            items.forEach((item, index) => {
                const card = document.createElement('div');
                card.className = 'dynamic-card-item';
                card.style.cssText = 'display:flex;align-items:flex-start;padding:14px 0;border-bottom:1px solid #f0f0f0;transition:background 0.15s;';
                card.addEventListener('mouseenter', () => { if (!card.classList.contains('selected')) card.style.background = '#fafafa'; });
                card.addEventListener('mouseleave', () => { if (!card.classList.contains('selected')) card.style.background = 'transparent'; });

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'dynamic-checkbox';
                checkbox.dataset.id = item.id_str;
                checkbox.style.cssText = 'margin-right:12px;margin-top:12px;flex-shrink:0;transform:scale(1.2);cursor:pointer;';
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        card.classList.add('selected');
                        card.style.background = '#fff0f0';
                    } else {
                        card.classList.remove('selected');
                        card.style.background = 'transparent';
                    }
                    updateSelectedCount(items);
                });
                card.appendChild(checkbox);

                const right = document.createElement('div');
                right.style.cssText = 'flex:1;min-width:0;';
                right.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <span style="font-size:13px;font-weight:600;color:#222;">${escapeHtml(item.author_name)}</span>
                        <span style="font-size:11px;color:#999;">${escapeHtml(item.pub_time)}</span>
                    </div>
                    <div style="font-size:12px;color:#555;line-height:1.5;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(item.summary)}</div>
                `;
                if (item.cover) {
                    const img = document.createElement('img');
                    img.src = item.cover;
                    img.style.cssText = 'max-height:60px;max-width:90px;border-radius:6px;object-fit:cover;border:1px solid #eee;';
                    right.appendChild(img);
                }
                card.appendChild(right);
                card.addEventListener('click', (e) => {
                    if (e.target !== checkbox) {
                        window.open(item.jump_url, '_blank');
                    }
                });
                list.appendChild(card);
            });
        }
        resultDiv.appendChild(list);
        document.body.appendChild(resultDiv);

        // 全选按钮
        document.getElementById('api-select-all').addEventListener('click', () => {
            const checkboxes = document.querySelectorAll('.dynamic-checkbox');
            const allChecked = Array.from(checkboxes).every(cb => cb.checked);
            checkboxes.forEach(cb => {
                cb.checked = !allChecked;
                cb.dispatchEvent(new Event('change'));
            });
            document.getElementById('api-select-all').textContent = allChecked ? '全选' : '取消全选';
        });

        // 删除选中按钮
        document.getElementById('api-delete-selected').addEventListener('click', () => {
            const checked = document.querySelectorAll('.dynamic-checkbox:checked');
            if (checked.length === 0) {
                alert('请至少勾选一条动态');
                return;
            }
            const ids = Array.from(checked).map(cb => cb.dataset.id);
            if (confirm(`确定要删除选中的 ${ids.length} 条动态吗？此操作不可恢复！`)) {
                batchDelete(ids, items);
            }
        });

        document.getElementById('api-close-result').addEventListener('click', () => resultDiv.remove());
    }

    function updateSelectedCount(items) {
        const count = document.querySelectorAll('.dynamic-checkbox:checked').length;
        const btn = document.getElementById('api-delete-selected');
        if (btn) btn.textContent = `🗑 删除选中 (${count})`;
    }

    async function batchDelete(ids, items) {
        const csrf = getCsrfToken();
        if (!csrf) {
            alert('未获取到 CSRF Token (bili_jct)，请刷新页面后重试。');
            return;
        }

        let success = 0, fail = 0;
        for (let i = 0; i < ids.length; i++) {
            try {
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1200));
                const resp = await fetch(`${DELETE_API}?csrf=${csrf}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dyn_id_str: ids[i] })
                });
                const json = await resp.json();
                if (json.code === 0) {
                    success++;
                    const card = document.querySelector(`.dynamic-checkbox[data-id="${ids[i]}"]`)?.parentElement;
                    if (card) card.style.display = 'none';
                } else {
                    fail++;
                    debugLog(`删除失败 ${ids[i]}:`, json.message);
                }
            } catch (e) {
                fail++;
                debugLog(`删除异常 ${ids[i]}:`, e.message);
            }
        }
        alert(`删除完成：成功 ${success} 条，失败 ${fail} 条。`);
        const remaining = document.querySelectorAll('.dynamic-checkbox:checked').length;
        document.getElementById('api-delete-selected').textContent = `🗑 删除选中 (${remaining})`;
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

    console.log('%c[API跳转] v2.5.1 已加载！支持拖拽面板+批量删除+自定义延迟','color:#667eea;font-weight:bold;background:#f0f4ff;padding:4px 8px;border-radius:4px;');
})();

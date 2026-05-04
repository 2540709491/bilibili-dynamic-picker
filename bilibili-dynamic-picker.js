// ==UserScript==
// @name         B站动态 API 跳转助手 (卡片展示)
// @name:en      Bilibili Dynamic API Jumper with Cards
// @namespace    https://github.com/tongle2025/bilibili-dynamic-jumper
// @version      2.3.0
// @description  通过 Bilibili 官方 API 快速定位指定日期的动态，卡片式摘要展示
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
    const PROGRESS_PREFIX = 'bili_api_jumper_progress_';

    let isSearching = false;
    let abortController = null;

    function debugLog(...args) {
        console.log('[API跳转]', ...args);
    }

    function formatDate(date) {
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }

    function timeAgo(ts) {
        const now = Date.now() / 1000;
        const diff = now - ts;
        if (diff < 60) return '刚刚';
        if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
        if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
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
        if (type === 'MAJOR_TYPE_OPUS' && major.opus?.pics?.length) {
            return major.opus.pics[0].url;
        } else if (type === 'MAJOR_TYPE_DRAW' && major.draw?.items?.length) {
            return major.draw.items[0].src;
        } else if (type === 'MAJOR_TYPE_ARCHIVE' && major.archive?.cover) {
            return major.archive.cover;
        } else if (type === 'MAJOR_TYPE_ARTICLE' && major.article?.covers?.length) {
            return major.article.covers[0];
        }
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
        const ms = 50; // 800-2000
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    function getProgressKey(mid) {
        return PROGRESS_PREFIX + mid;
    }

    function saveProgress(mid, targetYear, targetMonth, targetDay, offset, foundItems, pageCount) {
        const key = getProgressKey(mid);
        const data = { targetYear, targetMonth, targetDay, offset, foundItems, pageCount, updatedAt: Date.now() };
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

    function clearProgress(mid) {
        localStorage.removeItem(getProgressKey(mid));
    }

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

    function createPanel() {
        const panel = document.createElement('div');
        panel.innerHTML = `
        <div id="api-jumper-panel" style="position:fixed;top:80px;right:20px;z-index:10000;
            background:white;padding:20px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.2);
            width:340px;font-family:sans-serif;">
            <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #00a1d6;padding-bottom:10px;">
                <h3 style="margin:0;font-size:16px;color:#333;">📅 API 跳转 v2.3</h3>
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
                <button id="api-reset-btn" style="width:100%;padding:8px;background:#f0f0f0;color:#666;
                    border:1px solid #ddd;border-radius:8px;cursor:pointer;margin-top:6px;font-size:13px;">
                    🔄 重置当前进度
                </button>
            </div>
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

        const yearSelect = document.getElementById('api-year');
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= 2009; y--) {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y + '年';
            yearSelect.appendChild(opt);
        }
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

        document.getElementById('api-close-btn').addEventListener('click', () => {
            document.getElementById('api-jumper-panel').remove();
        });
        document.getElementById('api-start-btn').addEventListener('click', startApiSearch);
        document.getElementById('api-stop-btn').addEventListener('click', stopSearch);
        document.getElementById('api-reset-btn').addEventListener('click', () => {
            const mid = getHostMid();
            if (mid) {
                clearProgress(mid);
                alert('当前 UP 主的搜索进度已重置。');
            }
        });
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
        document.getElementById('api-target-show').textContent =
            formatDate(targetStart) + (targetDay ? '' : ' 整月');

        const savedProgress = loadProgress(mid);
        let offset = null;
        let pageCount = 0;
        let foundItems = [];

        if (savedProgress &&
            savedProgress.targetYear === targetYear &&
            savedProgress.targetMonth === targetMonth &&
            savedProgress.targetDay === targetDay) {
            const ok = confirm(
                `发现上次搜索进度：已翻页 ${savedProgress.pageCount} 页，找到 ${savedProgress.foundItems.length} 条动态。\n\n是否从上次位置继续？`
            );
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

                const response = await fetch(`${API_BASE}?${params}`, {
                    credentials: 'include',
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const json = await response.json();
                if (json.code !== 0) throw new Error(json.message || 'API 错误');

                const items = json.data?.items || [];
                if (!items.length) break;

                const lastItem = items[items.length - 1];
                let oldestDate = null;
                if (lastItem?.modules?.module_author?.pub_ts) {
                    oldestDate = new Date(lastItem.modules.module_author.pub_ts * 1000);
                    document.getElementById('api-current-date').textContent = formatDate(oldestDate);
                } else {
                    document.getElementById('api-current-date').textContent = '未知';
                }

                for (const item of items) {
                    const pubTs = item.modules?.module_author?.pub_ts;
                    if (!pubTs) continue;
                    const date = new Date(pubTs * 1000);
                    if (date >= targetStart && date < targetEnd) {
                        foundItems.push(simplifyItem(item));
                    }
                }

                document.getElementById('api-page-count').textContent = pageCount;
                document.getElementById('api-found-count').textContent = foundItems.length;

                saveProgress(mid, targetYear, targetMonth, targetDay, offset, foundItems, pageCount);

                if (oldestDate && oldestDate < targetStart) {
                    isSearching = false;
                    break;
                }

                if (!json.data.has_more || !json.data.offset) break;
                offset = json.data.offset;
            }
            stopSearch();
            displayResult(foundItems, targetYear, targetMonth, targetDay);
        } catch (err) {
            if (err.name !== 'AbortError') {
                alert('搜索失败: ' + err.message);
                console.error(err);
            }
            stopSearch();
            try { saveProgress(mid, targetYear, targetMonth, targetDay, offset, foundItems, pageCount); } catch (e) {}
        }
    }

    function stopSearch() {
        isSearching = false;
        if (abortController) abortController.abort();
        document.getElementById('api-start-btn').style.display = 'block';
        document.getElementById('api-stop-btn').style.display = 'none';
    }

    function displayResult(items, year, month, day) {
        // 移除旧结果
        const oldResult = document.getElementById('api-result-panel');
        if (oldResult) oldResult.remove();

        const desc = day ? `${year}年${month}月${day}日` : `${year}年${month}月`;
        const resultDiv = document.createElement('div');
        resultDiv.id = 'api-result-panel';
        resultDiv.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;' +
            'background:rgba(255,255,255,0.98);padding:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.25);' +
            'width:540px;max-height:75vh;display:flex;flex-direction:column;overflow:hidden;';

        // 标题栏
        const header = document.createElement('div');
        header.style.cssText = 'padding:16px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;';
        header.innerHTML = `<h3 style="margin:0;font-size:18px;color:#333;">📋 ${desc} · 找到 ${items.length} 条动态</h3>
            <button id="api-close-result" style="background:#f5f5f5;border:none;border-radius:20px;padding:4px 16px;cursor:pointer;font-size:14px;color:#666;">关闭</button>`;
        resultDiv.appendChild(header);

        // 卡片列表区域
        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'overflow-y:auto;padding:12px 20px 20px;flex:1;';
        if (items.length === 0) {
            listContainer.innerHTML = '<div style="text-align:center;color:#999;padding:40px 0;">未找到目标日期的动态</div>';
        } else {
            items.forEach(item => {
                const card = document.createElement('div');
                card.style.cssText = 'display:flex;align-items:flex-start;padding:14px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;transition:background 0.15s;';
                card.addEventListener('click', () => {
                    window.open(item.jump_url, '_blank');
                });
                card.addEventListener('mouseenter', () => card.style.background = '#fafafa');
                card.addEventListener('mouseleave', () => card.style.background = 'transparent');

                // 头像
                const avatar = document.createElement('img');
                avatar.src = item.author_face;
                avatar.style.cssText = 'width:44px;height:44px;border-radius:50%;margin-right:12px;flex-shrink:0;object-fit:cover;';
                card.appendChild(avatar);

                // 右侧信息
                const right = document.createElement('div');
                right.style.cssText = 'flex:1;min-width:0;';

                // 作者行
                const authorLine = document.createElement('div');
                authorLine.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
                authorLine.innerHTML = `<span style="font-size:14px;font-weight:600;color:#222;">${escapeHtml(item.author_name)}</span>
                    <span style="font-size:12px;color:#999;">${escapeHtml(item.pub_time)}</span>`;
                right.appendChild(authorLine);

                // 摘要
                const summary = document.createElement('div');
                summary.textContent = item.summary;
                summary.style.cssText = 'font-size:13px;color:#555;line-height:1.5;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
                right.appendChild(summary);

                // 如果有封面图，显示小缩略图
                if (item.cover) {
                    const imgWrapper = document.createElement('div');
                    imgWrapper.style.cssText = 'display:flex;gap:8px;';
                    const img = document.createElement('img');
                    img.src = item.cover;
                    img.style.cssText = 'max-height:80px;max-width:120px;border-radius:6px;object-fit:cover;border:1px solid #eee;';
                    imgWrapper.appendChild(img);
                    right.appendChild(imgWrapper);
                }

                card.appendChild(right);
                listContainer.appendChild(card);
            });
        }
        resultDiv.appendChild(listContainer);

        document.body.appendChild(resultDiv);

        // 关闭按钮事件
        document.getElementById('api-close-result').addEventListener('click', () => {
            resultDiv.remove();
        });
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

    console.log('%c[API跳转] v2.3 已加载！卡片式摘要展示，一目了然','color:#667eea;font-weight:bold;background:#f0f4ff;padding:4px 8px;border-radius:4px;');
})();

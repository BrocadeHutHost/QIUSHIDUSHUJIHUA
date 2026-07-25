// ==UserScript==
// @name         DGUT求是读书-全自动阅读助手 UI美化版
// @namespace    https://github.com/BrocadeHutHost/
// @version      4.0.0
// @license MIT
// @description  DGUT莞工求是读书计划自动阅读助手 — 获取优学院真实阅读时长 / 自动翻页章节
// @author       vanilla、DeepSeek、BrocadeHutHost
// @match        https://ua.dgut.edu.cn/learnCourse/learnCourse.html?*
// @match        https://*.ulearning.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const PAGE_WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const HOST_RE = /^https:\/\/ua\.dgut\.edu\.cn\/learnCourse\/learnCourse\.html\?.*/i;
    const KEY = 'dgut_single_file_helper_config';
    const THEME_KEY = 'dgut_m3_theme';
    const RECORDS_KEY = 'dgut_reading_records';
    const MSG = 'DGUT_SINGLE_FILE_READER_SYNC';
    const SAVE_INTERVAL = 30;
    const D = { posX:20, posY:120, readerSec:30, readerAutoStart:true };
    const MIN_BOOK_SEC = 4 * 3600 + 10;
    const NAV_SEC = 3;
    const cachedCourseId = new URL(location.href).searchParams.get('courseId') || '';

    if (HOST_RE.test(location.href)) {
        if (window.__DGUT_SINGLE_FILE_INITED__) return;
        window.__DGUT_SINGLE_FILE_INITED__ = true;
        initHost();
        return;
    }
    bootstrapReader();

    // --- 书目标识 & 持久化 ---

    function getActiveSectionName() {
        const activePage = document.querySelector('.page-name.active');
        if (!activePage) return '';
        const sectionItem = activePage.closest('.section-item');
        if (!sectionItem) return '';
        const nameEl = sectionItem.querySelector('.section-name .text');
        return nameEl ? trimName(nameEl.textContent) : '';
    }

    function getBookKey() {
        const name = getActiveSectionName();
        return name ? (cachedCourseId ? `${cachedCourseId}|${name}` : name) : (cachedCourseId || location.href);
    }

    function loadRecords() { return GM_getValue(RECORDS_KEY, {}); }
    function saveRecords(r) { GM_setValue(RECORDS_KEY, r); }
    function getBookTime(k) { return Math.max(0, parseInt(loadRecords()[k], 10) || 0); }
    function setBookTime(k, s) { const r = loadRecords(); r[k] = Math.max(0, Math.floor(s)); saveRecords(r); }

    // --- 常用工具 ---

    function readCfg() {
        const r = GM_getValue(KEY, D);
        if (!r || typeof r !== 'object') return { ...D };
        const sec = parseInt(r.readerSec, 10);
        return {
            posX: parseInt(r.posX,10)||D.posX,
            posY: parseInt(r.posY,10)||D.posY,
            readerSec: sec > 0 ? sec : D.readerSec,
            readerAutoStart: r.readerAutoStart !== false
        };
    }

    function getActivePageName() {
        const activePage = document.querySelector('.page-name.active');
        if (!activePage) return '';
        const textEl = activePage.querySelector('.text span') || activePage.querySelector('.text');
        return textEl ? trimName(textEl.textContent) : '';
    }

    function getBookDisplayName() {
        const section = getActiveSectionName();
        const page = getActivePageName();
        if (!section && !page) return '未识别';
        return page ? section + ' - ' + page : section;
    }

    function koUnwrap(val) { return typeof val === 'function' ? val() : val; }
    function trimName(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

    function getServerSideBookTimes() {
        const vm = PAGE_WIN.koLearnCourseViewModel;
        if (!vm) return null;
        const course = koUnwrap(vm.course);
        if (!course) return null;
        const chapters = koUnwrap(course.chapters);
        if (!chapters) return null;
        const result = {};
        chapters.forEach(function(chapter) {
            const sections = koUnwrap(chapter.sections);
            if (!sections) return;
            sections.forEach(function(section) {
                let name = '';
                try { name = trimName(koUnwrap(section.name)); } catch(e) {}
                if (!name) return;
                const key = cachedCourseId ? cachedCourseId + '|' + name : name;
                let total = 0;
                try {
                    const secRec = koUnwrap(section.record);
                    if (secRec && secRec.sectionStudyTime !== undefined) {
                        total = koUnwrap(secRec.sectionStudyTime) || 0;
                    }
                } catch(e) {}
                if (total === 0) {
                    const pages = koUnwrap(section.pages);
                    if (pages) {
                        pages.forEach(function(page) {
                            try {
                                const record = koUnwrap(page.record);
                                if (record) {
                                    total += (koUnwrap(record.studyTime) || 0) + (koUnwrap(record.lastStudyTime) || 0);
                                }
                            } catch(e) {}
                        });
                    }
                }
                if (total > 0) result[key] = total;
            });
        });
        return result;
    }

    function syncServerTime(bookKey, accumulated, logFn) {
        const serverTimes = getServerSideBookTimes();
        if (!serverTimes) return accumulated;
        const records = loadRecords();
        let updated = false;
        Object.keys(serverTimes).forEach(function(key) {
            const serverSec = serverTimes[key];
            const localSec = records[key] || 0;
            if (serverSec > localSec) {
                records[key] = serverSec;
                updated = true;
                if (logFn) logFn('服务端同步：' + key + ' ' + fmt(localSec) + ' → ' + fmt(serverSec));
            }
        });
        if (updated) saveRecords(records);
        if (bookKey && serverTimes[bookKey] && serverTimes[bookKey] > accumulated) {
            accumulated = serverTimes[bookKey];
        }
        return accumulated;
    }

    function fmt(t) {
        t = Math.max(0, t);
        return `${String(Math.floor(t/3600)).padStart(2,'0')}:${String(Math.floor(t%3600/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
    }

    // --- 主页面（课程页） MD3 UI ---
    //@author JinLi

    function initHost() {
        let bookKey = getBookKey();
        let accumulated = getBookTime(bookKey);
        let sessionStart = Date.now();
        let lastSave = accumulated;
        let timer = null;
        let drag = false, dx, dy;
        const cfg = readCfg();
        let currentPageId = null;
        let pageStartTime = Date.now();
        let cachedFlatList = [];
        let flatListDirty = true;
        let holdPageId = null;

        // 主题加载
        let currentTheme = GM_getValue(THEME_KEY, 'auto');
        function applyTheme(theme) {
            const panel = document.getElementById('dgut-m3-panel');
            if(!panel) return;
            let actualTheme = theme;
            if(theme === 'auto') {
                actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            panel.classList.remove('theme-light', 'theme-dark');
            panel.classList.add('theme-' + actualTheme);
            GM_setValue(THEME_KEY, theme);
            currentTheme = theme;
        }

        // 样式注入
        document.head.appendChild(Object.assign(document.createElement('style'), {
            textContent: `
                @import url('https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,400;8..144,500;8..144,700&family=Roboto+Mono:wght@400;500;700&display=swap');
                
                #dgut-m3-panel {
                    position: fixed; z-index: 100000;
                    font-family: 'Roboto Flex', -apple-system, "Microsoft YaHei", sans-serif;
                    border-radius: 28px; overflow: hidden;
                    transition: box-shadow 0.2s ease, transform 0.2s ease, width 0.3s ease, height 0.3s ease;
                    user-select: none;
                }
                
                #dgut-m3-panel.theme-light {
                    --m3-surface: #FEF7FF;
                    --m3-surface-container: #F3EDF7;
                    --m3-on-surface: #1D1B20;
                    --m3-on-surface-variant: #49454F;
                    --m3-primary: #6750A4;
                    --m3-on-primary: #FFFFFF;
                    --m3-primary-container: #EADDFF;
                    --m3-on-primary-container: #21005D;
                    --m3-secondary-container: #E8DEF8;
                    --m3-on-secondary-container: #1D192B;
                    --m3-outline: #79747E;
                    --m3-shadow: rgba(0,0,0,0.15);
                    --m3-ripple: rgba(0,0,0,0.08);
                }
                
                #dgut-m3-panel.theme-dark {
                    --m3-surface: #141218;
                    --m3-surface-container: #211F26;
                    --m3-on-surface: #E6E0E9;
                    --m3-on-surface-variant: #CAC4D0;
                    --m3-primary: #D0BCFF;
                    --m3-on-primary: #381E72;
                    --m3-primary-container: #4F378B;
                    --m3-on-primary-container: #EADDFF;
                    --m3-secondary-container: #4A4458;
                    --m3-on-secondary-container: #E8DEF8;
                    --m3-outline: #938F99;
                    --m3-shadow: rgba(0,0,0,0.4);
                    --m3-ripple: rgba(255,255,255,0.12);
                }

                #dgut-m3-panel { background: var(--m3-surface-container); box-shadow: 0px 1px 3px var(--m3-shadow); }
                #dgut-m3-panel.dragging { box-shadow: 0px 8px 12px var(--m3-shadow); }
                
                /* Ripple 水波纹 */
                .md-ripple { position: relative; overflow: hidden; }
                .md-ripple-effect {
                    position: absolute; border-radius: 50%; pointer-events: none;
                    background: var(--m3-ripple); transform: scale(0);
                    animation: md-ripple-anim 0.6s linear;
                }
                @keyframes md-ripple-anim { to { transform: scale(4); opacity: 0; } }

                /* Header */
                .md-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px 8px; cursor: move; }
                .md-title-group { display: flex; align-items: center; gap: 8px; }
                .md-status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--m3-outline); flex-shrink: 0; }
                .md-status-dot.active { background: var(--m3-primary); animation: md-pulse 2s infinite; }
                @keyframes md-pulse { 0% { box-shadow: 0 0 0 0 var(--m3-primary); opacity: 1; } 50% { box-shadow: 0 0 0 6px transparent; opacity: 0.5; } 100% { box-shadow: 0 0 0 0 transparent; opacity: 1; } }
                .md-title { font-size: 14px; font-weight: 500; color: var(--m3-on-surface); }
                .md-action-group { display: flex; gap: 4px; }
                
                .md-icon-btn { width: 32px; height: 32px; border: none; background: transparent; color: var(--m3-on-surface-variant); border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s; }
                .md-icon-btn:hover { background: var(--m3-surface); }
                .md-icon-btn svg { width: 18px; height: 18px; fill: currentColor; }
                #dgut-m3-panel.collapsed .md-collapse-hide { display: none; }
                #dgut-m3-panel .md-collapse-show { display: none; }
                #dgut-m3-panel.collapsed .md-collapse-show { display: flex; }

                /* Body */
                .md-body { padding: 8px 20px 20px; width: 280px; }
                
                /* Hero Card */
                .md-hero { background: var(--m3-primary-container); color: var(--m3-on-primary-container); border-radius: 24px; padding: 20px; margin-bottom: 16px; position: relative; overflow: hidden; }
                .md-hero-decor { position: absolute; width: 120px; height: 120px; border-radius: 50%; background: var(--m3-on-primary-container); opacity: 0.05; top: -40px; right: -20px; }
                .md-timer { font-family: 'Roboto Mono', monospace; font-size: 36px; font-weight: 500; text-align: center; letter-spacing: -1px; margin-bottom: 4px; position: relative; z-index: 1; }
                .md-book-name { font-size: 12px; text-align: center; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 12px; position: relative; z-index: 1; }
                .md-progress-track { height: 4px; background: rgba(0,0,0,0.1); border-radius: 2px; overflow: hidden; }
                .md-progress-fill { height: 100%; background: var(--m3-on-primary-container); border-radius: 2px; transition: width 0.6s cubic-bezier(.34,1.56,.64,1); }
                .md-progress-label { font-size: 10px; font-family: 'Roboto Mono'; text-align: center; margin-top: 6px; opacity: 0.7; }

                /* Controls */
                .md-btn { width: 100%; height: 40px; border: none; border-radius: 20px; font-family: inherit; font-size: 14px; font-weight: 500; cursor: pointer; transition: filter 0.2s, background 0.2s; position: relative; overflow: hidden; }
                .md-btn-filled { background: var(--m3-primary); color: var(--m3-on-primary); }
                .md-btn-tonal { background: var(--m3-secondary-container); color: var(--m3-on-secondary-container); }
                .md-btn-text { background: transparent; color: var(--m3-primary); width: auto; height: 32px; padding: 0 12px; }
                .md-btn:hover { filter: brightness(1.1); }
                
                .md-row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; gap: 8px; }
                .md-input-group { display: flex; align-items: center; gap: 8px; flex: 1; }
                .md-label { font-size: 12px; color: var(--m3-on-surface-variant); }
                .md-text-field { width: 50px; background: transparent; border: 1px solid var(--m3-outline); border-radius: 4px; color: var(--m3-on-surface); padding: 4px 8px; font-family: 'Roboto Mono'; text-align: center; outline: none; transition: border 0.2s; }
                .md-text-field:focus { border: 2px solid var(--m3-primary); padding: 3px 7px; }
                .md-unit { font-size: 12px; color: var(--m3-on-surface-variant); }
                .md-server-text { font-size: 12px; color: var(--m3-on-surface-variant); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

                /* Log */
                .md-log-header { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--m3-outline); cursor: pointer; }
                .md-log-title { font-size: 12px; font-weight: 500; color: var(--m3-on-surface-variant); }
                .md-log-container { max-height: 100px; overflow-y: auto; margin-top: 8px; background: var(--m3-surface); border-radius: 12px; padding: 8px; font-family: 'Roboto Mono', monospace; font-size: 11px; color: var(--m3-on-surface-variant); transition: max-height 0.3s; }
                .md-log-container.collapsed { max-height: 0; padding: 0; overflow: hidden; margin: 0; }
                .md-log-line { padding: 2px 0; border-bottom: 1px solid var(--m3-surface-container); }
                .md-log-line:last-child { border-bottom: none; }

                /* Collapsed FAB State */
                #dgut-m3-panel.collapsed { width: 120px !important; height: 48px !important; border-radius: 16px; display: flex; align-items: center; padding: 0 8px; box-shadow: 0px 4px 8px var(--m3-shadow); }
                #dgut-m3-panel.collapsed .md-body { display: none; }
                #dgut-m3-panel.collapsed .md-header { padding: 0; cursor: pointer; width: 100%; }
                #dgut-m3-panel.collapsed .md-title-group { display: none; }
                #dgut-m3-panel.collapsed .md-action-group { width: 100%; justify-content: space-between; padding: 0 4px; }
                #dgut-m3-panel.collapsed .md-fab-timer { font-family: 'Roboto Mono'; font-size: 14px; font-weight: 500; color: var(--m3-on-surface); }

                /* Snackbar */
                #dgut-snackbar { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(100px); background: var(--m3-on-surface); color: var(--m3-surface); padding: 14px 16px; border-radius: 8px; font-size: 14px; font-family: 'Roboto Flex'; box-shadow: 0px 4px 12px var(--m3-shadow); opacity: 0; transition: transform 0.3s, opacity 0.3s; z-index: 100001; pointer-events: none; }
                #dgut-snackbar.show { transform: translateX(-50%) translateY(0); opacity: 1; }

                @media (prefers-reduced-motion: reduce) {
                    * { transition: none !important; animation: none !important; }
                }
            `
        }));

        const p = Object.assign(document.createElement('div'), {
            id: 'dgut-m3-panel',
            style: `top:${cfg.posY}px;right:${cfg.posX}px`
        });
        
        p.innerHTML = `
            <div class="md-header md-ripple" id="md-drag-handle">
                <div class="md-title-group">
                    <span class="md-status-dot" id="md-status-dot"></span>
                    <span class="md-title">DGUT 求是阅读</span>
                </div>
                <div class="md-action-group">
                    <button id="md-btn-theme" class="md-icon-btn md-collapse-hide" title="切换主题">
                        <svg viewBox="0 0 24 24"><path d="M12 18a6 6 0 1 1 0-12 6 6 0 0 1 0 12zm0-2a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 1h2v3h-2V1zm0 19h2v3h-2v-3zM3.515 4.929l1.414-1.414L7.05 5.636 5.636 7.05 3.515 4.93zM16.95 18.364l1.414-1.414 2.121 2.121-1.414 1.414-2.121-2.121zm2.121-14.85l1.414 1.415-2.121 2.121-1.414-1.414 2.121-2.121zM5.636 16.95l1.414 1.414-2.121 2.121-1.414-1.414 2.121-2.121zM23 11v2h-3v-2h3zM4 11v2H1v-2h3z"/></svg>
                    </button>
                    <button id="md-btn-collapse" class="md-icon-btn md-collapse-hide" title="折叠">
                        <svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5z"/></svg>
                    </button>
                    <span class="md-fab-timer md-collapse-show" id="md-fab-timer">00:00:00</span>
                    <button id="md-btn-expand" class="md-icon-btn md-collapse-show" title="展开">
                        <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
                    </button>
                </div>
            </div>
            <div class="md-body">
                <div class="md-hero">
                    <div class="md-hero-decor"></div>
                    <div class="md-timer" id="md-timer">${fmt(accumulated)}</div>
                    <div class="md-book-name" id="md-book-name" title="${bookKey}">${getBookDisplayName()}</div>
                    <div class="md-progress-track"><div class="md-progress-fill" id="md-progress-fill" style="width:0%"></div></div>
                    <div class="md-progress-label" id="md-progress-label">目标 4h10m · 0%</div>
                </div>
                <button id="md-btn-toggle" class="md-btn md-btn-filled md-ripple">开始</button>
                <div class="md-row">
                    <div class="md-input-group">
                        <span class="md-label">间隔</span>
                        <input type="number" id="md-reader-sec" class="md-text-field" value="${cfg.readerSec}" min="1">
                        <span class="md-unit">秒/页</span>
                    </div>
                    <button id="md-btn-apply" class="md-btn md-btn-text md-ripple">保存</button>
                </div>
                <div class="md-row">
                    <span class="md-server-text" id="md-server-time">服务端: --</span>
                    <button id="md-btn-sync" class="md-btn md-btn-text md-ripple">同步</button>
                </div>
                <div class="md-log-header" id="md-log-header">
                    <span class="md-log-title">日志</span>
                    <svg id="md-log-icon" viewBox="0 0 24 24" width="16" height="16" fill="var(--m3-on-surface-variant)"><path d="M7 10l5 5 5-5z"/></svg>
                </div>
                <div class="md-log-container" id="md-log-container"></div>
            </div>
        `;
        document.body.appendChild(p);

        // Snackbar Host
        const snackbar = Object.assign(document.createElement('div'), { id: 'dgut-snackbar' });
        document.body.appendChild(snackbar);

        applyTheme(currentTheme);

        const td = document.getElementById('md-timer');
        const fabTd = document.getElementById('md-fab-timer');
        const bd = document.getElementById('md-book-name');
        const sd = document.getElementById('md-server-time');
        const pb = document.getElementById('md-btn-toggle');
        const sb = document.getElementById('md-btn-sync');
        let lastServerSync = 0;
        const SYNC_INTERVAL = 300;

        // Ripple 效果委托
        document.addEventListener('pointerdown', function(e) {
            const target = e.target.closest('.md-ripple');
            if (!target) return;
            const circle = document.createElement('span');
            const diameter = Math.max(target.clientWidth, target.clientHeight);
            const radius = diameter / 2;
            circle.style.width = circle.style.height = `${diameter}px`;
            circle.style.left = `${e.clientX - target.getBoundingClientRect().left - radius}px`;
            circle.style.top = `${e.clientY - target.getBoundingClientRect().top - radius}px`;
            circle.classList.add('md-ripple-effect');
            target.appendChild(circle);
            setTimeout(() => circle.remove(), 600);
        });

        function showSnackbar(msg) {
            snackbar.textContent = msg;
            snackbar.classList.add('show');
            clearTimeout(snackbar.timeoutId);
            snackbar.timeoutId = setTimeout(() => snackbar.classList.remove('show'), 3000);
        }

        function status(t, active) {
            const dot = document.getElementById('md-status-dot');
            if (dot) dot.classList.toggle('active', !!active);
        }
        
        function log(msg) {
            const c = document.getElementById('md-log-container');
            if(!c) return;
            const n = new Date();
            const t = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
            const l = document.createElement('div');
            l.className = 'md-log-line';
            l.innerHTML = `<span style="opacity:0.5">[${t}]</span> ${msg}`;
            c.appendChild(l);
            c.scrollTop = c.scrollHeight;
            while(c.children.length > 100) c.removeChild(c.firstChild);
        }
        
        function saveCfg() { GM_setValue(KEY, cfg); }
        function updateTimerDisplay(sec) {
            const timeStr = fmt(sec);
            td.textContent = timeStr;
            fabTd.textContent = timeStr;
            const pct = Math.min(100, Math.floor(sec / MIN_BOOK_SEC * 100));
            document.getElementById('md-progress-fill').style.width = pct + '%';
            document.getElementById('md-progress-label').textContent = `目标 4h10m · ${pct}%`;
        }
        
        function getTotal() { return accumulated + Math.floor((Date.now() - sessionStart) / 1000); }
        function persist() { const t = getTotal(); setBookTime(bookKey, t); lastSave = t; log('存档：' + fmt(t)); }

        function syncReader() {
            saveCfg();
            const payload = { type: MSG, intervalSec: cfg.readerSec, autoStart: cfg.readerAutoStart };
            let n = 0;
            Array.from(document.querySelectorAll('iframe')).forEach(f => {
                try { if(f.contentWindow){ f.contentWindow.postMessage(payload, '*'); n++; } } catch(e) {}
            });
            status(n > 0 ? '运行中' : '等待', n > 0);
        }

        function saveReader() {
            const s = parseInt(document.getElementById('md-reader-sec').value,10);
            if (s > 0) { cfg.readerSec = s; syncReader(); log('间隔设为 ' + s + ' 秒'); showSnackbar('设置已保存'); }
            else showSnackbar('请输入大于 0 的数字');
        }

        function solveModal() {
            const b1 = document.querySelector('button.btn-submit');
            if(b1&&b1.offsetParent!==null) { b1.click(); log('关闭弹窗'); }
            const b2 = document.querySelector('#alertModal .btn-submit, .modal.fade.in .btn-hollow, .modal.in .btn-primary');
            if(b2) { const r = b2.getBoundingClientRect(); if (r.width > 0 || r.height > 0) { b2.click(); log('关闭弹窗'); } }
        }

        function solveChapterModal() {
            const modal = document.querySelector('.stat-page.chapter-stat');
            if (!modal) return false;
            const rect = modal.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const btns = modal.querySelectorAll('.stat-next .btn-hollow');
            if (btns.length === 0) return false;
            if (getTotal() < MIN_BOOK_SEC) {
                btns[0].click(); pageStartTime = Date.now(); log('弹窗：未满4h，留本章');
            } else if (btns.length > 1) {
                btns[1].click(); currentPageId = null; pageStartTime = Date.now(); log('弹窗：满4h，切下章');
            } else {
                btns[0].click(); pageStartTime = Date.now(); log('弹窗：满4h，最后一章');
            }
            return true;
        }

        let antiDetectTimer = null;
        function setupAntiDetect() {
            antiDetectTimer = setInterval(() => {
                document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 + Math.random()*500, clientY: 100 + Math.random()*300, bubbles: false }));
            }, 30000);
        }

        function tick() {
            solveModal();
            const modalHandled = solveChapterModal();
            const currentKey = getBookKey();
            if (currentKey !== bookKey) {
                setBookTime(bookKey, getTotal());
                bookKey = currentKey;
                accumulated = getBookTime(bookKey);
                sessionStart = Date.now(); lastSave = accumulated;
                flatListDirty = true; holdPageId = null;
                const dispName = getBookDisplayName();
                bd.textContent = dispName; bd.title = bookKey;
                refreshServerDisplay(); log('当前书目：' + dispName);
            }
            const vm = PAGE_WIN.koLearnCourseViewModel;
            if(!modalHandled && vm && vm.currentPage && cfg.readerAutoStart) {
                const flatList = getFlatList(vm);
                const page = vm.currentPage();
                const pId = pageId(page);
                if(pId && pId !== currentPageId) {
                    const prevPid = currentPageId;
                    const prevIdx = prevPid ? findPageIndex(flatList, prevPid) : -1;
                    const currentIdx = findPageIndex(flatList, pId);
                    const prevItem = prevIdx >= 0 ? flatList[prevIdx] : null;
                    const currentItem = currentIdx >= 0 ? flatList[currentIdx] : null;
                    currentPageId = pId; pageStartTime = Date.now();
                    log(getMoveLabel(prevItem, currentItem) + '：' + formatMoveTarget(currentItem));
                    bd.textContent = getBookDisplayName(); bd.title = bookKey;
                }
                if (getTotal() >= MIN_BOOK_SEC) {
                    if(currentPageId && Date.now() - pageStartTime >= NAV_SEC * 1000) {
                        const next = vm.nextPageName?.();
                        const currentIdx = findPageIndex(flatList, currentPageId);
                        const currentItem = currentIdx >= 0 ? flatList[currentIdx] : null;
                        const nextFlatItem = currentIdx >= 0 && currentIdx < flatList.length - 1 ? flatList[currentIdx + 1] : null;
                        const isNoMore = !next || next === vm.i18nMessageText?.()?.noMore;
                        const crossesSection = !!(currentItem && nextFlatItem && pageId(currentItem.section) !== pageId(nextFlatItem.section));
                        const nextMoveLabel = getMoveLabel(currentItem, nextFlatItem);
                        const isChapterEnd = isNoMore || (next && next.includes('统计')) || crossesSection;
                        if (isChapterEnd) {
                            const result = advanceToNextSection(vm, currentPageId);
                            if (result.success) {
                                holdPageId = null; currentPageId = null; pageStartTime = Date.now();
                                log('满4h，' + result.moveLabel + '：' + result.targetText);
                                showSnackbar('切换至下一书目');
                                setTimeout(function() { syncReader(); }, 1500);
                            } else if (result.atEnd) {
                                stopReading(); log('全部书目已读完'); showSnackbar('全部书目已读完');
                            }
                        } else {
                            vm.goNextPage(); pageStartTime = Date.now();
                            log(nextMoveLabel + '：' + formatMoveTarget(nextFlatItem));
                        }
                    }
                } else { ensureHoldPage(vm, flatList); }
            }
            const total = getTotal();
            updateTimerDisplay(total);
            if (total - lastSave >= SAVE_INTERVAL) persist();
            if (Date.now() - lastServerSync >= SYNC_INTERVAL * 1000) {
                const newAcc = syncServerTime(bookKey, accumulated, log);
                if (newAcc !== accumulated) { sessionStart = Date.now(); lastSave = newAcc; }
                accumulated = newAcc; lastServerSync = Date.now(); refreshServerDisplay();
            }
        }

        function startReading() {
            if (timer) return;
            sessionStart = Date.now();
            timer = setInterval(tick, 1000);
            pb.textContent = '暂停';
            pb.classList.remove('md-btn-filled');
            pb.classList.add('md-btn-tonal');
            cfg.readerAutoStart = true;
            const vm = PAGE_WIN.koLearnCourseViewModel;
            if(vm && vm.currentPage) { currentPageId = pageId(vm.currentPage()); pageStartTime = Date.now(); }
            syncReader(); log('开始阅读'); status('运行中', true);
        }

        function stopReading() {
            if (!timer) return;
            clearInterval(timer); timer = null; persist();
            pb.textContent = '开始';
            pb.classList.remove('md-btn-tonal');
            pb.classList.add('md-btn-filled');
            cfg.readerAutoStart = false; syncReader(); log('暂停阅读'); status('已暂停', false);
        }

        function refreshServerDisplay() {
            try {
                const st = getServerSideBookTimes();
                if (st && st[bookKey]) { sd.textContent = '服务端: ' + fmt(st[bookKey]); return true; }
                else if (st) { sd.textContent = '服务端: 暂无记录'; return true; }
                else { sd.textContent = '服务端: 获取失败'; return false; }
            } catch(e) { sd.textContent = '服务端: 出错'; return false; }
        }

        function doSync() {
            refreshServerDisplay();
            const before = accumulated;
            accumulated = syncServerTime(bookKey, accumulated, log);
            sessionStart = Date.now(); lastSave = accumulated; lastServerSync = Date.now();
            updateTimerDisplay(accumulated); refreshServerDisplay();
            if (accumulated > before) { log('已从服务端同步'); showSnackbar('同步成功：' + fmt(accumulated)); }
            else { log('服务端数据已是最新'); showSnackbar('服务端数据已是最新'); }
        }

        function buildFlatPageList(vm) {
            const course = koUnwrap(vm.course); const chapters = koUnwrap(course.chapters);
            if (!chapters) return [];
            const flatList = [];
            chapters.forEach(function(chapter) {
                const sections = koUnwrap(chapter.sections); if (!sections) return;
                sections.forEach(function(section) {
                    if (koUnwrap(section.isHide)) return;
                    const pages = koUnwrap(section.pages); if (!pages) return;
                    pages.forEach(function(page) { flatList.push({ page: page, section: section, chapter: chapter }); });
                });
            });
            return flatList;
        }
        function findPageIndex(flatList, pid) { return flatList.findIndex(function(item) { return String(pageId(item.page)) === String(pid); }); }
        function advanceToNextSection(vm, currentPageId) {
            const flatList = getFlatList(vm); const currentIdx = findPageIndex(flatList, currentPageId);
            if (currentIdx >= 0 && currentIdx < flatList.length - 1) {
                const current = flatList[currentIdx]; const next = flatList[currentIdx + 1];
                vm.selectPage(next.page, next.section, next.chapter);
                return { success: true, moveLabel: getMoveLabel(current, next), targetText: formatMoveTarget(next) };
            }
            return { success: false, atEnd: flatList.length > 0 };
        }
        function ensureHoldPage(vm, flatList) {
            if (!currentPageId) return;
            const currentIdx = findPageIndex(flatList, currentPageId); if (currentIdx < 0) return;
            const currentItem = flatList[currentIdx]; const secId = pageId(currentItem.section);
            const sameSectionItems = flatList.filter(function(item) { return pageId(item.section) === secId; });
            if (sameSectionItems.length === 0) return;
            if (!isPageComplete(currentItem.page)) {
                if (holdPageId !== currentPageId) { holdPageId = currentPageId; log('未满4h，停留：' + trimName(koUnwrap(currentItem.page.name))); }
                return;
            }
            let target = sameSectionItems.find(function(item) { return !isPageComplete(item.page); });
            if (!target) target = sameSectionItems[sameSectionItems.length - 1];
            const targetPid = pageId(target.page);
            if (targetPid === currentPageId) { holdPageId = currentPageId; return; }
            if (holdPageId === targetPid) return;
            vm.selectPage(target.page, target.section, target.chapter);
            holdPageId = targetPid; currentPageId = null; pageStartTime = Date.now();
            log('未满4h，切并停留：' + trimName(koUnwrap(target.page.name)));
            setTimeout(function() { syncReader(); }, 1500);
        }

        // Drag Logic
        const onDragMove = e => {
            const l = e.clientX-dx, t = e.clientY-dy;
            Object.assign(p.style, { left: l+'px', right: 'auto', top: t+'px' });
            cfg.posX = Math.max(0, window.innerWidth-(l+p.offsetWidth));
            cfg.posY = Math.max(0, t);
            p.classList.add('dragging');
        };
        const onDragUp = () => {
            drag = false; p.classList.remove('dragging');
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragUp);
            saveCfg();
        };
        document.getElementById('md-drag-handle').addEventListener('mousedown', e => {
            if(e.target.closest('button')) return; // Prevent drag when clicking buttons
            drag = true; dx = e.clientX-p.offsetLeft; dy = e.clientY-p.offsetTop;
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragUp);
        });

        // Event Bindings
        document.getElementById('md-btn-theme').addEventListener('click', () => {
            const next = currentTheme === 'light' ? 'dark' : currentTheme === 'dark' ? 'auto' : 'light';
            applyTheme(next);
            showSnackbar('主题已切换：' + next);
        });

        document.getElementById('md-btn-collapse').addEventListener('click', () => {
            p.classList.add('collapsed');
        });
        document.getElementById('md-btn-expand').addEventListener('click', () => {
            p.classList.remove('collapsed');
        });

        document.getElementById('md-reader-sec').addEventListener('keydown', e => { if(e.key==='Enter') saveReader(); });
        document.getElementById('md-btn-apply').addEventListener('click', saveReader);
        pb.addEventListener('click', () => { timer ? stopReading() : startReading(); });
        sb.addEventListener('click', doSync);

        document.getElementById('md-log-header').addEventListener('click', function() {
            const c = document.getElementById('md-log-container');
            const i = document.getElementById('md-log-icon');
            c.classList.toggle('collapsed');
            i.style.transform = c.classList.contains('collapsed') ? 'rotate(0deg)' : 'rotate(180deg)';
        });

        updateTimerDisplay(accumulated);
        log('DGUT MD3 阅读助手已启动');
        log('当前书目：' + getBookDisplayName());
        if(cfg.readerAutoStart) { startReading(); } else { sessionStart = Date.now(); pb.textContent = '开始'; }
        syncReader();
        
        window.addEventListener('message', function(e) { if (e.data && e.data.type === 'DGUT_LOG') { log('[iframe] ' + e.data.text); } });
        setupAntiDetect();
        
        let startupSyncRetries = 0;
        function startupSync() {
            const newAcc = syncServerTime(bookKey, accumulated, null);
            if (newAcc !== accumulated || startupSyncRetries === 0) {
                if (newAcc !== accumulated) { sessionStart = Date.now(); lastSave = newAcc; }
                accumulated = newAcc; lastServerSync = Date.now(); updateTimerDisplay(accumulated);
            }
            const hasServerData = refreshServerDisplay();
            if (!hasServerData && startupSyncRetries < 10) { startupSyncRetries++; setTimeout(startupSync, 3000); }
            else if (hasServerData) { log('服务端时长已同步'); }
        }
        setTimeout(startupSync, 3000);
        window.addEventListener('load', () => { setTimeout(syncReader,1200); setTimeout(syncReader,2600); }, { once: true });
    }

    // --- 辅助函数补充 ---
    function getFlatList(vm) {
        // 此函数在 initHost 内部被重写覆盖，这里是外部预声明防止报错
        return [];
    }
    function pageId(page) { if (!page) return null; return typeof page.id === 'function' ? page.id() : page.id; }
    function isPageComplete(page) { try { const record = koUnwrap(page.record); return record ? !!koUnwrap(record.status) : false; } catch(e) { return false; } }
    function getMoveLabel(fromItem, toItem) {
        if (!fromItem || !toItem) return '切换';
        if (pageId(fromItem.chapter) !== pageId(toItem.chapter)) return '切换下一章';
        if (pageId(fromItem.section) !== pageId(toItem.section)) return '切换下一本书';
        return '切换下一节';
    }
    function formatMoveTarget(item) {
        if (!item) return '(未知)';
        const chapterName = trimName(koUnwrap(item.chapter && item.chapter.name));
        const sectionName = trimName(koUnwrap(item.section && item.section.name));
        const pageName = trimName(koUnwrap(item.page && item.page.name));
        if (chapterName && sectionName) return chapterName + ' / ' + sectionName + ' - ' + pageName;
        if (sectionName) return sectionName + ' - ' + pageName;
        return pageName || '(未知)';
    }

    // --- 阅读器 iframe 页 ---

    function initReader() {
        if(window.__DGUT_SINGLE_FILE_READER_INITED__) return;
        window.__DGUT_SINGLE_FILE_READER_INITED__ = true;
        let timer = null, state, lastFlipLogAt = 0, lastLoopBack = 0;
        const LOG = 'DGUT_LOG';

        function rlog(msg) {
            console.log('[DGUT Reader]', msg);
            try { window.parent.postMessage({ type: LOG, text: msg }, '*'); } catch(e) {}
        }

        function clickNext() {
            const b = document.querySelector('#nextBtn');
            if(!b || b.style.display === 'none' || b.disabled) return;
            const pageIdxEl = document.getElementById('pageIndex');
            const pageCntEl = document.getElementById('pageCount');
            if (pageIdxEl && pageCntEl) {
                const cur = parseInt(pageIdxEl.innerHTML, 10);
                const total = parseInt(pageCntEl.innerHTML, 10);
                if (total > 0 && cur >= total) {
                    const now = Date.now();
                    if (now - lastLoopBack < 3000) return;
                    lastLoopBack = now;
                    try {
                        const pw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                        if (typeof pw.goPage === 'function') { pw.goPage(0); }
                        else if (typeof goPage === 'function') { goPage(0); }
                        else {
                            const s = document.createElement('script');
                            s.textContent = 'goPage(0);';
                            document.head.appendChild(s);
                            setTimeout(function() { if (s.parentNode) s.parentNode.removeChild(s); }, 100);
                        }
                        lastFlipLogAt = 0; rlog('已至末页，回到第一页循环'); return;
                    } catch(e) { rlog('回到第一页失败：' + e.message); }
                }
            }
            b.click();
            const now = Date.now();
            if (now - lastFlipLogAt >= 60000) { lastFlipLogAt = now; rlog('翻页'); }
        }
        function stop() { if(!timer) return; clearInterval(timer); timer = null; rlog('翻页定时器已停止'); }
        function start(s) { if(timer) return; timer = setInterval(clickNext, s*1000); rlog('翻页定时器已启动：' + s + '秒/页'); }
        function apply(s, auto) { stop(); if(auto!==false) start(s); }

        window.addEventListener('message', e => {
            const d = e.data;
            if(!d||d.type!==MSG) return;
            state = readCfg();
            const sec = parseInt(d.intervalSec, 10);
            state.readerSec = sec > 0 ? sec : D.readerSec;
            state.readerAutoStart = d.autoStart !== false;
            GM_setValue(KEY, state);
            rlog('收到同步：' + sec + '秒/页，' + (state.readerAutoStart ? '自动' : '暂停'));
            apply(state.readerSec, state.readerAutoStart);
        });

        function tryStart() { state = readCfg(); apply(state.readerSec, state.readerAutoStart); }
        if (document.readyState === 'complete') { setTimeout(tryStart, 500); }
        else { window.addEventListener('load', () => setTimeout(tryStart, 1200), { once: true }); }
    }

    function bootstrapReader() {
        const init = () => document.querySelector('#nextBtn') ? (initReader(), true) : false;
        if(init()) { console.log('[DGUT Reader] 阅读器已连接'); return; }
        let n = 0, t = setInterval(() => { n++; if(init()||n>=20) clearInterval(t); }, 500);
        window.addEventListener('load', () => setTimeout(init, 1200), { once: true });
    }
})();
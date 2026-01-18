/**
 * Too Many Chats - SillyTavern Extension
 * Organizes chats per character into collapsible folders
 * v1.0.0 - Early Release
 * @author chaaruze
 * @version 1.0.0
 */

(function () {
    'use strict';

    const MODULE_NAME = 'chat_folders';
    const EXTENSION_NAME = 'Too Many Chats';

    const defaultSettings = Object.freeze({
        folders: {},
        characterFolders: {},
        version: '1.0.0'
    });

    let observer = null;
    let syncDebounceTimer = null;

    // ========== SETTINGS ==========

    function getSettings() {
        const context = SillyTavern.getContext();
        const { extensionSettings } = context;

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        }

        for (const key of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
                extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
            }
        }

        return extensionSettings[MODULE_NAME];
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    // ========== HELPERS ==========

    function generateId() {
        return 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    function getCurrentCharacterId() {
        const context = SillyTavern.getContext();
        if (context.characterId !== undefined && context.characters[context.characterId]) {
            return context.characters[context.characterId].avatar || context.characters[context.characterId].name;
        }
        return null;
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diff = now - date;
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));

            if (days === 0) return 'Today';
            if (days === 1) return 'Yesterday';
            if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' });
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    }

    function extractChatTitle(fileName) {
        if (!fileName) return 'Untitled';
        // Remove .jsonl extension and clean up
        return fileName.replace(/\.jsonl$/i, '').trim() || 'Untitled';
    }


    function createFolder(name) {
        if (!name || !name.trim()) return;
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) {
            toastr.warning('Please select a character first');
            return;
        }

        const folderId = generateId();
        const existingCount = (settings.characterFolders[characterId] || []).length;

        settings.folders[folderId] = {
            name: name.trim(),
            chats: [],
            collapsed: false,
            order: existingCount
        };

        if (!settings.characterFolders[characterId]) settings.characterFolders[characterId] = [];
        settings.characterFolders[characterId].push(folderId);

        saveSettings();
        scheduleSync();
    }

    function renameFolder(folderId, newName) {
        if (!newName || !newName.trim()) return;
        const settings = getSettings();
        if (settings.folders[folderId]) {
            settings.folders[folderId].name = newName.trim();
            saveSettings();
            scheduleSync();
        }
    }

    function deleteFolder(folderId) {
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) return;

        const charFolders = settings.characterFolders[characterId];
        if (charFolders) {
            const idx = charFolders.indexOf(folderId);
            if (idx > -1) charFolders.splice(idx, 1);
        }

        delete settings.folders[folderId];
        saveSettings();
        scheduleSync();
    }

    function moveChat(fileName, targetFolderId) {
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) return;

        const allFolderIds = settings.characterFolders[characterId] || [];
        for (const fid of allFolderIds) {
            const folder = settings.folders[fid];
            if (folder && folder.chats) {
                const idx = folder.chats.indexOf(fileName);
                if (idx > -1) folder.chats.splice(idx, 1);
            }
        }

        if (targetFolderId && targetFolderId !== 'uncategorized') {
            const folder = settings.folders[targetFolderId];
            if (folder) {
                if (!folder.chats) folder.chats = [];
                folder.chats.push(fileName);
            }
        }

        saveSettings();
        scheduleSync();
    }

    function getFolderForChat(fileName) {
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) return 'uncategorized';

        const folderIds = settings.characterFolders[characterId] || [];
        for (const fid of folderIds) {
            const folder = settings.folders[fid];
            if (folder && folder.chats && folder.chats.includes(fileName)) {
                return fid;
            }
        }
        return 'uncategorized';
    }

    // ========== SYNC ENGINE ==========

    function scheduleSync() {
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        // PERFORMANCE FIX: Increased to 200ms to prevent UI lag
        // 15ms was too aggressive and caused constant re-rendering
        syncDebounceTimer = setTimeout(performSync, 200);
    }

    function performSync() {
        try {
            const popups = [
                document.querySelector('#shadow_select_chat_popup'),
                document.querySelector('#select_chat_popup')
            ];

            const popup = popups.find(p => p && getComputedStyle(p).display !== 'none');
            if (!popup) return;

            const nativeBlocks = Array.from(popup.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)'));

            const chatData = nativeBlocks.map(block => {
                const fileName = block.getAttribute('file_name') || block.title || block.innerText.split('\n')[0].trim();
                // Try to extract date from the block
                const dateEl = block.querySelector('.select_chat_block_date, [title*="20"]');
                const dateStr = dateEl ? dateEl.textContent || dateEl.title : '';

                return {
                    element: block,
                    fileName,
                    title: extractChatTitle(fileName),
                    date: formatDate(dateStr),
                    html: block.innerHTML // Full native content with buttons
                };
            }).filter(d => d.fileName);

            let proxyRoot = popup.querySelector('#tmc_proxy_root');
            if (!proxyRoot) {
                proxyRoot = document.createElement('div');
                proxyRoot.id = 'tmc_proxy_root';

                const body = popup.querySelector('.shadow_select_chat_popup_body') || popup;
                const searchBar = popup.querySelector('input[type="search"], input[type="text"], .search_input');

                if (searchBar && searchBar.parentNode) {
                    const searchContainer = searchBar.closest('.shadow_select_chat_popup_header') || searchBar.parentNode;
                    if (searchContainer.nextSibling) {
                        searchContainer.parentNode.insertBefore(proxyRoot, searchContainer.nextSibling);
                    } else {
                        searchContainer.parentNode.appendChild(proxyRoot);
                    }
                } else {
                    body.insertBefore(proxyRoot, body.firstChild);
                }
            }

            const newTree = document.createDocumentFragment();
            const characterId = getCurrentCharacterId();
            const settings = getSettings();

            if (!characterId) {
                proxyRoot.innerHTML = '<div style="padding:12px;opacity:0.6">Select a character</div>';
                return;
            }

            const folderIds = settings.characterFolders[characterId] || [];
            const folderContents = {};

            folderIds.forEach(fid => {
                const folder = settings.folders[fid];
                if (!folder) return;
                const section = createFolderDOM(fid, folder);
                newTree.appendChild(section);
                folderContents[fid] = section.querySelector('.tmc_content');
            });

            const uncatSection = createUncategorizedDOM();
            newTree.appendChild(uncatSection);
            folderContents['uncategorized'] = uncatSection.querySelector('.tmc_content');

            chatData.forEach(chat => {
                const fid = getFolderForChat(chat.fileName);
                const container = folderContents[fid] || folderContents['uncategorized'];
                const proxy = createProxyBlock(chat);
                container.appendChild(proxy);
            });

            Object.keys(folderContents).forEach(fid => {
                const container = folderContents[fid];
                const count = container.children.length;
                const section = container.closest('.tmc_section');

                const badge = section.querySelector('.tmc_count');
                if (badge) badge.textContent = count;

                if (fid === 'uncategorized') {
                    section.style.display = count > 0 ? '' : 'none';
                }
            });

            proxyRoot.innerHTML = '';
            proxyRoot.appendChild(newTree);

            injectAddButton(popup);

        } catch (err) {
            console.error('[TMC] Sync Error:', err);
        }
    }

    function createFolderDOM(fid, folder) {
        const section = document.createElement('div');
        section.className = 'tmc_section';
        section.dataset.id = fid;
        section.dataset.collapsed = folder.collapsed ? 'true' : 'false';

        const header = document.createElement('div');
        header.className = 'tmc_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_toggle"><i class="fa-solid fa-chevron-down"></i></span>
                <span class="tmc_icon"><i class="fa-solid fa-folder"></i></span>
                <span class="tmc_name">${escapeHtml(folder.name)}</span>
                <span class="tmc_count">0</span>
            </div>
            <div class="tmc_header_right">
                <span class="tmc_btn tmc_edit" title="Rename"><i class="fa-solid fa-pencil"></i></span>
                <span class="tmc_btn tmc_del" title="Delete"><i class="fa-solid fa-trash"></i></span>
            </div>
        `;

        header.querySelector('.tmc_header_left').onclick = () => {
            const s = getSettings();
            if (s.folders[fid]) {
                s.folders[fid].collapsed = !s.folders[fid].collapsed;
                saveSettings();
                scheduleSync();
            }
        };

        header.querySelector('.tmc_edit').onclick = (e) => {
            e.stopPropagation();
            const n = prompt('Rename:', folder.name);
            if (n) renameFolder(fid, n);
        };

        header.querySelector('.tmc_del').onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Delete "${folder.name}"?`)) deleteFolder(fid);
        };

        const content = document.createElement('div');
        content.className = 'tmc_content';
        content.style.display = folder.collapsed ? 'none' : '';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

    function createUncategorizedDOM() {
        const section = document.createElement('div');
        section.className = 'tmc_section tmc_uncat';
        section.dataset.id = 'uncategorized';

        const header = document.createElement('div');
        header.className = 'tmc_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_icon"><i class="fa-regular fa-comments"></i></span>
                <span class="tmc_name">Your chats</span>
                <span class="tmc_count">0</span>
            </div>
        `;

        const content = document.createElement('div');
        content.className = 'tmc_content';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

    // Proxy block with FULL native content (buttons, preview, etc.)
    function createProxyBlock(chatData) {
        const el = document.createElement('div');
        el.className = 'select_chat_block tmc_proxy_block';

        // Use full native HTML content (includes preview, buttons, etc.)
        el.innerHTML = chatData.html;
        el.title = chatData.fileName;
        el.setAttribute('file_name', chatData.fileName);

        // FIX: Move pencil icon to the right side with other action buttons
        const pencilBtn = el.querySelector('.renameChatButton');
        const actionContainer = el.querySelector('.flex-container.gap10px') ||
            el.querySelector('[class*="action"]') ||
            el.querySelector('.select_chat_info')?.parentElement;
        if (pencilBtn && actionContainer) {
            // Move pencil to the action container (right side)
            actionContainer.insertBefore(pencilBtn, actionContainer.firstChild);
        }

        // Intercept main click (not on buttons)
        el.addEventListener('click', (e) => {
            // Don't intercept if clicking on action buttons
            if (e.target.closest('.renameChatButton, .select_chat_block_action, .mes_edit, .mes_delete, .mes_export, button, a, [class*="export"], [class*="delete"], [class*="download"]')) {
                // Find corresponding button in hidden original and click it
                const clickedClass = e.target.closest('[class]')?.className;
                if (clickedClass) {
                    const originalBtn = chatData.element.querySelector('.' + clickedClass.split(' ')[0]);
                    if (originalBtn) {
                        originalBtn.click();
                        return;
                    }
                }
            }
            // Otherwise load the chat
            chatData.element.click();
        });

        el.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e, chatData.fileName);
        };

        return el;
    }

    function injectAddButton(popup) {
        if (popup.querySelector('.tmc_add_btn')) return;

        // FIX: Use correct selector - native SillyTavern uses [name="selectChatPopupHeader"]
        const headerRow = popup.querySelector('[name="selectChatPopupHeader"]') ||
            popup.querySelector('.flex-container.alignitemscenter') ||
            popup.querySelector('h3');
        if (!headerRow) {
            console.warn('[TMC] Could not find header row for New Folder button');
            return;
        }

        const btn = document.createElement('div');
        btn.className = 'tmc_add_btn';  // Remove menu_button to avoid conflicts
        btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i> New Folder';
        btn.title = 'Create New Folder';
        // Apply full inline styles to ensure they work regardless of specificity
        btn.style.cssText = `
            display: flex !important;
            align-items: center !important;
            gap: 5px !important;
            padding: 5px 10px !important;
            margin: 0 5px !important;
            background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.3)) !important;
            border: 1px solid var(--SmartThemeBorderColor, #555) !important;
            border-radius: 5px !important;
            color: var(--SmartThemeBodyColor, #fff) !important;
            font-size: 13px !important;
            cursor: pointer !important;
            white-space: nowrap !important;
        `;
        btn.onmouseenter = () => {
            btn.style.background = 'var(--SmartThemeQuoteColor, rgba(100,100,100,0.5))';
        };
        btn.onmouseleave = () => {
            btn.style.background = 'var(--SmartThemeBlurTintColor, rgba(0,0,0,0.3))';
        };
        btn.onclick = (e) => {
            e.stopPropagation();
            const n = prompt('New Folder Name:');
            if (n) createFolder(n);
        };
        // Insert right after "New Chat" button
        const newChatBtn = headerRow.querySelector('#newChatFromManageScreenButton');
        if (newChatBtn && newChatBtn.nextSibling) {
            headerRow.insertBefore(btn, newChatBtn.nextSibling);
        } else {
            // Fallback: insert at beginning
            headerRow.insertBefore(btn, headerRow.firstChild);
        }
    }

    // ========== CONTEXT MENU ==========

    function showContextMenu(e, fileName) {
        document.querySelectorAll('.tmc_ctx').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'tmc_ctx';
        menu.style.top = e.pageY + 'px';
        menu.style.left = e.pageX + 'px';

        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        const folderIds = settings.characterFolders[characterId] || [];

        let html = '<div class="tmc_ctx_head">Move to</div>';
        folderIds.forEach(fid => {
            const f = settings.folders[fid];
            html += `<div class="tmc_ctx_item" data-fid="${fid}">📁 ${escapeHtml(f.name)}</div>`;
        });
        html += '<div class="tmc_ctx_sep"></div>';
        html += '<div class="tmc_ctx_item" data-fid="uncategorized">💬 Your chats</div>';
        // New Folder button is now in the header, removed from here

        menu.innerHTML = html;
        document.body.appendChild(menu);

        menu.onclick = (ev) => {
            const item = ev.target.closest('.tmc_ctx_item');
            if (!item) return;
            // Only "Move to folder" actions remain
            moveChat(fileName, item.dataset.fid);
            menu.remove();
        };

        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
        }, 50);
    }

    // ========== OBSERVER ==========

    function initObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver((mutations) => {
            let needsSync = false;
            for (const m of mutations) {
                // IGNORE our own proxy elements
                if (m.target.closest && m.target.closest('#tmc_proxy_root')) continue;
                if (m.target.classList && m.target.classList.contains('tmc_proxy_block')) continue;

                if (m.target.classList?.contains('select_chat_block_wrapper')) {
                    needsSync = true;
                    break;
                }
                if (m.target.id === 'shadow_select_chat_popup' || m.target.id === 'select_chat_popup') {
                    needsSync = true;
                    break;
                }
            }
            if (needsSync) scheduleSync();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'id']
        });
    }

    // ========== INIT ==========

    function init() {
        console.log(`[${EXTENSION_NAME}] v2.1.0 Loading...`);
        const ctx = SillyTavern.getContext();

        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, scheduleSync);

        // Faster heartbeat
        setInterval(() => {
            const popup = document.querySelector('#shadow_select_chat_popup') || document.querySelector('#select_chat_popup');
            if (popup && getComputedStyle(popup).display !== 'none') {
                const proxy = popup.querySelector('#tmc_proxy_root');
                if (!proxy || proxy.children.length === 0) {
                    scheduleSync();
                }
            }
        }, 500);

        initObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

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
        pinned: {},
        showRecent: true,
        version: '1.1.0'
    });

    let observer = null;
    let syncDebounceTimer = null;
    let bulkMode = false;
    let selectedChats = new Set();
    // Helper to clear selection
    function clearSelection() {
        selectedChats.clear();
        bulkMode = false;
        updateBulkBar();
        scheduleSync();
    }

    // ========== STYLES ==========
    // Extended to support raw hexes in logic
    const FOLDER_COLORS = {
        'red': '#ff6b6b',
        'orange': '#ffa94d',
        'yellow': '#ffec99',
        'green': '#69db7c',
        'blue': '#4dabf7',
        'purple': '#b197fc',
        'pink': '#fcc2d7',
        'default': 'transparent'
    };

    let userOpenedPanel = false;  // Track if user intentionally opened the panel

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
        return 'folder_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
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

    function setFolderColor(folderId, colorKeyOrHex) {
        const settings = getSettings();
        if (settings.folders[folderId]) {
            // Check if it's a key in FOLDER_COLORS, otherwise treat as hex
            if (FOLDER_COLORS[colorKeyOrHex]) {
                settings.folders[folderId].color = colorKeyOrHex;
            } else {
                // It is a hex from picker
                settings.folders[folderId].color = colorKeyOrHex;
            }
            saveSettings();
            scheduleSync();
        }
    }

    function togglePin(fileName) {
        const settings = getSettings();
        if (!settings.pinned) settings.pinned = {};

        if (settings.pinned[fileName]) {
            delete settings.pinned[fileName];
        } else {
            settings.pinned[fileName] = true;
        }
        saveSettings();
        scheduleSync();
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
        // Only sync if user has opened the panel
        if (!userOpenedPanel) return;

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

            if (!characterId) {
                proxyRoot.innerHTML = '<div style="padding:12px;opacity:0.6">Select a character</div>';
                return;
            }

            const folderContents = {};
            const folderIds = settings.characterFolders[characterId] || [];

            // SMART FOLDER: Recent
            if (settings.showRecent !== false) {
                const recentSection = createRecentDOM();
                newTree.appendChild(recentSection);
                folderContents['recent'] = recentSection.querySelector('.tmc_content');
            }

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
                const isPinned = settings.pinned && settings.pinned[chat.fileName];

                // 1. Regular Folder Logic
                const fid = getFolderForChat(chat.fileName);
                const container = folderContents[fid] || folderContents['uncategorized'];
                const proxy = createProxyBlock(chat, isPinned);

                if (isPinned) {
                    // Pinned items go to the top
                    container.insertBefore(proxy, container.firstChild);
                } else {
                    container.appendChild(proxy);
                }

                // 2. Smart Recent Logic (Cloned item)
                if (folderContents['recent']) {
                    if (chat.date === 'Today' || chat.date === 'Yesterday') {
                        const recentProxy = createProxyBlock(chat, isPinned);
                        // Differentiate ID to avoid dupes if we used IDs (we don't)
                        recentProxy.classList.add('tmc_recent_clone');
                        folderContents['recent'].appendChild(recentProxy);
                    }
                }
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
                <span class="tmc_btn tmc_color" title="Color"><i class="fa-solid fa-palette"></i></span>
                <span class="tmc_btn tmc_edit" title="Rename"><i class="fa-solid fa-pencil"></i></span>
                <span class="tmc_btn tmc_del" title="Delete"><i class="fa-solid fa-trash"></i></span>
            </div>
        `;

        // Apply Color
        if (folder.color) {
            // It could be a key or a raw hex
            const c = FOLDER_COLORS[folder.color] || folder.color;
            if (c && c !== 'transparent') {
                header.style.borderLeft = `4px solid ${c}`;
                header.style.background = `${c}22`; // Low opacity background
            }
        }

        // Hidden color input - must use visibility:hidden, not display:none for clicks to work reliably
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.style.cssText = 'visibility: hidden; position: absolute; width: 0; height: 0; pointer-events: none;';
        colorInput.value = (folder.color && FOLDER_COLORS[folder.color] && FOLDER_COLORS[folder.color] !== 'transparent')
            ? FOLDER_COLORS[folder.color]
            : '#ffffff';

        section.appendChild(colorInput);

        header.querySelector('.tmc_color').onclick = (e) => {
            e.stopPropagation();
            colorInput.click();
        };

        colorInput.onchange = (e) => {
            // WE need to save the custom HEX or map it to closest? 
            // The prompt asked for keys (red, blue). 
            // User requested "picker". 
            // We should support custom hexes in setFolderColor now.
            // But FOLDER_COLORS is a map.
            // Let's modify setFolderColor to handle direct hex or extend the map?
            // Easiest: Just use the hex directly if it doesn't match a key.
            const val = e.target.value;
            setFolderColor(fid, val);
        };

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

    function createRecentDOM() {
        const section = document.createElement('div');
        section.className = 'tmc_section tmc_recent';
        // Virtual ID, not in settings (unless we want to save collapse state later)
        section.dataset.id = 'recent';

        const header = document.createElement('div');
        header.className = 'tmc_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_icon"><i class="fa-solid fa-clock-rotate-left"></i></span>
                <span class="tmc_name">Recent</span>
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
    // Proxy block with FULL native content (buttons, preview, etc.)
    function createProxyBlock(chatData, isPinned) {
        const el = document.createElement('div');
        el.className = 'select_chat_block tmc_proxy_block';
        if (isPinned) el.classList.add('tmc_pinned');

        // Use full native HTML content (includes preview, buttons, etc.)
        el.innerHTML = chatData.html;
        el.title = chatData.fileName;
        el.setAttribute('file_name', chatData.fileName);

        // Render Pin Visual
        if (isPinned) {
            const pinIcon = document.createElement('span');
            pinIcon.className = 'tmc_pin_icon';
            pinIcon.innerHTML = '📌';
            pinIcon.style.cssText = 'font-size: 12px; margin-right: 5px; opacity: 0.8;';

            // Insert before title or at start
            const titleEl = el.querySelector('.select_chat_block_title') || el.querySelector('.avatar_title_div');
            if (titleEl) {
                titleEl.prepend(pinIcon);
            } else {
                el.prepend(pinIcon);
            }
        }

        // BULK MODE VISUALS
        if (bulkMode) {
            const check = document.createElement('div');
            check.className = 'tmc_bulk_check';
            check.innerHTML = selectedChats.has(chatData.fileName) ? '<i class="fa-solid fa-square-check"></i>' : '<i class="fa-regular fa-square"></i>';
            el.prepend(check);

            if (selectedChats.has(chatData.fileName)) {
                el.classList.add('tmc_selected');
            }
        }

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
                // ... existing button logic
                const clickedClass = e.target.closest('[class]')?.className;
                if (clickedClass) {
                    const originalBtn = chatData.element.querySelector('.' + clickedClass.split(' ')[0]);
                    if (originalBtn) originalBtn.click();
                }
                return;
            }

            // BULK MODE LOGIC
            if (bulkMode) {
                e.stopPropagation();
                e.preventDefault();
                if (selectedChats.has(chatData.fileName)) {
                    selectedChats.delete(chatData.fileName);
                } else {
                    selectedChats.add(chatData.fileName);
                }
                scheduleSync(); // Re-render to show selection
                updateBulkBar();
                return;
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

        // New Folder Button
        const btn = document.createElement('div');
        btn.className = 'tmc_add_btn';  // Remove menu_button to avoid conflicts
        btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i> New Folder';
        btn.title = 'Create New Folder';

        btn.onclick = (e) => {
            e.stopPropagation();
            const n = prompt('New Folder Name:');
            if (n) createFolder(n);
        };

        // Bulk Select Button
        const bulkBtn = document.createElement('div');
        bulkBtn.className = 'tmc_add_btn tmc_bulk_btn';
        bulkBtn.innerHTML = '<i class="fa-solid fa-list-check"></i> Select';
        bulkBtn.title = 'Select Multiple Chats';
        bulkBtn.onclick = (e) => {
            e.stopPropagation();
            bulkMode = !bulkMode;
            if (!bulkMode) selectedChats.clear();
            scheduleSync();
            updateBulkBar();
        };

        // Insert right after "New Chat" button
        const newChatBtn = headerRow.querySelector('#newChatFromManageScreenButton');
        if (newChatBtn && newChatBtn.nextSibling) {
            headerRow.insertBefore(bulkBtn, newChatBtn.nextSibling);
            headerRow.insertBefore(btn, bulkBtn);
        } else {
            // Fallback: insert at beginning
            headerRow.insertBefore(bulkBtn, headerRow.firstChild);
            headerRow.insertBefore(btn, bulkBtn);
        }
    }

    function updateBulkBar() {
        let bar = document.querySelector('#tmc_bulk_bar');
        if (!bulkMode) {
            if (bar) bar.remove();
            return;
        }

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'tmc_bulk_bar';
            document.body.appendChild(bar);
        }

        const count = selectedChats.size;
        bar.innerHTML = `
            <div class="tmc_bulk_info">${count} Selected</div>
            <div class="tmc_bulk_actions">
                <button id="tmc_bulk_move" ${count === 0 ? 'disabled' : ''}><i class="fa-solid fa-folder-open"></i> Move</button>
                <button id="tmc_bulk_del" ${count === 0 ? 'disabled' : ''} style="background:var(--SmartThemeRed);color:#fff;"><i class="fa-solid fa-trash"></i> Delete</button>
                <button id="tmc_bulk_cancel">Cancel</button>
            </div>
        `;

        bar.querySelector('#tmc_bulk_cancel').onclick = clearSelection;

        bar.querySelector('#tmc_bulk_move').onclick = (e) => {
            if (count === 0) return;
            // Hacky: reuse render context menu logic but for bulk
            // We pass a dummy event to position it center or just list folders
            showContextMenu(e, null, true); // true = bulk mode
        };

        bar.querySelector('#tmc_bulk_del').onclick = async (e) => {
            if (count === 0) return;
            if (!confirm(`Delete ${count} chats? You may need to confirm native popups for each.`)) return;

            // Iterate and trigger native delete
            // We need to find the NATIVE blocks, not our proxies
            const popup = document.querySelector('#shadow_select_chat_popup') || document.querySelector('#select_chat_popup');
            if (!popup) return;

            const nativeBlocks = Array.from(popup.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)'));

            for (const fileName of selectedChats) {
                const block = nativeBlocks.find(b => {
                    const f = b.getAttribute('file_name') || b.title;
                    return f === fileName || (b.innerText && b.innerText.includes(fileName));
                });
                if (block) {
                    const delBtn = block.querySelector('.mes_delete, [class*="delete"]');
                    if (delBtn) {
                        delBtn.click();
                        // Small delay to let UI process if needed, though native confirm usually blocks
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            }
            clearSelection();
        };
    }

    // ========== CONTEXT MENU ==========

    // ========== CONTEXT MENU ==========

    function showContextMenu(e, fileName, isBulk = false) {
        document.querySelectorAll('.tmc_ctx').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'tmc_ctx';

        // Position centering if bulk
        if (isBulk) {
            menu.style.top = '50%';
            menu.style.left = '50%';
            menu.style.transform = 'translate(-50%, -50%)';
            menu.style.position = 'fixed';
            menu.style.maxHeight = '80vh';
            menu.style.overflowY = 'auto';
        } else {
            menu.style.top = e.pageY + 'px';
            menu.style.left = e.pageX + 'px';
        }

        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        const folderIds = settings.characterFolders[characterId] || [];

        let html = '<div class="tmc_ctx_head">' + (isBulk ? `Move ${selectedChats.size} chats to...` : 'Actions') + '</div>';

        if (!isBulk) {
            // Pin option
            const pinText = (getSettings().pinned && getSettings().pinned[fileName]) ? 'Unpin' : 'Pin to top';
            html += `<div class="tmc_ctx_item" data-action="pin">📌 ${pinText}</div>`;
            html += '<div class="tmc_ctx_sep"></div>';
            html += '<div class="tmc_ctx_head">Move to</div>';
        }

        folderIds.forEach(fid => {
            const f = settings.folders[fid];
            html += `<div class="tmc_ctx_item" data-fid="${fid}">📁 ${escapeHtml(f.name)}</div>`;
        });
        html += '<div class="tmc_ctx_sep"></div>';
        html += '<div class="tmc_ctx_item" data-fid="uncategorized">💬 Your chats</div>';

        menu.innerHTML = html;
        document.body.appendChild(menu);

        menu.onclick = (ev) => {
            const item = ev.target.closest('.tmc_ctx_item');
            if (!item) return;

            if (isBulk) {
                const targetFid = item.dataset.fid;
                selectedChats.forEach(file => moveChat(file, targetFid));
                clearSelection();
            } else {
                if (item.dataset.action === 'pin') {
                    togglePin(fileName);
                } else {
                    moveChat(fileName, item.dataset.fid);
                }
            }
            menu.remove();
        };

        setTimeout(() => {
            document.addEventListener('click', (ev) => {
                if (!menu.contains(ev.target)) menu.remove();
            }, { once: true });
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

                // Detect native chat blocks being added (async load)
                if (m.target.id === 'select_chat_div' || m.target.classList?.contains('select_chat_block_wrapper')) {
                    needsSync = true;
                    break;
                }
                // Detect popup visibility changes
                if (m.target.id === 'shadow_select_chat_popup' || m.target.id === 'select_chat_popup') {
                    needsSync = true;
                    break;
                }
                // Detect new blocks added anywhere in popup
                if (m.addedNodes?.length > 0) {
                    for (const node of m.addedNodes) {
                        if (node.classList?.contains('select_chat_block')) {
                            needsSync = true;
                            break;
                        }
                    }
                }
            }
            if (needsSync && userOpenedPanel) scheduleSync();
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
        console.log(`[${EXTENSION_NAME}] v1.0.0 Loading...`);
        const ctx = SillyTavern.getContext();

        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, scheduleSync);

        // Listen for user opening chat history popup
        document.addEventListener('click', (e) => {
            const manageBtn = e.target.closest('#option_select_chat, [onclick*="select_chat"], .mes_button[title*="Chat"], [data-i18n="Manage"]');
            if (manageBtn) {
                userOpenedPanel = true;
            }
        }, true);

        // Heartbeat: check for empty folders or missing proxy root
        setInterval(() => {
            const popup = document.querySelector('#shadow_select_chat_popup') || document.querySelector('#select_chat_popup');
            if (userOpenedPanel && popup && getComputedStyle(popup).display !== 'none') {
                const proxy = popup.querySelector('#tmc_proxy_root');
                const nativeBlocks = popup.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)');
                const proxyBlocks = popup.querySelectorAll('.tmc_proxy_block');

                // Re-sync if: no proxy root, or native blocks exist but no proxy blocks
                if (!proxy || proxy.children.length === 0 || (nativeBlocks.length > 0 && proxyBlocks.length === 0)) {
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

/**
 * Too Many Chats - SillyTavern Extension
 * Organizes chats per character into collapsible folders
 * v2.0.1 - Robust Matching Fix
 * @author chaaruze
 * @version 2.0.1
 */

(function () {
    'use strict';

    const MODULE_NAME = 'chat_folders';
    const EXTENSION_NAME = 'Too Many Chats';

    const defaultSettings = Object.freeze({
        folders: {},
        characterFolders: {},
        version: '2.0.1'
    });

    let observer = null;
    let syncDebounceTimer = null;
    let isBuilding = false;

    // ========== SETTINGS ==========

    function getSettings() {
        const context = SillyTavern.getContext();
        const { extensionSettings } = context;

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        }

        // Ensure defaults
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

    // ========== ASSETS ==========

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

    // ========== FOLDER DATA ==========

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

        // Remove from current folders
        const allFolderIds = settings.characterFolders[characterId] || [];
        for (const fid of allFolderIds) {
            const folder = settings.folders[fid];
            if (folder && folder.chats) {
                const idx = folder.chats.indexOf(fileName);
                if (idx > -1) folder.chats.splice(idx, 1);
            }
        }

        // Add to target if not uncategorized
        if (targetFolderId && targetFolderId !== 'uncategorized') {
            const folder = settings.folders[targetFolderId];
            if (folder) {
                // Ensure array exists
                if (!folder.chats) folder.chats = [];
                // Allow same chat in multiple folders? No, move assumes specific location.
                // Logic above removes it from ALL folders, so we enforce single folder.
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
        syncDebounceTimer = setTimeout(performSync, 50);
    }

    function performSync() {
        // We removed isBuilding semaphore because sometimes it got stuck if an error occurred.
        // It's safer to just run.

        try {
            // Target BOTH popups for robustness
            const popups = [
                document.querySelector('#shadow_select_chat_popup'),
                document.querySelector('#select_chat_popup')
            ];

            // Find active one
            const popup = popups.find(p => p && getComputedStyle(p).display !== 'none');

            if (!popup) return;

            // 1. Gather all Native Blocks
            // CRITICAL FIX: SillyTavern uses multiple .select_chat_block_wrapper elements (one per chat).
            // We must query the POPUP root, not a specific wrapper.
            const nativeBlocks = Array.from(popup.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)'));

            // 2. Extract Data
            const chatData = nativeBlocks.map(block => ({
                element: block,
                fileName: block.getAttribute('file_name') || block.title || block.innerText.split('\n')[0].trim(),
                html: block.innerHTML
            })).filter(d => d.fileName);

            // 3. Setup Proxy Root
            let proxyRoot = popup.querySelector('#tmc_proxy_root');
            if (!proxyRoot) {
                proxyRoot = document.createElement('div');
                proxyRoot.id = 'tmc_proxy_root';

                // CRITICAL FIX: Insert at the top of the container that holds the wrappers.
                // We find the first wrapper to identify the parent.
                const firstWrapper = popup.querySelector('.select_chat_block_wrapper');
                const container = firstWrapper ? firstWrapper.parentNode : popup.querySelector('.shadow_select_chat_popup_body') || popup;

                if (container) {
                    // Try to put it after the search bar if possible?
                    // Search bar is usually in header or separate. 
                    // Wrappers are in body.
                    container.insertBefore(proxyRoot, container.firstChild);
                }
            }

            // 4. Build Tree
            const newTree = document.createDocumentFragment();
            const characterId = getCurrentCharacterId();
            const settings = getSettings();

            if (!characterId || chatData.length === 0) {
                // Nothing to show or mismatch
                // Just clear root if no character, or maybe waiting?
                if (!characterId) proxyRoot.textContent = 'Select a character to manage folders.';
                else {
                    // If character selected but no chats, maybe clean up.
                }
                // If we have chats but no characterID (group chat?), we just show them uncategorized?
            }

            const folderIds = (characterId && settings.characterFolders[characterId]) || [];
            const folderContents = {};

            // Create Folders
            folderIds.forEach(fid => {
                const folder = settings.folders[fid];
                if (!folder) return;
                const section = createFolderDOM(fid, folder);
                newTree.appendChild(section);
                folderContents[fid] = section.querySelector('.tmc_content');
            });

            // Create Uncategorized
            const uncatSection = createUncategorizedDOM();
            newTree.appendChild(uncatSection);
            folderContents['uncategorized'] = uncatSection.querySelector('.tmc_content');

            // Distribute Chats
            chatData.forEach(chat => {
                const fid = getFolderForChat(chat.fileName);
                const container = folderContents[fid] || folderContents['uncategorized']; // Fallback

                const proxy = createProxyBlock(chat);
                container.appendChild(proxy);
            });

            // Update Counts and Toggle Visibility
            Object.keys(folderContents).forEach(fid => {
                const container = folderContents[fid];
                const count = container.children.length;
                const section = container.closest('.tmc_section');

                // Update badge
                const badge = section.querySelector('.tmc_count');
                if (badge) badge.textContent = count;

                // Hide empty Uncategorized if user wants? usually keep it if folder structure exists
                // We'll hide uncategorized if empty to be clean, unless it's the ONLY thing
                if (fid === 'uncategorized') {
                    // Only hide if empty AND we have other folders. 
                    // If we have no folders, we should probably keep Uncategorized visible or just show nothing?
                    // Let's hide if empty.
                    section.style.display = count > 0 ? '' : 'none';
                }
            });

            // 5. Swap
            proxyRoot.innerHTML = '';
            proxyRoot.appendChild(newTree);

            // 6. Add Button
            injectAddButton(popup);

        } catch (err) {
            console.error('[TMC] Sync Error:', err);
        }
    }

    function createFolderDOM(fid, folder) {
        const section = document.createElement('div');
        section.className = 'tmc_section';
        section.dataset.id = fid;

        const header = document.createElement('div');
        header.className = 'tmc_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_toggle">${folder.collapsed ? '▶' : '▼'}</span>
                <span class="tmc_icon">📁</span>
                <span class="tmc_name">${escapeHtml(folder.name)}</span>
                <span class="tmc_count">0</span>
            </div>
            <div class="tmc_header_right">
                <span class="tmc_btn tmc_edit" title="Rename"><i class="fa-solid fa-pencil"></i></span>
                <span class="tmc_btn tmc_del" title="Delete"><i class="fa-solid fa-trash"></i></span>
            </div>
        `;

        // Click handlers
        header.querySelector('.tmc_header_left').onclick = () => {
            const s = getSettings();
            if (s.folders[fid]) {
                s.folders[fid].collapsed = !s.folders[fid].collapsed;
                saveSettings(); // Writes file
                scheduleSync(); // Re-renders UI
            }
        };

        header.querySelector('.tmc_edit').onclick = (e) => {
            e.stopPropagation();
            const n = prompt('Rename:', folder.name);
            if (n) renameFolder(fid, n);
        };

        header.querySelector('.tmc_del').onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Delete folder "${folder.name}"?`)) deleteFolder(fid);
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
                <span class="tmc_icon">📄</span>
                <span class="tmc_name">Uncategorized</span>
                <span class="tmc_count">0</span>
            </div>
        `;

        const content = document.createElement('div');
        content.className = 'tmc_content';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

    function createProxyBlock(chatData) {
        const el = document.createElement('div');
        el.className = 'select_chat_block tmc_proxy_block';
        el.innerHTML = chatData.html;
        el.title = chatData.fileName;

        // Forward Click
        el.onclick = (e) => {
            // Forward the click to the hidden native element
            chatData.element.click();
        };

        // Context Menu
        el.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e, chatData.fileName);
        };

        return el;
    }

    function injectAddButton(popup) {
        if (popup.querySelector('.tmc_add_btn')) return;

        const headerRow = popup.querySelector('.shadow_select_chat_popup_header') || popup.querySelector('h3');
        if (!headerRow) return;

        const btn = document.createElement('div');
        btn.className = 'tmc_add_btn menu_button';
        btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i>';
        btn.title = 'New Folder';
        btn.onclick = (e) => {
            e.stopPropagation();
            const n = prompt('New Folder Name:');
            if (n) createFolder(n);
        };

        const closeBtn = headerRow.querySelector('#select_chat_cross');
        if (closeBtn) {
            headerRow.insertBefore(btn, closeBtn);
        } else {
            headerRow.appendChild(btn);
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

        let html = `<div class="tmc_ctx_head">Move to...</div>`;
        folderIds.forEach(fid => {
            const f = settings.folders[fid];
            html += `<div class="tmc_ctx_item" data-fid="${fid}">📁 ${escapeHtml(f.name)}</div>`;
        });
        html += `<div class="tmc_ctx_sep"></div>`;
        html += `<div class="tmc_ctx_item" data-fid="uncategorized">📄 Uncategorized</div>`;
        html += `<div class="tmc_ctx_item tmc_new">➕ New Folder</div>`;

        menu.innerHTML = html;
        document.body.appendChild(menu);

        menu.onclick = (ev) => {
            const item = ev.target.closest('.tmc_ctx_item');
            if (!item) return;
            if (item.classList.contains('tmc_new')) {
                const name = prompt('Folder Name:');
                if (name) {
                    createFolder(name);
                    // ideally we moveChat here too, but simple first
                }
            } else {
                moveChat(fileName, item.dataset.fid);
            }
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
                // If it's a wrapper modification
                if (m.target.classList.contains('select_chat_block_wrapper')) {
                    needsSync = true;
                    break;
                }
                // If ID changes (unlikely) or children of body (popup appearance)
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
        console.log(`[${EXTENSION_NAME}] v2.0.1 Loading...`);
        const ctx = SillyTavern.getContext();

        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, scheduleSync);

        // Heartbeat
        setInterval(() => {
            const popup = document.querySelector('#shadow_select_chat_popup') || document.querySelector('#select_chat_popup');
            if (popup && getComputedStyle(popup).display !== 'none') {
                // Check if proxy exists OR if Native wrapper has items but Proxy is empty?
                const proxy = popup.querySelector('#tmc_proxy_root');
                const native = popup.querySelector('.select_chat_block_wrapper');

                // If we have native content but no proxy content, FORCE SYNC
                if (native && native.children.length > 0) {
                    // Basic check if we are desynced
                    const nativeCount = native.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)').length;
                    const proxyCount = proxy ? proxy.querySelectorAll('.tmc_proxy_block').length : 0;
                    if (nativeCount !== proxyCount) {
                        scheduleSync();
                    }
                }
            }
        }, 1000);

        initObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

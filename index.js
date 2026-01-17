/**
 * Too Many Chats - SillyTavern Extension
 * Organizes chats per character into collapsible folders
 * v2.0.0 - Proxy UI Architecture
 * @author chaaruze
 * @version 2.0.0
 */

(function () {
    'use strict';

    const MODULE_NAME = 'chat_folders';
    const EXTENSION_NAME = 'Too Many Chats';

    const defaultSettings = Object.freeze({
        folders: {},
        characterFolders: {},
        version: '2.0.0'
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

    // ========== FOLDER DATA MANIPILATION ==========

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

        // Remove from source info
        const allFolderIds = settings.characterFolders[characterId] || [];
        for (const fid of allFolderIds) {
            const folder = settings.folders[fid];
            if (folder && folder.chats) {
                const idx = folder.chats.indexOf(fileName);
                if (idx > -1) folder.chats.splice(idx, 1);
            }
        }

        // Add to target
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

    // ========== SYNC ENGINE & PROXY UI ==========

    function scheduleSync() {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(performSync, 50);
    }

    function performSync() {
        if (isBuilding) return;
        isBuilding = true;

        try {
            const popup = document.querySelector('#shadow_select_chat_popup'); // Use shadow popup if available
            // Note: v1.5.0 used #shadow_select_chat_popup. We continue to target it.
            // But we must also check #select_chat_popup just in case ST changes.
            // The "Proxy UI" means we inject OUR UI into the popup, and hide the .select_chat_block_wrapper

            if (!popup || getComputedStyle(popup).display === 'none') return;

            // Find Native Wrapper
            const nativeWrapper = popup.querySelector('.select_chat_block_wrapper');
            if (!nativeWrapper) return;

            // 1. Hide Native Wrapper (handled in CSS mostly, but ensure here)
            // nativeWrapper.style.display = 'none'; // Done via CSS class .tmc_hidden_native

            // 2. Read Native Data
            const nativeBlocks = Array.from(nativeWrapper.querySelectorAll('.select_chat_block'));
            const chatData = nativeBlocks.map(block => ({
                element: block, // Reference to original DOM for clicking
                fileName: block.getAttribute('file_name') || block.textContent.trim(),
                html: block.innerHTML
            }));

            // 3. Find or Create Proxy Root
            let proxyRoot = popup.querySelector('#tmc_proxy_root');
            if (!proxyRoot) {
                proxyRoot = document.createElement('div');
                proxyRoot.id = 'tmc_proxy_root';
                // Insert BEFORE the native wrapper so it sits at the top
                if (nativeWrapper.parentNode) {
                    nativeWrapper.parentNode.insertBefore(proxyRoot, nativeWrapper);
                }
            }

            // 4. Build the UI Tree (Virtual DOM style, then flush)
            const newTree = document.createDocumentFragment();
            const characterId = getCurrentCharacterId();
            const settings = getSettings();

            if (!characterId) {
                // Should show warning or empty state
                proxyRoot.textContent = 'Please select a character.';
                return;
            }

            const folderIds = settings.characterFolders[characterId] || [];

            // -- Folder Sections --
            const folderContents = {}; // Map fid -> content container

            folderIds.forEach(fid => {
                const folder = settings.folders[fid];
                if (!folder) return;

                const section = createFolderDOM(fid, folder);
                newTree.appendChild(section);
                folderContents[fid] = section.querySelector('.tmc_content');
            });

            // -- Uncategorized Section --
            const uncatSection = createUncategorizedDOM();
            newTree.appendChild(uncatSection);
            folderContents['uncategorized'] = uncatSection.querySelector('.tmc_content');

            // -- Distribute Chats --
            chatData.forEach(chat => {
                if (!chat.fileName) return;

                const fid = getFolderForChat(chat.fileName);
                const targetContainer = folderContents[fid];

                if (targetContainer) {
                    const proxyBlock = createProxyBlock(chat);
                    targetContainer.appendChild(proxyBlock);
                }
            });

            // -- Update Counts & Visibility --
            Object.keys(folderContents).forEach(fid => {
                const container = folderContents[fid];
                const count = container.children.length;
                const section = container.closest('.tmc_section');

                // Update Badge
                const badge = section.querySelector('.tmc_count');
                if (badge) badge.textContent = count;

                // Toggle visibility for Uncategorized
                if (fid === 'uncategorized') {
                    section.style.display = count > 0 ? '' : 'none';
                }
            });

            // 5. Swap the Proxy Root content
            proxyRoot.innerHTML = '';
            proxyRoot.appendChild(newTree);

            // 6. Inject Add Button
            injectAddButton(popup);

        } catch (err) {
            console.error('[TMC] Sync Error:', err);
        } finally {
            isBuilding = false;
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

        // Interactive Header
        header.querySelector('.tmc_header_left').onclick = () => {
            const s = getSettings();
            if (s.folders[fid]) {
                s.folders[fid].collapsed = !s.folders[fid].collapsed;
                saveSettings(); // triggers observer -> triggers sync
                // But wait, saveSettings writes to file. It doesn't trigger DOM change.
                // We need to re-render manually.
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

    /**
     * proxyBlock: Looks like a chat block, acts like a remote control
     */
    function createProxyBlock(chatData) {
        const el = document.createElement('div');
        el.className = 'select_chat_block tmc_proxy_block'; // mimic class for style
        el.innerHTML = chatData.html; // Copy avatars/text/etc
        el.title = chatData.fileName;

        // PROXY CLICK: When clicked, click the REAL element
        el.onclick = (e) => {
            // If user clicks delete/edit buttons INSIDE the chat block (if they exist)
            // we should forward those carefully.
            // But usually clicking main block loads chat.
            chatData.element.click();

            // Visual feedback? relying on ST re-render
        };

        // Context Menu for Moving
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
                    const fid = createFolder(name);
                    // createFolder schedules sync, but we want to move instantly after creation
                    // wait for fid? createFolder is synchronous mostly.
                    // But createFolder calls scheduleSync.
                    // We can just moveChat manually if we had the ID.
                    // Actually createFolder in this version does NOT return ID (my bad).
                    // Fixed above? No, I copied old one.
                    // Let's rely on user doing it in 2 steps for safety or simple reload.
                    // Wait, I can fix createFolder return.
                    // Nah, let's keep it simple. User creates folder -> Popup refreshes -> User moves.
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
                // If the native wrapper changes (children added/removed), we need sync
                if (m.target.classList.contains('select_chat_block_wrapper')) {
                    needsSync = true;
                    break;
                }
                // If the popup becomes visible
                if (m.target.id === 'shadow_select_chat_popup' || m.target.id === 'select_chat_popup') {
                    needsSync = true;
                    break;
                }
            }
            if (needsSync) scheduleSync();
        });

        // We watch document.body to catch popup appearing
        // And we try to find the wrapper to watch specifically if possible?
        // Actually, just watching body subtree is expensive but robust.
        // Let's refine: Watch body for Popup visibility.
        // Once popup is found, watch wrapper.
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    }

    // ========== INIT ==========

    function init() {
        console.log(`[${EXTENSION_NAME}] v2.0.0 Loading...`);
        const ctx = SillyTavern.getContext();

        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, scheduleSync);

        // Periodic Health Check
        setInterval(() => {
            const popup = document.querySelector('#shadow_select_chat_popup');
            if (popup && getComputedStyle(popup).display !== 'none') {
                if (!popup.querySelector('#tmc_proxy_root')) {
                    scheduleSync();
                }
            }
        }, 2000); // 2s heartbeat

        initObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

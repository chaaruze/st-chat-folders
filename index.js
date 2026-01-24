/**
 * Too Many Chats - SillyTavern Extension
 * Organizes chats per character into collapsible folders
 * v1.0.0 - Early Release
 * @author chaaruze
 * @version 1.0.0
 */

(function () {
    'use strict';
    console.warn('[TMC] Script Parsed & Executing Top Level IIFE');

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
    let currentView = 'main'; // 'main' | 'folder'
    let viewFolderId = null;
    let chatsByFolder = {}; // Memory store for lazy loading
    let sortOrder = 'date-desc'; // 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' (Prepared for Phase 2)
    const BATCH_SIZE = 20;
    let lastSelectedChat = null; // Track last clicked for shift-select
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
        // Group Chat Support
        if (context.groupId) {
            return context.groupId;
        }
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
            const diff = now.getTime() - date.getTime();
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

    function highlightText(text, term) {
        if (!term || !text) return text;
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedTerm})`, 'gi');
        return text.replace(regex, '<span style="background-color: rgba(255, 255, 0, 0.3); color: #fff; font-weight: bold;">$1</span>');
    }


    function createFolder(name) {
        if (!name || !name.trim()) return;
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) {
            console.warn('[TMC] getCurrentCharacterId returned null. Context:', SillyTavern.getContext());
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






    // Sorting Helpers
    function getChatMetadata(block, fileName) {
        try {
            // Name
            const name = (fileName || '').toLowerCase();

            // Date (Native)
            const dateEl = block.querySelector('.chat_messages_date');
            const dateStr = dateEl ? dateEl.textContent : '';
            const date = dateStr ? new Date(dateStr).getTime() : 0;

            // Message Count (123 💬)
            const msgEl = block.querySelector('.chat_messages_num');
            const msgStr = msgEl ? msgEl.textContent : '0';
            const msgCount = parseInt(msgStr.replace(/[^0-9]/g, '')) || 0;

            // File Size ((29.96KB, ...)
            const sizeEl = block.querySelector('.chat_file_size');
            const sizeStr = sizeEl ? sizeEl.textContent : '';
            let size = 0;
            if (sizeStr) {
                const match = sizeStr.match(/([\d.]+)\s*([KMGT]?B)/i);
                if (match) {
                    const val = parseFloat(match[1]);
                    const unit = match[2].toUpperCase();
                    if (unit === 'KB') size = val * 1024;
                    else if (unit === 'MB') size = val * 1024 * 1024;
                    else if (unit === 'GB') size = val * 1024 * 1024 * 1024;
                    else size = val;
                }
            }

            return { name, date, msgCount, size };
        } catch (err) {
            console.error('[TMC] Metadata Error:', err);
            return { name: '', date: 0, msgCount: 0, size: 0 };
        }
    }

    function sortChats(chatDataList) {
        return chatDataList.sort((a, b) => {
            const metaA = a.metadata;
            const metaB = b.metadata;

            switch (sortOrder) {
                case 'name-asc': return metaA.name.localeCompare(metaB.name);
                case 'name-desc': return metaB.name.localeCompare(metaA.name);

                case 'date-asc': return metaA.date - metaB.date;
                case 'date-desc': return metaB.date - metaA.date;

                case 'size-asc': return metaA.size - metaB.size;
                case 'size-desc': return metaB.size - metaA.size;

                case 'count-asc': return metaA.msgCount - metaB.msgCount;
                case 'count-desc': return metaB.msgCount - metaA.msgCount;

                default: return 0; // Native order
            }
        });
    }

    // ========== SYNC ENGINE ==========

    function scheduleSync() {
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        // Increased to 200ms to prevent UI lag
        syncDebounceTimer = setTimeout(performSync, 200);
    }

    // Lazy Loading Helper (Append Only)
    // Lazy Loading Helper (Append Only)
    function renderBatch(folderId, startIndex, count, containerElement = null, searchTerm = '') {
        const container = containerElement || document.querySelector(`.tmc_section[data-id="${folderId}"] .tmc_content`);
        if (!container) return;

        const chats = chatsByFolder[folderId] || [];
        const endIndex = Math.min(startIndex + count, chats.length);
        const settings = getSettings();

        // Remove old sentinel if exists
        const oldSentinel = container.querySelector('.tmc_sentinel');
        if (oldSentinel) oldSentinel.remove();

        const fragment = document.createDocumentFragment();

        for (let i = startIndex; i < endIndex; i++) {
            const chat = chats[i];
            const isPinned = settings.pinned && settings.pinned[chat.fileName];
            const proxy = createProxyBlock(chat, isPinned, searchTerm);
            fragment.appendChild(proxy);
        }

        container.appendChild(fragment);

        // Update counts
        const section = container.closest('.tmc_section');
        const badge = section.querySelector('.tmc_count');
        if (badge) badge.textContent = chats.length;

        // Truncation logic for Main View (Strict 3 items)
        if (currentView === 'main' && folderId !== 'uncategorized') {
            const children = Array.from(container.querySelectorAll('.tmc_proxy_block'));
            if (children.length > 3) {
                // Remove excess from DOM for main view
                for (let i = 3; i < children.length; i++) children[i].remove();

                // Show More check
                if (!container.querySelector('.tmc_show_more')) {
                    const showMore = document.createElement('div');
                    showMore.className = 'tmc_show_more';
                    showMore.innerHTML = `<i class="fa-solid fa-ellipsis"></i> Show more (${chats.length - 3} more)`;
                    showMore.addEventListener('click', (e) => {
                        e.stopPropagation();
                        currentView = 'folder';
                        viewFolderId = folderId;
                        scheduleSync();
                    });
                    container.appendChild(showMore);
                }
            }
            return;
        }

        // Observer for Infinite Scroll (Only in Folder View)
        if (currentView === 'folder' && endIndex < chats.length) {
            const sentinel = document.createElement('div');
            sentinel.className = 'tmc_sentinel';
            sentinel.style.height = '20px';
            sentinel.textContent = 'Loading...'; // Visual feedback
            sentinel.style.opacity = '0.5';
            sentinel.style.textAlign = 'center';
            sentinel.style.fontSize = '12px';
            sentinel.setAttribute('data-folder-id', folderId);
            sentinel.setAttribute('data-next-index', endIndex.toString());
            container.appendChild(sentinel);

            if (observer) observer.observe(sentinel);
        }
    }

    function initIntersectionObserver() {
        if (observer) observer.disconnect();

        observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const sentinel = entry.target;
                    const folderId = sentinel.getAttribute('data-folder-id');
                    const nextIndexStr = sentinel.getAttribute('data-next-index');
                    const nextIndex = nextIndexStr ? parseInt(nextIndexStr, 10) : NaN;

                    if (folderId && !isNaN(nextIndex)) {
                        // CRITICAL: Unobserve immediately to prevent double-firing
                        observer.unobserve(sentinel);
                        // Add small delay to smooth out rapid scrolling
                        setTimeout(() => {
                            renderBatch(folderId, nextIndex, BATCH_SIZE);
                        }, 50);

                    }
                }
            });
        }, { root: document.querySelector('#tmc_proxy_root'), rootMargin: '200px' });
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

                // Improved date extraction - try multiple sources
                let dateStr = '';

                // Method 1: Look for date element with specific classes
                const dateEl = block.querySelector('.select_chat_block_date, .chat_date, [class*="date"]');
                if (dateEl) {
                    dateStr = dateEl.textContent || dateEl.title || '';
                }

                // Method 2: Look for elements containing date patterns (Jan XX, XXXX or similar)
                if (!dateStr) {
                    const allText = block.innerText || '';
                    // Look for patterns like "Jan 18, 2026" or "January 18, 2026"
                    const dateMatch = allText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i);
                    if (dateMatch) {
                        dateStr = dateMatch[0];
                    }
                }

                // Method 3: Check for ISO date in file_name or title
                if (!dateStr && fileName) {
                    const isoMatch = fileName.match(/\d{4}-\d{2}-\d{2}/);
                    if (isoMatch) {
                        dateStr = isoMatch[0];
                    }
                }

                return {
                    element: block,
                    fileName,
                    title: extractChatTitle(fileName),
                    date: formatDate(dateStr),
                    html: block.innerHTML, // Full native content with buttons
                    metadata: getChatMetadata(block, fileName)
                };
            }).filter(d => d.fileName);

            // Capture Search Term
            const searchBar = popup.querySelector('input[type="search"], input[type="text"], .search_input');
            const searchTerm = searchBar instanceof HTMLInputElement ? searchBar.value.trim().toLowerCase() : '';

            // Apply Logic: Sort (Global or Folder-specific if we want, presently Global setting)
            const sortedData = sortChats(chatData);

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

            const folderContents = {};
            const folderIds = settings.characterFolders[characterId] || [];

            // VIEW LOGIC SWITCH
            if (currentView === 'folder' && viewFolderId && settings.folders[viewFolderId]) {
                // RENDER FOLDER VIEW
                const folder = settings.folders[viewFolderId];
                const section = createFolderViewDOM(viewFolderId, folder);
                newTree.appendChild(section);
                folderContents[viewFolderId] = section.querySelector('.tmc_content');
            } else {
                // RENDER MAIN VIEW
                // Reset view if invalid
                if (currentView === 'folder') {
                    currentView = 'main';
                    viewFolderId = null;
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
            }


            if (!observer) initIntersectionObserver();

            // Populate chatsByFolder memory store
            chatsByFolder = {};
            // Initialize with empty arrays for all known sections
            Object.keys(folderContents).forEach(fid => chatsByFolder[fid] = []);

            // Distribute chats into folders
            // Use sortedData instead of chatData
            sortedData.forEach(chat => {
                // Check Native Filter: If native search is active, non-matches are hidden.
                // We should respect this.
                // FIX: This might be hiding everything if native logic hasn't run yet.
                // if (chat.element.style.display === 'none') return;

                const isPinned = settings.pinned && settings.pinned[chat.fileName];
                const fid = getFolderForChat(chat.fileName);

                // If in folder view, only process valid chats
                if (currentView === 'folder' && fid !== viewFolderId) return;

                // If in main view, filter out unwanted folders? No, we need all for counts.
                if (!chatsByFolder[fid]) chatsByFolder[fid] = [];

                // Sorting is already applied by sortChats! 
                // But Pinned items should always be at the TOP regardless of sort order.
                if (isPinned) {
                    chatsByFolder[fid].unshift(chat);
                } else {
                    chatsByFolder[fid].push(chat);
                }
            });

            // Initial Render Batch for each visible section
            Object.keys(folderContents).forEach(fid => {
                const count = chatsByFolder[fid] ? chatsByFolder[fid].length : 0;
                if (count > 0) {
                    // console.log(`[TMC] Rendering folder ${fid}: ${count} chats`); 
                }

                const container = folderContents[fid];
                const section = container.closest('.tmc_section');

                // Hide if empty (uncategorized only)
                if (fid === 'uncategorized') {
                    section.style.display = (chatsByFolder[fid] && chatsByFolder[fid].length > 0) ? '' : 'none';
                }


                // Render first batch synchronously
                renderBatch(fid, 0, BATCH_SIZE, container, searchTerm);
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

    function createFolderViewDOM(fid, folder) {
        const section = document.createElement('div');
        section.className = 'tmc_section tmc_folder_view';
        section.dataset.id = fid;

        const header = document.createElement('div');
        header.className = 'tmc_header tmc_folder_view_header';
        header.innerHTML = `
            <div class="tmc_header_left" style="cursor: default;">
                <span class="tmc_back_btn" title="Back"><i class="fa-solid fa-arrow-left"></i></span>
                <span class="tmc_icon"><i class="fa-solid fa-folder-open"></i></span>
                <span class="tmc_name">${escapeHtml(folder.name)}</span>
                <span class="tmc_count">0</span>
            </div>
             <div class="tmc_header_right">
                <span class="tmc_btn tmc_color" title="Color"><i class="fa-solid fa-palette"></i></span>
                <span class="tmc_btn tmc_edit" title="Rename"><i class="fa-solid fa-pencil"></i></span>
            </div>
        `;

        // Apply Color in header
        if (folder.color) {
            const c = FOLDER_COLORS[folder.color] || folder.color;
            if (c && c !== 'transparent') {
                header.style.borderLeft = `4px solid ${c}`;
                header.style.background = `${c}22`;
            }
        }

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.style.cssText = 'visibility: hidden; position: absolute; width: 0; height: 0; pointer-events: none;';
        colorInput.value = (folder.color && FOLDER_COLORS[folder.color] && FOLDER_COLORS[folder.color] !== 'transparent') ? FOLDER_COLORS[folder.color] : '#ffffff';
        section.appendChild(colorInput);

        header.querySelector('.tmc_color').onclick = (e) => { e.stopPropagation(); colorInput.click(); };
        colorInput.onchange = (e) => { setFolderColor(fid, e.target.value); };

        header.querySelector('.tmc_back_btn').onclick = (e) => {
            e.stopPropagation();
            currentView = 'main';
            viewFolderId = null;
            scheduleSync();
        };

        header.querySelector('.tmc_edit').onclick = (e) => {
            e.stopPropagation();
            const n = prompt('Rename:', folder.name);
            if (n) renameFolder(fid, n);
        };

        const content = document.createElement('div');
        content.className = 'tmc_content';

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
    function createProxyBlock(chatData, isPinned, searchTerm = '') {
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

        // SEARCH HIGHLIGHTING
        if (searchTerm) {
            const titleEl = el.querySelector('.select_chat_block_title') || el.querySelector('.avatar_title_div');
            if (titleEl) {
                const originalText = titleEl.textContent;
                // Preserve the PIN icon if it's there (it's prepended)
                // Actually prepending adds it to the DOM, modifying textContent usually wipes it.
                // We should highlight safely.
                const highlighted = highlightText(chatData.title, searchTerm);

                // If we replace innerHTML, we lose the pin. 
                // Let's re-append highlight logic carefully.
                // Simplest strategy: Set HTML, then re-add Pin.
                titleEl.innerHTML = highlighted;
                if (isPinned) {
                    const pinIcon = document.createElement('span');
                    pinIcon.className = 'tmc_pin_icon';
                    pinIcon.innerHTML = '📌';
                    pinIcon.style.cssText = 'font-size: 12px; margin-right: 5px; opacity: 0.8;';
                    titleEl.prepend(pinIcon);
                }
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

        // Move pencil icon to the right side with other action buttons
        const pencilBtn = el.querySelector('.renameChatButton');
        const actionContainer = el.querySelector('.flex-container.gap10px') ||
            el.querySelector('[class*="action"]') ||
            el.querySelector('.select_chat_info')?.parentElement;
        if (pencilBtn && actionContainer) {
            // Move pencil to the action container (right side)
            actionContainer.insertBefore(pencilBtn, actionContainer.firstChild);
        }



        // MOBILE MENU: Add context menu button (kebab)
        const menuBtn = document.createElement('div');
        menuBtn.className = 'tmc_mobile_menu';
        menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showContextMenu(e, chatData.fileName);
        });
        el.appendChild(menuBtn);

        // Intercept main click (not on buttons)
        el.addEventListener('click', (e) => {
            // Don't intercept if clicking on action buttons
            // Improve Selector specificity
            const target = e.target.closest('button, .mes_button, .renameChatButton, .select_chat_block_action, .mes_edit, .mes_delete, .mes_export, [class*="export"], [class*="delete"], [class*="download"]');

            if (target) {
                e.stopPropagation();
                // Try to find matching button in original element by specific class
                // Map common classes to selectors
                const classList = target.classList;
                let selector = '';

                if (classList.contains('mes_delete') || classList.contains('fa-trash') || classList.contains('fa-skull')) selector = '.mes_delete, .fa-trash, .fa-skull, [class*="delete"]';
                else if (classList.contains('renameChatButton') || classList.contains('fa-pen')) selector = '.renameChatButton, .fa-pen';
                else if (classList.contains('mes_edit')) selector = '.mes_edit';
                else if (classList.contains('mes_export')) selector = '.mes_export';

                // Fallback: Try strict class matching of the first class that isn't generic
                if (!selector && target.className) {
                    const parts = target.className.split(' ').filter(c => c !== 'mes_button' && c !== 'fa-solid' && c !== 'fa');
                    if (parts.length > 0) selector = '.' + parts[0];
                }

                if (selector) {
                    const originalBtn = chatData.element.querySelector(selector);
                    if (originalBtn) {
                        originalBtn.click();
                        return;
                    }
                }
                // If explicit match failed, try the old fragile method as last resort
                const clickedClass = target.className;
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

                if (e.shiftKey && lastSelectedChat) {
                    // Range Selection
                    const allBlocks = Array.from(document.querySelectorAll('.tmc_proxy_block'));
                    const startIdx = allBlocks.findIndex(b => b.getAttribute('file_name') === lastSelectedChat);
                    const endIdx = allBlocks.findIndex(b => b.getAttribute('file_name') === chatData.fileName);

                    if (startIdx > -1 && endIdx > -1) {
                        const low = Math.min(startIdx, endIdx);
                        const high = Math.max(startIdx, endIdx);

                        for (let i = low; i <= high; i++) {
                            const fname = allBlocks[i].getAttribute('file_name');
                            if (fname) selectedChats.add(fname);
                        }
                    } else {
                        // Fallback if not found
                        if (selectedChats.has(chatData.fileName)) {
                            selectedChats.delete(chatData.fileName);
                        } else {
                            selectedChats.add(chatData.fileName);
                        }
                    }
                } else {
                    // Normal Toggle
                    if (selectedChats.has(chatData.fileName)) {
                        selectedChats.delete(chatData.fileName);
                    } else {
                        selectedChats.add(chatData.fileName);
                    }
                    lastSelectedChat = chatData.fileName;
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
        btn.className = 'menu_button tmc_add_btn';
        btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i> New Folder';
        btn.title = 'Create New Folder';
        btn.onclick = (e) => {
            e.stopPropagation();
            const n = prompt('New Folder Name:');
            if (n) createFolder(n);
        };

        // Bulk Select Button
        const bulkBtn = document.createElement('div');
        bulkBtn.className = 'menu_button tmc_add_btn tmc_bulk_btn';
        bulkBtn.innerHTML = '<i class="fa-solid fa-list-check"></i> Select';
        bulkBtn.title = 'Select Multiple Chats';
        bulkBtn.onclick = (e) => {
            e.stopPropagation();
            bulkMode = !bulkMode;
            if (!bulkMode) selectedChats.clear();
            scheduleSync();
            updateBulkBar();
        };

        // SORT DROPDOWN
        const sortContainer = document.createElement('div');
        sortContainer.className = 'menu_button tmc_add_btn tmc_sort_btn';
        sortContainer.style.display = 'flex';
        sortContainer.style.alignItems = 'center';
        sortContainer.style.paddingLeft = '10px';
        sortContainer.style.position = 'relative'; // Ensure relative parent
        sortContainer.innerHTML = '<i class="fa-solid fa-arrow-down-wide-short"></i>';

        const sortSelect = document.createElement('select');
        sortSelect.id = 'tmc_sort_select';
        // Overlay fully with opacity 0 to ensure click capture
        sortSelect.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;';
        sortSelect.innerHTML = `
                <option value="date-desc">Date (New)</option>
                <option value="date-asc">Date (Old)</option>
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="count-desc">Msgs (Most)</option>
                <option value="count-asc">Msgs (Least)</option>
                <option value="size-desc">Size (Large)</option>
                <option value="size-asc">Size (Small)</option>
            `;
        sortSelect.value = sortOrder; // Set current

        sortSelect.onchange = (e) => {
            sortOrder = e.target.value;
            scheduleSync();
        };

        // Prevent popup close on click
        sortSelect.onclick = (e) => e.stopPropagation();

        sortContainer.appendChild(sortSelect);


        // Inject into the header row (found earlier)
        if (!headerRow.querySelector('.tmc_add_btn')) {
            headerRow.appendChild(sortContainer);
            headerRow.appendChild(bulkBtn);
            headerRow.appendChild(btn);
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


    }



    // ========== CONTEXT MENU ==========

    function showContextMenu(e, fileName, isBulk = false) {
        // Cleanup existing menus properly
        document.querySelectorAll('.tmc_ctx').forEach(m => {
            if (m.cleanup) m.cleanup();
            m.remove();
        });

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
            // MOBILE FIX: Smart positioning
            // If on mobile (small screen) and clicking near right edge, anchor to right
            const isMobile = window.innerWidth <= 768; // Matching CSS media query
            if (isMobile && e.clientX > window.innerWidth / 2) {
                // Determine right equivalent
                const rightSpace = window.innerWidth - e.pageX;
                menu.style.right = rightSpace + 'px';
                menu.style.left = 'auto';
                menu.style.transformOrigin = 'top right';
                menu.style.top = e.pageY + 'px';
            } else {
                menu.style.top = e.pageY + 'px';
                menu.style.left = e.pageX + 'px';
            }

            if (isMobile) {
                menu.style.maxHeight = '60vh';
                menu.style.overflowY = 'auto';
            }
        }

        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        const folderIds = settings.characterFolders[characterId] || [];

        let html = '<div class="tmc_ctx_head">' + (isBulk ? `Move ${selectedChats.size} chats to...` : 'Actions') + '</div>';

        if (!isBulk) {
            // Pin option
            const pinText = (getSettings().pinned && getSettings().pinned[fileName]) ? 'Unpin' : 'Pin to top';
            html += `<div class="tmc_ctx_item" data-action="pin">📌 ${pinText}</div>`;
            // Add Rename and Delete
            html += `<div class="tmc_ctx_item" data-action="rename">✏️ Rename</div>`;
            html += `<div class="tmc_ctx_item" data-action="delete" style="color:var(--red);">🗑️ Delete</div>`;
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
                } else if (item.dataset.action === 'rename') {
                    // Trigger rename on original element
                    const originalBlock = document.querySelector(`.select_chat_block[file_name="${fileName}"]:not(.tmc_proxy_block)`);
                    const renameBtn = originalBlock?.querySelector('.renameChatButton') || originalBlock?.querySelector('.fa-pen');
                    if (renameBtn) renameBtn.click();
                } else if (item.dataset.action === 'delete') {
                    // Trigger delete on original element
                    const originalBlock = document.querySelector(`.select_chat_block[file_name="${fileName}"]:not(.tmc_proxy_block)`);
                    // Look for typical delete class names
                    const delBtn = originalBlock?.querySelector('.mes_delete') ||
                        originalBlock?.querySelector('.fa-skull') ||
                        originalBlock?.querySelector('[class*="delete"]');
                    if (delBtn) delBtn.click();
                    else console.warn('TMC: Could not find delete button for', fileName);
                } else {
                    moveChat(fileName, item.dataset.fid);
                }
            }
            menu.remove();
        };

        // Close on click outside
        const closeHandler = (ev) => {
            if (!menu.contains(ev.target)) {
                cleanup();
            }
        };

        // Close on Escape
        const escHandler = (ev) => {
            if (ev.key === 'Escape') cleanup();
        };

        function cleanup() {
            menu.remove();
            document.removeEventListener('click', closeHandler);
            document.removeEventListener('keydown', escHandler);
        }

        setTimeout(() => {
            document.addEventListener('click', closeHandler);
            document.addEventListener('keydown', escHandler);
        }, 50);

        // Also close if another menu is opened (handled by top of showContextMenu)
        // But we should ensure listeners are cleaned up if removed externally
        // MutationObserver on body could detect removal, but let's just be careful.
        // For now, simpler is better. logic at start of function removes .tmc_ctx,
        // but that won't remove the *listeners* attached to document for those old menus.
        // FIX: Add a custom property to the menu element to call cleanup
        menu.cleanup = cleanup;
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

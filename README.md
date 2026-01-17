# 📁 Chat Folders

<div align="center">

![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-orange?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQxIDAtOC0zLjU5LTgtOHMzLjU5LTggOC04IDggMy41OSA4IDgtMy41OSA4LTggOHoiLz48L3N2Zz4=)
![Version](https://img.shields.io/badge/version-1.0.0-blue?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)

**Organize your SillyTavern chats into collapsible folders**

[Features](#-features) • [Installation](#-installation) • [Usage](#-usage) • [Contributing](#-contributing)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 📂 Per-Character Organization
Each character has their own independent folder set. Keep your roleplay storylines separate and organized.

### 🔄 Collapsible Folders
Expand or collapse folders with a single click. State persists across page reloads.

</td>
<td width="50%">

### 🖱️ Right-Click Context Menu
Quickly move chats between folders with a simple right-click. Create new folders on the fly.

### 🎨 Native Dark Theme
Seamlessly blends with SillyTavern's interface. No jarring visual differences.

</td>
</tr>
</table>

---

## 📦 Installation

### Method 1: Via SillyTavern (Recommended)

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste this URL:
   ```
   https://github.com/chaaruze/st-chat-folders
   ```
4. Click **Install**
5. Refresh the page

### Method 2: Manual Installation

1. Download this repository as a ZIP
2. Extract to your SillyTavern extensions folder:
   ```
   SillyTavern/data/<your-user>/extensions/st-chat-folders
   ```
3. Restart SillyTavern

---

## 🚀 Usage

### Creating Folders

1. Click the **📁 Folders** button in the chat area
2. Type a folder name in the input field
3. Click **+** or press Enter

### Moving Chats to Folders

1. **Right-click** on any chat in the chat list
2. Select your target folder from the menu
3. Or choose **New Folder...** to create and assign in one step

### Collapse/Expand Folders

- Click any folder header to toggle visibility
- Collapsed state is saved automatically

### Managing Folders

| Action | How |
|--------|-----|
| **Rename** | Click ✏️ in the folder modal |
| **Delete** | Click 🗑️ (chats become uncategorized) |
| **Reorder** | Coming in v1.1! |

---

## 🛠️ Technical Details

| Aspect | Detail |
|--------|--------|
| **Data Storage** | SillyTavern's `extensionSettings` API |
| **Folder Scope** | Per-character (keyed by avatar) |
| **Destructive?** | No - deleting folders preserves chats |
| **Dependencies** | None - pure vanilla JS |

---

## 🗺️ Roadmap

- [ ] Drag-and-drop folder reordering
- [ ] Folder color customization
- [ ] Bulk chat operations
- [ ] Export/import folder structure
- [ ] Folder search/filter

---

## 🤝 Contributing

Contributions are welcome! Feel free to:

- 🐛 Report bugs via [Issues](https://github.com/chaaruze/st-chat-folders/issues)
- 💡 Suggest features
- 🔧 Submit pull requests

---

## 📄 License

[MIT License](LICENSE) - feel free to modify and share!

---

<div align="center">

Made with ❤️ by [chaaruze](https://github.com/chaaruze)

**If you find this useful, consider giving it a ⭐!**

</div>

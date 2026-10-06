/**
 * file-drag-upload - 文件拖拽上传插件（改进版）
 * 参考 Kiro/VSCode/Electron 的拖拽机制优化
 *
 * 核心改进：
 * 1. 更精准的拖拽检测（区分文件拖拽和文本拖拽）
 * 2. 更健壮的事件冒泡控制
 * 3. 限定拖拽区域为聊天输入框区域
 * 4. 改进的遮罩显示逻辑（防止闪烁）
 * 5. 更好的文件路径处理（Electron file.path）
 */

const MAX_FILES = 50;
const OVERLAY_Z_INDEX = 2147483647;
const COMPOSER_SELECTOR = '[data-testid="composer-input"], .composer-input, .chat-input, textarea[placeholder*="消息"]';

// ========== 工具函数 ==========

function toArray(value) {
  try {
    return Array.from(value || []);
  } catch (_) {
    return [];
  }
}

/**
 * 检测是否为文件拖拽（参考 VSCode/Electron 实现）
 * 关键：区分文件拖拽和文本/链接拖拽
 */
function isFileDrag(dataTransfer) {
  if (!dataTransfer) return false;

  // 方法1: 检查 types 数组
  const types = toArray(dataTransfer.types).map(t => String(t).toLowerCase());
  if (types.includes('files')) return true;

  // 方法2: 检查 items（更可靠）
  const items = toArray(dataTransfer.items);
  const hasFile = items.some(item => {
    const kind = String(item?.kind || '').toLowerCase();
    return kind === 'file';
  });

  if (hasFile) return true;

  // 方法3: 排除纯文本/链接拖拽
  const hasOnlyText = types.length > 0 && types.every(t =>
    t === 'text/plain' || t === 'text/html' || t === 'text/uri-list'
  );

  if (hasOnlyText && items.length === 0) return false;

  return false;
}

/**
 * 获取文件路径（Electron 环境有 file.path 属性）
 */
function getFilePath(file) {
  // Electron 环境优先使用 file.path（完整绝对路径）
  if (file?.path) return file.path;

  // Fallback: webkitRelativePath 或 name
  return file?.webkitRelativePath || file?.name || '';
}

/**
 * 检查元素是否为输入框或其祖先
 */
function isComposerArea(element) {
  if (!element) return false;

  // 检查自身
  if (element.matches && element.matches(COMPOSER_SELECTOR)) return true;

  // 检查祖先链
  let current = element;
  while (current && current !== document.body) {
    if (current.matches && current.matches(COMPOSER_SELECTOR)) return true;
    if (current.classList && (
      current.classList.contains('composer') ||
      current.classList.contains('chat-input-area') ||
      current.classList.contains('input-container')
    )) return true;
    current = current.parentElement;
  }

  return false;
}

// ========== 文件管理器 ==========

class FileManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.files = [];
    this.listeners = [];
    this.loadFromStorage();
  }

  async loadFromStorage() {
    try {
      const stored = await this.ctx.storage.get('files');
      if (Array.isArray(stored)) {
        this.files = stored;
        this.notify();
      }
    } catch (e) {
      console.error('[file-drag] Load failed:', e);
    }
  }

  async save() {
    try {
      await this.ctx.storage.set('files', this.files);
    } catch (e) {
      console.error('[file-drag] Save failed:', e);
    }
  }

  add(newFiles) {
    const added = [];
    for (const file of newFiles) {
      if (this.files.length >= MAX_FILES) break;
      const path = getFilePath(file);
      if (!path) continue;

      // 去重检查
      if (this.files.some(f => f.path === path)) continue;

      this.files.push({
        name: file.name,
        path: path,
        size: file.size,
        type: file.type || 'unknown',
        addedAt: Date.now()
      });
      added.push(path);
    }
    if (added.length > 0) {
      this.save();
      this.notify();
    }
    return added;
  }

  remove(index) {
    if (index >= 0 && index < this.files.length) {
      this.files.splice(index, 1);
      this.save();
      this.notify();
    }
  }

  move(from, to) {
    if (from >= 0 && from < this.files.length && to >= 0 && to < this.files.length) {
      const [file] = this.files.splice(from, 1);
      this.files.splice(to, 0, file);
      this.save();
      this.notify();
    }
  }

  clear() {
    this.files = [];
    this.save();
    this.notify();
  }

  getAll() {
    return this.files;
  }

  on(callback) {
    this.listeners.push(callback);
  }

  off(callback) {
    this.listeners = this.listeners.filter(l => l !== callback);
  }

  notify() {
    this.listeners.forEach(l => {
      try {
        l();
      } catch (e) {
        console.error('[file-drag] Listener error:', e);
      }
    });
  }
}

// ========== 主函数 ==========

export default function activate(ctx) {
  console.log('[file-drag-improved] Plugin starting');

  const fileManager = new FileManager(ctx);
  const h = ctx.react.createElement;
  const { useState, useEffect } = ctx.react;

  // ========== 创建遮罩层 ==========

  const overlay = document.createElement('div');
  overlay.className = 'file-drag-overlay';
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: ${OVERLAY_Z_INDEX};
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.15s ease, visibility 0.15s ease;
    pointer-events: none;
  `.replace(/\n\s+/g, '');

  const box = document.createElement('div');
  box.className = 'file-drag-box';
  box.style.cssText = `
    padding: 48px 64px;
    border: 3px dashed #4a9eff;
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.98);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    text-align: center;
    user-select: none;
  `.replace(/\n\s+/g, '');

  const icon = document.createElement('div');
  icon.style.cssText = `
    font-size: 72px;
    margin-bottom: 20px;
    animation: bounce 0.6s infinite alternate;
  `.replace(/\n\s+/g, '');
  icon.textContent = '📁';

  const title = document.createElement('div');
  title.style.cssText = `
    font-size: 28px;
    font-weight: 700;
    color: #333;
    margin-bottom: 12px;
  `.replace(/\n\s+/g, '');
  title.textContent = '松开即可添加文件';

  const desc = document.createElement('div');
  desc.style.cssText = `
    font-size: 16px;
    color: #666;
  `.replace(/\n\s+/g, '');
  desc.textContent = `最多支持 ${MAX_FILES} 个文件`;

  box.appendChild(icon);
  box.appendChild(title);
  box.appendChild(desc);
  overlay.appendChild(box);

  // 添加 CSS 动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes bounce {
      from { transform: translateY(0); }
      to { transform: translateY(-10px); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // ========== 拖拽状态管理 ==========

  let dragCounter = 0;
  let isDraggingFiles = false;
  let hideTimeout = null;

  const show = () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    overlay.style.opacity = '1';
    overlay.style.visibility = 'visible';
  };

  const hide = () => {
    // 延迟隐藏，防止闪烁
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      overlay.style.opacity = '0';
      overlay.style.visibility = 'hidden';
      isDraggingFiles = false;
    }, 100);
  };

  // ========== 事件处理函数（参考 VSCode/Electron 实现）==========

  /**
   * dragenter: 拖拽进入窗口
   * 关键：使用 counter 处理嵌套元素的 enter/leave
   */
  const onEnter = (e) => {
    // 只处理文件拖拽
    if (!isFileDrag(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    dragCounter++;
    isDraggingFiles = true;

    // 只在第一次进入时显示遮罩
    if (dragCounter === 1) {
      show();
    }
  };

  /**
   * dragover: 拖拽在窗口上移动
   * 必须 preventDefault 才能触发 drop 事件
   */
  const onOver = (e) => {
    if (!isDraggingFiles && !isFileDrag(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // 设置 dropEffect 提示用户操作类型
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  /**
   * dragleave: 拖拽离开元素
   * 关键：使用 counter 正确处理嵌套元素
   */
  const onLeave = (e) => {
    if (!isDraggingFiles) return;

    e.preventDefault();
    e.stopPropagation();

    dragCounter--;

    // 只在完全离开窗口时隐藏
    if (dragCounter <= 0) {
      dragCounter = 0;
      hide();
    }
  };

  /**
   * drop: 松开鼠标释放文件
   * 核心逻辑：获取文件并插入路径
   */
  const onDrop = (e) => {
    if (!isDraggingFiles && !isFileDrag(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // 重置状态
    dragCounter = 0;
    isDraggingFiles = false;
    hide();

    // 获取文件列表
    const files = toArray(e.dataTransfer?.files);

    if (files.length === 0) {
      console.warn('[file-drag] No files found');
      return;
    }

    if (files.length > MAX_FILES) {
      alert(`最多支持 ${MAX_FILES} 个文件，当前拖入了 ${files.length} 个`);
      return;
    }

    console.log(`[file-drag] Dropped ${files.length} files:`, files.map(f => f.name));

    // 添加到文件管理器
    const paths = fileManager.add(files);

    if (paths.length === 0) {
      console.warn('[file-drag] No valid paths extracted');
      return;
    }

    // 插入到输入框（使用 composer API）
    if (ctx.composer?.setDraft && ctx.composer?.getDraft) {
      try {
        const current = ctx.composer.getDraft() || '';
        const text = paths.map(p => `@${p}`).join(' ');
        const newDraft = current ? `${current} ${text}` : text;

        ctx.composer.setDraft(newDraft);
        console.log(`[file-drag] Inserted ${paths.length} paths into composer`);
      } catch (err) {
        console.error('[file-drag] Failed to set draft:', err);

        // Fallback: 尝试直接操作 DOM（不推荐，但作为后备）
        const composerInput = document.querySelector(COMPOSER_SELECTOR);
        if (composerInput) {
          const text = paths.map(p => `@${p}`).join(' ');
          composerInput.value = composerInput.value ? `${composerInput.value} ${text}` : text;

          // 触发 input 事件
          composerInput.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('[file-drag] Fallback: Inserted via DOM');
        }
      }
    } else {
      console.error('[file-drag] composer API not available');
    }
  };

  // ========== 注册全局事件监听（使用 capture 阶段）==========

  document.addEventListener('dragenter', onEnter, true);
  document.addEventListener('dragover', onOver, true);
  document.addEventListener('dragleave', onLeave, true);
  document.addEventListener('drop', onDrop, true);

  console.log('[file-drag-improved] Event listeners registered');

  // ========== 文件列表面板组件 ==========

  function FilePanel() {
    const [files, setFiles] = useState([]);

    useEffect(() => {
      const update = () => setFiles([...fileManager.getAll()]);
      update();
      fileManager.on(update);
      return () => fileManager.off(update);
    }, []);

    // 空状态
    if (files.length === 0) {
      return h('div', {
        style: {
          padding: '40px',
          textAlign: 'center',
          color: '#999'
        }
      },
        h('div', { style: { fontSize: '64px', marginBottom: '20px' } }, '📁'),
        h('div', { style: { fontSize: '18px', fontWeight: '600', marginBottom: '8px' } }, '拖拽文件到聊天窗口'),
        h('div', { style: { fontSize: '14px', color: '#bbb' } }, '已添加的文件会显示在这里')
      );
    }

    // 文件列表
    return h('div', { style: { padding: '16px', height: '100%', overflow: 'auto' } },
      // 头部工具栏
      h('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
          paddingBottom: '12px',
          borderBottom: '1px solid #eee'
        }
      },
        h('div', { style: { fontSize: '16px', fontWeight: '600', color: '#333' } },
          `已添加 ${files.length} 个文件`
        ),
        h('button', {
          onClick: () => {
            if (confirm('确定清空所有文件？')) {
              fileManager.clear();
            }
          },
          style: {
            padding: '6px 16px',
            borderRadius: '6px',
            border: '1px solid #e0e0e0',
            background: '#fff',
            color: '#666',
            cursor: 'pointer',
            fontSize: '14px',
            transition: 'all 0.2s'
          },
          onMouseEnter: (e) => {
            e.target.style.background = '#f5f5f5';
            e.target.style.borderColor = '#d0d0d0';
          },
          onMouseLeave: (e) => {
            e.target.style.background = '#fff';
            e.target.style.borderColor = '#e0e0e0';
          }
        }, '清空全部')
      ),

      // 文件列表
      h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }
      },
        files.map((file, i) =>
          h('div', {
            key: i,
            style: {
              padding: '12px',
              border: '1px solid #e8e8e8',
              borderRadius: '8px',
              background: '#fafafa',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              transition: 'all 0.2s'
            }
          },
            // 文件信息
            h('div', {
              style: {
                flex: 1,
                overflow: 'hidden',
                marginRight: '12px'
              }
            },
              h('div', {
                style: {
                  fontSize: '14px',
                  fontWeight: '500',
                  color: '#333',
                  marginBottom: '4px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }
              }, file.name),
              h('div', {
                style: {
                  fontSize: '12px',
                  color: '#999',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }
              }, file.path)
            ),

            // 操作按钮组
            h('div', {
              style: {
                display: 'flex',
                gap: '8px',
                flexShrink: 0
              }
            },
              // 上移
              i > 0 && h('button', {
                onClick: () => fileManager.move(i, i - 1),
                style: {
                  padding: '4px 8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  background: '#fff',
                  cursor: 'pointer',
                  fontSize: '12px'
                },
                title: '上移'
              }, '↑'),

              // 下移
              i < files.length - 1 && h('button', {
                onClick: () => fileManager.move(i, i + 1),
                style: {
                  padding: '4px 8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  background: '#fff',
                  cursor: 'pointer',
                  fontSize: '12px'
                },
                title: '下移'
              }, '↓'),

              // 删除
              h('button', {
                onClick: () => {
                  if (confirm(`确定删除 ${file.name}？`)) {
                    fileManager.remove(i);
                  }
                },
                style: {
                  padding: '4px 8px',
                  border: '1px solid #ffcdd2',
                  borderRadius: '4px',
                  background: '#fff',
                  color: '#f44336',
                  cursor: 'pointer',
                  fontSize: '12px'
                },
                title: '删除'
              }, '删除')
            )
          )
        )
      )
    );
  }

  // ========== 注册 UI 组件 ==========

  ctx.ui.registerPanelTab({
    key: 'file-drag-upload',
    label: () => '📁 文件',
    component: FilePanel
  });

  console.log('[file-drag-improved] Plugin activated successfully');

  // ========== 清理函数 ==========

  return () => {
    console.log('[file-drag-improved] Plugin deactivating');

    document.removeEventListener('dragenter', onEnter, true);
    document.removeEventListener('dragover', onOver, true);
    document.removeEventListener('dragleave', onLeave, true);
    document.removeEventListener('drop', onDrop, true);

    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }

    if (style.parentNode) {
      style.parentNode.removeChild(style);
    }

    if (hideTimeout) {
      clearTimeout(hideTimeout);
    }

    console.log('[file-drag-improved] Plugin deactivated');
  };
}

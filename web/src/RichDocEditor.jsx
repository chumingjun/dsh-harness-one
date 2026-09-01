// 所见即所得文稿编辑器（直接编辑通道，issue #97）：
// Tiptap v2 + tiptap-markdown——打开即排版文档，直接改字/改表格/调格式，
// 用户不需要懂 Markdown；保存时序列化回 Markdown 落版本链（与 AI 修订同链）。
// 表格：Tiptap 官方 table 扩展（悬浮 +/= 控行列、Tab 切格、表头行列）。
import { useCallback, useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Markdown } from 'tiptap-markdown';

export const RICH_DOC_EXTENSIONS = [
  StarterKit,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
  Link.configure({ openOnClick: false }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
];

/** 工具条按钮规格：active 判定与动作（编辑器实例方法安全调用） */
function toolbarState(editor) {
  return [
    { key: 'bold', label: 'B', title: '加粗', className: 'rde-btn-b', active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { key: 'italic', label: 'I', title: '斜体', className: 'rde-btn-i', active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { key: 'strike', label: 'S', title: '删除线', className: 'rde-btn-s', active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { key: 'code', label: '</>', title: '行内代码', active: editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
    { sep: true },
    { key: 'h1', label: 'H1', title: '一级标题', active: editor.isActive('heading', { level: 1 }), run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { key: 'h2', label: 'H2', title: '二级标题', active: editor.isActive('heading', { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: 'h3', label: 'H3', title: '三级标题', active: editor.isActive('heading', { level: 3 }), run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { sep: true },
    { key: 'bullet', label: '•', title: '无序列表', active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { key: 'ordered', label: '1.', title: '有序列表', active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: 'task', label: '☑', title: '任务清单', active: editor.isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run() },
    { key: 'quote', label: '❝', title: '引用', active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { key: 'codeblock', label: '{ }', title: '代码块', active: editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run() },
    { sep: true },
    { key: 'link', label: '🔗', title: '链接（选中文字后点）', active: editor.isActive('link'), run: () => {
      const url = window.prompt('链接地址：', editor.getAttributes('link').href || 'https://');
      if (url == null) return;
      if (!url) { editor.chain().focus().unsetLink().run(); return; }
      editor.chain().focus().setLink({ href: url }).run();
    } },
    { key: 'hr', label: '―', title: '分隔线', active: false, run: () => editor.chain().focus().setHorizontalRule().run() },
    { key: 'undo', label: '↩', title: '撤销', active: false, run: () => editor.chain().focus().undo().run() },
    { key: 'redo', label: '↪', title: '重做', active: false, run: () => editor.chain().focus().redo().run() },
  ];
}

function tableState(editor) {
  if (!editor.isActive('table')) return null;
  return [
    { key: 'add-row', label: '＋行', title: '下方插入行', run: () => editor.chain().focus().addRowAfter().run() },
    { key: 'del-row', label: '－行', title: '删除本行', run: () => editor.chain().focus().deleteRow().run() },
    { key: 'add-col', label: '＋列', title: '右侧插入列', run: () => editor.chain().focus().addColumnAfter().run() },
    { key: 'del-col', label: '－列', title: '删除本列', run: () => editor.chain().focus().deleteColumn().run() },
    { key: 'header-row', label: '表头行', title: '切换首行为表头', active: editor.isActive('tableHeader'), run: () => editor.chain().focus().toggleHeaderRow().run() },
    { key: 'merge', label: '合并', title: '合并单元格', run: () => editor.chain().focus().mergeCells().run() },
    { key: 'split', label: '拆分', title: '拆分单元格', run: () => editor.chain().focus().splitCell().run() },
  ];
}

export function RichDocEditor({ initialMarkdown, onChange, onReady }) {
  const [tick, setTick] = useState(0); // 编辑器选区/格式态变化 → 重渲染工具条

  // deps 留空：只在挂载时解析底稿（受控状态放外面）。若把 initialMarkdown 放进依赖，
  // 每次击键 onChange 更新草稿都会重建编辑器——光标跳回文档开头，连续输入不可用。
  // 换底稿由宿主用 key 重挂载（FeedbackDrawer 的 draft key）。
  const editor = useEditor({
    extensions: RICH_DOC_EXTENSIONS,
    content: initialMarkdown, // Markdown 扩展解析 md 字符串为文档
    editorProps: { attributes: { class: 'rde-prose', spellcheck: 'false' } },
    onUpdate: ({ editor: e }) => onChange?.(e.storage.markdown.getMarkdown()),
    onSelectionUpdate: () => setTick((t) => t + 1),
    onTransaction: () => setTick((t) => t + 1),
  });

  // 保存快捷键：Cmd/Ctrl+S 交给宿主处理（FeedbackDrawer 的保存按钮逻辑）
  useEffect(() => { onReady?.(editor); }, [editor, onReady]);

  const insertTable = useCallback(() => {
    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    setTick((t) => t + 1);
  }, [editor]);

  if (!editor) return <div className="rde-loading">编辑器加载中…</div>;
  const bar = toolbarState(editor);
  const table = tableState(editor);
  void tick; // tick 仅驱动重渲染

  return (
    <div className="rde">
      <div className="rde-toolbar" role="toolbar" aria-label="格式工具条">
        {bar.map((item, i) => (item.sep
          ? <span key={`sep${i}`} className="rde-sep" />
          : (
            <button
              key={item.key} type="button" className={`rde-btn ${item.className || ''} ${item.active ? 'rde-btn-on' : ''}`}
              title={item.title} aria-label={item.title} aria-pressed={item.active}
              onMouseDown={(e) => e.preventDefault()} // 保住编辑器焦点
              onClick={item.run}
            >{item.label}</button>
          )))}
        {!table && <button type="button" className="rde-btn" title="插入表格" aria-label="插入表格" onMouseDown={(e) => e.preventDefault()} onClick={insertTable}>▦</button>}
        {table && (
          <span className="rde-table-tools">
            {table.map((item) => (
              <button
                key={item.key} type="button" className={`rde-btn ${item.active ? 'rde-btn-on' : ''}`}
                title={item.title} aria-label={item.title}
                onMouseDown={(e) => e.preventDefault()} onClick={() => { item.run(); setTick((t) => t + 1); }}
              >{item.label}</button>
            ))}
          </span>
        )}
      </div>
      <EditorContent editor={editor} className="rde-body" />
    </div>
  );
}
